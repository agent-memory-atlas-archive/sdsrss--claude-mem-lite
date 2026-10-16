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
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeFixtureTracker } from './test-helpers.mjs';
import { DB_BUSY_TIMEOUT_MS, HOOK_DB_DEADLINE_MS, UPS_DB_BUSY_TIMEOUT_MS } from '../lib/time-constants.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_TIMEOUT_MS = 5000; // hooks.json: user-prompt, stop, post-tool-failure, pre-compact
const UPS_TIMEOUT_MS = 2000; // hooks.json: scripts/user-prompt-search.js
const SESSION_START_TIMEOUT_MS = 15000; // hooks.json: hook.mjs session-start
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
  // Lessons the prompt below finds, so "context still reaches the model" has something to show,
  // and more than one of them (D#382): each row a face injects is one more best-effort write
  // after the lock wait ran out, and with a single row the cut-off of the later waits could not
  // be told from waiting on each. The unrelated rows keep the matching terms rare enough to pass
  // the 2 s face's BM25 floor; with only the three invoice rows it injected none.
  for (const [title, lesson] of [...INVOICE_LESSONS, ...UNRELATED_LESSONS]) {
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
        title,
        '--lesson',
        lesson,
        `${title}: ${lesson}.`,
      ],
      { env, cwd: projectDir, encoding: 'utf8' },
    );
    expect(saved.status, saved.stderr).toBe(0);
  }
});

