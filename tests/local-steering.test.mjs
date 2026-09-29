// Steering channel r3 (tasks/specs/sandbox-eval-l3.md; docs/audits/20260929-sandbox-usage-eval.md
// §8.5). Injected SessionStart steering cost most of the agent's proactive memory writes
// (1.5 per trajectory vs 5.25 from a CLAUDE.md block, exact p=0.029) and never reached
// subagents (0/12 vs 12/12). A managed block in CLAUDE.local.md — a file Claude Code loads
// like CLAUDE.md — restored the write rate (5.25) and reached subagents (12/12), and with
// the file listed in the repository's info/exclude it never enters a commit.
//
// So auto-adopt writes <git top-level>/CLAUDE.local.md inside a git work tree and keeps
// injecting everywhere else. It never writes where the file would be committed (tracked),
// where it would steer every project below it ($HOME, `/`), or where the user opted out.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import {
  LOCAL_MD,
  localSteeringRoot,
  writeLocalSteering,
  readLocalSteering,
  removeLocalSteering,
  isSharedAncestor,
} from '../lib/local-steering.mjs';
import { silentAutoAdopt, cmdUnadopt, cmdAdopt } from '../adopt-cli.mjs';
import { isOwnAdoptionArtifact, readBlock, writeManaged } from '../claudemd.mjs';
import {
  buildClaudeMdBlock,
  getDetailDoc,
  PLUGIN_SLUG,
  CURRENT_SENTINEL_VERSION,
} from '../adopt-content.mjs';
import { memdirPath, disableSentinelPath } from '../memdir.mjs';
import { isAdoptedHere } from '../lib/quiet-scope.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = PLUGIN_SLUG;
const V = CURRENT_SENTINEL_VERSION;
const HEADING = '## claude-mem-lite — persistent memory';
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const initRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
};
const status = (dir) => git(dir, 'status', '--porcelain').trim();
const excludeOf = (dir) => readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');

let home;
let saved;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cml-local-'));
  saved = {
    HOME: process.env.HOME,
    MEM_NO_AUTO_ADOPT: process.env.MEM_NO_AUTO_ADOPT,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.MEM_NO_AUTO_ADOPT;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('localSteeringRoot', () => {
  it('is the git top-level, from the root or a subdirectory', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    mkdirSync(join(app, 'src'));
    expect(localSteeringRoot(app)).toBe(app);
    expect(localSteeringRoot(join(app, 'src'))).toBe(app);
  });

  it('is null outside a git work tree', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    expect(localSteeringRoot(plain)).toBeNull();
  });

  it('is null when the work tree is $HOME itself (the file would steer every project below)', () => {
    initRepo(home);
    const proj = join(home, 'dev', 'proj');
    mkdirSync(proj, { recursive: true });
    expect(localSteeringRoot(proj)).toBeNull();
  });
});

