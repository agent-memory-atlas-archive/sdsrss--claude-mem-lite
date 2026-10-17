// scripts/swap-mixed-tree.mjs (D#397): the release check for a killed update swap must name the
// exports an entry point is left without in every shape this tree reads a dynamic import by, and
// it must be able to say NO. It named only `const { a } = await import()` and
// `(await import()).a`; assignment destructuring (install.mjs repair, scripts/pre-tool-recall.js)
// and Promise.all elements (hook.mjs, scripts/pre-agent-inject.js) were checked for the module's
// existence alone.
//
// The fixture is a git repository with two tags. At <old> every entry reads `b` from lib/x.mjs,
// each in one shape; <new> drops that export (and the entries' reads of it). SOURCE_FILES swaps
// lib/x.mjs first, so a kill after it leaves each <old> entry reading `b` from a lib/x.mjs that
// lacks it — the planted missing export.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_FILES = `export const SOURCE_FILES = [
  'lib/x.mjs',
  'lib/y.mjs',
  'install.mjs',
  'hook.mjs',
  'mem-cli.mjs',
  'server.mjs',
  'cli.mjs',
  'source-files.mjs',
];
export const HOOK_SCRIPT_FILES = [];
`;

const OLD = {
  'source-files.mjs': SOURCE_FILES,
  'lib/x.mjs': 'export const a = () => 1;\nexport const b = () => 2;\n',
  'lib/y.mjs': 'export const y = () => 3;\n',
  // Assignment destructuring.
  'install.mjs': "let a, b;\n({ a, b } = await import('./lib/x.mjs'));\nexport { a, b };\n",
  // A Promise.all element destructured.
  'hook.mjs':
    "const [{ y }, { b }] = await Promise.all([import('./lib/y.mjs'), import('./lib/x.mjs')]);\n" +
    'export { y, b };\n',
  // A Promise.all element bound to a namespace, read as `xm.b`.
  'mem-cli.mjs':
    'export async function run() {\n' +
    "  const [ym, xm] = await Promise.all([import('./lib/y.mjs'), import('./lib/x.mjs')]);\n" +
    '  return [ym.y(), xm.b()];\n' +
    '}\n',
  // A namespace bound by a declaration.
  'server.mjs':
    "export async function run() {\n  const xm = await import('./lib/x.mjs');\n  return xm.b();\n}\n",
  // Control: a name both releases export, and reads the code probes for (`?.()`, `typeof`), which
  // a missing export does not break.
  'cli.mjs':
    'export async function run() {\n' +
    "  const { a } = await import('./lib/x.mjs');\n" +
    "  const xm = await import('./lib/x.mjs');\n" +
    "  return [a(), xm.b?.(), typeof xm.c === 'function' && xm.c()];\n" +
    '}\n',
};
const NEW = {
  ...OLD,
  'lib/x.mjs': 'export const a = () => 1;\n',
  'install.mjs': "const { a } = await import('./lib/x.mjs');\nexport { a };\n",
  'hook.mjs': "const [{ y }] = await Promise.all([import('./lib/y.mjs')]);\nexport { y };\n",
  'mem-cli.mjs':
    "export async function run() {\n  const { y } = await import('./lib/y.mjs');\n  return y();\n}\n",
  'server.mjs':
    "export async function run() {\n  const { a } = await import('./lib/x.mjs');\n  return a();\n}\n",
};

let fixture;
const git = (...args) =>
  execFileSync(
    'git',
    ['-C', fixture, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
  );
function commit(files, tag) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, f)), { recursive: true });
    writeFileSync(join(fixture, f), text);
  }
  git('add', ...Object.keys(files));
  git('commit', '-q', '-m', tag);
  git('tag', tag);
}
const check = (oldRev, newRev) =>
  spawnSync(process.execPath, [join(fixture, 'scripts', 'swap-mixed-tree.mjs'), oldRev, newRev], {
    encoding: 'utf8',
    timeout: 60000,
  });

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'cml-swap-mixed-tree-'));
  git('init', '-q');
  commit(OLD, 'old');
  commit(NEW, 'new');
  // The script under test runs from the fixture (its repository is the directory above it), and
  // resolves acorn through this repository's node_modules. Neither is committed.
  mkdirSync(join(fixture, 'scripts'));
  copyFileSync(join(REPO, 'scripts', 'swap-mixed-tree.mjs'), join(fixture, 'scripts', 'swap-mixed-tree.mjs'));
  symlinkSync(join(REPO, 'node_modules'), join(fixture, 'node_modules'));
});
afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe('swap-mixed-tree names the export a dynamic import reads, in every shape', () => {
  it('fails on the planted missing export, naming each entry and shape', () => {
    const r = check('old', 'new');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    for (const entry of ['install.mjs', 'hook.mjs', 'mem-cli.mjs', 'server.mjs']) {
      expect(r.stdout, entry).toMatch(new RegExp(`^${entry.replace('.', '\\.')}: FAILS at `, 'm'));
      expect(r.stdout, entry).toContain(`${entry}@old import()s {b} that lib/x.mjs@new lacks`);
    }
    expect(r.stdout).toMatch(/^cli\.mjs: loads at all 9 split points$/m);
    expect(r.stdout).toMatch(/old -> new: 4 entry point\(s\) fail/);
  });

  it('passes when every name read exists (the same shapes, no swap)', () => {
    const r = check('old', 'old');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/old -> old: every entry point loads at every split point/);
  });
});

// Pre-tag review 2026-10-17 P3-1: a STATIC `import * as ns` was checked for the module only, so a
// name read as `ns.x` or `const { x } = ns` (install.mjs's `const { lockHeld } = procLock`) could
// be unexported with every split point reported loadable.
describe('swap-mixed-tree names the exports a static namespace import reads', () => {
  const NS_SOURCE_FILES = SOURCE_FILES.replace("'lib/y.mjs',", "'lib/ns.mjs',");
  const NS_OLD = {
    'source-files.mjs': NS_SOURCE_FILES,
    'lib/x.mjs': 'export const a = () => 1;\nexport const b = () => 2;\nexport const c = () => 3;\n',
    'lib/ns.mjs':
      "import * as xs from './x.mjs';\nconst { b } = xs;\nexport const viaNs = () => [xs.a(), b(), xs.c()];\n",
    'install.mjs': "import { viaNs } from './lib/ns.mjs';\nexport { viaNs };\n",
    'hook.mjs': 'export const h = 1;\n',
    'mem-cli.mjs': 'export const m = 1;\n',
    'server.mjs': 'export const s = 1;\n',
    'cli.mjs': 'export const k = 1;\n',
  };
  const NS_NEW = {
    ...NS_OLD,
    'lib/x.mjs': 'export const a = () => 1;\n',
    'lib/ns.mjs': "import * as xs from './x.mjs';\nexport const viaNs = () => xs.a();\n",
  };
  let nsFixture;
  beforeAll(() => {
    const saved = fixture;
    nsFixture = mkdtempSync(join(tmpdir(), 'cml-swap-ns-'));
    fixture = nsFixture;
    git('init', '-q');
    commit(NS_OLD, 'old');
    commit(NS_NEW, 'new');
    mkdirSync(join(nsFixture, 'scripts'));
    copyFileSync(
      join(REPO, 'scripts', 'swap-mixed-tree.mjs'),
      join(nsFixture, 'scripts', 'swap-mixed-tree.mjs'),
    );
    symlinkSync(join(REPO, 'node_modules'), join(nsFixture, 'node_modules'));
    fixture = saved;
  });
  afterAll(() => {
    if (nsFixture) rmSync(nsFixture, { recursive: true, force: true });
  });

  it('fails on a member read and a destructured read the new module lacks', () => {
    const r = spawnSync(process.execPath, [join(nsFixture, 'scripts', 'swap-mixed-tree.mjs'), 'old', 'new'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/^install\.mjs: FAILS at /m);
    expect(r.stdout).toMatch(/lib\/ns\.mjs@old imports \{[^}]*\bb\b[^}]*\} that lib\/x\.mjs@new lacks/);
    expect(r.stdout).toMatch(/lib\/ns\.mjs@old imports \{[^}]*\bc\b[^}]*\} that lib\/x\.mjs@new lacks/);
  });
});
