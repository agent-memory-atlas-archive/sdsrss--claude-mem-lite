// d366's events migration filled events.search_terms for every row inside the one migration
// transaction, and a second full segmentation ran in the glued-identifier cleanup. On a CJK-heavy
// store of 200,000 events the first open took 12.6–25.5 s (round-3 pre-tag review, 2026-10-17):
// a 5 s hook that opened it first was killed with nothing committed, again on every later hook,
// and a process opening it meanwhile got SQLITE_BUSY (the MCP server exited 1). The migration pass
// now only adds the column, a partial index of the rows still to fill and the rebuilt events_fts;
// every ensureDb then fills a budget's worth of those rows, newest first, segmenting row by row
// and committing batch by batch, so a killed opener keeps what it wrote, an opener under another
// writer's lock is not held, and an event an older build writes later is filled too.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// A pass-through, except that a test can run something just before the backfill segments its
// `at`-th row (another writer, another connection's read) and can make each row take `delayMs`.
const race = vi.hoisted(() => ({ calls: 0, at: 0, hook: null, delayMs: 0 }));
vi.mock('../nlp.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    eventSearchTerms: (title, body) => {
      race.calls++;
      if (race.hook && race.calls === race.at) {
        const hook = race.hook;
        race.hook = null;
        hook();
      }
      if (race.delayMs) {
        const until = performance.now() + race.delayMs;
        while (performance.now() < until);
      }
      return real.eventSearchTerms(title, body);
    },
  };
});

import { initSchema, backfillEventSearchTerms } from '../schema.mjs';
import { createTestDb } from './test-helpers.mjs';
import { eventSearchTerms } from '../nlp.mjs';
import { searchEvents } from '../lib/activity.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = 'parent--terms-backfill';
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
  Object.assign(race, { calls: 0, at: 0, hook: null, delayMs: 0 });
});

/** The pre-d366 events shape (v6.27.0): no search_terms column, a 4-column index, old triggers. */
function toLegacyShape(d) {
  d.exec(`DROP INDEX IF EXISTS idx_events_terms_pending`);
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
  return ROWS.map(([t, b], i) => Number(ins.run(P, t, b, Date.now() + i).lastInsertRowid));
}

/** A WAL file store in the legacy shape, migrated by one pass. */
function migratedFileStore() {
  dir = mkdtempSync(join(tmpdir(), 'terms-backfill-'));
  const path = join(dir, 'claude-mem-lite.db');
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  const ids = toLegacyShape(db);
  initSchema(db);
  return { path, ids };
}

const nullIds = (d) =>
  d
    .prepare(`SELECT id FROM events WHERE search_terms IS NULL ORDER BY id`)
    .all()
    .map((r) => r.id);

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

/** The SELECTs backfillEventSearchTerms prepares, as it prepares them. */
function pickSqlOf(d, opts) {
  const seen = [];
  const prepare = d.prepare.bind(d);
  d.prepare = (sql) => {
    seen.push(sql);
    return prepare(sql);
  };
  try {
    backfillEventSearchTerms(d, opts);
  } finally {
    delete d.prepare;
  }
  return seen.filter((sql) => /^\s*SELECT\b[\s\S]*search_terms IS NULL/i.test(sql));
}

describe('the read of the rows to fill', () => {
  // Review, 2026-10-17: the MCP server's startup refreshPlannerStats sampled events while most
  // rows were pending; with that sqlite_stat1 row the planner read the rows to fill by a rowid
  // scan of every filled row, about 41 ms per open at 200,000 events once the fill was done.
  it('walks the pending index even under statistics sampled mid-fill', () => {
    db = createTestDb();
    toLegacyShape(db);
    const ins = db.prepare(
      `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, 'bugfix', ?, ?, 2, ?)`,
    );
    for (let i = 0; i < 2000; i++) ins.run(P, `事件${i}`, `正文${i}`, Date.now() + i);
    initSchema(db);
    backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 1 }); // creates the index
    db.exec('ANALYZE');
    expect(
      db.prepare(`SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_events_terms_pending'`).get()?.stat,
    ).toMatch(/^\d{4} /); // premise: sampled with ~2000 rows pending
    backfillEventSearchTerms(db, { budgetMs: 60_000 });
    const picks = pickSqlOf(db, { budgetMs: 60_000 });
    expect(picks.length).toBeGreaterThan(0);
    for (const sql of picks) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(Number.MAX_SAFE_INTEGER, 250, 0)
        .map((r) => r.detail)
        .join(' | ');
      expect(plan).toContain('idx_events_terms_pending');
    }
  });

  it('creates the pending index on a store migrated without it, then fills', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    db.exec(`DROP INDEX IF EXISTS idx_events_terms_pending`); // an earlier candidate's migration
    expect(backfillEventSearchTerms(db, { budgetMs: 60_000 })).toEqual({ filled: ids.length, done: true });
    expect(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_events_terms_pending'`).get()?.sql,
    ).toMatch(/WHERE search_terms IS NULL/);
  });
});