describe('writeLocalSteering / removeLocalSteering', () => {
  let app;
  beforeEach(() => {
    app = join(home, 'work', 'app');
    initRepo(app);
  });
  const block = () => buildClaudeMdBlock({ detailDocRef: '/data/plugin_claude_mem_lite.md' });

  it('writes the block, excludes the file, and leaves `git status` clean', () => {
    const r = writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(r.action).toBe('created');
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toContain(HEADING);
    expect(excludeOf(app)).toMatch(/^CLAUDE\.local\.md$/m);
    expect(status(app)).toBe('');
    expect(readLocalSteering(app, SLUG).body).not.toBeNull();
  });

  it('is idempotent: a second write changes nothing and adds no second exclude line', () => {
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    const before = readFileSync(join(app, LOCAL_MD), 'utf8');
    expect(writeLocalSteering(app, { slug: SLUG, version: V, block: block() }).action).toBe('unchanged');
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toBe(before);
    expect(excludeOf(app).match(/^CLAUDE\.local\.md$/gm)).toHaveLength(1);
  });

  it("keeps the user's own CLAUDE.local.md text around the block", () => {
    writeFileSync(join(app, LOCAL_MD), '# my notes\n\nUse pnpm.\n');
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    const text = readFileSync(join(app, LOCAL_MD), 'utf8');
    expect(text).toMatch(/^# my notes\n\nUse pnpm\.\n/);
    expect(text).toContain(HEADING);
    removeLocalSteering(app, SLUG);
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toBe('# my notes\n\nUse pnpm.\n');
  });

  it('does not add an exclude line when the file is already ignored', () => {
    writeFileSync(join(app, '.gitignore'), 'CLAUDE.local.md\n');
    git(app, 'add', '.gitignore');
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore');
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(excludeOf(app)).not.toMatch(/^CLAUDE\.local\.md$/m);
    expect(status(app)).toBe('');
  });

  it('refuses when CLAUDE.local.md is tracked — writing it would dirty the repository', () => {
    writeFileSync(join(app, LOCAL_MD), 'team notes\n');
    git(app, 'add', LOCAL_MD);
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked');
    const r = writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(r.action).toBe('refused');
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toBe('team notes\n');
    expect(status(app)).toBe('');
  });

  it('removal deletes a file that held only the block and drops the exclude lines it added', () => {
    const userLine = 'secret.txt';
    writeFileSync(join(app, '.git', 'info', 'exclude'), `${userLine}\n`);
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    const r = removeLocalSteering(app, SLUG);
    expect(r.action).toBe('removed');
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(excludeOf(app)).toBe(`${userLine}\n`);
  });

  it('a CLAUDE.local.md holding only the block is the plugin’s own artifact', () => {
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(isOwnAdoptionArtifact(app, LOCAL_MD, SLUG)).toBe(true);
    writeFileSync(join(app, LOCAL_MD), `mine\n${readFileSync(join(app, LOCAL_MD), 'utf8')}`);
    expect(isOwnAdoptionArtifact(app, LOCAL_MD, SLUG)).toBe(false);
  });
});

describe('silentAutoAdopt picks the channel', () => {
  it('a git project gets CLAUDE.local.md and nothing else under the tree', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    const r = silentAutoAdopt({ cwd: app });
    expect(r.action).toBe('local');
    expect(readdirSync(app).sort()).toEqual(['.git', 'CLAUDE.local.md', 'README.md']);
    expect(status(app)).toBe('');
  });

  it('a directory outside git keeps the injected steering', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    expect(silentAutoAdopt({ cwd: plain }).action).toBe('inject');
    expect(readdirSync(plain)).toEqual([]);
  });

  it('a tracked CLAUDE.local.md falls back to injection', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeFileSync(join(app, LOCAL_MD), 'team notes\n');
    git(app, 'add', LOCAL_MD);
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked');
    // The reason, not only the outcome: with the exclude roll-back, removing the tracked check
    // would still refuse (as exclude-failed) after touching info/exclude twice.
    expect(silentAutoAdopt({ cwd: app })).toMatchObject({ action: 'inject', reason: 'local-tracked' });
  });

  it('a project that carries the CLAUDE.md block is synced and loses a stale local block', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeLocalSteering(app, { slug: SLUG, version: V, block: 'stale' });
    writeManaged(app, { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    silentAutoAdopt({ cwd: app });
    expect(readBlock(app, SLUG).body).not.toBeNull();
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 leaves an existing local block as it is', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeLocalSteering(app, { slug: SLUG, version: V, block: 'frozen by the user' });
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      expect(silentAutoAdopt({ cwd: app })).toMatchObject({ action: 'local', written: 'unchanged' });
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(readLocalSteering(app, SLUG).body).toBe('frozen by the user');
  });

  it('when the exclude entry cannot be written, nothing is written and the steering is injected', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    const exclude = join(app, '.git', 'info', 'exclude');
    rmSync(exclude, { force: true });
    mkdirSync(exclude); // appending to a directory fails
    const r = silentAutoAdopt({ cwd: app });
    expect(r).toMatchObject({ action: 'inject', reason: 'local-exclude-failed' });
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('the per-project opt-out writes nothing', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    mkdirSync(memdirPath(app), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app)), '{}');
    expect(silentAutoAdopt({ cwd: app }).action).toBe('disabled');
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });
});

