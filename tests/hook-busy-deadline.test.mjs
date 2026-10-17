// D#394: a hook's lock waits were bounded by one deadline only where openDb handed a connection
// out (setHookDbDeadline set busy_timeout once, to the time left). Two waits stayed outside it
// (round-2 review 2026-10-16): ensureDb's own statements, a first open's migration and a pending
// one-shot cleanup among them, waited DB_BUSY_TIMEOUT_MS before openDb set anything; and
// busy_timeout applies per statement, so a statement meeting a lock after another one on the same
// connection had waited could wait the whole handed-out value again (demo: +6888 ms against a
// 3500 ms deadline, in a hook the host kills at 5 s). Every statement on a connection ensureDb
// opens in such a process now waits at most the time left until the deadline.
//
// This file MUST set CLAUDE_MEM_DIR and dynamic-import before anything binds DB_DIR, so every
// open below is of a sandbox store and never the user's.

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'mem-busy-deadline-'));
process.env.CLAUDE_MEM_DIR = tmp;
const { openDb, setHookDbDeadline } = await import('../hook-shared.mjs');
const { ensureDb } = await import('../schema.mjs');
const { DB_BUSY_TIMEOUT_MS } = await import('../lib/time-constants.mjs');
const DB_PATH = join(tmp, 'claude-mem-lite.db');

