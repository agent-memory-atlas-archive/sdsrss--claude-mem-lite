// install-legacy-db-backup.test.mjs — Bug 2 regression
// install.mjs used to copyFileSync(~/.claude-mem/claude-mem.db, DB_PATH),
// turning legacy claude-mem v16 schema (schema_versions plural table) into
// the new claude-mem-lite v28 schema home. There is no v16→v28 bridge in
// MIGRATIONS[]; the new code FATALs on first launch with
// "no such column: memory_session_id". Instead, install must rename the
// legacy DB to a timestamped backup so the new install creates a clean DB
// and the user can recover the file later if they want.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { migrateLegacyClaudeMemData } from '../install.mjs';

/** A WAL store at `path` whose `rows` rows are only in its -wal, copied while the writer holds them. */
function plantWalOnlyStore(path, rows) {
  const work = mkdtempSync(join(tmpdir(), 'mem-legacy-live-'));
  try {
    const db = new Database(join(work, 'live.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE t (x)');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < rows; i++) insert.run(i);
    copyFileSync(join(work, 'live.db'), path);
    copyFileSync(join(work, 'live.db-wal'), `${path}-wal`);
    db.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The rows SQLite reads from the file at `path` opened as it is, beside whatever log it pairs. */
function rowsAsFound(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT count(*) FROM t').pluck().get();
  } finally {
    db.close();
  }
}

function makeDirs() {
  const root = join(tmpdir(), `mem-legacy-${randomUUID().slice(0, 8)}`);
  const oldDir = join(root, '.claude-mem');
  const newDir = join(root, '.claude-mem-lite');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  return { root, oldDir, newDir };
}

describe('Bug 2: migrateLegacyClaudeMemData', () => {
  it('renames legacy claude-mem.db to a timestamped backup in newDir, never as the new DB', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'legacy-content');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      expect(result.backupPath).toContain('claude-mem-lite.db.legacy-backup-');
      // Critically: new DB path must NOT exist after backup — new install
      // creates a fresh v28 schema.
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);
      // Backup file exists and contains the original bytes.
      expect(existsSync(result.backupPath)).toBe(true);
      // Old location no longer holds the DB (renamed, not copied).
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('also backs up -wal and -shm sidecar files when present', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      writeFileSync(join(oldDir, 'claude-mem.db-shm'), 'shm');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      const stamps = readdirSync(newDir).filter((f) => f.includes('legacy-backup'));
      expect(stamps.sort()).toEqual([
        'claude-mem-lite.db.legacy-backup-1700000000000',
        'claude-mem-lite.db.legacy-backup-1700000000000-shm',
        'claude-mem-lite.db.legacy-backup-1700000000000-wal',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // D#584 (v6.30.8 r2 R2-9): the log was named claude-mem-lite.db-wal.legacy-backup-<ms>, which
  // SQLite does not pair with claude-mem-lite.db.legacy-backup-<ms>, so the backup opened as found
  // read none of the rows only in its log.
  it('the backup opened as found reads the rows only in its log', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      plantWalOnlyStore(join(oldDir, 'claude-mem.db'), 40);
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      expect(rowsAsFound(result.backupPath)).toBe(40);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns action "noop" when old claude-mem.db does not exist', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('noop');
      expect(readdirSync(newDir)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns action "skip" and touches nothing when newDir already has claude-mem-lite.db', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'legacy');
      writeFileSync(join(newDir, 'claude-mem-lite.db'), 'fresh');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('skip');
      // Working DB untouched
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(true);
      // Old DB also untouched (don't surprise users with mutations on skip)
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// D#579: with CLAUDE_MEM_DIR on another filesystem than ~/.claude-mem, the rename threw EXDEV and
// install printed "Legacy DB backup failed". Two writable directories on different devices stand in
// for that (here /tmp is a tmpfs and the home directory is not; a CI runner has /dev/shm).
function dirsOnTwoFilesystems() {
  const roots = [tmpdir(), '/dev/shm', join(homedir(), '.cache')];
  const made = [];
  for (const r of roots) {
    try {
      made.push(mkdtempSync(join(r, 'mem-legacy-xdev-')));
    } catch {
      /* not there, or not writable */
    }
  }
  for (const a of made) {
    for (const b of made) {
      if (statSync(a).dev !== statSync(b).dev) {
        for (const m of made) if (m !== a && m !== b) rmSync(m, { recursive: true, force: true });
        return [a, b];
      }
    }
  }
  for (const m of made) rmSync(m, { recursive: true, force: true });
  return null;
}
const probe = dirsOnTwoFilesystems();
for (const d of probe ?? []) rmSync(d, { recursive: true, force: true });

describe.skipIf(!probe)('migrateLegacyClaudeMemData across filesystems (D#579)', () => {
  it('copies the legacy store and its sidecars to the backup names and leaves the source', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('copied');
      expect(readFileSync(result.backupPath, 'utf8')).toBe('main');
      expect(readFileSync(`${result.backupPath}-wal`, 'utf8')).toBe('wal');
      expect(readdirSync(newDir).sort()).toEqual([
        'claude-mem-lite.db.legacy-backup-1700000000000',
        'claude-mem-lite.db.legacy-backup-1700000000000-wal',
      ]);
      expect(
        readFileSync(join(oldDir, 'claude-mem.db'), 'utf8'),
        'the source stays, as setup.sh leaves it',
      ).toBe('main');
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // A copy killed partway leaves its private file, a whole copy of the store, which nothing else removes.
  it('removes a private copy an earlier, killed copy left', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      mkdirSync(newDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(newDir, '.legacy-backup-copy-999999-1600000000000'), 'half a copy');
      expect(migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 }).action).toBe('copied');
      expect(readdirSync(newDir)).toEqual(['claude-mem-lite.db.legacy-backup-1700000000000']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // v6.30.8 r1 (claims F4, defects F6): a copy killed after the store's file was placed and before
  // its -wal was left a backup of the store without its log, and every later install skipped. The
  // kill comes from an fs preload: the second copyFileSync of the run exits the process.
  it('a copy killed partway is made again whole by the next install', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      const shim = join(a, 'kill-shim.mjs');
      writeFileSync(
        shim,
        `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.copyFileSync;
let n = 0;
fs.copyFileSync = function (...args) {
  if (++n === 2) process.kill(process.pid, 'SIGKILL');
  return real.apply(this, args);
};
syncBuiltinESMExports();
`,
      );
      const run = (preload, now) =>
        spawnSync(
          process.execPath,
          [
            ...(preload ? ['--import', pathToFileURL(shim).href] : []),
            '--input-type=module',
            '-e',
            `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'install.mjs')).href)}); console.log(m.migrateLegacyClaudeMemData(${JSON.stringify(oldDir)}, ${JSON.stringify(newDir)}, { now: ${now} }).action);`,
          ],
          { encoding: 'utf8', env: { ...process.env, MEM_NO_AUTO_ADOPT: '1' } },
        );
      expect(run(true, 1700000000000).signal, 'premise: the first copy was killed').toBe('SIGKILL');
      const again = run(false, 1700000000001);
      expect(again.status, again.stderr).toBe(0);
      const names = readdirSync(newDir).sort();
      const main = names.filter((n) => /^claude-mem-lite\.db\.legacy-backup-\d+$/.test(n));
      expect(main).toHaveLength(1);
      expect(readFileSync(join(newDir, main[0]), 'utf8')).toBe('main');
      expect(readFileSync(join(newDir, `${main[0]}-wal`), 'utf8'), 'its log beside it').toBe('wal');
      expect(names, 'nothing else: no private copy, and no log of the killed copy').toEqual([
        main[0],
        `${main[0]}-wal`,
      ]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // Placed the other way round, a copy killed between the two renames left the store's backup
  // without its log, and every later install skipped. The kill comes from an fs preload: the third
  // renameSync of the run (the first is the rename that fails with EXDEV) exits the process.
  it('a copy killed between placing the log and placing the store is made again with its log', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      const shim = join(a, 'kill-shim.mjs');
      writeFileSync(
        shim,
        `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.renameSync;
let n = 0;
fs.renameSync = function (...args) {
  if (++n === 3) process.kill(process.pid, 'SIGKILL');
  return real.apply(this, args);
};
syncBuiltinESMExports();
`,
      );
      const run = (preload, now) =>
        spawnSync(
          process.execPath,
          [
            ...(preload ? ['--import', pathToFileURL(shim).href] : []),
            '--input-type=module',
            '-e',
            `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'install.mjs')).href)}); console.log(m.migrateLegacyClaudeMemData(${JSON.stringify(oldDir)}, ${JSON.stringify(newDir)}, { now: ${now} }).action);`,
          ],
          { encoding: 'utf8', env: { ...process.env, MEM_NO_AUTO_ADOPT: '1' } },
        );
      expect(run(true, 1700000000000).signal, 'premise: the copy was killed').toBe('SIGKILL');
      const again = run(false, 1700000000001);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout.trim()).toBe('copied');
      expect(readFileSync(join(newDir, 'claude-mem-lite.db.legacy-backup-1700000000001'), 'utf8')).toBe(
        'main',
      );
      expect(readFileSync(join(newDir, 'claude-mem-lite.db.legacy-backup-1700000000001-wal'), 'utf8')).toBe(
        'wal',
      );
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // D#584: a log placed under the paired name starts with the backup's own name, and a copy killed
  // between placing the log and placing the store left only that.
  it('a backup log without its store is not a backup: the copy is made', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      mkdirSync(newDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(newDir, 'claude-mem-lite.db.legacy-backup-1600000000000-wal'), 'a log alone');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('copied');
      expect(readFileSync(result.backupPath, 'utf8')).toBe('main');
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('the copy opened as found reads the rows only in its log (D#584)', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      plantWalOnlyStore(join(oldDir, 'claude-mem.db'), 40);
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('copied');
      expect(rowsAsFound(result.backupPath)).toBe(40);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // The source stays, so without this every install would add another copy (the D#573 shape).
  it('copies once: a backup already in the data dir is enough', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      expect(migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 }).action).toBe('copied');
      expect(migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000001 }).action).toBe('skip');
      expect(readdirSync(newDir)).toEqual(['claude-mem-lite.db.legacy-backup-1700000000000']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
