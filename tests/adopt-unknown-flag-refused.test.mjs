// adopt / unadopt write and delete files in the user's repository, so a mistyped flag must
// stop them, as it stops the install family (install.mjs: "refuse an unknown flag on a command
// that writes"). Before: `adopt --dryrun` warned "did you mean --dry-run?" and then wrote the
// committed CLAUDE.md, `adopt --disabel` adopted (the opposite of what was asked), and
// `unadopt --dryrun` removed the block, all with exit 0 (E2E 2026-10-16, install P1-8).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
const TEAM_RULES = '# Team rules\n';

let root, repo, env;

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-adopt-typo-'));
  repo = join(root, 'work', 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), TEAM_RULES);
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  env = {
    ...process.env,
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: join(root, 'data'),
    PWD: repo,
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('adopt / unadopt refuse a flag they do not know', () => {
  it('adopt --dryrun writes nothing and exits non-zero', () => {
    const r = cli('adopt', '--dryrun');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--dryrun/);
    expect(r.stderr).toMatch(/--dry-run/);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(TEAM_RULES);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
  });

  it('adopt --disabel does not adopt', () => {
    const r = cli('adopt', '--disabel');
    expect(r.status).toBe(1);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(TEAM_RULES);
  });

  it('unadopt --dryrun removes nothing', () => {
    expect(cli('adopt').status).toBe(0);
    const adopted = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    expect(adopted).toMatch(/claude-mem-lite:begin/);
    const r = cli('unadopt', '--dryrun');
    expect(r.status).toBe(1);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(adopted);
  });

  it('`adopt help` prints help instead of adopting', () => {
    const r = cli('adopt', 'help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/adopt/);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(TEAM_RULES);
  });

  it('a documented flag still works', () => {
    const r = cli('adopt', '--dry-run');
    expect(r.status).toBe(0);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(TEAM_RULES);
  });
});

// E2E 2026-10-16 (install P2-2): adopt took $PWD before the real cwd. A program that spawns
// `adopt` with `cwd: repoA` leaves its OWN PWD in the child's env, so the block was written
// into the caller's directory and repoA was untouched. $PWD still wins when it names the
// directory the process is in (a symlinked project's logical spelling).
describe('adopt targets the directory it runs in, not a stale $PWD', () => {
  it('a spawned adopt with an inherited PWD writes into its cwd', () => {
    const caller = join(root, 'caller');
    mkdirSync(caller, { recursive: true });
    const r = spawnSync(process.execPath, [CLI, 'adopt'], {
      cwd: repo,
      env: { ...env, PWD: caller },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toMatch(/claude-mem-lite:begin/);
    expect(existsSync(join(caller, 'CLAUDE.md'))).toBe(false);
  });
});
