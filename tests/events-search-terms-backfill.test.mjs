// d366's events migration filled events.search_terms for every row inside the one migration
// transaction, and a second full segmentation ran in the glued-identifier cleanup. On a CJK-heavy
// store of 200,000 events the first open took 12.6–25.3 s (round-3 pre-tag review, 2026-10-17):
// a 5 s hook that opened it first was killed with nothing committed, again on every later hook,
// and a process opening it meanwhile got SQLITE_BUSY (the MCP server exited 1). The migration pass
// now only adds the column and rebuilds events_fts; the terms are filled by a deferred cleanup
// that commits in short batches, newest first, within a time budget per open, so a killed opener
// keeps what it did and a concurrent one waits one batch at most.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// A pass-through, except that a test can run another writer between the backfill's read of a
// batch and its write (`between`).
const race = vi.hoisted(() => ({ between: null }));
vi.mock('../nlp.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    eventSearchTerms: (title, body) => {
      const hook = race.between;
      race.between = null;
      hook?.();
      return real.eventSearchTerms(title, body);
    },
  };
});

import * as schema from '../schema.mjs';
import { createTestDb } from './test-helpers.mjs';
import { eventSearchTerms } from '../nlp.mjs';
import { searchEvents } from '../lib/activity.mjs';

const { initSchema, runDeferredCleanups } = schema;
const P = 'parent--terms-backfill';
const MARKER = 'backfill-event-search-terms';
const ROWS = [
  ['修复连接池泄漏问题', '连接池在高并发下耗尽'],
  ['升级到node22之后构建失败', '原生模块没有重新编译'],
  ['缓存键缺少租户前缀', '两个租户读到了同一份缓存'],
  ['登录页面会话过期', '刷新令牌被中间件缓存'],
  ['消费者延迟越来越高', 'kafka分区重新平衡太频繁'],
];

let db;
let dir;
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** The pre-d366 events shape (v6.27.0): no search_terms column, a 4-column index, old triggers. */
function toLegacyShape(d) {
  d.exec(`DROP TRIGGER IF EXISTS events_fts_ai`);
  d.exec(`DROP TRIGGER IF EXISTS events_fts_ad`);
  d.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
  d.exec(`DROP TABLE IF EXISTS events_fts`);
  d.exec(`ALTER TABLE events DROP COLUMN search_terms`);
  d.exec(`
    CREATE VIRTUAL TABLE events_fts USING fts5(
      title, body, event_type UNINDEXED, project UNINDEXED,
      content='events', content_rowid='id',
      tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
    );
    CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, body, event_type, project)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
    END;
  `);
  const ins = d.prepare(
    `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, 'bugfix', ?, ?, 2, ?)`,
  );
  const ids = ROWS.map(([t, b], i) => Number(ins.run(P, t, b, Date.now() + i).lastInsertRowid));
  d.prepare(`DELETE FROM migration_cleanups WHERE name IN (?, 'backfill-glued-ascii-runs')`).run(MARKER);
  return ids;
}

const nullIds = (d) =>
  d
    .prepare(`SELECT id FROM events WHERE search_terms IS NULL ORDER BY id`)
    .all()
    .map((r) => r.id);
const marked = (d) => Boolean(d.prepare(`SELECT 1 FROM migration_cleanups WHERE name = ?`).get(MARKER));

describe('the events migration pass', () => {
  it('adds the column and the 5-column index without computing any terms', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    const ftsCols = db
      .prepare(`PRAGMA table_info(events_fts)`)
      .all()
      .map((c) => c.name);
    expect(ftsCols).toContain('search_terms');
    expect(nullIds(db)).toEqual(ids);
    // Until a row is filled, a CJK substring misses it, as on 6.27.0.
    expect(searchEvents(db, '连接池', { project: P })).toEqual([]);
  });
});

describe('backfillEventSearchTerms', () => {
  it('is exported', () => {
    expect(typeof schema.backfillEventSearchTerms).toBe('function');
  });

  it('with no budget left fills one batch, newest first, and says it is not done', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    const r = schema.backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 2 });
    expect(r).toEqual({ filled: 2, done: false });
    expect(nullIds(db)).toEqual(ids.slice(0, 3));
  });

  it('commits each batch: another connection sees it while the backfill is unfinished', () => {
    dir = mkdtempSync(join(tmpdir(), 'terms-backfill-'));
    const path = join(dir, 'store.db');
    db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    toLegacyShape(db);
    initSchema(db);
    schema.backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 2 });
    const other = new Database(path, { readonly: true });
    try {
      expect(other.prepare(`SELECT COUNT(*) AS n FROM events WHERE search_terms IS NOT NULL`).get().n).toBe(
        2,
      );
    } finally {
      other.close();
    }
  });

  it("under another writer's lock returns at once with nothing filled, and restores the busy wait", () => {
    dir = mkdtempSync(join(tmpdir(), 'terms-backfill-'));
    const path = join(dir, 'store.db');
    db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    toLegacyShape(db);
    initSchema(db);
    db.pragma('busy_timeout = 4321');
    const locker = new Database(path);
    locker.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      expect(schema.backfillEventSearchTerms(db, { budgetMs: 60_000 })).toEqual({ filled: 0, done: false });
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    expect(db.pragma('busy_timeout', { simple: true })).toBe(4321);
    expect(nullIds(db)).toHaveLength(ROWS.length);
  });

  it('keeps the terms another writer stored between its read and its write', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    const newest = ids.at(-1);
    race.between = () => db.prepare(`UPDATE events SET search_terms = 'fresh' WHERE id = ?`).run(newest);
    schema.backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 2 });
    expect(db.prepare(`SELECT search_terms FROM events WHERE id = ?`).get(newest).search_terms).toBe('fresh');
  });

  it('reports done once no row is left, and fills nothing more', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    expect(schema.backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2 })).toEqual({
      filled: ROWS.length,
      done: true,
    });
    expect(schema.backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2 })).toEqual({
      filled: 0,
      done: true,
    });
  });
});

describe('the deferred cleanup across opens', () => {
  it('leaves its marker unset until every row is filled, then every event is found by a CJK substring', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    const opens = [];
    for (let k = 0; k < 10 && !marked(db); k++) {
      runDeferredCleanups(db, { budgetMs: 0, batchSize: 2 });
      opens.push({ left: nullIds(db).length, marked: marked(db) });
    }
    expect(opens).toEqual([
      { left: 3, marked: false },
      { left: 1, marked: false },
      { left: 0, marked: false },
      { left: 0, marked: true },
    ]);
    for (const [k, needle] of ['连接池', 'node22', '租户', '中间件', '分区'].entries())
      expect(searchEvents(db, needle, { project: P }).map((r) => r.id)).toEqual([ids[k]]);
  });

  it('ends with the terms the one-shot migration wrote', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    for (let k = 0; k < 10 && !marked(db); k++) runDeferredCleanups(db, { budgetMs: 0, batchSize: 2 });
    for (const r of db.prepare(`SELECT title, body, search_terms FROM events`).all())
      expect(r.search_terms).toBe(eventSearchTerms(r.title, r.body));
  });
});
