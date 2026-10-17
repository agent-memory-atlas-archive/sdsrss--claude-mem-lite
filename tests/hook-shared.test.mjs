// Tests for hook-shared.mjs callLLM — unified provider routing.
// callLLM now mirrors haiku-client's provider priority: ANTHROPIC_API_KEY /
// OPENROUTER_API_KEY route through callHaiku (async API/OpenRouter), and only
// the no-key case falls back to the `claude -p` CLI.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../schema.mjs', () => ({
  ensureDb: vi.fn(),
  ensureDbWithWalRecovery: vi.fn(),
  setBusyDeadline: vi.fn(),
  DB_DIR: '/tmp/hook-shared-test',
}));

vi.mock('../utils.mjs', () => ({
  inferProject: vi.fn(() => 'proj'),
  debugCatch: vi.fn(),
}));

// vi.mock factories are hoisted above imports, so shared mock fns must come
// from vi.hoisted (top-level consts are not yet initialized at factory time).
const { callHaikuMock, detectModeMock, execClaudeCliSyncMock } = vi.hoisted(() => ({
  callHaikuMock: vi.fn(),
  detectModeMock: vi.fn(),
  execClaudeCliSyncMock: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  getClaudePath: vi.fn(() => '/usr/bin/claude'),
  resolveModel: vi.fn(() => ({ cli: 'haiku', api: 'claude-haiku-4-5-20251001' })),
  flattenForCLI: vi.fn((p) => (typeof p === 'string' ? p : `${p.system}\n${p.user}`)),
  detectMode: detectModeMock,
  callHaiku: callHaikuMock,
  // The `claude -p` argv/env contract (and the flag-compat retry) now lives in
  // ONE runner in haiku-client, asserted there; this file's job is that the CLI
  // leg still routes through it rather than re-inlining its own spawn.
  execClaudeCliSync: execClaudeCliSyncMock,
  // callLLM's default timeout argument — a full mock must carry it or every
  // routing case throws before reaching the branch under test.
  BG_LLM_TIMEOUT_MS: 45000,
}));

vi.mock('../memdir.mjs', () => ({
  memdirPath: vi.fn(() => '/tmp/memdir'),
  isAdopted: vi.fn(() => false),
}));

vi.mock('../adopt-content.mjs', () => ({
  PLUGIN_SLUG: 'claude-mem-lite',
}));

import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { ensureDbWithWalRecovery } from '../schema.mjs';
import { callLLM, openDb, setHookDbDeadline } from '../hook-shared.mjs';

describe('hook-shared callLLM — provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to callHaiku and returns its text in api mode', async () => {
    detectModeMock.mockReturnValue('api');
    callHaikuMock.mockResolvedValue({ text: 'api summary' });

    const out = await callLLM('summarize this');

    expect(out).toBe('api summary');
    expect(callHaikuMock).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('delegates to callHaiku and returns its text in openrouter mode', async () => {
    detectModeMock.mockReturnValue('openrouter');
    callHaikuMock.mockResolvedValue({ text: 'or summary' });

    const out = await callLLM({ system: 'INSTR', user: 'DATA' });

    expect(out).toBe('or summary');
    expect(callHaikuMock).toHaveBeenCalledWith(
      { system: 'INSTR', user: 'DATA' },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('returns null when callHaiku yields null (api/openrouter)', async () => {
    detectModeMock.mockReturnValue('openrouter');
    callHaikuMock.mockResolvedValue(null);

    const out = await callLLM('x');

    expect(out).toBeNull();
  });

  it('passes the caller timeout through to callHaiku', async () => {
    detectModeMock.mockReturnValue('api');
    callHaikuMock.mockResolvedValue({ text: 'ok' });

    await callLLM('x', 20000);

    expect(callHaikuMock).toHaveBeenCalledWith('x', expect.objectContaining({ timeout: 20000 }));
  });

  it('falls back to the shared claude-CLI runner in cli mode', async () => {
    detectModeMock.mockReturnValue('cli');
    execClaudeCliSyncMock.mockReturnValue('  cli summary  ');

    // A {system, user} prompt, not a bare string: with a string the flattenForCLI
    // mock is the identity function, so asserting on the input proved only that
    // the test supplied it — skipping _flattenForCLI entirely would have passed,
    // and with it the injection boundary marker that wraps untrusted user text.
    const out = await callLLM({ system: 'SYS', user: 'summarize this' }, 20000);

    expect(out).toBe('cli summary');
    expect(callHaikuMock).not.toHaveBeenCalled();
    expect(execClaudeCliSyncMock).toHaveBeenCalledWith('haiku', {
      input: 'SYS\nsummarize this',
      timeout: 20000,
    });
    // Drift guard: this leg used to hand-roll its own execFileSync with a
    // duplicated argv+env pair, which is how the headless flags could be pinned
    // at three sites and lost at the fourth. Re-inlining a spawn here fails both
    // assertions — the shared runner is the only sanctioned path.
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

// Round-2 pre-tag review 2026-10-16 (F10): the hook's lock budget was the deadline minus Date.now(),
// so a step of the system clock between process start and the open moved it: forward to 0 (writes
// lost under any lock), backward up to DB_BUSY_TIMEOUT_MS (the host's kill at 5 s).
describe('hook-shared openDb — the hook deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    setHookDbDeadline(null);
  });
  it.each([
    ['forward', 60_000],
    ['backward', -60_000],
  ])('a wall-clock step %s does not move the wait', (_, step) => {
    ensureDbWithWalRecovery.mockReturnValue(new Database(':memory:'));
    setHookDbDeadline(performance.timeOrigin + performance.now() + 2000);
    // Every wall-clock reader steps (Date.now and new Date alike; round-3 review: a spy on
    // Date.now alone stayed green with new Date().getTime() in its place).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + step });
    const db = openDb();
    const wait = db.pragma('busy_timeout', { simple: true });
    db.close();
    expect(wait).toBeGreaterThan(1500);
    expect(wait).toBeLessThanOrEqual(2000);
  });
});