// Pre-tag claims review (P1-2/3/4, P2-3, P1-5): the plugin wrote the file back after the user
// removed it, a root-level opt-out did not hold for a session started in a subdirectory, a
// subdirectory session added a local copy next to the root's CLAUDE.md block, and the file named
// the data dir by absolute path (the username), while `npm pack` does not read info/exclude.
describe('a removed or opted-out local block stays removed', () => {
  const app = () => join(home, 'work', 'app');
  beforeEach(() => initRepo(app()));

  it('a CLAUDE.local.md the user deleted is not written again; the steering is injected instead', () => {
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('local');
    rmSync(join(app(), LOCAL_MD));
    const r = silentAutoAdopt({ cwd: app() });
    expect(r).toMatchObject({ action: 'inject', reason: 'local-removed' });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('after unadopt the next session does not write it again', () => {
    silentAutoAdopt({ cwd: app() });
    const cwdBefore = process.cwd();
    process.chdir(app());
    process.env.CLAUDE_PROJECT_DIR = app();
    try {
      cmdUnadopt([]);
    } finally {
      process.chdir(cwdBefore);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('inject');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('adopt --enable re-arms it', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    const cwdBefore = process.cwd();
    process.chdir(app());
    process.env.CLAUDE_PROJECT_DIR = app();
    try {
      cmdAdopt(['--enable']);
    } finally {
      process.chdir(cwdBefore);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('local');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(true);
  });

  it('an opt-out at the repository root holds for a session started in a subdirectory', () => {
    const sub = join(app(), 'pkg');
    mkdirSync(sub);
    mkdirSync(memdirPath(app()), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app())), '{}');
    expect(silentAutoAdopt({ cwd: sub }).action).toBe('inject');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('a subdirectory session of a repository whose root CLAUDE.md carries the block adds nothing', () => {
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    const sub = join(app(), 'pkg');
    mkdirSync(sub);
    const r = silentAutoAdopt({ cwd: sub });
    expect(r.action).toBe('already-adopted');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('the file names the detail doc under ~, not by the home path', () => {
    silentAutoAdopt({ cwd: app() });
    const text = readFileSync(join(app(), LOCAL_MD), 'utf8');
    expect(text).not.toContain(home);
    expect(text).toMatch(/→ `~\/[^`]*plugin_claude_mem_lite\.md`/);
  });
});

describe('the CLI verbs clean the local block up', () => {
  let app;
  let cwdBefore;
  beforeEach(() => {
    app = join(home, 'work', 'app');
    initRepo(app);
    cwdBefore = process.cwd();
    process.chdir(app);
    process.env.CLAUDE_PROJECT_DIR = app;
    silentAutoAdopt({ cwd: app });
    expect(existsSync(join(app, LOCAL_MD))).toBe(true);
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it('unadopt removes it and its exclude line', () => {
    cmdUnadopt([]);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(excludeOf(app)).not.toMatch(/^CLAUDE\.local\.md$/m);
  });

  it('adopt --disable removes it (the guidance is off for this project)', () => {
    cmdAdopt(['--disable']);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('an explicit adopt moves the steering into CLAUDE.md and drops the local copy', () => {
    cmdAdopt([]);
    expect(readBlock(app, SLUG).body).not.toBeNull();
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });
});

describe('SessionStart end to end', () => {
  let app;
  let dataDir;
  beforeEach(() => {
    app = join(home, 'work', 'app');
    initRepo(app);
    dataDir = join(home, 'data');
  });
  const sessionStart = (cwd, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      cwd,
      input: JSON.stringify({ session_id: 'local-e2e', source: 'startup', cwd }),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MEM_)/.test(k))),
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        ...extraEnv,
      },
    });
    expect(r.status).toBe(0);
    return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : {};
  };

  it('MEM_NO_ADOPT_HINT=1 silences the local-file note but still writes the file', () => {
    const out = sessionStart(app, { MEM_NO_ADOPT_HINT: '1' });
    expect(out.systemMessage).toBeUndefined();
    expect(existsSync(join(app, LOCAL_MD))).toBe(true);
  });

  // Claude Code reads CLAUDE.local.md at startup, BEFORE SessionStart hooks run, so the session
  // that creates the file does not load it. The release-tree sandbox run showed it: in the first
  // session of every project neither the main agent nor its subagents had any steering (0/4).
  // That session gets the block injected once; from the next session on the file carries it.
  it('first session: writes CLAUDE.local.md AND injects the block once; later sessions rely on the file', () => {
    const first = sessionStart(app);
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toContain(HEADING);
    expect(first.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(status(app)).toBe('');
    expect(first.systemMessage).toMatch(/CLAUDE\.local\.md/);
    // The block points at a detail doc that exists, in the plugin's data dir, named under ~.
    const ref = /→ `([^`]+plugin_claude_mem_lite\.md)`/.exec(readFileSync(join(app, LOCAL_MD), 'utf8'))?.[1];
    const abs = ref?.replace(/^~/, home);
    expect(abs && abs.startsWith(dataDir) && existsSync(abs)).toBe(true);
    const second = sessionStart(app);
    expect(second.hookSpecificOutput?.additionalContext ?? '').not.toContain(HEADING);
    expect(second.systemMessage).toBeUndefined();
  });

  it('at $HOME the steering is injected without suggesting /adopt, which would write ~/CLAUDE.md', () => {
    const out = sessionStart(home);
    expect(out.hookSpecificOutput.additionalContext).toContain(HEADING);
    expect(out.systemMessage ?? '').not.toMatch(/\/adopt/);
  });

  it('outside git the steering is still injected', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    const out = sessionStart(plain);
    expect(out.hookSpecificOutput.additionalContext).toContain(HEADING);
    expect(readdirSync(plain)).toEqual([]);
  });
});

// Pre-tag defect review (v6.20.0, against 80335a4): P2-1 worktrees, P2-2 symlinks, P1-1 npm pack,
// P2-3 a pre-upgrade opt-out under ~/.claude, P2-4 --disable --all without a memdir, and the
// mutations no test could catch (tracked refusal leaving exclude alone, filesystem-root refusal,
// the post-append check, exclude cleanup after a hand delete, the note switch, quiet-scope, the
// --all sweeps, CLAUDE_CONFIG_DIR wiring, --dry-run and --status lines).
describe('pre-tag defect review: local steering edges', () => {
  const app = () => join(home, 'work', 'app');
  const withCwd = (dir, fn) => {
    const before = process.cwd();
    process.chdir(dir);
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      return fn();
    } finally {
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
  };
  const captureLog = (fn) => {
    const lines = [];
    const orig = console.log;
    console.log = (m) => lines.push(String(m));
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return lines.join('\n');
  };
  beforeEach(() => initRepo(app()));

  it('a symlinked CLAUDE.local.md is not written through', () => {
    const other = join(home, 'dotfiles');
    mkdirSync(other);
    writeFileSync(join(other, 'shared.md'), 'shared notes\n');
    symlinkSync(join(other, 'shared.md'), join(app(), LOCAL_MD));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'inject', reason: 'local-symlink' });
    expect(readFileSync(join(other, 'shared.md'), 'utf8')).toBe('shared notes\n');
  });

  it('removing one worktree’s block keeps the shared exclude entry while another worktree still has one', () => {
    const wt = join(home, 'work', 'wt');
    git(app(), 'worktree', 'add', '-q', wt);
    silentAutoAdopt({ cwd: app() });
    silentAutoAdopt({ cwd: wt });
    removeLocalSteering(wt, SLUG);
    expect(status(app())).toBe('');
    removeLocalSteering(app(), SLUG);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
  });

  it('with template refresh frozen, a missing exclude entry is restored', () => {
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), '.git', 'info', 'exclude'), '');
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      silentAutoAdopt({ cwd: app() });
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(status(app())).toBe('');
  });

  it('a publishable npm package at the root gets injection, not a file npm pack would ship', () => {
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-npm-publishable',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('a private package, a files whitelist, or an .npmignore entry keeps the local file', () => {
    for (const [i, setup] of [
      () => writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'a', private: true })),
      () => writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'b', files: ['index.js'] })),
      () => {
        writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'c' }));
        writeFileSync(join(app(), '.npmignore'), 'CLAUDE.local.md\n');
      },
    ].entries()) {
      const dir = join(home, 'work', `pkg${i}`);
      initRepo(dir);
      const before = process.cwd();
      process.chdir(dir);
      try {
        setup.call(null);
      } finally {
        process.chdir(before);
      }
      for (const f of ['package.json', '.npmignore']) {
        if (existsSync(join(app(), f))) {
          writeFileSync(join(dir, f), readFileSync(join(app(), f)));
          rmSync(join(app(), f));
        }
      }
      expect(silentAutoAdopt({ cwd: dir }).action, `setup ${i}`).toBe('local');
    }
  });

  it('refusing a tracked CLAUDE.local.md leaves info/exclude as it was', () => {
    writeFileSync(join(app(), LOCAL_MD), 'team\n');
    git(app(), 'add', LOCAL_MD);
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked');
    const before = excludeOf(app());
    silentAutoAdopt({ cwd: app() });
    expect(excludeOf(app())).toBe(before);
  });

  it('a negated ignore rule makes the exclude entry useless: nothing written, exclude restored', () => {
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    git(app(), 'add', '.gitignore');
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'negate');
    const before = excludeOf(app());
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-exclude-failed',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).toBe(before);
  });

  it('the filesystem root and $HOME are never a steering root', () => {
    expect(isSharedAncestor('/')).toBe(true);
    expect(isSharedAncestor(home)).toBe(true);
    expect(isSharedAncestor(app())).toBe(false);
  });

  it('unadopt after a hand delete still drops the exclude entry', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    withCwd(app(), () => cmdUnadopt([]));
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
  });

  it('quiet-scope counts a local block as adopted even with MEM_NO_AUTO_ADOPT=1', () => {
    silentAutoAdopt({ cwd: app() });
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(isAdoptedHere(app())).toBe(true);
    rmSync(join(app(), LOCAL_MD));
    expect(isAdoptedHere(app())).toBe(false);
  });

  it('unadopt --all and adopt --disable --all sweep the local block of every known project', () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    silentAutoAdopt({ cwd: app() });
    silentAutoAdopt({ cwd: other });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {}, [other]: {} } }));
    withCwd(app(), () => cmdUnadopt(['--all']));
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(existsSync(join(other, LOCAL_MD))).toBe(false);
  });

  it('adopt --disable --all disables known projects that have no memory dir', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {} } }));
    silentAutoAdopt({ cwd: app() });
    withCwd(app(), () => cmdAdopt(['--disable', '--all']));
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('disabled');
  });

  it('with CLAUDE_CONFIG_DIR, unadopt --all reads the moved .claude.json', () => {
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ projects: { [app()]: {} } }));
    silentAutoAdopt({ cwd: app() });
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      withCwd(home, () => cmdUnadopt(['--all']));
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('an opt-out written under ~/.claude before CLAUDE_CONFIG_DIR was honoured still holds', () => {
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    const legacy = join(home, '.claude', 'projects', app().replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(disableSentinelPath(legacy), '{}');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      expect(silentAutoAdopt({ cwd: app() }).action).toBe('disabled');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('--dry-run and --status name the local file', () => {
    silentAutoAdopt({ cwd: app() });
    expect(withCwd(app(), () => captureLog(() => cmdUnadopt(['--dry-run'])))).toMatch(
      /would-remove the block in .*CLAUDE\.local\.md/,
    );
    expect(withCwd(app(), () => captureLog(() => cmdAdopt(['--status'])))).toMatch(
      /local: +✓ .*CLAUDE\.local\.md/,
    );
    expect(existsSync(join(app(), LOCAL_MD))).toBe(true);
  });
});
