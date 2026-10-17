// The observations backfill that ran as the deferred cleanup `backfill-glued-ascii-runs` (d366)
// segmented every observation in ONE transaction on the first open after the update: about 1 s of
// a 1.84 s first open at 50,000 observations, linear in the store (D#395), so a 5 s hook opening a
// large store first was killed with nothing committed, and the next one started over. Two openers
// that both found the marker unset read their rows outside the transaction and both appended
// (CLI pre-tag review 2026-10-16 P3-1: 8334 of 8334 rows doubled with three openers). And it
// appended only the glued ASCII runs, while the writers before the D#374 write-side fix built CJK
// bigrams from title + narrative only, so CJK in lesson_learned / facts / concepts /
// search_aliases stayed unreachable by a substring.
//
// The pass is now `backfill-cjk-index-terms`: every term of cjkIndexTerms(doc) no column of the
// row already carries as a standalone token, newest rows first, segmented row by row within a
// per-open budget and written batch by batch with a persistent cursor, each batch re-checking the
// cursor and its rows inside its write transaction. A new name, so a store that finished the old
// cleanup runs the wider one.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A pass-through, except that a test can run something just before the backfill segments its
// `at`-th row (another opener), can make each row take `delayMs`, and can throw at row `throwAt`.
const race = vi.hoisted(() => ({ calls: 0, at: 0, hook: null, delayMs: 0, throwAt: 0 }));
vi.mock('../nlp.mjs', async (importOriginal) => {
  const real = await importOriginal();
  const wrap = (fn) => (text) => {
    race.calls++;
    if (race.throwAt && race.calls === race.throwAt) throw new Error('simulated kill mid-batch');
    if (race.hook && race.calls === race.at) {
      const hook = race.hook;
      race.hook = null;
      hook();
    }
    if (race.delayMs) {
      const until = performance.now() + race.delayMs;
      while (performance.now() < until);
    }
    return fn(text);
  };
  // The segmentation each tree's pass calls per row: gluedAsciiRuns before, missingCjkIndexTerms now.
  return {
    ...real,
    ...(real.gluedAsciiRuns ? { gluedAsciiRuns: wrap(real.gluedAsciiRuns) } : {}),
    ...(real.missingCjkIndexTerms ? { missingCjkIndexTerms: wrap(real.missingCjkIndexTerms) } : {}),
  };
});

import { initSchema, runDeferredCleanups } from '../schema.mjs';
import { cjkBigrams, cjkIndexTerms } from '../nlp.mjs';
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

const P = 'parent--index-terms';
const CLEANUP = 'backfill-cjk-index-terms';
let db;
let other;
let dir;
afterEach(() => {
  for (const d of [db, other]) {
    try {
      d?.close();
    } catch {
      /* already closed */
    }
  }
  db = other = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  Object.assign(race, { calls: 0, at: 0, hook: null, delayMs: 0, throwAt: 0 });
});

function fileStore() {
  dir = mkdtempSync(join(tmpdir(), 'index-terms-'));
  const path = join(dir, 'claude-mem-lite.db');
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return path;
}

function memStore() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

/**
 * An observation as the writers before d366 / D#374 stored it: `text` carries the content plus
 * the CJK bigrams of title + narrative, no glued runs, nothing of lesson_learned.
 */
