// `delete --confirm` right after a save failed now and then with "busy past the 5s timeout" in
// under 150 ms (E2E 2026-10-16 round 2, data N1). deleteObservations ran a DEFERRED
// transaction that starts with a SELECT: when another connection held the write lock at that
// moment (the save's background enrich worker), the read could not be upgraded to a write,
// and SQLite returns SQLITE_BUSY at once instead of calling the busy handler, since waiting
// could deadlock. BEGIN IMMEDIATE takes the write lock first, so busy_timeout applies.
// MCP mem_delete runs the same function. Swept for the same shape: activity promote --execute
// and activity delete, run under the same writer, already succeeded before the change, so
// they are left as they are.
//
// The other writer is a separate process holding BEGIN IMMEDIATE: a second connection in this
// process could not release its lock while the call under test blocks the thread.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { deleteObservations } from '../lib/delete-core.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

const require = createRequire(import.meta.url);
const BETTER_SQLITE3 = require.resolve('better-sqlite3');
const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-busy-snap-'));
  dirs.push(dir);
  const file = join(dir, 'claude-mem-lite.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  insertSession(db, { id: 's1', project: 'p' });
  insertObs(db, { sessionId: 's1', project: 'p', title: 'other row' });
  return { dir, file, db };
}

/** Run `fn` while another process holds the write lock for `holdMs`, then commits. */
async function underForeignWriter(dir, file, holdMs, fn) {
  const ready = join(dir, 'writer-ready');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${JSON.stringify(BETTER_SQLITE3)});
       const d = new D(${JSON.stringify(file)});
       d.pragma('busy_timeout = 5000');
       d.exec('BEGIN IMMEDIATE');
       d.exec("UPDATE observations SET importance = 2 WHERE title = 'other row'");
       require('fs').writeFileSync(${JSON.stringify(ready)}, '1');
       const end = Date.now() + ${holdMs}; while (Date.now() < end) {}
       d.exec('COMMIT'); d.close();`,
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((r) => child.on('exit', r));
  const deadline = Date.now() + 10000;
  while (!existsSync(ready) && Date.now() < deadline) await sleep(5);
  expect(existsSync(ready), 'premise: the other writer holds the lock').toBe(true);
  let error = null;
  let value;
  try {
    value = await fn();
  } catch (e) {
    error = e;
  }
  await exited;
  return { error, value };
}

describe('delete waits for another writer instead of failing at once', () => {
  it('deleteObservations', async () => {
    const { dir, file, db } = fileDb();
    const id = Number(insertObs(db, { sessionId: 's1', project: 'p', title: 'doomed row' }).lastInsertRowid);
    const { error } = await underForeignWriter(dir, file, 300, () =>
      deleteObservations(db, [id], { snapshotTag: 'test' }),
    );
    expect(error?.code ?? null).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id = ?').get(id).n).toBe(0);
    db.close();
  }, 20000);
});
