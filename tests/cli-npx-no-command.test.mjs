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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dirname, '..');
const CLI = join(REPO, 'cli.mjs');

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

// npx runs the package from its cache, `~/.npm/_npx/<hash>/node_modules/claude-mem-lite`. The
// tree is linked there and node keeps the link's path, so the entry sees the path npx gives it.
function npxShapedCli() {
  const dir = join(root, '.npm', '_npx', 'abc123', 'node_modules');
  mkdirSync(dir, { recursive: true });
  symlinkSync(REPO, join(dir, 'claude-mem-lite'), 'dir');
  return join(dir, 'claude-mem-lite', 'cli.mjs');
}
const runAt = (cli, extra = {}) => {
  const e = { ...env, ...extra };
  if (!('npm_command' in extra)) delete e.npm_command;
  const r = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', cli], {
    env: e,
    encoding: 'utf8',
    timeout: 60000,
  });
  return r.stdout + r.stderr;
};

describe('cli.mjs with no command', () => {
  it('under npx, routes to install even when a database exists', () => {
    const out = runAt(npxShapedCli(), { npm_command: 'exec' });
    expect(out).not.toMatch(/claude-mem-lite CLI/);
    expect(out).toMatch(/settings\.json/);
    // The cache path alone decides: without the variable the same entry still installs.
    const bare = runAt(join(root, '.npm', '_npx', 'abc123', 'node_modules', 'claude-mem-lite', 'cli.mjs'));
    expect(bare).toMatch(/settings\.json/);
  });

  // E2E round 2 (install B5): npm exports npm_command=exec to everything npx starts, so a
  // Claude Code launched with npx hands it to its Bash tool and hooks. A bare
  // `claude-mem-lite` (the npm -g link, or ~/.claude-mem-lite/cli.mjs) there ran a full install
  // over a plugin-only machine. The entry's own path decides, not the inherited variable.
  it('an inherited npm_command=exec outside the npx cache still prints the CLI help', () => {
    const out = run({ npm_command: 'exec' });
    expect(out).toMatch(/claude-mem-lite CLI/);
    expect(out).not.toMatch(/settings\.json/);
  });

  it('outside npx, with a database, prints the CLI help', () => {
    const e = { ...env };
    delete e.npm_command;
    const r = spawnSync(process.execPath, [CLI], { env: e, encoding: 'utf8', timeout: 60000 });
    expect(r.stdout).toMatch(/claude-mem-lite CLI/);
  });
});