function insertLegacy(d, { title, narrative = '', lesson = null }) {
  d.prepare(
    `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES ('s-old', 's-old', ?, ?, ?, 'completed')`,
  ).run(P, new Date().toISOString(), Date.now());
  const content = `${title} ${narrative}`.trim();
  const text = [content, cjkBigrams(content)].filter(Boolean).join(' ');
  return Number(
    d
      .prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, lesson_learned, created_at, created_at_epoch, importance)
         VALUES ('s-old', ?, ?, 'bugfix', ?, ?, ?, ?, ?, 2)`,
      )
      .run(P, text, title, narrative, lesson, new Date().toISOString(), Date.now()).lastInsertRowid,
  );
}

/** `n` legacy rows, each with a glued run of its own (`modN`) and a CJK lesson. */
function insertMany(d, n) {
  const ids = [];
  for (let i = 0; i < n; i++)
    ids.push(insertLegacy(d, { title: `修复了mod${i}连接池泄漏`, lesson: `缓存键缺少租户前缀${i}` }));
  return ids;
}

const marked = (d) => !!d.prepare('SELECT 1 FROM migration_cleanups WHERE name = ?').get(CLEANUP);
const textOf = (d, id) => d.prepare('SELECT text FROM observations WHERE id = ?').get(id).text;
const countTok = (text, tok) => text.split(' ').filter((t) => t === tok).length;
/** Rows whose own glued run stands alone in `text` exactly once / more than once. */
function runCounts(d, ids) {
  let once = 0;
  let more = 0;
  ids.forEach((id, i) => {
    const n = countTok(textOf(d, id), `mod${i}`);
    if (n === 1) once++;
    if (n > 1) more++;
  });
  return { once, more };
}

async function obsHits(d, query) {
  const res = await coreRunSearchPipeline(
    {
      db: d,
      currentProject: P,
      env: {},
      searchObservationsHybrid,
      deepSearch: async () => ({ rows: [] }),
      shouldEscalateToDeep: () => false,
      autoDeepLlmReady: () => false,
      reRankWithContext: async (rows) => rows,
      llm: null,
    },
    {
      query,
      ftsQuery: buildSearchFtsQuery(query),
      effectiveSource: 'observations',
      deepMode: 'normal',
      rerank: false,
      limit: 10,
      offset: 0,
      project: P,
      obsType: null,
      sort: 'relevance',
      obsTypeScoped: false,
      obsTypeFallback: false,
      crossSourceEpochSortNoFts: false,
      rerankPolicy: 'cli',
      rerankProject: P,
      recentListingNoFts: false,
      tolerateMissingFts: false,
      tierPosition: 'early',
      tierProject: P,
    },
  );
  return res.page.filter((r) => r.source === 'obs').map((r) => r.id);
}

describe('missingCjkIndexTerms', () => {
  it('returns the index terms the text lacks as standalone tokens, and nothing on a re-run', async () => {
    const { missingCjkIndexTerms } = await import('../nlp.mjs');
    const title = '修复了redis连接池泄漏';
    const text = `${title} ${title} ${cjkBigrams(title)} 缓存键缺少租户前缀`;
    const missing = missingCjkIndexTerms(text).split(' ');
    expect(missing).toContain('redis');
    expect(missing).toContain('租户');
    for (const bg of cjkBigrams(title).split(' ')) expect(missing).not.toContain(bg);
    // The same set as segmenting the whole text, repeated tokens and all.
    const standalone = new Set(text.match(/[\p{L}\p{N}\p{Co}_-]+/gu).map((t) => t.toLowerCase()));
    const naive = cjkIndexTerms(text)
      .split(' ')
      .filter((t) => !standalone.has(t.toLowerCase()));
    expect(new Set(missing)).toEqual(new Set(naive));
    expect(missingCjkIndexTerms(`${text} ${missing.join(' ')}`)).toBe('');
    expect(missingCjkIndexTerms('redis pool drained under load')).toBe('');
  });
});

describe('the observations index-terms backfill (D#374 widening)', () => {
  it('a row whose only CJK is in lesson_learned is found by a 2-character substring after it', async () => {
    memStore();
    const id = insertLegacy(db, { title: 'tenant cache key collision', lesson: '缓存键缺少租户前缀' });
    insertLegacy(db, { title: 'unrelated pool leak', lesson: 'release the client in finally' });
    expect(
      cjkIndexTerms('缓存键缺少租户前缀').split(' '),
      'premise: the query term is an index term',
    ).toContain('租户');
    expect(await obsHits(db, '租户'), 'the gap, before the pass').toEqual([]);
    runDeferredCleanups(db);
    expect(await obsHits(db, '租户')).toEqual([id]);
  });

  it('runs on a store that finished backfill-glued-ascii-runs', async () => {
    memStore();
    const id = insertLegacy(db, { title: 'tenant cache key collision', lesson: '缓存键缺少租户前缀' });
    // A 6.28.x store: the glued-runs cleanup is marked done.
    db.prepare(
      `INSERT OR IGNORE INTO migration_cleanups (name, done_at_epoch) VALUES ('backfill-glued-ascii-runs', 1)`,
    ).run();
    runDeferredCleanups(db);
    expect(await obsHits(db, '租户')).toEqual([id]);
    expect(marked(db)).toBe(true);
  });

  it('appends each missing term once, and a forced re-run appends nothing', () => {
    memStore();
    const content = '修复了redis连接池泄漏';
    const id = insertLegacy(db, { title: content, lesson: '缓存键缺少租户前缀' });
    runDeferredCleanups(db);
    const once = textOf(db, id);
    expect(countTok(once, 'redis')).toBe(1);
    expect(countTok(once, '租户')).toBe(1);
    // Bigrams the legacy writer already appended are not appended again.
    for (const bg of cjkBigrams(content).split(' ')) expect(countTok(once, bg)).toBe(1);
    db.prepare('DELETE FROM migration_cleanups WHERE name = ?').run(CLEANUP);
    db.prepare(`DELETE FROM migration_cursors`).run();
    runDeferredCleanups(db);
    expect(textOf(db, id)).toBe(once);
  });
});

describe('bounded and resumable across opens (D#395)', () => {
  it('one open stops at its budget with the marker unset, and later opens finish it', () => {
    memStore();
    const ids = insertMany(db, 20);
    race.delayMs = 100; // a long row: 100 ms each, against the 250 ms budget
    const t0 = performance.now();
    runDeferredCleanups(db);
    const ms = performance.now() - t0;
    expect(ms, 'one open is bounded by the budget, not by the store').toBeLessThan(1000);
    expect(marked(db)).toBe(false);
    const first = runCounts(db, ids);
    expect(first.once).toBeGreaterThanOrEqual(1);
    expect(first.once).toBeLessThan(ids.length);
    race.delayMs = 0;
    let opens = 0;
    while (!marked(db) && opens < 20) {
      runDeferredCleanups(db);
      opens++;
    }
    expect(marked(db)).toBe(true);
    expect(runCounts(db, ids)).toEqual({ once: ids.length, more: 0 });
  });

  it('a process killed mid-batch keeps every batch it committed before', () => {
    memStore();
    const ids = insertMany(db, 600);
    race.throwAt = 400; // a kill while the second batch of 250 is being segmented
    runDeferredCleanups(db);
    expect(race.calls, 'premise: the pass reached the kill').toBe(400);
    expect(marked(db)).toBe(false);
    expect(runCounts(db, ids)).toEqual({ once: 250, more: 0 });
    // The next open resumes below the committed batch instead of starting over.
    race.calls = 0;
    race.throwAt = 0;
    runDeferredCleanups(db);
    expect(race.calls, 'the resumed open segments only the rows left').toBe(350);
    expect(runCounts(db, ids)).toEqual({ once: 600, more: 0 });
    expect(marked(db)).toBe(true);
  });
});

describe('two openers at once (P3-1)', () => {
  it('a batch another opener committed meanwhile is not appended a second time', () => {
    const path = fileStore();
    const ids = insertMany(db, 10);
    let peerRan = false;
    // After this opener read its rows and before it wrote any of them, a second process runs the
    // whole pass (on the old code that is before its first append, which takes the lock). This
    // opener's rows take 100 ms each, so its budget cuts its batch at the third row.
    race.at = 1;
    race.delayMs = 100;
    race.hook = () => {
      race.delayMs = 0;
      other = new Database(path);
      other.pragma('busy_timeout = 2000');
      runDeferredCleanups(other);
      peerRan = runCounts(other, ids).once === ids.length;
      race.delayMs = 100;
    };
    runDeferredCleanups(db);
    expect(peerRan, 'premise: the peer filled every row while this opener held its batch').toBe(true);
    expect(runCounts(db, ids)).toEqual({ once: ids.length, more: 0 });
    // Its shorter batch did not move the walk back above the rows the peer finished.
    expect(db.prepare(`SELECT below_id FROM migration_cursors`).get().below_id).toBe(Math.min(...ids));
  });
});

describe('rows changed between the read and the write', () => {
  it('a row another writer rewrote meanwhile is segmented again, so its terms are not doubled', () => {
    memStore();
    const ids = insertMany(db, 5);
    race.at = 1;
    race.hook = () => {
      // The current writers append every index term, as a re-enrich rewriting the row would.
      const r = db.prepare('SELECT title, lesson_learned FROM observations WHERE id = ?').get(ids[4]);
      const doc = `${r.title} ${r.lesson_learned}`;
      db.prepare('UPDATE observations SET text = ? WHERE id = ?').run(`${doc} ${cjkIndexTerms(doc)}`, ids[4]);
    };
    runDeferredCleanups(db);
    expect(race.hook, 'premise: the rewrite ran during the pass').toBeNull();
    expect(countTok(textOf(db, ids[4]), 'mod4')).toBe(1);
    expect(countTok(textOf(db, ids[4]), '租户')).toBe(1);
    expect(runCounts(db, ids)).toEqual({ once: 5, more: 0 });
  });

  it('a row deleted meanwhile is skipped and the rest of its batch is written', () => {
    memStore();
    const ids = insertMany(db, 5);
    race.at = 1;
    race.hook = () => db.prepare('DELETE FROM observations WHERE id = ?').run(ids[2]);
    runDeferredCleanups(db);
    expect(race.hook, 'premise: the delete ran during the pass').toBeNull();
    expect(marked(db)).toBe(true);
    for (const i of [0, 1, 3, 4]) expect(countTok(textOf(db, ids[i]), `mod${i}`)).toBe(1);
  });
});

describe("under another writer's lock", () => {
  it('returns at once with nothing appended, and restores the busy wait', async () => {
    const { backfillObservationIndexTerms } = await import('../schema.mjs');
    const path = fileStore();
    const ids = insertMany(db, 5);
    db.pragma('busy_timeout = 4321');
    const locker = new Database(path);
    locker.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      expect(backfillObservationIndexTerms(db, { budgetMs: 60_000 })).toEqual({ appended: 0, done: false });
      expect(Date.now() - t0).toBeLessThan(400);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    expect(db.pragma('busy_timeout', { simple: true })).toBe(4321);
    expect(runCounts(db, ids)).toEqual({ once: 0, more: 0 });
  });
});
