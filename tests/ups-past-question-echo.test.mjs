// Injection budget C5: the "Past similar questions" fallback (scripts/user-prompt-search.js)
// must not hand the model its own prompt back.
//
// On the frozen 52-session corpus (docs/audits/20261016-injection-budget-baseline.md) 8 of 52
// rows were the very prompt that triggered them and 1 an earlier prompt of the same session:
// `hook.mjs user-prompt` writes the current prompt into user_prompts in parallel with this
// search, and nothing excluded the current session. A prompt from THIS session is already in
// the context; one that is the same text as the current prompt says nothing new either.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession } from './test-helpers.mjs';
import { isPromptEcho } from '../scripts/prompt-search-utils.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'user-prompt-search.js');
const HEADER = '[mem] FYI — Past similar questions';

describe('past-question fallback excludes its own session and echoes of the prompt', () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ups-echo-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    db = new Database(join(dir, 'claude-mem-lite.db'));
    initSchema(db);
    insertSession(db, { id: 'mem-1', project: 'test--project' });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (text, ccSessionId, minutesAgo = 30) => {
    const at = Date.now() - minutesAgo * 60000;
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
       VALUES ('mem-1', ?, 1, ?, ?, ?)`,
    ).run(text, ccSessionId, new Date(at).toISOString(), at);
    db.pragma('wal_checkpoint(FULL)');
  };

  const run = (prompt, sessionId) =>
    new Promise((ok) => {
      const env = {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: '/test/project',
        PWD: '/test/project',
        CLAUDE_MEM_UPS_TOP_MIN: '0',
        CLAUDE_MEM_HOOK_RUNNING: '',
      };
      const proc = spawn(process.execPath, [SCRIPT], { env });
      let stdout = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.on('close', () => ok(stdout));
      proc.stdin.end(
        JSON.stringify({
          prompt,
          hook_event_name: 'UserPromptSubmit',
          cwd: '/test/project',
          session_id: sessionId,
        }),
      );
    });

  const PROMPT = 'fix the retry loop timeout handling in fetcher.mjs';

  it('premise: a related prompt from another session is shown', async () => {
    seed('why does the retry loop in fetcher.mjs ignore the timeout', 'sess-old');
    const out = await run(PROMPT, 'sess-now');
    expect(out).toContain(HEADER);
    expect(out).toContain('ignore the timeout');
  });

  it('a prompt from the current session is not shown back', async () => {
    seed('why does the retry loop in fetcher.mjs ignore the timeout', 'sess-now');
    const out = await run(PROMPT, 'sess-now');
    expect(out).not.toContain('ignore the timeout');
  });

  it('the current prompt itself (written by the parallel hook) is not shown back', async () => {
    seed(PROMPT, 'sess-now', 0);
    const out = await run(PROMPT, 'sess-now');
    expect(out).not.toContain(HEADER);
  });

  it('the same text from another session is not shown, a different one still is', async () => {
    seed(`${PROMPT}\n`, 'sess-old', 60);
    seed('why does the retry loop in fetcher.mjs ignore the timeout', 'sess-older', 90);
    const out = await run(PROMPT, 'sess-now');
    expect(out).toContain('ignore the timeout');
    expect(out.split('\n').filter((l) => l.startsWith('P#') && l.includes('fix the retry loop'))).toEqual([]);
  });
});

describe('isPromptEcho', () => {
  const P = 'fix the retry loop timeout handling in fetcher.mjs';
  it('same text after whitespace and case folding', () => {
    expect(isPromptEcho(`  ${P.toUpperCase()}\n`, P)).toBe(true);
  });
  it('a re-paste with a short addition (prefix covering >= 80%)', () => {
    expect(isPromptEcho(`${P} now`, P)).toBe(true);
    expect(isPromptEcho(P, `${P} now`)).toBe(true);
  });
  it('a prefix covering less than 80% is a different question', () => {
    expect(isPromptEcho('fix the retry loop', P)).toBe(false);
    expect(isPromptEcho(`${P} and then also rewrite the backoff table to use jitter`, P)).toBe(false);
  });
  it('empty sides are never echoes', () => {
    expect(isPromptEcho('', P)).toBe(false);
    expect(isPromptEcho(P, '')).toBe(false);
  });
});

// Pre-ship defect review P2-2: dropping an identical question from an EARLIER session is a
// behaviour change (not the self-match bug), so it keeps a switch. The current session's own
// prompts stay excluded either way — returning the prompt just typed is the bug being fixed.
describe('CLAUDE_MEM_UPS_PROMPT_ECHO=0', () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ups-echo-sw-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    db = new Database(join(dir, 'claude-mem-lite.db'));
    initSchema(db);
    insertSession(db, { id: 'mem-1', project: 'test--project' });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  const seed = (text, ccSessionId, minutesAgo) => {
    const at = Date.now() - minutesAgo * 60000;
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
       VALUES ('mem-1', ?, 1, ?, ?, ?)`,
    ).run(text, ccSessionId, new Date(at).toISOString(), at);
    db.pragma('wal_checkpoint(FULL)');
  };
  const run = (prompt, sessionId, extra = {}) =>
    new Promise((ok) => {
      const env = {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: '/test/project',
        PWD: '/test/project',
        CLAUDE_MEM_UPS_TOP_MIN: '0',
        CLAUDE_MEM_HOOK_RUNNING: '',
        ...extra,
      };
      const proc = spawn(process.execPath, [SCRIPT], { env });
      let stdout = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.on('close', () => ok(stdout));
      proc.stdin.end(
        JSON.stringify({
          prompt,
          hook_event_name: 'UserPromptSubmit',
          cwd: '/test/project',
          session_id: sessionId,
        }),
      );
    });
  const PROMPT = 'why does the retry loop in fetcher.mjs ignore the timeout';

  it('restores an identical question from an earlier session', async () => {
    seed(PROMPT, 'sess-three-days-ago', 3 * 24 * 60);
    expect(await run(PROMPT, 'sess-now')).not.toContain(HEADER);
    expect(await run(PROMPT, 'sess-now-2', { CLAUDE_MEM_UPS_PROMPT_ECHO: '0' })).toContain(HEADER);
  });

  it('still never returns a prompt of the current session', async () => {
    seed(PROMPT, 'sess-now', 0);
    expect(await run(PROMPT, 'sess-now', { CLAUDE_MEM_UPS_PROMPT_ECHO: '0' })).not.toContain(HEADER);
  });
});
