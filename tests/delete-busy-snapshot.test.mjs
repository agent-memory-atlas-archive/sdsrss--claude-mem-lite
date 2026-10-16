// `delete --confirm` right after a save failed now and then with "busy past the 5s timeout" in
// under 150 ms (E2E 2026-10-16 round 2, data N1). deleteObservations ran a DEFERRED
// transaction that starts with a SELECT: when another connection held the write lock at that
// moment (the save's background enrich worker), the read could not be upgraded to a write,
// and SQLite returns SQLITE_BUSY at once instead of calling the busy handler, since waiting
// could deadlock. BEGIN IMMEDIATE takes the write lock first, so busy_timeout applies.
// MCP mem_delete runs the same function. The sweep for the same shape is the describe block
// at the end.
//
// The other writer is a separate process holding BEGIN IMMEDIATE: a second connection in this
// process could not release its lock while the call under test blocks the thread.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { deleteObservations } from '../lib/delete-core.mjs';
import { runMaintainOps, STALE_AGE_MS } from '../lib/maintain-core.mjs';
import { cmdActivity } from '../cli/activity.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

const require = createRequire(import.meta.url);
const BETTER_SQLITE3 = require.resolve('better-sqlite3');
const CLI = resolve(import.meta.dirname, '../cli.mjs');
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
       d.exec("UPDATE observations SET title = title WHERE title = 'other row'");
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

// E2E 2026-10-16 round 3 (data NEW-1): the same deferred-transaction shape sat in three more
// person-run writers — update (CLI and mem_update), maintain execute (CLI and mem_maintain) and
// activity delete — each failing in < 100 ms with "busy past the 5s timeout" while a hook wrote.
// (Round 2's sweep line said activity delete already waited; a held lock shows it did not.)
describe('the other person-run writers wait too', () => {
  // Through the CLI: called in-process on a fresh connection the same update waited, so only the
  // real command shows the failure (measured: rc=1 in 81 ms with --title, rc=0 after 2 s with
  // --importance alone).
  it('update --title (applyObsUpdate, shared with mem_update)', async () => {
    const { dir, file, db } = fileDb();
    const id = Number(insertObs(db, { sessionId: 's1', project: 'p', title: 'old title' }).lastInsertRowid);
    db.close();
    mkdirSync(join(dir, 'w', 'p'), { recursive: true });
    const env = {
      ...process.env,
      CLAUDE_MEM_DIR: dir,
      CLAUDE_PROJECT_DIR: join(dir, 'w', 'p'),
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_CODE_PATH: join(dir, 'no-claude'),
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENROUTER_API_KEY;
    // A CLI save first: on a store only the helpers wrote, the same update waited (measured);
    // after one save through the CLI it failed in ~80 ms, as in real use.
    expect(
      spawnSync(process.execPath, [CLI, 'save', 'a row saved through the CLI', '--force'], { env }).status,
    ).toBe(0);
    const { value: r } = await underForeignWriter(dir, file, 1500, () =>
      spawnSync(process.execPath, [CLI, 'update', String(id), '--title', 'new title'], {
        env,
        encoding: 'utf8',
      }),
    );
    expect(r.status, r.stderr).toBe(0);
    const check = new Database(file, { readonly: true });
    expect(check.prepare('SELECT title FROM observations WHERE id = ?').get(id).title).toBe('new title');
    check.close();
  }, 20000);

  it('runMaintainOps (maintain execute / mem_maintain execute)', async () => {
    const { dir, file, db } = fileDb();
    const ctx = { projectFilter: '', baseParams: [], staleAge: Date.now() - STALE_AGE_MS, opCap: 1000 };
    const { error } = await underForeignWriter(dir, file, 300, () =>
      runMaintainOps(db, ctx, ['cleanup', 'decay'], {
        retainCutoff: Date.now() - 30 * 86400000,
        renderPurgePreview: () => '',
      }),
    );
    expect(error?.code ?? null).toBeNull();
    db.close();
  }, 20000);

  it('activity delete --confirm', async () => {
    const { dir, file, db } = fileDb();
    db.prepare(
      `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
       VALUES ('p', 'bug', 'Cron overlap', 'use flock', 2, ?)`,
    ).run(Date.now());
    const prevCode = process.exitCode;
    const write = process.stdout.write;
    process.stdout.write = () => true;
    let code;
    try {
      const { error } = await underForeignWriter(dir, file, 300, () =>
        cmdActivity(db, ['delete', '1', '--confirm']),
      );
      expect(error?.code ?? null).toBeNull();
      code = process.exitCode;
    } finally {
      process.stdout.write = write;
      process.exitCode = prevCode;
    }
    expect(code ?? 0).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get().n).toBe(0);
    db.close();
  }, 20000);
});
