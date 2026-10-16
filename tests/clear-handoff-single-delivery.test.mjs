// After /clear the same handoff reached the model twice: SessionStart's "### Working State" block
// and the first prompt's <session-handoff> injection (E2E 2026-10-16, hooks F3). SessionStart now
// consumes the clear handoff it rendered, so the first prompt does not replay it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';

const HOOK = resolve(import.meta.dirname, '../hook.mjs');
let root, proj, env;

function hook(event, payload) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [HOOK, event], { env, cwd: proj, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', () => res(stdout));
    child.on('error', rej);
    child.stdin.end(JSON.stringify({ cwd: proj, ...payload }));
    setTimeout(() => {
      child.kill();
      rej(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-clear-once-'));
  proj = join(root, 'work', 'shop');
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  env = {
    ...process.env,
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_PROJECT_DIR: proj,
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SUMMARY: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_CODE_PATH: join(root, 'no-claude'),
    CLAUDE_MEM_HOOK_RUNNING: '',
  };
  delete env.CLAUDE_PID;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a /clear handoff is delivered once', () => {
  it('SessionStart(clear) shows Working State and the first prompt does not replay it', async () => {
    await hook('session-start', { session_id: 'c-old', source: 'startup' });
    await hook('user-prompt', {
      session_id: 'c-old',
      prompt: 'Fix the TANGO_ROUNDING bug in applyDiscount so totals are whole cents',
    });
    const start = await hook('session-start', { session_id: 'c-new', source: 'clear' });
    expect(start, 'premise: the clear start renders the handoff').toContain('TANGO_ROUNDING');
    const first = await hook('user-prompt', { session_id: 'c-new', prompt: 'continue' });
    expect(first).not.toContain('<session-handoff');
  }, 60000);

  // Round 2 (hooks STILL-BROKEN-1): every Stop writes the session's `exit` handoff with the same
  // state, and the first prompt after /clear picked THAT row (an exit row of another CC session),
  // so the state still arrived twice. The case above never fired Stop before the /clear.
  it('a Stop before the /clear does not bring the state back through the exit handoff', async () => {
    await hook('session-start', { session_id: 'd-old', source: 'startup' });
    await hook('user-prompt', {
      session_id: 'd-old',
      prompt: 'Fix the TANGO_ROUNDING bug in applyDiscount so totals are whole cents',
    });
    await hook('stop', { session_id: 'd-old' });
    const start = await hook('session-start', { session_id: 'd-new', source: 'clear' });
    expect(start, 'premise: the clear start renders the handoff').toContain('TANGO_ROUNDING');
    const first = await hook('user-prompt', { session_id: 'd-new', prompt: 'continue' });
    expect(first).not.toContain('TANGO_ROUNDING');
  }, 60000);

  it('control: after an /exit and a fresh start, "continue" still gets the exit handoff', async () => {
    await hook('session-start', { session_id: 'e-old', source: 'startup' });
    await hook('user-prompt', {
      session_id: 'e-old',
      prompt: 'Fix the TANGO_ROUNDING bug in applyDiscount so totals are whole cents',
    });
    await hook('stop', { session_id: 'e-old' });
    await hook('session-start', { session_id: 'e-new', source: 'startup' });
    const first = await hook('user-prompt', { session_id: 'e-new', prompt: 'continue' });
    expect(first).toContain('TANGO_ROUNDING');
  }, 60000);
});