const lockers = [];
afterEach(async () => {
  setHookDbDeadline(null);
  for (const c of lockers.splice(0)) {
    c.kill('SIGKILL');
    await new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', r)));
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const now = () => performance.timeOrigin + performance.now();

/**
 * Another process holding the write lock: for `firstMs`, then, once the row `first` is in
 * busy_probe (the statement under test got the lock and committed), again for `againMs`.
 * Resolves a reader of the lines it prints: locked, released, relocked.
 */
function locker({ firstMs, againMs = 0 }) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require('better-sqlite3');
       const db = new D(${JSON.stringify(DB_PATH)});
       db.pragma('busy_timeout = 10000');
       const say = (s) => process.stdout.write(s + '\\n');
       db.exec('BEGIN IMMEDIATE');
       say('locked');
       setTimeout(() => {
         db.exec('ROLLBACK');
         say('released');
         if (!${againMs}) return;
         const poll = setInterval(() => {
           if (!db.prepare("SELECT 1 FROM busy_probe WHERE k = 'first'").get()) return;
           clearInterval(poll);
           db.exec('BEGIN IMMEDIATE');
           say('relocked');
           setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${againMs});
         }, 5);
       }, ${firstMs});`,
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  lockers.push(child);
  const seen = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      seen.push(line);
      for (const w of waiters.splice(0)) w();
    }
  });
  const until = (line) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (seen.includes(line)) return resolve();
        if (child.exitCode !== null) return reject(new Error(`locker exited before "${line}"`));
        waiters.push(check);
      };
      check();
    });
  const kill = () => child.kill('SIGKILL');
  return { until, seen, kill };
}

function store() {
  const db = ensureDb(); // the first open, without any lock: migration and cleanups done
  db.exec(`CREATE TABLE IF NOT EXISTS busy_probe (k TEXT)`);
  db.exec(`DELETE FROM busy_probe`);
  db.close();
}

describe('a hook deadline bounds every statement of the connection (D#394)', () => {
  // Each way a statement runs on the connection: a prepared statement, exec, and an IMMEDIATE
  // transaction, whose BEGIN better-sqlite3 prepares out of reach of db.prepare.
  it.each([
    ['a prepared statement', (db) => db.prepare(`INSERT INTO busy_probe (k) VALUES ('second')`).run()],
    ['exec', (db) => db.exec(`INSERT INTO busy_probe (k) VALUES ('second')`)],
    [
      'an IMMEDIATE transaction',
      (db) =>
        db.transaction(() => db.prepare(`INSERT INTO busy_probe (k) VALUES ('second')`).run()).immediate(),
    ],
  ])('%s meeting a second lock after a first statement waited gets only the time left', async (_, second) => {
    store();
    const lock = locker({ firstMs: 500, againMs: 5000 });
    await lock.until('locked');
    const budget = 1500;
    const t0 = now();
    setHookDbDeadline(t0 + budget);
    const db = openDb();
    expect(db, 'premise: the open itself does not need the lock').not.toBeNull();
    try {
      db.prepare(`INSERT INTO busy_probe (k) VALUES ('first')`).run();
      const firstMs = now() - t0;
      expect(firstMs, 'premise: the first statement met the lock and waited for it').toBeGreaterThan(300);
      await lock.until('relocked');
      let err = null;
      try {
        second(db);
      } catch (e) {
        err = e;
      }
      const total = now() - t0;
      expect(err?.code, 'premise: the second statement met the second lock').toBe('SQLITE_BUSY');
      expect(total, `total ${Math.round(total)} ms against a ${budget} ms deadline`).toBeLessThan(
        budget + 250,
      );
    } finally {
      db.close();
    }
  });

  it("ensureDb's own statements (a pending one-shot cleanup) wait only until the deadline", async () => {
    store();
    const seed = ensureDb();
    seed.prepare(`DELETE FROM migration_cleanups WHERE name = 'orphan-observation-files'`).run();
    seed.close();
    const lock = locker({ firstMs: 6000 });
    await lock.until('locked');
    const budget = 1200;
    const t0 = now();
    setHookDbDeadline(t0 + budget);
    const db = openDb();
    const total = now() - t0;
    db?.close();
    expect(lock.seen, 'premise: the lock was held throughout the open').not.toContain('released');
    expect(total, `open took ${Math.round(total)} ms against a ${budget} ms deadline`).toBeLessThan(
      budget + 400,
    );
    // The cleanup that met the lock is left for the next open.
    const ro = new Database(DB_PATH, { readonly: true });
    expect(
      ro.prepare(`SELECT 1 FROM migration_cleanups WHERE name = 'orphan-observation-files'`).get(),
    ).toBeUndefined();
    ro.close();
  });

  it("a first open's migration waits for the lock only until the deadline", async () => {
    store();
    // Back to the 4-column events_fts of v6.27.0: the version fast path's sentinel is missing, so
    // the open runs the migration pass, which starts with BEGIN IMMEDIATE.
    const seed = ensureDb();
    seed.exec(`DROP TRIGGER IF EXISTS events_fts_ai; DROP TRIGGER IF EXISTS events_fts_ad;
      DROP TRIGGER IF EXISTS events_fts_au; DROP TABLE IF EXISTS events_fts;
      CREATE VIRTUAL TABLE events_fts USING fts5(title, body, event_type UNINDEXED, project UNINDEXED,
        content='events', content_rowid='id');`);
    seed.close();
    const lock = locker({ firstMs: 6000 });
    await lock.until('locked');
    const budget = 1200;
    const t0 = now();
    setHookDbDeadline(t0 + budget);
    const db = openDb();
    const total = now() - t0;
    db?.close();
    expect(db, 'the migration met the lock, so the open fails').toBeNull();
    expect(lock.seen, 'premise: the lock was held throughout the open').not.toContain('released');
    expect(total, `open took ${Math.round(total)} ms against a ${budget} ms deadline`).toBeLessThan(
      budget + 400,
    );
    lock.kill();
    setHookDbDeadline(null);
    const healed = ensureDb(); // and the next open migrates
    expect(
      healed.prepare(`SELECT 1 FROM pragma_table_info('events_fts') WHERE name = 'search_terms'`).get(),
    ).toBeTruthy();
    healed.close();
  });

  it('a busy_timeout the code sets to 0 stays 0 under the deadline (the backfills do not wait)', async () => {
    const { backfillObservationIndexTerms } = await import('../schema.mjs');
    store();
    const seed = ensureDb();
    seed
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
         VALUES ('s0', 's0', 'p--x', ?, ?, 'completed')`,
      )
      .run(new Date().toISOString(), Date.now());
    seed
      .prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
         VALUES ('s0', 'p--x', '', 'bugfix', '修复了redis连接池泄漏', ?, ?)`,
      )
      .run(new Date().toISOString(), Date.now());
    seed.close();
    setHookDbDeadline(now() + 3000);
    const db = openDb(); // the pass is marked done on this store, so the open walks nothing
    const lock = locker({ firstMs: 6000 });
    await lock.until('locked');
    try {
      const t0 = now();
      expect(backfillObservationIndexTerms(db, { budgetMs: 60_000 })).toEqual({ appended: 0, done: false });
      expect(now() - t0).toBeLessThan(400);
    } finally {
      db.close();
    }
  });

  it('without a deadline (MCP server, CLI, workers) the connection is as before', () => {
    store();
    setHookDbDeadline(null);
    const db = ensureDb();
    try {
      expect(db.pragma('busy_timeout', { simple: true })).toBe(DB_BUSY_TIMEOUT_MS);
      for (const m of ['prepare', 'exec', 'pragma', 'transaction']) expect(Object.hasOwn(db, m)).toBe(false);
    } finally {
      db.close();
    }
  });
});
