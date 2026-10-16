// E2E 2026-10-16 hooks F9: a write lock held past 5 s got UserPromptSubmit killed. The hooks'
// connections waited DB_BUSY_TIMEOUT_MS = 5000 for the lock, the same 5 s the host gives
// user-prompt / stop / post-tool-failure in hooks.json, so the wait never failed inside the
// hook: the host killed it first, the prompt was lost and no context reached the model. A long
// `maintain --ops vacuum`, `fts-check rebuild`, import or restore holds that lock.
//
// Repro shape from the report: another process holds BEGIN IMMEDIATE for 8 s while the hook runs
// under the host's own timeout.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_TIMEOUT_MS = 5000; // hooks.json: user-prompt, stop, post-tool-failure, pre-compact
const UPS_TIMEOUT_MS = 2000; // hooks.json: scripts/user-prompt-search.js
const LOCK_MS = 8000;
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

let home, projectDir, dbPath, env;

beforeAll(() => {
  const root = fixtures.track(join(tmpdir(), `mem-dbbusy-${randomUUID().slice(0, 8)}`));
  home = join(root, 'home');
  projectDir = join(root, 'work', 'invoice-app');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(
    join(projectDir, 'src/invoice.js'),
    'export const total = (l) => l.reduce((a, x) => a + x, 0);\n',
  );
  dbPath = join(home, '.claude-mem-lite', 'claude-mem-lite.db');
  env = {
    ...process.env,
    HOME: home,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PID: String(process.pid),
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_SUMMARY: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  hook('session-start', { source: 'startup' }, 20000);
  // A lesson the prompt below finds, so "context still reaches the model" has something to show.
  const saved = spawnSync(
    process.execPath,
    [
      join(REPO, 'cli.mjs'),
      'save',
      '--type',
      'bugfix',
      '--importance',
      '2',
      '--title',
      'invoice totals reduce crashed on undefined lines',
      '--lesson',
      'Default invoice lines to an empty array before reduce so totals never crash',
      'The invoice totals reduce threw a TypeError when lines was undefined.',
    ],
    { env, cwd: projectDir, encoding: 'utf8' },
  );
  expect(saved.status, saved.stderr).toBe(0);
});

function hook(event, payload, timeout = HOST_TIMEOUT_MS) {
  const t0 = Date.now();
  // `ups` is UserPromptSubmit's other command, scripts/user-prompt-search.js (2 s in hooks.json).
  const argv =
    event === 'ups' ? [join(REPO, 'scripts/user-prompt-search.js')] : [join(REPO, 'hook.mjs'), event];
  const r = spawnSync(process.execPath, argv, {
    input: JSON.stringify({ session_id: 'cc-busy', cwd: projectDir, hook_event_name: event, ...payload }),
    env,
    cwd: projectDir,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  return { ...r, ms: Date.now() - t0 };
}

/** Another process holding the write lock, as a long maintain/import/restore would. */
function holdWriteLock() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3');
         const db = new D(${JSON.stringify(dbPath)});
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${LOCK_MS});`,
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

async function underLock(fn) {
  const locker = await holdWriteLock();
  try {
    return fn();
  } finally {
    locker.kill('SIGKILL');
    await new Promise((r) => locker.once('exit', r));
  }
}

const PROMPT = 'invoice totals reduce crashed again on undefined lines';

describe('a hook under a write lock held past its host timeout', () => {
  it('without a lock, the prompt finds the lesson (premise)', () => {
    const r = hook('user-prompt', { session_id: 'cc-premise', prompt: PROMPT });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Default invoice lines to an empty array');
  });

  it('UserPromptSubmit exits inside its timeout and still injects the memory it found', async () => {
    const r = await underLock(() => hook('user-prompt', { prompt: PROMPT }));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(HOST_TIMEOUT_MS);
    expect(r.stdout).toContain('Default invoice lines to an empty array');
  });

  it('the 2 s prompt search exits inside its timeout and still injects', async () => {
    // Premise first, without a lock: this session's prompt finds the lesson on this face too.
    const free = hook('ups', { session_id: 'cc-ups-premise', prompt: PROMPT }, UPS_TIMEOUT_MS);
    expect(free.stdout).toContain('Default invoice lines to an empty array');
    // Its per-row injection_count bumps waited 5 s each under the lock.
    const r = await underLock(() => hook('ups', { session_id: 'cc-ups', prompt: PROMPT }, UPS_TIMEOUT_MS));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(UPS_TIMEOUT_MS);
    expect(r.stdout).toContain('Default invoice lines to an empty array');
  });

  it('Stop exits inside its timeout', async () => {
    const r = await underLock(() => hook('stop', {}));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(HOST_TIMEOUT_MS);
  });

  it('without a lock, the prompt is stored as before (premise)', () => {
    const r = hook('user-prompt', { prompt: 'second prompt without any lock held' });
    expect(r.status).toBe(0);
    const q = spawnSync(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3'); const db = new D(${JSON.stringify(dbPath)}, { readonly: true });
         process.stdout.write(JSON.stringify(db.prepare('SELECT prompt_text FROM user_prompts').all().map((r) => r.prompt_text)));`,
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(JSON.parse(q.stdout)).toContain('second prompt without any lock held');
  });
});