describe('backfillEventSearchTerms', () => {
  it('with no budget left fills one row, the newest, and says it is not done', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    expect(backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 2 })).toEqual({ filled: 1, done: false });
    expect(nullIds(db)).toEqual(ids.slice(0, 4));
  });

  it('commits each batch: another connection sees the first while the second is segmented', () => {
    const { path } = migratedFileStore();
    const seen = [];
    race.at = 3; // the first row of the second batch of 2
    race.hook = () => {
      const other = new Database(path, { readonly: true });
      try {
        seen.push(other.prepare(`SELECT COUNT(*) AS n FROM events WHERE search_terms IS NOT NULL`).get().n);
      } finally {
        other.close();
      }
    };
    expect(backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2 })).toEqual({
      filled: ROWS.length,
      done: true,
    });
    expect(seen).toEqual([2]);
  });

  it('stops at its default budget row by row, however long each row takes', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    race.delayMs = 100; // a long body: 100 ms per row, against the 250 ms budget
    const r = backfillEventSearchTerms(db);
    expect(r.done).toBe(false);
    expect(r.filled).toBeGreaterThanOrEqual(1);
    expect(r.filled).toBeLessThanOrEqual(3);
  });

  it("under another writer's lock returns after its short write wait with nothing filled, and restores the busy wait", () => {
    const { path } = migratedFileStore();
    db.pragma('busy_timeout = 4321');
    const locker = new Database(path);
    locker.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      expect(backfillEventSearchTerms(db, { budgetMs: 60_000 })).toEqual({ filled: 0, done: false });
      expect(Date.now() - t0).toBeLessThan(400);
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
    race.at = 1;
    race.hook = () => db.prepare(`UPDATE events SET search_terms = 'fresh' WHERE id = ?`).run(newest);
    // The one row segmented was stored meanwhile, so nothing is counted as filled.
    expect(backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 2 })).toEqual({ filled: 0, done: false });
    expect(db.prepare(`SELECT search_terms FROM events WHERE id = ?`).get(newest).search_terms).toBe('fresh');
  });

  it('reports done once no row is left, and fills nothing more', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    expect(backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2 })).toEqual({
      filled: ROWS.length,
      done: true,
    });
    expect(backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2 })).toEqual({
      filled: 0,
      done: true,
    });
  });
});

describe('across opens', () => {
  it('every event is found by a CJK substring, with the terms the one-shot migration wrote', () => {
    db = createTestDb();
    const ids = toLegacyShape(db);
    initSchema(db);
    let opens = 0;
    while (!backfillEventSearchTerms(db, { budgetMs: 0 }).done && opens < 20) opens++;
    expect(opens).toBe(ROWS.length);
    for (const [k, needle] of ['连接池', 'node22', '租户', '中间件', '分区'].entries())
      expect(searchEvents(db, needle, { project: P }).map((r) => r.id)).toEqual([ids[k]]);
    for (const r of db.prepare(`SELECT title, body, search_terms FROM events`).all())
      expect(r.search_terms).toBe(eventSearchTerms(r.title, r.body));
  });

  it('an event an older build writes after the fill finished is filled by the next open', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    backfillEventSearchTerms(db, { budgetMs: 60_000 });
    // 6.27.0's INSERT names no search_terms.
    const late = Number(
      db
        .prepare(
          `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, 'bugfix', ?, ?, 2, ?)`,
        )
        .run(P, '旧版本写入的事件', '数据库锁等待超时', Date.now()).lastInsertRowid,
    );
    expect(nullIds(db)).toEqual([late]);
    expect(backfillEventSearchTerms(db)).toEqual({ filled: 1, done: true });
    expect(searchEvents(db, '锁等待', { project: P }).map((r) => r.id)).toEqual([late]);
  });

  it('ensureDb fills them: a CLI search on a migrating store finds a CJK event by a substring', () => {
    const { path } = migratedFileStore();
    toLegacyShape(db); // back to the shape a 6.27.0 store has when 6.28.0 first opens it
    db.close();
    db = null;
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'cli.mjs'), 'activity', 'search', '高并发', '--project', P],
      {
        env: {
          ...process.env,
          CLAUDE_MEM_DIR: dirname(path),
          CLAUDE_MEM_SKIP_UPDATE: '1',
          MEM_NO_AUTO_ADOPT: '1',
          CLAUDE_PROJECT_DIR: dirname(path),
        },
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('修复连接池泄漏问题');
  });
});

