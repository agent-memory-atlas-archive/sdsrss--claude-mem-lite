// `npx claude-mem-lite` with no command is the documented install / reinstall (README
// "npx claude-mem-lite  # Install / reinstall"; CHANGELOG 6.25.x: an update that left
// ~/.claude-mem-lite without cli.mjs or server.mjs is repaired by `npx claude-mem-lite@latest`).
// cli.mjs printed the CLI help instead whenever a database already existed — i.e. on every
// machine that needed the reinstall (E2E 2026-10-16, install P1-1).
//
// The installer is reached but stopped before it writes anything: an unparseable
// settings.json makes `install` refuse, and that refusal is what tells the two routes apart.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(import.meta.dirname, '../cli.mjs');

let root, env;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-npx-bare-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{ "hooks": { ,,, }');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'claude-mem-lite.db'), ''); // a store exists: memories were kept
  env = {
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: data,
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (extra) => {
  const r = spawnSync(process.execPath, [CLI], {
    env: { ...env, ...extra },
    encoding: 'utf8',
    timeout: 60000,
  });
  return r.stdout + r.stderr;
};

describe('cli.mjs with no command', () => {
  it('under npx, routes to install even when a database exists', () => {
    const out = run({ npm_command: 'exec' });
    expect(out).not.toMatch(/claude-mem-lite CLI/);
    expect(out).toMatch(/settings\.json/);
  });

  it('outside npx, with a database, prints the CLI help', () => {
    const e = { ...env };
    delete e.npm_command;
    const r = spawnSync(process.execPath, [CLI], { env: e, encoding: 'utf8', timeout: 60000 });
    expect(r.stdout).toMatch(/claude-mem-lite CLI/);
  });
});
