// D#394 follow-up / D#398 (2): the two hook scripts that open the database themselves, not through
// hook-shared's openDb, had no deadline, so a first open's migration under another writer's lock
// waited DB_BUSY_TIMEOUT_MS (5 s): past the host's kill for the prompt search (2 s) and at it for
// the opt-in Agent injection (5 s). Each now sets one before its first open.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../schema.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let root, dbPath, projectDir, env, locker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-script-deadline-'));
  const dataDir = join(root, 'data');
  projectDir = join(root, 'work', 'invoice-app');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  dbPath = join(dataDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  // Back to v6.27.0's 4-column events_fts: the version fast path's sentinel is missing, so the
  // next open runs the migration pass, which starts with BEGIN IMMEDIATE.
  db.exec(`DROP TRIGGER IF EXISTS events_fts_ai; DROP TRIGGER IF EXISTS events_fts_ad;
    DROP TRIGGER IF EXISTS events_fts_au; DROP TABLE IF EXISTS events_fts;
    CREATE VIRTUAL TABLE events_fts USING fts5(title, body, event_type UNINDEXED, project UNINDEXED,
      content='events', content_rowid='id');`);
  db.close();
  env = {
    ...process.env,
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_MEM_SKIP_UPDATE: '1',
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_CODE_PATH: '/nonexistent',
  };
  for (const k of ['CLAUDE_MEM_HOOK_RUNNING', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete env[k];
});
afterEach(async () => {
  if (locker && locker.exitCode === null) {
    locker.kill('SIGKILL');
    await new Promise((r) => locker.once('exit', r));
  }
  rmSync(root, { recursive: true, force: true });
});

/** Another process holding the write lock for 8 s, as a long maintain or import would. */
function holdLock() {
  return new Promise((resolve, reject) => {
    locker = spawn(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3');
         const db = new D(${JSON.stringify(dbPath)});
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 8000);`,
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    locker.once('error', reject);
    locker.stdout.once('data', () => resolve());
  });
}

function run(script, payload, hostTimeoutMs, extraEnv = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(REPO, script)], {
    input: JSON.stringify({ session_id: 'cc-deadline', cwd: projectDir, ...payload }),
    env: { ...env, ...extraEnv },
    cwd: projectDir,
    encoding: 'utf8',
    timeout: hostTimeoutMs,
    killSignal: 'SIGKILL',
  });
  return { ...r, ms: Date.now() - t0 };
}

const eventsFtsMigrated = () => {
  const db = new Database(dbPath, { readonly: true });
  const has = db.prepare(`SELECT 1 FROM pragma_table_info('events_fts') WHERE name = 'search_terms'`).get();
  db.close();
  return Boolean(has);
};

describe('a hook script whose first open meets a migration under a held lock exits in time', () => {
  it('the prompt search (2 s in hooks.json)', async () => {
    await holdLock();
    const r = run(
      'scripts/user-prompt-search.js',
      { hook_event_name: 'UserPromptSubmit', prompt: 'why does the invoice total drift by a cent' },
      2000,
    );
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(eventsFtsMigrated(), 'premise: the migration could not run under the lock').toBe(false);
  });

  it('the opt-in Agent injection (5 s in hooks.json)', async () => {
    await holdLock();
    const r = run(
      'scripts/pre-agent-inject.js',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { prompt: 'fix the invoice total', subagent_type: 'general-purpose' },
      },
      5000,
      { CLAUDE_MEM_SUBAGENT_INJECT: '1' },
    );
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(4500);
    expect(eventsFtsMigrated(), 'premise: the migration could not run under the lock').toBe(false);
  });
});
