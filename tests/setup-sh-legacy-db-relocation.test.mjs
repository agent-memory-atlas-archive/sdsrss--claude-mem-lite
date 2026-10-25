// scripts/setup.sh's two database-migration blocks must act on the directory the database
// actually lives in.
//
// setup.sh carried ONE variable, DATA_DIR = "$HOME/.claude-mem-lite", for what
// lib/data-paths.mjs splits into three: DB_DIR (follows CLAUDE_MEM_DIR), CODE_DIR (always
// homedir, because settings.json bakes absolute paths to server.mjs) and the runtime dir.
// Under CLAUDE_MEM_DIR that single variable is the CODE dir, so both migration blocks asked
// their question of a directory holding no database:
//
//   * the claude-mem.db -> claude-mem-lite.db rename never fired, so a relocated user
//     upgrading across that rename kept a database nothing opens;
//   * the legacy ~/.claude-mem/ backup is gated on "no claude-mem-lite.db here yet", and
//     under relocation nothing ever creates one THERE — the product creates it in the
//     relocated dir. Measured 2026-09-14: control arm 1 backup and stable across three
//     SessionStarts; relocated arm 1 -> 3, i.e. one full copy of the legacy database per
//     session start, without bound.
//
// This repo has now had the same DB_DIR/CODE_DIR confusion three times (v6.3.0, then the
// same fix reintroduced with the halves swapped, then here), so the arms below assert the
// two directories separately rather than trusting one to stand in for the other.
//
// Expressed as single-run assertions on purpose: counting timestamped backups needs the
// clock to tick between runs, and a guard that has to sleep to say NO is a slow guard.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETUP_SH = join(REPO_ROOT, 'scripts', 'setup.sh');

let sandbox;

// Same healthy-dependency fixture as tests/setup-sh-deps-flag-relocation.test.mjs: a stub
// better-sqlite3 directory plus the ABI marker send setup.sh down mark_deps_ok without an
// npm call or a binding probe, and lib/ is present because every shipped shape has it.
function makeHealthyRoot() {
  const root = join(sandbox, 'plugin-root');
  mkdirSync(join(root, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(root, 'node_modules', `.mem-binding-ok-${process.versions.modules}`), '');
  mkdirSync(join(root, 'lib'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'lib', 'resolve-data-dir.mjs'), join(root, 'lib', 'resolve-data-dir.mjs'));
  return root;
}

function runSetup({ home, dataDir }) {
  return spawnSync('bash', [SETUP_SH], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_ROOT: makeHealthyRoot(),
      CLAUDE_MEM_DIR: dataDir ?? '',
      CLAUDE_MEM_RUNTIME_DIR: '',
      MEM_NO_AUTO_ADOPT: '1',
    },
  });
}

function legacyBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('claude-mem-lite.db.legacy-backup-'));
}

/** The main file of each backup, without its log: `claude-mem-lite.db.legacy-backup-<s>`. */
function mainBackups(dir) {
  return legacyBackups(dir).filter((f) => /^claude-mem-lite\.db\.legacy-backup-\d+$/.test(f));
}

/** An original claude-mem store whose 40 rows are only in its -wal, copied while the writer holds them. */
function plantWalOnlyClaudeMem(home) {
  const dir = join(home, '.claude-mem');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(sandbox, 'live.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t (x)');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const insert = db.prepare('INSERT INTO t VALUES (?)');
  for (let i = 0; i < 40; i++) insert.run(i);
  copyFileSync(join(sandbox, 'live.db'), join(dir, 'claude-mem.db'));
  copyFileSync(join(sandbox, 'live.db-wal'), join(dir, 'claude-mem.db-wal'));
  db.close();
}

