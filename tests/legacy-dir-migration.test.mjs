// D#561: the migration of the unhidden data dir (~/claude-mem-lite/, before v0.5) moves only a
// store, and only into a data dir that holds none of a store's files. It used to remove a data dir
// holding no `*.db` name and rename ~/claude-mem-lite into its place: after the set-aside command
// that took the kept file and every snapshot, and README method 3 (`git clone` run from ~) puts a
// clone of this repository at that path. Each case opens the store in a child, since DB_DIR is
// fixed from CLAUDE_MEM_DIR when lib/data-paths.mjs is first imported.
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

/** A clone of this repository, as README method 3 leaves it at ~/claude-mem-lite. */
function writeClone(dir) {
  write(join(dir, 'README.md'), '# claude-mem-lite\n');
  write(join(dir, 'package.json'), '{"name":"claude-mem-lite"}\n');
  write(join(dir, 'hook.mjs'), '// clone\n');
}

/** The data dir after the set-aside command: the kept file and its log, and a snapshot. */
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
  // into the code dir: that is the clone the install runs from in README method 3.
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
