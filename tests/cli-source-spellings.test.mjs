// `search --source` took observations|sessions|prompts|events and `get --source` took
// obs|session|prompt|event, each refusing the other's spelling of the same four record kinds
// (E2E 2026-10-16, cli F11). Both commands now accept both.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
let root, env;

const cli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: join(root, 'w', 'p') });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-source-spell-'));
  mkdirSync(join(root, 'w', 'p'), { recursive: true });
  env = {
    ...process.env,
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_PROJECT_DIR: join(root, 'w', 'p'),
    MEM_NO_AUTO_ADOPT: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  expect(
    cli('save', 'Redis pool exhaustion fixed by per-worker pool sizing', '--type', 'bugfix').status,
  ).toBe(0);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('--source accepts both spellings', () => {
  it('search --source obs', () => {
    const r = cli('search', 'redis', '--source', 'obs');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Redis pool exhaustion');
  });
  it('get --source observations', () => {
    const r = cli('get', '1', '--source', 'observations');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Redis pool exhaustion');
  });
  it('a real typo is still refused', () => {
    expect(cli('search', 'redis', '--source', 'obsrv').status).not.toBe(0);
    expect(cli('get', '1', '--source', 'obsrv').status).not.toBe(0);
  });
});

// E2E 2026-10-16 (cli F17): `timeline 1` sent "1" to the query search and answered "No anchor
// found for \"1\"" with #1 right there. A lone positional naming a record is the anchor.
describe('timeline takes a lone id positional as the anchor', () => {
  it('timeline 1 centres on #1', () => {
    const r = cli('timeline', '1', '--json');
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).anchor?.id).toBe(1);
    expect(r.stderr).not.toMatch(/No anchor found/);
  });
  it('a positional that names no record is still a query', () => {
    const r = cli('timeline', 'redis');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Redis pool exhaustion');
  });
});
