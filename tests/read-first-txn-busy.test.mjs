// A deferred transaction whose first statement is a SELECT takes a read lock, and its first
// write then fails at once with SQLITE_BUSY while another connection holds the write lock —
// busy_timeout does not apply to that upgrade. `.immediate()` takes the write lock at BEGIN,
// where it does (lib/delete-core.mjs and tests/delete-busy-snapshot.test.mjs, the same shape
// for the person-run writers). Triage 2026-10-20 measured the background writers below failing
// in 0-1 ms against a 1.5 s foreign lock: the episode worker then re-runs its LLM call later, or
// loses it if the 1 h sweep removes the flush file first.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  callModelJSONAsync: vi.fn(),
}));

const { callModelJSONAsync } = await import('../haiku-client.mjs');
const { persistHaikuSummary, retractPreSavedObs } = await import('../hook-llm.mjs');
const { resolveEdgeAttribution } = await import('../lib/edge-attribution.mjs');
const { executeMergeCluster, executeSmartCompressCluster } = await import('../hook-optimize.mjs');

const require = createRequire(import.meta.url);
const BETTER_SQLITE3 = require.resolve('better-sqlite3');
const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  callModelJSONAsync.mockReset();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-read-first-'));
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
  const started = Date.now();
  let error = null;
  let value;
  try {
    value = await fn();
  } catch (e) {
    error = e;
  }
  const waitedMs = Date.now() - started;
  await exited;
  return { error, value, waitedMs };
}

const count = (db, id) => db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id = ?').get(id).n;

describe('background writers that read first wait for another writer', () => {
  it('persistHaikuSummary upgrade-delete (episode worker)', async () => {
    const { dir, file, db } = fileDb();
    const pre = Number(insertObs(db, { sessionId: 's1', project: 'p', title: 'pre-saved' }).lastInsertRowid);
    const { error, value, waitedMs } = await underForeignWriter(dir, file, 1500, () =>
      persistHaikuSummary(
        db,
        { type: 'bugfix', title: 'event title', lesson_learned: 'a lesson' },
        { project: 'p', session_id: 's1', preSavedObsId: pre },
      ),
    );
    expect(error?.code ?? null).toBeNull();
    expect(waitedMs, 'premise: it ran while the lock was held').toBeGreaterThan(500);
    expect(value.table).toBe('events');
    expect(count(db, pre)).toBe(0);
    db.close();
  }, 20000);

  it('retractPreSavedObs on its own (low-yield drop)', async () => {
    const { dir, file, db } = fileDb();
    const pre = Number(insertObs(db, { sessionId: 's1', project: 'p', title: 'pre-saved' }).lastInsertRowid);
    const { error, value } = await underForeignWriter(dir, file, 1500, () =>
      retractPreSavedObs(db, pre, 'test'),
    );
    expect(error?.code ?? null).toBeNull();
    expect(value).toBe(true);
    expect(count(db, pre)).toBe(0);
    db.close();
  }, 20000);

  it('resolveEdgeAttribution (Stop)', async () => {
    const { dir, file, db } = fileDb();
    const id = Number(
      insertObs(db, { sessionId: 's1', project: 'p', title: 'edge row', filesModified: '["src/a.mjs"]' })
        .lastInsertRowid,
    );
    const { error, value } = await underForeignWriter(dir, file, 1500, () =>
      resolveEdgeAttribution(db, 'p', [{ filePath: 'src/a.mjs', obsIds: [id] }], new Set([id]), 'sess-x'),
    );
    expect(error?.code ?? null).toBeNull();
    expect(value.hits).toBe(1);
    db.close();
  }, 20000);

  it('executeMergeCluster (daily cluster merge)', async () => {
    const { dir, file, db } = fileDb();
    const a = Number(
      insertObs(db, { sessionId: 's1', project: 'p', title: 'redis pool timeout' }).lastInsertRowid,
    );
    const b = Number(
      insertObs(db, { sessionId: 's1', project: 'p', title: 'redis pool timeouts' }).lastInsertRowid,
    );
    const cluster = db.prepare('SELECT * FROM observations WHERE id IN (?, ?)').all(a, b);
    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'Redis pool timeouts',
      merged_narrative: 'Merged narrative.',
      merged_concepts: ['redis'],
      merged_facts: [],
      merged_lesson: null,
      importance: 1,
    });
    const { error, value } = await underForeignWriter(dir, file, 1500, () =>
      executeMergeCluster(db, cluster),
    );
    expect(error?.code ?? null).toBeNull();
    expect(value.merged).toBe(true);
    db.close();
  }, 20000);

  it('executeSmartCompressCluster (daily smart compress)', async () => {
    const { dir, file, db } = fileDb();
    const ids = ['one', 'two', 'three'].map((t) =>
      Number(insertObs(db, { sessionId: 's1', project: 'p', title: `compress ${t}` }).lastInsertRowid),
    );
    const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${ids.join(',')})`).all();
    callModelJSONAsync.mockResolvedValue({
      should_compress: true,
      title: 'Compressed summary',
      narrative: 'Summary narrative.',
      concepts: ['compress'],
      facts: [],
      lesson_learned: 'none',
    });
    const { error, value } = await underForeignWriter(dir, file, 1500, () =>
      executeSmartCompressCluster(db, rows, 'p'),
    );
    expect(error?.code ?? null).toBeNull();
    expect(value.compressed).toBe(true);
    db.close();
  }, 20000);
});
