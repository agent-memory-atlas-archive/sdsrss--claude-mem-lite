// D#561: the migration of the unhidden data dir (~/claude-mem-lite/, before the first release)
// moves only a store, and only into a data dir that holds none of a store's files. It used to
// remove a data dir holding no `*.db` name and rename ~/claude-mem-lite into its place: after the
// set-aside command that took the kept file, and a `git clone` of this repository run from ~ is at
// that path. Each case opens the store in a child, since DB_DIR is fixed from CLAUDE_MEM_DIR when
// lib/data-paths.mjs is first imported.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { homedir, tmpdir } from 'node:os';
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

/**
 * The product's ensureDb, once, in a child whose HOME (and CLAUDE_MEM_DIR, when given) is the
 * sandbox's. shim: a mode for the fs preload below. Returns the child's result; `expectOk: false`
 * leaves its exit status to the caller.
 */
function openStore(home, dataDir, { shim, expectOk = true, env: extra = {} } = {}) {
  const code = `const s = await import(${JSON.stringify(SCHEMA_URL)}); s.ensureDb().close();`;
  const env = { ...childEnv(home, dataDir), ...extra };
  const args = ['--input-type=module', '-e', code];
  if (shim) {
    const preload = join(dirname(home), 'fs-shim.mjs');
    writeFileSync(preload, FS_SHIM);
    Object.assign(env, {
      SHIM_MODE: shim,
      SHIM_DATA_DIR: dataDir ?? join(home, '.claude-mem-lite'),
      SHIM_OPENER: `const s = await import(${JSON.stringify(SCHEMA_URL)}); const db = s.ensureDb(); db.prepare("INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch) VALUES ('s1','p','discovery','between','n',datetime('now'),2)").run(); db.close();`,
    });
    args.unshift('--import', pathToFileURL(preload).href);
  }
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
  if (expectOk) expect(r.status, r.stderr).toBe(0);
  return r;
}

/**
 * Preloaded into the child: another opener acts at the moment the first store file reaches the data
 * dir (by link or rename), before the call that puts it there.
 * - before-place: it has already put a store of its own there (one holding the observation 'other').
 * - after-place: right after that file lands, it opens the store, writes the observation 'between'
 *   and closes; then the move goes on.
 * - no-link: link(2) fails as on a filesystem without hard links.
 * - header: bytes 18 and 19 of the file as it landed go to SHIM_HEADER_OUT (2,2 is WAL mode).
 */
const FS_SHIM = `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const dataDir = process.env.SHIM_DATA_DIR + '/';
const mode = process.env.SHIM_MODE;
let fired = false;
const intoDataDir = (dest) => String(dest).startsWith(dataDir) && /\\/claude-mem(-lite)?\\.db$/.test(String(dest));
for (const name of ['linkSync', 'renameSync']) {
  const real = fs[name];
  fs[name] = function (src, dest) {
    if (mode === 'no-link' && name === 'linkSync') throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
    if (!fired && intoDataDir(dest)) {
      fired = true;
      if (mode === 'before-place') fs.copyFileSync(process.env.SHIM_OTHER_STORE, dataDir + 'claude-mem-lite.db');
      const out = real(src, dest);
      if (mode === 'header') fs.writeFileSync(process.env.SHIM_HEADER_OUT, fs.readFileSync(dest).subarray(18, 20).join(','));
      if (mode === 'after-place') {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', process.env.SHIM_OPENER], { env: process.env, encoding: 'utf8' });
        if (r.status !== 0) throw new Error('the other opener failed: ' + r.stderr);
      }
      return out;
    }
    return real(src, dest);
  };
}
syncBuiltinESMExports();
`;

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
    expect(migrateLegacyClaudeMemData(claudeMem, dataDir).action).toBe('backed-up'); // premise
    const data = listing(dataDir);
    expect(Object.keys(data)).toHaveLength(2); // premise: the backup and its log
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-beside-backup')).toBe(1);
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

/** Two writable directories on different devices (here /tmp is a tmpfs; a CI runner has /dev/shm). */
function dirsOnTwoFilesystems() {
  const made = [];
  for (const r of [tmpdir(), '/dev/shm', join(homedir(), '.cache')]) {
    try {
      made.push(mkdtempSync(join(r, 'cml-legacy-xdev-')));
    } catch {
      /* not there, or not writable */
    }
  }
  roots.push(...made);
  for (const a of made) for (const b of made) if (statSync(a).dev !== statSync(b).dev) return [a, b];
  return null;
}
const twoFilesystems = (() => {
  const pair = dirsOnTwoFilesystems();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  return pair !== null;
})();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const STORE_FILES = ['claude-mem-lite.db', 'claude-mem-lite.db-wal', 'claude-mem-lite.db-shm'];
const leftInOldDir = (legacy) => STORE_FILES.filter((n) => existsSync(join(legacy, n)));
const privateCopies = (dataDir) => readdirSync(dataDir).filter((n) => n.startsWith('.unhidden-move-'));
const integrity = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('PRAGMA integrity_check(1)').pluck().get();
  } finally {
    db.close();
  }
};

