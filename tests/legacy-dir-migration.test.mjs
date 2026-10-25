// D#561: the migration of the unhidden data dir (~/claude-mem-lite/, before the first release)
// moves only a store, and only into a data dir that holds none of a store's files. It used to
// remove a data dir holding no `*.db` name and rename ~/claude-mem-lite into its place: after the
// set-aside command that took the kept file, and a `git clone` of this repository run from ~ is at
// that path. Each case opens the store in a child, since DB_DIR is fixed from CLAUDE_MEM_DIR when
// lib/data-paths.mjs is first imported.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { migrateLegacyClaudeMemData } from '../install.mjs';
import { pathWithClaudeStub } from './claude-stub.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_URL = pathToFileURL(join(REPO, 'schema.mjs')).href;
const roots = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cml-legacy-dir-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home, legacy: join(home, 'claude-mem-lite'), dataDir: join(home, '.claude-mem-lite') };
}

function childEnv(home, dataDir) {
  const env = { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_SKIP_UPDATE: '1' };
  delete env.CLAUDE_MEM_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENROUTER_API_KEY;
  if (dataDir) env.CLAUDE_MEM_DIR = dataDir;
  return env;
}

/** The product's ensureDb, once, in a child whose HOME (and CLAUDE_MEM_DIR, when given) is the sandbox's. */
function openStore(home, dataDir) {
  const code = `const s = await import(${JSON.stringify(SCHEMA_URL)}); s.ensureDb().close();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: childEnv(home, dataDir),
    encoding: 'utf8',
    timeout: 60000,
  });
  expect(r.status, r.stderr).toBe(0);
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** relative path → sha1 of every file under dir. */
function listing(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha1').update(readFileSync(p)).digest('hex');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Every file listed before is still there with the same bytes. */
function expectKept(dir, before) {
  const after = listing(dir);
  for (const [name, sum] of Object.entries(before)) expect(after[name], `${dir}/${name}`).toBe(sum);
}

/**
 * A store holding one observation titled `marker`. walOnly: the row is only in the store's -wal
 * (copied while the writer still holds it, so no checkpoint has moved it into the main file).
 */
function writeStore(path, marker, { walOnly = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'cml-legacy-store-'));
  roots.push(work);
  const live = join(work, 'live.db');
  const db = new Database(live);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  initSchema(db);
  db.prepare(
    "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch) VALUES ('c-s1','s1','p',datetime('now'),1)",
  ).run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare(
    "INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch) VALUES ('s1','p','discovery',?,'n',datetime('now'),1)",
  ).run(marker);
  if (!walOnly) db.pragma('wal_checkpoint(TRUNCATE)');
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(live, path);
  if (walOnly) copyFileSync(`${live}-wal`, `${path}-wal`);
  db.close();
}

function markers(dbPath, marker) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT count(*) FROM observations WHERE title = ?').pluck().get(marker);
  } finally {
    db.close();
  }
}

/** A clone of this repository at ~/claude-mem-lite. */
function writeClone(dir) {
  write(join(dir, 'README.md'), '# claude-mem-lite\n');
  write(join(dir, 'package.json'), '{"name":"claude-mem-lite"}\n');
  write(join(dir, 'hook.mjs'), '// clone\n');
}

/** A data dir holding a kept copy of a broken store, its log and a snapshot. */
function writeSetAside(dir) {
  write(join(dir, 'claude-mem-lite.db.corrupt-2026-10-01T00-00-00-000Z'), 'broken store bytes');
  write(join(dir, 'claude-mem-lite.db.corrupt-2026-10-01T00-00-00-000Z-wal'), 'broken log bytes');
  write(join(dir, 'claude-mem-lite.db.pre-delete-2026-10-01T00-00-00-000Z-1-1.bak'), 'snapshot bytes');
}

describe('the unhidden-dir migration moves only a store, and deletes nothing (D#561)', () => {
  // FAILS IF the open removes a data dir that holds no `*.db` name: the kept file, its log and the
  // snapshot go, and the clone takes the data dir's place.
  it('a clone beside a set-aside data dir: both stay byte for byte', () => {
    const { home, legacy, dataDir } = sandbox();
    writeClone(legacy);
    writeSetAside(dataDir);
    const clone = listing(legacy);
    const data = listing(dataDir);
    openStore(home);
    expectKept(legacy, clone);
    expectKept(dataDir, data);
    expect(existsSync(join(dataDir, 'claude-mem-lite.db'))).toBe(true);
  });

  // FAILS IF the code a direct install copied into the data dir (it is the code dir when
  // CLAUDE_MEM_DIR is unset) is removed because no store exists there yet.
  it('a clone beside a data dir holding only code: both stay', () => {
    const { home, legacy, dataDir } = sandbox();
    writeClone(legacy);
    write(join(dataDir, 'hook.mjs'), '// installed\n');
    write(join(dataDir, 'package.json'), '{"name":"claude-mem-lite","version":"6.30.5"}\n');
    write(join(dataDir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
    const clone = listing(legacy);
    const data = listing(dataDir);
    openStore(home);
    expectKept(legacy, clone);
    expectKept(dataDir, data);
  });

  // FAILS IF the store's -wal stays behind (its rows are lost) or the migration still moves the
  // whole directory (the legacy dir's other files go with it).
  it('a legacy store with rows only in its -wal, no data dir: the rows move, nothing else does', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-wal-row', { walOnly: true });
    expect(existsSync(join(legacy, 'claude-mem-lite.db-wal'))).toBe(true); // premise
    write(join(legacy, 'runtime', 'keep.txt'), 'runtime file');
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-wal-row')).toBe(1);
    expect(existsSync(join(legacy, 'claude-mem-lite.db'))).toBe(false);
    expect(readFileSync(join(legacy, 'runtime', 'keep.txt'), 'utf8')).toBe('runtime file');
  });

  // FAILS IF the old file name is not looked for, or if the data dir's own files are removed to
  // make room.
  it('a legacy claude-mem.db and a data dir holding other files: the store moves under the new name', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem.db'), 'legacy-old-name');
    write(join(dataDir, 'runtime', 'early.txt'), 'made before the open');
    const data = listing(dataDir);
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-old-name')).toBe(1);
    expectKept(dataDir, data);
  });

  // FAILS IF a legacy store is moved into a data dir that already holds a store's files: the
  // set-aside state would get an old store put in front of it, and the old predicate (a name
  // ending in .db) does not see snapshots or kept files.
  it('a legacy store beside a data dir holding a snapshot: nothing moves', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-stays');
    write(join(dataDir, 'claude-mem-lite.db.pre-delete-2026-10-01T00-00-00-000Z-1-1.bak'), 'snapshot bytes');
    const old = listing(legacy);
    const data = listing(dataDir);
    openStore(home);
    expectKept(legacy, old);
    expectKept(dataDir, data);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-stays')).toBe(0);
  });

  // FAILS IF a data dir holding a current store under the old name (claude-mem.db, which the same
  // open renames) counts as holding none: the legacy store moves in under the new name and the
  // current one is never opened (v6.30.6 r2 P3-3: dropping that prefix from the check passed every
  // case of this file).
  it('a legacy store beside a data dir holding claude-mem.db: nothing moves, that store opens', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-not-this-one');
    writeStore(join(dataDir, 'claude-mem.db'), 'current-old-name');
    const old = listing(legacy);
    openStore(home);
    expectKept(legacy, old);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'current-old-name')).toBe(1);
  });

  // FAILS IF the backup install makes of an original claude-mem store (~/.claude-mem) counts as one
  // of this store's files: the unhidden dir's store stays behind and the open creates an empty one.
  it('a legacy store beside a data dir holding only the claude-mem backup: the store moves', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-beside-backup');
    const claudeMem = join(home, '.claude-mem');
    write(join(claudeMem, 'claude-mem.db'), 'original claude-mem store');
    write(join(claudeMem, 'claude-mem.db-wal'), 'original claude-mem log');
    write(join(claudeMem, 'claude-mem.db-shm'), 'original claude-mem shm');
    expect(migrateLegacyClaudeMemData(claudeMem, dataDir).action).toBe('backed-up'); // premise
    const data = listing(dataDir);
    expect(Object.keys(data)).toHaveLength(3); // premise: the backup, its log and its -shm
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-beside-backup')).toBe(1);
    expectKept(dataDir, data);
  });

  // FAILS IF the names an earlier version gave the claude-mem backup's log and shared-memory file
  // (`claude-mem-lite.db-wal.legacy-backup-<ms>`, before D#584) count as this store's files.
  it('a legacy store beside a claude-mem backup named as earlier versions name it: the store moves', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-beside-old-backup');
    write(join(dataDir, 'claude-mem-lite.db.legacy-backup-1700000000000'), 'original claude-mem store');
    write(join(dataDir, 'claude-mem-lite.db-wal.legacy-backup-1700000000000'), 'original claude-mem log');
    write(join(dataDir, 'claude-mem-lite.db-shm.legacy-backup-1700000000000'), 'original claude-mem shm');
    const data = listing(dataDir);
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-beside-old-backup')).toBe(1);
    expectKept(dataDir, data);
  });

  // FAILS IF the relocated data dir gets the same removal as the default one.
  it('under CLAUDE_MEM_DIR: a clone beside a set-aside data dir both stay', () => {
    const { root, home, legacy } = sandbox();
    const dataDir = join(root, 'relocated');
    writeClone(legacy);
    writeSetAside(dataDir);
    const clone = listing(legacy);
    const data = listing(dataDir);
    openStore(home, dataDir);
    expectKept(legacy, clone);
    expectKept(dataDir, data);
  });

  // FAILS IF install, under relocation (its code dir does not exist yet), renames ~/claude-mem-lite
  // into the code dir.
  it('install under CLAUDE_MEM_DIR leaves a clone at ~/claude-mem-lite in place', () => {
    const { root, home, legacy } = sandbox();
    writeClone(legacy);
    const clone = listing(legacy);
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'install', '--dev'], {
      encoding: 'utf8',
      cwd: root,
      timeout: 120000,
      env: {
        ...childEnv(home, join(root, 'data')),
        PATH: pathWithClaudeStub(root),
        CLAUDE_MEM_SKIP_REPOS: '1',
      },
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expectKept(legacy, clone);
  }, 130000);
});

/**
 * The plugin's SessionStart script, run from this repository against a plugin root holding a stub
 * better-sqlite3 and the binding marker (as tests/setup-sh-legacy-db-relocation.test.mjs does), so
 * it neither installs nor symlinks anything into the repository.
 */
function runSetup(root, home, dataDir) {
  const plugin = join(root, 'plugin-root');
  mkdirSync(join(plugin, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(plugin, 'node_modules', `.mem-binding-ok-${process.versions.modules}`), '');
  mkdirSync(join(plugin, 'lib'), { recursive: true });
  copyFileSync(join(REPO, 'lib', 'resolve-data-dir.mjs'), join(plugin, 'lib', 'resolve-data-dir.mjs'));
  const r = spawnSync('bash', [join(REPO, 'scripts', 'setup.sh')], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...childEnv(home, dataDir), CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_MEM_RUNTIME_DIR: '' },
  });
  expect(r.status, r.stderr).toBe(0);
}

describe("the plugin's setup.sh leaves ~/claude-mem-lite where it is (D#568)", () => {
  // FAILS IF setup.sh still moves ~/claude-mem-lite into a missing ~/.claude-mem-lite: the clone,
  // uncommitted files included, becomes the code dir that the documented uninstall deletes.
  it('a clone at ~/claude-mem-lite and no ~/.claude-mem-lite: the clone stays', () => {
    const { root, home, legacy, dataDir } = sandbox();
    writeClone(legacy);
    write(join(legacy, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(join(legacy, 'MY-UNCOMMITTED-NOTES.txt'), 'work in progress');
    const clone = listing(legacy);
    runSetup(root, home);
    expect(listing(legacy)).toEqual(clone);
    expect(existsSync(join(dataDir, 'MY-UNCOMMITTED-NOTES.txt'))).toBe(false);
  });

  // FAILS IF dropping setup.sh's move strands a store from before the first release: the plugin's
  // session start (setup.sh, then the first open) must still bring its rows into the data dir.
  it('a legacy store and no ~/.claude-mem-lite: setup.sh then the first open move the store only', () => {
    const { root, home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-via-plugin', { walOnly: true });
    write(join(legacy, 'runtime', 'keep.txt'), 'runtime file');
    runSetup(root, home);
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-via-plugin')).toBe(1);
    expect(readFileSync(join(legacy, 'runtime', 'keep.txt'), 'utf8')).toBe('runtime file');
  });
});
