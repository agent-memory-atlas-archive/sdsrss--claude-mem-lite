// Install-family commands used to ignore every flag they did not read, so `uninstall --dry-run`
// and `uninstall --help` UNINSTALLED — removed the MCP registration, the CLI symlink and every
// hook — and `install --help` installed. `cleanup` honours `--dry-run`, which is exactly why a
// user expects its siblings to. A command that writes must refuse a flag it does not know, and
// `--help` / `-h` must print usage and do nothing.
//
// §8.V3: destructive paths run against a sandbox HOME with a fake `claude` on PATH that only
// records its argv, so an unguarded run shows up as a recorded `mcp remove` rather than as damage.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const OUR_HOOK = {
  hooks: [{ type: 'command', command: 'node "/x/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop' }],
};

function sandbox() {
  const root = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-flag-guard-')));
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [OUR_HOOK] } }, null, 2));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'claude-calls.log');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { root, home, settings, bin, calls, before: readFileSync(settings, 'utf8') };
}

function run(s, args) {
  return spawnSync(process.execPath, [join(REPO, 'install.mjs'), ...args], {
    cwd: s.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: s.home,
      // cleanup sweeps os.tmpdir(); keep an unguarded run inside the sandbox too.
      TMPDIR: s.root,
      PATH: `${s.bin}:${process.env.PATH}`,
      CLAUDE_MEM_DIR: join(s.root, 'data'),
      CLAUDE_MEM_SKIP_UPDATE: '1',
      MEM_NO_AUTO_ADOPT: '1',
    },
  });
}

const untouched = (s) => {
  expect(readFileSync(s.settings, 'utf8')).toBe(s.before);
  expect(existsSync(s.calls)).toBe(false);
};

describe('install-family commands do nothing on a flag they do not know', () => {
  it('premise: plain uninstall does write — the sandbox can see damage', () => {
    const s = sandbox();
    const r = run(s, ['uninstall']);
    expect(r.status).toBe(0);
    expect(readFileSync(s.settings, 'utf8')).not.toBe(s.before);
    expect(readFileSync(s.calls, 'utf8')).toMatch(/mcp remove/);
  });

  for (const flag of ['--dry-run', '--bogus']) {
    it(`uninstall ${flag} refuses, exits 1 and names the flag`, () => {
      const s = sandbox();
      const r = run(s, ['uninstall', flag]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(flag);
      expect(r.stderr).toMatch(/nothing was done/);
      untouched(s);
    });
  }

  // `install`, `repair` and `release` are left out on purpose: unguarded, they run npm, fetch
  // a tarball, or rewrite this repository's own manifests. The guard sits in main(), ahead of
  // every command, and the table case below keeps each command inside it.
  for (const cmd of ['uninstall', 'cleanup', 'cleanup-hooks']) {
    for (const flag of ['--help', '-h']) {
      it(`${cmd} ${flag} prints usage and exits 0 without acting`, () => {
        const s = sandbox();
        const r = run(s, [cmd, flag]);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/Usage:/);
        untouched(s);
      });
    }
  }

  it('a read-only command reports an unknown flag and still runs', () => {
    const s = sandbox();
    const r = run(s, ['status', '--bogus']);
    expect(r.stderr).toMatch(/Unknown flag --bogus/);
    expect(r.stdout).toMatch(/status/i);
    // status reads `claude mcp list`; it must not add or remove anything.
    expect(readFileSync(s.settings, 'utf8')).toBe(s.before);
    const calls = existsSync(s.calls) ? readFileSync(s.calls, 'utf8') : '';
    expect(calls).not.toMatch(/mcp (add|remove)/);
  });

  it('every install-family command the CLI routes has a flag table', async () => {
    const { INSTALL_COMMAND_FLAGS } = await import('../install.mjs');
    const cli = readFileSync(join(REPO, 'cli.mjs'), 'utf8');
    const block = cli.match(/const INSTALL_COMMANDS = new Set\(\[([\s\S]*?)\]\)/)[1];
    const routed = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(routed.length).toBeGreaterThanOrEqual(10);
    for (const c of routed) expect(Object.keys(INSTALL_COMMAND_FLAGS)).toContain(c);
  });

  it('flags a command documents are still accepted', () => {
    const s = sandbox();
    const r = run(s, ['cleanup', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    untouched(s);
  });
});