/** A legacy claude-mem install sitting in the home directory, as a real one would. */
function plantLegacyClaudeMem(home) {
  mkdirSync(join(home, '.claude-mem'), { recursive: true });
  writeFileSync(join(home, '.claude-mem', 'claude-mem.db'), 'LEGACY-DB-BYTES');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mem-setup-legacydb-'));
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('setup.sh database migrations under CLAUDE_MEM_DIR', () => {
  it('control: the legacy-backup block still fires when there is no database yet', () => {
    // Without this arm, every "no backup was written" assertion below could pass because the
    // block is unreachable in this fixture rather than because the guard closed.
    const home = join(sandbox, 'home');
    mkdirSync(home, { recursive: true });
    plantLegacyClaudeMem(home);

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(legacyBackups(join(home, '.claude-mem-lite'))).toHaveLength(1);
  });

  it('control: an existing database in the same dir closes the guard', () => {
    const home = join(sandbox, 'home');
    mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
    plantLegacyClaudeMem(home);
    writeFileSync(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), 'CURRENT');

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(legacyBackups(join(home, '.claude-mem-lite'))).toHaveLength(0);
  });

  it('a backup it already made closes the guard while no database exists yet (D#573)', () => {
    // While every open failed before creating the database (D#569: the unhidden-dir move threw
    // EXDEV), the "no database yet" guard never closed and each session start added another full
    // copy of the claude-mem store. The backup is this block's own output, so it closes it too.
    const home = join(sandbox, 'home');
    const dataDir = join(home, '.claude-mem-lite');
    mkdirSync(dataDir, { recursive: true });
    plantLegacyClaudeMem(home);
    writeFileSync(join(dataDir, 'claude-mem-lite.db.legacy-backup-1700000000'), 'LEGACY-DB-BYTES');

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(legacyBackups(dataDir)).toEqual(['claude-mem-lite.db.legacy-backup-1700000000']);
  });

  // A data dir whose path holds glob characters: the guard matched its backups as a pattern, so a
  // `[1]` in the path never matched its own backup and the copy repeated (v6.30.7 r1 defects P3-2).
  it('a backup it already made closes the guard under a data dir named with brackets', () => {
    const home = join(sandbox, 'home');
    const relocated = join(sandbox, 'data[1]');
    mkdirSync(home, { recursive: true });
    mkdirSync(relocated, { recursive: true });
    plantLegacyClaudeMem(home);
    writeFileSync(join(relocated, 'claude-mem-lite.db.legacy-backup-1700000000'), 'LEGACY-DB-BYTES');

    const r = runSetup({ home, dataDir: relocated });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(legacyBackups(relocated)).toEqual(['claude-mem-lite.db.legacy-backup-1700000000']);
  });

  // D#584: the copy took the database without its -wal, so the backup lacked the rows only in the
  // log, and a later install across filesystems skipped its own copy because this one was there.
  it('the backup takes the log under the name SQLite pairs with it, and reads the rows only in it', () => {
    const home = join(sandbox, 'home');
    const dataDir = join(home, '.claude-mem-lite');
    plantWalOnlyClaudeMem(home);

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    const [main, ...more] = mainBackups(dataDir);
    expect(more).toEqual([]);
    expect(
      readdirSync(dataDir)
        .filter((f) => f.includes('legacy-backup'))
        .sort(),
    ).toEqual([main, `${main}-wal`]);
    const db = new Database(join(dataDir, main), { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) FROM t').pluck().get()).toBe(40);
    } finally {
      db.close();
    }
    expect(existsSync(join(home, '.claude-mem', 'claude-mem.db-wal')), 'the source stays').toBe(true);
  });

  // A copy killed between placing the log and placing the database leaves the log alone; it
  // starts with the backup's own name.
  it('a backup log without its database does not close the guard', () => {
    const home = join(sandbox, 'home');
    const dataDir = join(home, '.claude-mem-lite');
    mkdirSync(dataDir, { recursive: true });
    plantLegacyClaudeMem(home);
    writeFileSync(join(dataDir, 'claude-mem-lite.db.legacy-backup-1700000000-wal'), 'a log alone');

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(mainBackups(dataDir)).toHaveLength(1);
  });

  // The copy is written under a private name first; a session start killed partway leaves that
  // name, a partial copy of the store. One whose process still runs is another session's copy.
  it('removes a private copy whose process has exited, and keeps one whose process runs', () => {
    const home = join(sandbox, 'home');
    const dataDir = join(home, '.claude-mem-lite');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'claude-mem-lite.db'), 'CURRENT');
    const dead = `.legacy-backup-copy-${spawnSync(process.execPath, ['-e', '']).pid}-1600000000`;
    const live = `.legacy-backup-copy-${process.pid}-1600000000`;
    for (const n of [dead, `${dead}-wal`, live]) writeFileSync(join(dataDir, n), 'part of a copy');

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(readdirSync(dataDir).filter((f) => f.startsWith('.legacy-backup-copy-'))).toEqual([live]);
  });

  // A session start killed partway (the hook's 30 s cap) must leave no backup, or the guard closes
  // on a partial one for good: killed while copying the database, before placing its log, and
  // between placing the log and placing the database. Copying straight to the backup name, or
  // placing the database before its log, leaves a backup the next session start does not redo.
  it.each([
    ['while copying the database', 'cp', '"$1"', '/claude-mem\\.db$'],
    ['before placing the log', 'mv', '"${@: -1}"', '-wal$'],
    [
      'between placing the log and the database',
      'mv',
      '"${@: -1}"',
      '/claude-mem-lite\\.db\\.legacy-backup-[0-9]+$',
    ],
  ])('a session start killed %s leaves no backup, and the next one makes it whole', (_l, tool, arg, re) => {
    const home = join(sandbox, 'home');
    const dataDir = join(home, '.claude-mem-lite');
    plantWalOnlyClaudeMem(home);
    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    const real = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    // The wrapper stands in for the hook runner's kill: it kills the script that called it, a copy
    // after writing part of the file, a rename before renaming.
    const partial = tool === 'cp' ? 'head -c 100 "$1" > "${@: -1}"; ' : '';
    writeFileSync(
      join(bin, tool),
      `#!/bin/bash\nif [[ ${arg} =~ ${re} ]]; then ${partial}kill -9 $PPID; exit 1; fi\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const killed = spawnSync('bash', [SETUP_SH], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: makeHealthyRoot(),
        CLAUDE_MEM_DIR: '',
        CLAUDE_MEM_RUNTIME_DIR: '',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
    expect(killed.signal, 'premise: the session start was killed').toBe('SIGKILL');
    expect(mainBackups(dataDir)).toEqual([]);

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    const [main, ...more] = mainBackups(dataDir);
    expect(more).toEqual([]);
    const db = new Database(join(dataDir, main), { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) FROM t').pluck().get()).toBe(40);
    } finally {
      db.close();
    }
    expect(readdirSync(dataDir).filter((f) => f.startsWith('.legacy-backup-copy-'))).toEqual([]);
  });

  it('writes no legacy backup when the RELOCATED dir already holds a database', () => {
    // The unbounded-copy bug stated as one run: this user has a working relocated install,
    // so the legacy backup has nothing to offer and must not be written — anywhere. Before
    // the fix the guard looked at $HOME, saw no database, and copied on every SessionStart.
    const home = join(sandbox, 'home');
    const relocated = join(sandbox, 'relocated-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(relocated, { recursive: true });
    plantLegacyClaudeMem(home);

    // Placed through the product's own resolver rather than by spelling the path out here.
    const dbDir = resolveDataDir(relocated);
    expect(dbDir).toBe(relocated);
    writeFileSync(join(dbDir, 'claude-mem-lite.db'), 'CURRENT');

    const r = runSetup({ home, dataDir: relocated });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(legacyBackups(join(home, '.claude-mem-lite'))).toHaveLength(0);
    expect(legacyBackups(relocated)).toHaveLength(0);
  });

  it('renames claude-mem.db in the RELOCATED dir, not in the home dir', () => {
    const home = join(sandbox, 'home');
    const relocated = join(sandbox, 'relocated-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(relocated, { recursive: true });
    writeFileSync(join(relocated, 'claude-mem.db'), 'OLD-NAME');
    writeFileSync(join(relocated, 'claude-mem.db-wal'), 'OLD-WAL');

    const r = runSetup({ home, dataDir: relocated });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(join(relocated, 'claude-mem-lite.db'))).toBe(true);
    expect(readFileSync(join(relocated, 'claude-mem-lite.db'), 'utf8')).toBe('OLD-NAME');
    expect(existsSync(join(relocated, 'claude-mem.db'))).toBe(false);
    // The sidecars have to travel with it — a renamed database beside its old -wal is a
    // half-migrated store, not a migrated one.
    expect(existsSync(join(relocated, 'claude-mem-lite.db-wal'))).toBe(true);
  });

  it('leaves the code dir alone: node_modules and the run-once markers stay in $HOME', () => {
    // The other half of the split. CODE_DIR must NOT follow the relocation — settings.json
    // and the MCP registration bake absolute paths under $HOME/.claude-mem-lite — and the
    // two one-shot markers are state about this machine's install, so relocating either
    // would re-run what it gated (one of them edits ~/.claude.json).
    const home = join(sandbox, 'home');
    const relocated = join(sandbox, 'relocated-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(relocated, { recursive: true });

    const r = runSetup({ home, dataDir: relocated });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    const codeRuntime = join(home, '.claude-mem-lite', 'runtime');
    expect(existsSync(join(codeRuntime, '.mcp-dedup-v2.78'))).toBe(true);
    expect(existsSync(join(codeRuntime, '.residue-warned-v2.55'))).toBe(true);
    expect(existsSync(join(relocated, 'runtime', '.mcp-dedup-v2.78'))).toBe(false);
  });
});