// D#580 (D#569's second attempt). The store and its -wal used to reach the data dir in two renames
// (three with the -shm), and across filesystems the first threw EXDEV and every open failed. The
// first attempt copied them across and still put the store and its log in place in two steps, so an
// opener in between had the old log replayed over its writes (v6.30.7 r2 P2-1), and a slower opener
// could put its copy over a store another one had placed (P2-2). Now SQLite copies the store into
// one file in the data dir (VACUUM INTO, which carries the -wal's rows) and link(2) puts it in
// place, failing if a store is already there; only then do the old files go.
describe('the unhidden-dir move puts the store in place in one step (D#580)', () => {
  // FAILS IF the move across filesystems fails the open (EXDEV), leaves the -wal's rows behind, or
  // leaves the old files or a private copy.
  it.skipIf(!twoFilesystems)('across filesystems: the rows arrive, and the old store files go', () => {
    const [a, b] = dirsOnTwoFilesystems();
    const home = join(a, 'home');
    const legacy = join(home, 'claude-mem-lite');
    const dataDir = join(b, 'data');
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-xdev', { walOnly: true });
    write(join(legacy, 'runtime', 'keep.txt'), 'runtime file');
    openStore(home, dataDir);
    openStore(home, dataDir);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-xdev')).toBe(1);
    expect(leftInOldDir(legacy)).toEqual([]);
    expect(privateCopies(dataDir)).toEqual([]);
    expect(readFileSync(join(legacy, 'runtime', 'keep.txt'), 'utf8')).toBe('runtime file');
  });

  // FAILS IF the store arrives in rollback mode, which VACUUM INTO writes: openers racing to switch
  // it to WAL got SQLITE_BUSY from `journal_mode = WAL` (1 run in 11 of the four-opener case below).
  // The store it replaces was in WAL mode, so that pragma changed nothing.
  it('the store arrives in WAL mode, with no file of the private copy beside it', () => {
    const { root, home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-wal-mode', { walOnly: true });
    const header = join(root, 'header.txt');
    openStore(home, undefined, { shim: 'header', env: { SHIM_HEADER_OUT: header } });
    expect(readFileSync(header, 'utf8'), 'bytes 18 and 19 of the file as it landed').toBe('2,2');
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-wal-mode')).toBe(1);
    expect(readdirSync(dataDir).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  // FAILS IF the store and its log arrive in two steps: an opener between them writes to the store,
  // and the old log placed after it is replayed over those writes (v6.30.7 r2 P2-1).
  it('another opener writing as soon as the store arrives keeps its row and the old ones', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-wal-row', { walOnly: true });
    openStore(home, undefined, { shim: 'after-place' });
    openStore(home);
    const db = join(dataDir, 'claude-mem-lite.db');
    expect(integrity(db)).toBe('ok');
    expect(markers(db, 'legacy-wal-row')).toBe(1);
    expect(markers(db, 'between')).toBe(1);
  });

  // FAILS IF the move puts its copy over a store another opener placed first (v6.30.7 r2 P2-2:
  // existsSync, then a rename that replaces), or removes the old files when it placed nothing.
  it('a store another opener placed first stays, and the old files stay for it', () => {
    const { root, home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-second', { walOnly: true });
    const other = join(root, 'other.db');
    writeStore(other, 'other');
    const old = listing(legacy);
    openStore(home, undefined, { shim: 'before-place', env: { SHIM_OTHER_STORE: other } });
    const db = join(dataDir, 'claude-mem-lite.db');
    expect(markers(db, 'other')).toBe(1);
    expect(markers(db, 'legacy-second')).toBe(0);
    expect(privateCopies(dataDir)).toEqual([]);
    for (const n of Object.keys(old).filter(
      (k) => k === 'claude-mem-lite.db' || k === 'claude-mem-lite.db-wal',
    )) {
      expect(listing(legacy)[n], n).toBe(old[n]);
    }
  });

  // FAILS IF a filesystem without hard links fails every open.
  it('without hard links: the copy is renamed into place', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-no-link', { walOnly: true });
    openStore(home, undefined, { shim: 'no-link' });
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-no-link')).toBe(1);
    expect(leftInOldDir(legacy)).toEqual([]);
    expect(privateCopies(dataDir)).toEqual([]);
  });

  // FAILS IF a read-only ~/claude-mem-lite fails every open (the rename's EACCES) once SQLite can
  // read the store there: the rows are copied and the old files, which cannot go, stay.
  it.skipIf(isRoot)('a read-only old dir: the rows arrive and the old files stay', () => {
    const { home, legacy, dataDir } = sandbox();
    const old = join(legacy, 'claude-mem-lite.db');
    writeStore(old, 'legacy-read-only', { walOnly: true });
    const ro = new Database(old, { readonly: true });
    ro.prepare('SELECT count(*) FROM observations').get();
    ro.close();
    expect(existsSync(`${old}-shm`), 'premise: a reader left its -shm').toBe(true);
    chmodSync(legacy, 0o555);
    try {
      openStore(home);
      openStore(home);
    } finally {
      chmodSync(legacy, 0o755);
    }
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-read-only')).toBe(1);
    expect(existsSync(old)).toBe(true);
  });

  // FAILS IF a store SQLite cannot open in place is taken as moved by another opener: the open would
  // create an empty store in the data dir and leave the rows behind without a word. As before, the
  // move fails the open, and the old store stays whole.
  it.skipIf(isRoot)(
    'a read-only old dir with no -shm: as before, the open fails and the old store stays',
    () => {
      const { home, legacy, dataDir } = sandbox();
      writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-cannot-open', { walOnly: true });
      const old = listing(legacy);
      chmodSync(legacy, 0o555);
      let r;
      try {
        r = openStore(home, undefined, { expectOk: false });
      } finally {
        chmodSync(legacy, 0o755);
      }
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/EACCES/);
      expect(listing(legacy)).toEqual(old);
      expect(existsSync(join(dataDir, 'claude-mem-lite.db'))).toBe(false);
    },
  );

  // FAILS IF the fallback for a store SQLite cannot read changed: it is moved into the data dir as
  // before, where doctor finds it.
  it('a file SQLite cannot read is moved as before', () => {
    const { home, legacy, dataDir } = sandbox();
    write(join(legacy, 'claude-mem-lite.db'), 'not a database at all '.repeat(50));
    const r = openStore(home, undefined, { expectOk: false });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a database/);
    expect(readFileSync(join(dataDir, 'claude-mem-lite.db'), 'utf8')).toMatch(/^not a database at all/);
    expect(privateCopies(dataDir)).toEqual([]);
  });

  // FAILS IF a private copy a killed move left is never removed (each is a whole copy of the store),
  // or one a running opener is still writing is removed.
  it('removes a private copy a killed move left, and keeps a running one', () => {
    const { home, legacy, dataDir } = sandbox();
    writeStore(join(legacy, 'claude-mem-lite.db'), 'legacy-after-kill');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    write(join(dataDir, `.unhidden-move-${dead}-0a1b2c3d`), 'half a copy');
    write(join(dataDir, `.unhidden-move-${process.pid}-0a1b2c3d`), 'a copy being written');
    openStore(home);
    expect(markers(join(dataDir, 'claude-mem-lite.db'), 'legacy-after-kill')).toBe(1);
    expect(privateCopies(dataDir)).toEqual([`.unhidden-move-${process.pid}-0a1b2c3d`]);
  });

  it('four first opens at once: one store, every row, nothing left behind', async () => {
    for (let trial = 0; trial < 3; trial++) {
      const { home, legacy, dataDir } = sandbox();
      writeStore(join(legacy, 'claude-mem-lite.db'), `legacy-race-${trial}`, { walOnly: true });
      const code = `const s = await import(${JSON.stringify(SCHEMA_URL)}); s.ensureDb().close();`;
      const runs = await Promise.all(
        Array.from({ length: 4 }, () => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(home) });
          let err = '';
          child.stderr.on('data', (d) => (err += d));
          return new Promise((done) => child.on('close', (status) => done({ status, err })));
        }),
      );
      for (const r of runs) expect(r.status, r.err).toBe(0);
      const db = join(dataDir, 'claude-mem-lite.db');
      expect(integrity(db)).toBe('ok');
      expect(markers(db, `legacy-race-${trial}`)).toBe(1);
      expect(leftInOldDir(legacy)).toEqual([]);
      expect(privateCopies(dataDir)).toEqual([]);
    }
  }, 60000);
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