const INVOICE_LESSONS = [
  [
    'invoice totals reduce crashed on undefined lines',
    'Default invoice lines to an empty array before reduce so totals never crash',
  ],
  [
    'invoice totals reduce drifted on float lines',
    'Sum invoice lines in integer cents before reduce so totals never drift',
  ],
  [
    'invoice totals reduce skipped discount lines',
    'Filter invoice lines by kind before reduce so totals never skip discounts',
  ],
];
const UNRELATED_LESSONS = [
  [
    'docker compose network timed out on startup',
    'Raise the healthcheck interval so compose waits for the database',
  ],
  [
    'redis pool leaked connections under load',
    'Release redis clients in a finally block after every command',
  ],
  ['css grid overflowed on narrow screens', 'Use minmax with zero so grid tracks can shrink below content'],
  ['jwt refresh failed after expiry', 'Refresh the token before expiry with a sixty second margin'],
  ['kafka consumer lagged behind producers', 'Raise max poll records and commit offsets asynchronously'],
  ['postgres vacuum left table bloat', 'Schedule vacuum analyze nightly on the hot tables'],
];
/** How many of the invoice lessons a hook's output carries (the 2 s face cuts lessons, not titles). */
const injectedCount = (stdout) => INVOICE_LESSONS.filter(([title]) => stdout.includes(title)).length;

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
function holdWriteLock(lockMs = LOCK_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3');
         const db = new D(${JSON.stringify(dbPath)});
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${lockMs});`,
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

async function underLock(fn, lockMs) {
  const locker = await holdWriteLock(lockMs);
  try {
    return fn();
  } finally {
    locker.kill('SIGKILL');
    await new Promise((r) => locker.once('exit', r));
  }
}

const PROMPT = 'invoice totals reduce crashed again on undefined lines';

/** One row of a read-only query, from another process (the hooks hold no handle in this one). */
function queryRow(sql) {
  const q = spawnSync(
    process.execPath,
    [
      '-e',
      `const D = require('better-sqlite3'); const db = new D(${JSON.stringify(dbPath)}, { readonly: true });
       process.stdout.write(JSON.stringify(db.prepare(${JSON.stringify(sql)}).get()));`,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  return JSON.parse(q.stdout);
}

function promptTexts() {
  return JSON.parse(queryRow('SELECT json_group_array(prompt_text) AS t FROM user_prompts').t);
}

describe('a hook under a write lock held past its host timeout', () => {
  it('without a lock, the prompt finds the lessons (premise)', () => {
    const r = hook('user-prompt', { session_id: 'cc-premise', prompt: PROMPT });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Default invoice lines to an empty array');
    expect(injectedCount(r.stdout), 'premise: more than one row is injected').toBeGreaterThan(1);
  });

  it('UserPromptSubmit exits inside its timeout and still injects the memory it found', async () => {
    const r = await underLock(() => hook('user-prompt', { prompt: PROMPT }));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(HOST_TIMEOUT_MS);
    expect(r.stdout).toContain('Default invoice lines to an empty array');
    // One lock wait (the prompt row, until the deadline), and none for the writes behind each
    // injected row: they still had the connection's whole wait each, 3 x ~3.4 s past the host's 5 s.
    expect(injectedCount(r.stdout)).toBeGreaterThan(1);
    expect(r.ms).toBeLessThan(HOOK_DB_DEADLINE_MS + 1000);
  });

  it('the 2 s prompt search exits inside its timeout and still injects', async () => {
    // Premise first, without a lock: this session's prompt finds the lessons on this face too.
    const free = hook('ups', { session_id: 'cc-ups-premise', prompt: PROMPT }, UPS_TIMEOUT_MS);
    expect(free.stdout).toContain('invoice totals reduce crashed on undefined lines');
    expect(injectedCount(free.stdout), 'premise: more than one row is injected').toBeGreaterThan(1);
    // Its per-row injection_count bumps waited 5 s each under the lock; now the first bump that
    // runs out of its wait ends them, so the lock costs one wait however many rows were shown.
    const r = await underLock(() => hook('ups', { session_id: 'cc-ups', prompt: PROMPT }, UPS_TIMEOUT_MS));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(UPS_TIMEOUT_MS);
    expect(r.stdout).toContain('invoice totals reduce crashed on undefined lines');
    expect(injectedCount(r.stdout)).toBeGreaterThan(1);
    expect(r.ms).toBeLessThan(2 * UPS_DB_BUSY_TIMEOUT_MS);
  });

  // D#381: SessionStart keeps the 5 s wait (its host timeout is 15 s), but the first write that
  // ran out of it threw out of the whole handler: exit 0 with 0 B on stdout, so the session began
  // with no memory context at all. After a /clear it has two more writes to make (the ending
  // session's handoff and fast summary), and each one waiting 5 s in turn reaches the host's
  // 15 s; the lock outlasts two waits here, so a run that waited for each write, or for the lock
  // to clear, cannot pass the bound.
  it('SessionStart after a /clear still emits the memory context, after one lock wait', async () => {
    const free = hook('session-start', { session_id: 'cc-ss', source: 'startup' }, SESSION_START_TIMEOUT_MS);
    expect(free.status).toBe(0);
    expect(free.stdout, 'premise: SessionStart shows the lesson').toContain('invoice totals reduce');
    // Work in the session the /clear ends, so it has a handoff to write.
    hook('user-prompt', { session_id: 'cc-ss', prompt: PROMPT });
    hook('post-tool-use', {
      session_id: 'cc-ss',
      tool_name: 'Edit',
      tool_input: {
        file_path: join(projectDir, 'src/invoice.js'),
        old_string: 'l.reduce',
        new_string: '(l ?? []).reduce',
      },
      tool_response: { success: true },
    });
    hook('stop', { session_id: 'cc-ss' });
    const lockMs = 2 * DB_BUSY_TIMEOUT_MS + 2000;
    const r = await underLock(
      () => hook('session-start', { session_id: 'cc-ss', source: 'clear' }, SESSION_START_TIMEOUT_MS),
      lockMs,
    );
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('invoice totals reduce');
    expect(r.ms).toBeLessThan(1.5 * DB_BUSY_TIMEOUT_MS);
  });

  // Pre-tag review 2026-10-16 (P2): one 1.5 s wait per statement turned the kill under a long lock
  // into an exit, but under a lock of 1.5–4.5 s it lost writes v6.27.0 had waited out: the prompt
  // row (and with it the handoff phase), and Stop's handoff and summary spawn. The 5 s hooks now
  // wait until a deadline 3.5 s after their process started, spread over every connection.
  it('UserPromptSubmit under a 2.5 s lock records the prompt, as v6.27.0 did', async () => {
    const text = `${PROMPT}, asked while a short lock is held`;
    const r = await underLock(() => hook('user-prompt', { session_id: 'cc-short', prompt: text }), 2500);
    expect(r.status).toBe(0);
    expect(r.stdout.length, 'premise: the hook ran to its output').toBeGreaterThan(0);
    expect(promptTexts()).toContain(text);
  });

  it('Stop under a 2.5 s lock writes its turn instead of failing on the lock', async () => {
    const t0 = Date.now();
    const summaries = () => queryRow('SELECT COUNT(*) AS n FROM session_summaries').n;
    const before = summaries();
    const r = await underLock(() => hook('stop', { session_id: 'cc-short' }), 2500);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/database is locked/);
    // Stop logs a lost lock to the debug log only, so the exit alone cannot tell (round-2 review:
    // green with Stop's wait mutated to 0, the session left 'active' and no summary written).
    const completed = queryRow(
      `SELECT COUNT(*) AS n FROM sdk_sessions WHERE status = 'completed' AND completed_at_epoch >= ${t0}`,
    ).n;
    expect(completed, 'the turn marked the session completed').toBe(1);
    expect(summaries(), "the turn's summary baseline").toBe(before + 1);
  });

  it('Stop with three sessions in the episode buffer exits inside its timeout under a long lock', async () => {
    for (const sid of ['cc-multi-a', 'cc-multi-b', 'cc-multi-c']) {
      hook('post-tool-use', {
        session_id: sid,
        tool_name: 'Edit',
        tool_input: {
          file_path: join(projectDir, 'src/invoice.js'),
          old_string: 'a',
          new_string: `a /* ${sid} */`,
        },
        tool_response: { success: true },
      });
    }
    const r = await underLock(() => hook('stop', { session_id: 'cc-multi-a' }));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(HOST_TIMEOUT_MS);
  });

  // A leftover buffer, two sessions in it, and an orphan one (a Claude Code process that died
  // mid-turn): three connections flush before the handler's own, and at 5 s each they reached
  // the host's 15 s (pre-tag review 2026-10-16: SIGKILL at 15018 ms, 0 B). They now share
  // SessionStart's deadline.
  it('SessionStart after /compact with buffered and orphaned episodes emits the context inside its timeout', async () => {
    for (const sid of ['cc-cmp-a', 'cc-cmp-b']) {
      hook('post-tool-use', {
        session_id: sid,
        tool_name: 'Edit',
        tool_input: {
          file_path: join(projectDir, 'src/invoice.js'),
          old_string: 'b',
          new_string: `b /* ${sid} */`,
        },
        tool_response: { success: true },
      });
    }
    const runtime = join(home, '.claude-mem-lite', 'runtime');
    const own = join(runtime, `ep-work--invoice-app@h${process.pid}.json`);
    expect(existsSync(own), 'premise: the edits left an episode buffer').toBe(true);
    // Above any pid_max, so the host it names is gone.
    copyFileSync(own, join(runtime, 'ep-work--invoice-app@h999999999.json'));
    const r = await underLock(
      () => hook('session-start', { session_id: 'cc-cmp-a', source: 'compact' }, SESSION_START_TIMEOUT_MS),
      SESSION_START_TIMEOUT_MS + 1000,
    );
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('invoice totals reduce');
  }, 30000);

  it('Stop exits inside its timeout', async () => {
    const r = await underLock(() => hook('stop', {}));
    expect(r.signal, `killed at the host timeout after ${r.ms} ms`).toBeNull();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(HOST_TIMEOUT_MS);
    // The lock is caught in the handler, which goes on to spawn the summary worker; thrown, it
    // reached the dispatcher's error line and skipped the spawn (pre-tag review 2026-10-16).
    expect(r.stderr).not.toMatch(/database is locked/);
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