// D#396: every opener picked the newest pending rows, and a batch write did not wait for another
// writer at all, so openers started together (UserPromptSubmit always runs two) segmented the same
// rows and all but one stopped at their first write. On a synthetic store of 200,000 CJK events,
// three openers released together filled 12.4% more rows per round with both changes below than
// without (30 rounds each, order rotated, 22 of 30 rounds ahead; 2026-10-17, load average 24-30);
// either change alone gained nothing measurable, and one opener alone was unchanged.
describe('openers started together (D#396)', () => {
  it('start a batch apart, so a second opener fills rows the first is not segmenting', () => {
    const { path, ids } = migratedFileStore();
    let peer = null;
    race.at = 1; // while this opener segments its first row
    race.hook = () => {
      const other = new Database(path);
      try {
        peer = backfillEventSearchTerms(other, { budgetMs: 0, batchSize: 2, startBatch: 1 });
      } finally {
        other.close();
      }
    };
    const mine = backfillEventSearchTerms(db, { budgetMs: 0, batchSize: 2 });
    expect(peer).toEqual({ filled: 1, done: false });
    expect(mine, 'two rows filled, not one twice').toEqual({ filled: 1, done: false });
    // This opener the newest row, the peer the newest one below the first batch of 2.
    expect(nullIds(db)).toEqual([ids[0], ids[1], ids[3]]);
  });

  it('with fewer rows pending than its start, starts from the newest and says when none is left', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    expect(backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2, startBatch: 3 })).toEqual({
      filled: ROWS.length,
      done: true,
    });
  });

  it('started below the newest rows, goes back up for them within its budget', () => {
    db = createTestDb();
    toLegacyShape(db);
    initSchema(db);
    expect(backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 2, startBatch: 1 })).toEqual({
      filled: ROWS.length,
      done: true,
    });
    expect(nullIds(db)).toEqual([]);
  });

  it("waits for another writer's short write instead of stopping at it", async () => {
    const { spawn } = await import('node:child_process');
    const { path } = migratedFileStore();
    let held = false;
    race.at = 1;
    race.hook = () => {
      // Another opener's batch write: the lock taken now and held 300 ms.
      const child = spawn(
        process.execPath,
        [
          '-e',
          `const D = require('better-sqlite3'); const d = new D(${JSON.stringify(path)});
           d.exec('BEGIN IMMEDIATE'); setTimeout(() => { d.exec('COMMIT'); d.close(); }, 300);`,
        ],
        { cwd: REPO, stdio: 'ignore' },
      );
      child.unref();
      const probe = new Database(path);
      probe.pragma('busy_timeout = 0');
      const until = Date.now() + 5000;
      try {
        while (Date.now() < until) {
          try {
            probe.exec('BEGIN IMMEDIATE');
            probe.exec('ROLLBACK');
          } catch {
            held = true;
            break;
          }
        }
      } finally {
        probe.close();
      }
    };
    const t0 = Date.now();
    const r = backfillEventSearchTerms(db, { budgetMs: 60_000, batchSize: 10, writeWaitMs: 3000 });
    expect(held, 'premise: the other writer held the lock while this one segmented').toBe(true);
    expect(r).toEqual({ filled: ROWS.length, done: true });
    expect(Date.now() - t0, 'premise: the write met the lock').toBeGreaterThan(150);
  });

  it('ensureDb starts each process at the batch its pid picks', () => {
    dir = mkdtempSync(join(tmpdir(), 'terms-spread-'));
    const n = 1100; // more than four batches of 250
    /** A store of n pending events whose fill order a trigger records; one ensureDb in a child. */
    const attempt = (k) => {
      const home = join(dir, String(k));
      mkdirSync(home);
      const path = join(home, 'claude-mem-lite.db');
      const d = new Database(path);
      d.pragma('journal_mode = WAL');
      d.pragma('foreign_keys = OFF');
      initSchema(d);
      const ins = d.prepare(
        `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, 'bugfix', ?, ?, 2, ?)`,
      );
      d.transaction(() => {
        for (let i = 0; i < n; i++) ins.run(P, `事件${i}`, `正文${i}`, Date.now() + i);
      })();
      d.exec(`UPDATE events SET search_terms = NULL`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_events_terms_pending ON events(id) WHERE search_terms IS NULL`);
      d.exec(`CREATE TABLE fill_order (seq INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER)`);
      d.exec(`CREATE TRIGGER fill_order_t AFTER UPDATE OF search_terms ON events
               WHEN old.search_terms IS NULL BEGIN INSERT INTO fill_order (id) VALUES (new.id); END`);
      const top = d.prepare(`SELECT MAX(id) AS m FROM events`).get().m;
      d.close();
      const r = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { ensureDb } = await import(${JSON.stringify(join(REPO, 'schema.mjs'))});
           ensureDb().close(); process.stdout.write(String(process.pid));`,
        ],
        { env: { ...process.env, CLAUDE_MEM_DIR: home, MEM_NO_AUTO_ADOPT: '1' }, encoding: 'utf8' },
      );
      expect(r.status, r.stderr).toBe(0);
      const ro = new Database(path, { readonly: true });
      const first = ro.prepare(`SELECT id FROM fill_order ORDER BY seq LIMIT 1`).get()?.id;
      ro.close();
      return { pid: Number(r.stdout), first, top };
    };
    // A pid that is a multiple of 4 starts at the newest row either way, so try until one is not.
    let run;
    for (let k = 0; k < 8 && !(run && run.pid % 4); k++) run = attempt(k);
    expect(run.pid % 4, 'premise: a child whose pid picks a batch below the newest').not.toBe(0);
    expect(run.first, `pid ${run.pid}`).toBe(run.top - (run.pid % 4) * 250);
  });
});
