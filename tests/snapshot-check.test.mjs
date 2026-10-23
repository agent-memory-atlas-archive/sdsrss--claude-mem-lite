// D#558: the restore command names a snapshot only when restoring it gives a store this version
// opens and SQLite's integrity check passes once its indexes are rebuilt the way the command's
// last step (`fts-check rebuild`: the FTS5 indexes, then REINDEX) rebuilds them. The check
// restores a copy into a private directory and opens it in a child process with the product's
// own opener (lib/snapshot-probe.mjs). These cases run the real check, and the printed commands
// in a shell; tests/db-unusable.test.mjs drives the walk with a stub.
//
// The first attempt (v6.30.5, withdrawn at its round-2 review) checked the snapshot FILE with
// integrity_check and rejected snapshots whose only damage was the search index; the 'fts' case
// below is that shape. The second (645de4e2, withdrawn at its r1 review) ignored the rebuild's
// own errors, so a full disk during the rebuild rejected a sound snapshot; and it did no REINDEX,
// so it rejected snapshots whose only damage was an ordinary index (the 'index' case).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLI_INVOKE, shellWord } from '../cli-path.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as du from '../lib/db-unusable.mjs';
import { pathWithClaudeStub } from './claude-stub.mjs';
import { makeFixtureTracker, writeStoreSnapshot } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-snapcheck-')));
const listing = (dir) => readdirSync(dir).sort();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** The pid of a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const integrityRows = (path) => {
  const copy = join(dataDir(), 'premise.db');
  copyFileSync(path, copy);
  const raw = new Database(copy);
  try {
    return raw.prepare('PRAGMA integrity_check(5)').pluck().all();
  } finally {
    raw.close();
  }
};

describe('checkSnapshot restores a private copy and opens it with the product opener', () => {
  it('passes a sound snapshot and counts its observations, leaving nothing behind', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { observations: 7 });
    const before = listing(dir);
    const r = du.checkSnapshot(snap);
    expect(r).toMatchObject({ verdict: 'ok', observations: 7, withLog: false });
    expect(listing(dir), 'no private directory, -wal or -shm left in the data dir').toEqual(before);
  });

  it('passes a snapshot whose only damage is its search index (round-2 P1-1 of the first attempt)', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'fts' });
    // Premise: SQLite's integrity check on the file as it is does fail, on the index alone.
    const copy = join(dataDir(), 'premise.db');
    copyFileSync(snap, copy);
    const raw = new Database(copy);
    const rows = raw.prepare('PRAGMA integrity_check(5)').pluck().all();
    raw.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r) => /^fts5: /.test(r)),
      rows.join('\n'),
    ).toBe(true);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 12 });
  });

  // r1 claims P2-1 of the second attempt: 269 of the 325 corpus snapshots it rejected passed
  // after a REINDEX.
  it('passes a snapshot whose only damage is an ordinary index, which REINDEX repairs', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'index' });
    const rows = integrityRows(snap);
    expect(rows.length, 'premise: integrity_check fails').toBeGreaterThan(0);
    expect(
      rows.every((r) => /index idx_/.test(r)),
      rows.join('\n'),
    ).toBe(true);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 12 });
  });

  // D#558's "compare row counts": a snapshot whose indexes list more rows than its table holds.
  // REINDEX makes it consistent, and short; 73 of the 605 corpus snapshots that pass are this shape,
  // each listing exactly the damaged store's count. It still restores cleanly; the result says by
  // how much it is short of its own index.
  it('passes a snapshot that lost rows its indexes still list, and says how many it lists', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), {
      damage: 'lost-rows',
    });
    expect(integrityRows(snap), 'premise').toEqual([expect.stringMatching(/^wrong # of entries in index /)]);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 3, listed: 12 });
  });

  // A sound snapshot's index lists exactly what its table holds; a damaged index can list fewer.
  it.each([null, 'index'])(
    'lists nothing extra when its index lists no more than it holds (%s)',
    (damage) => {
      const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), { damage });
      const r = du.checkSnapshot(snap);
      expect(r).toMatchObject({ verdict: 'ok', observations: 12 });
      expect(r).not.toHaveProperty('listed');
    },
  );

  // main21-112's shape (D#562b): FTS5 refuses the index's config, and no rebuild repairs it.
  it('fails a snapshot whose search index cannot be rebuilt, and names the rebuild', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), {
      damage: 'fts-config',
    });
    const r = du.checkSnapshot(snap);
    expect(r).toMatchObject({ verdict: 'bad', why: 'rebuild' });
    expect(r.reason).toMatch(/observations_fts: invalid fts5 file format/);
  });

  // r1 defects P1-1 of the second attempt, on a real rebuild: a page cap stands in for the disk
  // filling up while the rebuild writes.
  it('reports a full disk during the rebuild with its code', async () => {
    const { probeOpenedStore } = await import('../lib/snapshot-probe.mjs');
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), {
      observations: 200,
      damage: 'fts',
    });
    const db = new Database(snap);
    try {
      db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true })}`);
      const r = probeOpenedStore(db);
      expect(r.rebuildErrors).toContainEqual({
        code: 'SQLITE_FULL',
        message: 'observations_fts: database or disk is full',
      });
    } finally {
      db.close();
    }
  });

  // The rebuild reads every row of the table, so it is the step that meets the damage first.
  it('fails a snapshot whose observations table is damaged', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'page' });
    expect(du.checkSnapshot(snap)).toMatchObject({
      verdict: 'bad',
      why: 'rebuild',
      reason: 'observations_fts: database disk image is malformed',
    });
  });

  it('fails a snapshot that is not a database', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'header' });
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'bad', why: 'open' });
  });

  it('calls a snapshot with no observations empty', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { observations: 0 });
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'empty', observations: 0 });
  });

  // Round-2 P2-2 of the first attempt: a hand-made copy taken after the store's first checkpoint
  // holds part of its rows in its own -wal, and a restore of the main file alone drops them.
  it('restores a hand-made copy together with its own -wal', () => {
    const dir = dataDir();
    const live = join(dataDir(), 'live.db');
    const src = writeStoreSnapshot(join(dataDir(), 'src.db'), { observations: 10 });
    copyFileSync(src, live);
    const db = new Database(live);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    const insert = db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'discovery', ?, 'n', datetime('now'), ?)`,
    );
    for (let i = 0; i < 50; i++) insert.run(`late ${i}`, 1_800_000_000_000 + i);
    const snap = join(dir, 'claude-mem-lite.db.before-upgrade.bak');
    copyFileSync(live, snap);
    copyFileSync(`${live}-wal`, `${snap}-wal`);
    db.close();
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 60, withLog: true });
    // Premise: the main file alone holds only the checkpointed rows.
    const alone = join(dataDir(), 'claude-mem-lite.db.alone.bak');
    copyFileSync(snap, alone);
    expect(du.checkSnapshot(alone)).toMatchObject({ verdict: 'ok', observations: 10, withLog: false });
  });

  it.skipIf(isRoot)('cannot check a snapshot it cannot read, and says why', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    chmodSync(snap, 0o000);
    try {
      expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'unchecked', reason: 'EACCES' });
    } finally {
      chmodSync(snap, 0o600);
    }
    expect(listing(dir).filter((n) => n.startsWith('.snapshot-check-'))).toEqual([]);
  });

  it('cannot check when the probe does not run, and says why', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, "process.stderr.write('boom\\n'); process.exit(3);\n");
    const r = du.checkSnapshot(snap, { probe });
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/exited 3/);
    expect(r.reason).toContain('boom');
  });

  // r1 P3-3 / P3-5: the first stderr line of an import-time failure is a source location.
  it('names the error, not the source location, when the probe throws while loading', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, "throw new Error('the probe could not load');\n");
    const r = du.checkSnapshot(snap, { probe });
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/^probe exited 1: Error: the probe could not load$/);
  });

  // r1 defects P3-1: the product opener creates a fresh store where none is, so a copy that went
  // away (a second doctor's sweep, say) read as an empty snapshot.
  it('cannot check a copy that is gone, rather than calling it empty', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'vanish.mjs');
    const real = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'snapshot-probe.mjs');
    writeFileSync(
      probe,
      [
        "import { rmSync } from 'node:fs';",
        "rmSync(process.env.CLAUDE_MEM_DIR + '/claude-mem-lite.db');",
        `process.argv[1] = ${JSON.stringify(real)};`,
        `await import(${JSON.stringify(pathToFileURL(real).href)});`,
      ].join('\n'),
    );
    const r = du.checkSnapshot(snap, { probe });
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/the copy to check is gone/);
  });

  it.skipIf(isRoot)('cannot check when the data directory is not writable, and names the directory', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    chmodSync(dir, 0o555);
    try {
      expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'unchecked', reason: 'EACCES', where: dir });
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // The probe's result line, as each branch of the verdict reads it.
  it.each([
    [
      'a full disk under the copy',
      { opened: false, error: { code: 'SQLITE_FULL', message: 'database or disk is full' } },
      { verdict: 'unchecked', reason: 'SQLITE_FULL' },
    ],
    [
      'an I/O error under the copy',
      { opened: true, error: { code: 'SQLITE_IOERR_READ', message: 'disk I/O error' } },
      { verdict: 'unchecked', reason: 'SQLITE_IOERR_READ' },
    ],
    // Deterministic for the same file: the product's open fails on it after a restore too.
    [
      'NOMEM from the opener',
      { opened: false, error: { code: 'SQLITE_NOMEM', message: 'out of memory' } },
      { verdict: 'bad', why: 'open', reason: 'SQLITE_NOMEM' },
    ],
    [
      'a throw after the open',
      { opened: true, error: { code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' } },
      { verdict: 'bad', why: 'integrity', reason: 'SQLITE_CORRUPT' },
    ],
    [
      'a throw with no code',
      {
        opened: false,
        error: { code: null, message: 'DB schema is v99 but this binary supports up to v49' },
      },
      { verdict: 'bad', why: 'open', reason: 'DB schema is v99 but this binary supports up to v49' },
    ],
    [
      'integrity rows',
      { opened: true, rebuildErrors: [], integrity: 'Tree 5 page 5 cell 1: bad', observations: 3 },
      { verdict: 'bad', why: 'integrity', reason: 'Tree 5 page 5 cell 1: bad' },
    ],
    // The check's own disk, whichever step met it.
    [
      'a full disk during the rebuild',
      {
        opened: true,
        rebuildErrors: [{ code: 'SQLITE_FULL', message: 'observations_fts: database or disk is full' }],
        integrity: 'fts5: corruption found reading blob 1 from table "observations_fts"',
        observations: 5,
      },
      { verdict: 'unchecked', reason: 'SQLITE_FULL' },
    ],
    [
      'an I/O error during the rebuild, then a throw',
      {
        opened: true,
        rebuildErrors: [{ code: 'SQLITE_IOERR_WRITE', message: 'events_fts: disk I/O error' }],
        error: { code: 'SQLITE_CORRUPT_VTAB', message: 'database disk image is malformed' },
      },
      { verdict: 'unchecked', reason: 'SQLITE_IOERR_WRITE' },
    ],
    // A rebuild that failed leaves an index the command's own last step fails on too.
    [
      'a rebuild error with the integrity check passing',
      {
        opened: true,
        rebuildErrors: [{ code: null, message: 'observations_fts: not found' }],
        integrity: 'ok',
        observations: 3,
      },
      { verdict: 'bad', why: 'rebuild', reason: 'observations_fts: not found' },
    ],
    [
      'a rebuild error, then a throw',
      {
        opened: true,
        rebuildErrors: [{ code: 'SQLITE_ERROR', message: 'observations_fts: invalid fts5 file format' }],
        error: { code: 'SQLITE_ERROR', message: 'invalid fts5 file format' },
      },
      { verdict: 'bad', why: 'rebuild', reason: 'observations_fts: invalid fts5 file format' },
    ],
  ])('reads %s from the probe', (_label, line, expected) => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, `process.stdout.write(${JSON.stringify(JSON.stringify(line) + '\n')});\n`);
    expect(du.checkSnapshot(snap, { probe })).toMatchObject(expected);
  });

  it('gives up on a probe that outlives its timeout', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, 'setTimeout(() => {}, 60_000);\n');
    expect(du.checkSnapshot(snap, { probe, timeoutMs: 300 })).toMatchObject({
      verdict: 'unchecked',
      reason: 'ETIMEDOUT, over 300 ms',
    });
    expect(listing(dir).filter((n) => n.startsWith('.snapshot-check-'))).toEqual([]);
  });

  it('writes nothing outside its private directory: HOME and TMPDIR stay empty', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'fts' });
    const home = dataDir();
    const tmp = dataDir();
    const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    process.env.HOME = home;
    process.env.TMPDIR = tmp;
    let r;
    try {
      r = du.checkSnapshot(snap);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(r.verdict, 'premise: the check ran to its end').toBe('ok');
    expect(listing(home)).toEqual([]);
    expect(listing(tmp)).toEqual([]);
  });

  it('cannot check when the probe exits non-zero, even after a result line', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    const line = JSON.stringify({ opened: true, rebuildErrors: [], integrity: 'ok', observations: 3 });
    writeFileSync(probe, `process.stdout.write(${JSON.stringify(line + '\n')}); process.exit(3);\n`);
    expect(du.checkSnapshot(snap, { probe })).toMatchObject({
      verdict: 'unchecked',
      reason: 'probe exited 3',
    });
  });

  // The product opener, not a bare open: a snapshot written by a newer claude-mem-lite opens in
  // SQLite and passes its integrity check, and this version refuses it (its schema is too new),
  // so restoring it would turn memory off again.
  it('fails a snapshot whose schema is newer than this version, which a bare open would pass', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const db = new Database(snap);
    db.prepare('UPDATE schema_version SET version = 999').run();
    expect(db.prepare('PRAGMA integrity_check(1)').pluck().get(), 'premise').toBe('ok');
    db.close();
    expect(du.checkSnapshot(snap)).toMatchObject({
      verdict: 'bad',
      why: 'open',
      reason: 'CLAUDE_MEM_SCHEMA_TOO_NEW',
    });
  });

  // r1 P2 of the second attempt: a directory a killed check left was removed only by a walk 20+
  // minutes later, which never comes once the store is restored.
  it('removes a private directory whose check has exited, and keeps a running one', () => {
    const dir = dataDir();
    const dead = join(dir, `.snapshot-check-${deadPid()}-abcdef`);
    const running = join(dir, `.snapshot-check-${process.pid}-ghijkl`);
    const runningButOld = join(dir, `.snapshot-check-${process.pid}-mnopqr`);
    const notOurs = [join(dir, 'snapshot-check-notours'), join(dir, '.snapshot-check-notapid-abcdef')];
    for (const d of [dead, running, runningButOld, ...notOurs]) {
      mkdirSync(d);
      writeFileSync(join(d, 'claude-mem-lite.db'), 'x');
    }
    const aFile = join(dir, `.snapshot-check-${deadPid()}-stuvwx`);
    writeFileSync(aFile, 'not a directory');
    const old = Date.now() / 1000 - 25 * 3600;
    for (const p of [runningButOld, ...notOurs, aFile]) utimesSync(p, old, old);
    du.sweepSnapshotChecks(dir);
    expect(existsSync(dead), 'its check has exited').toBe(false);
    expect(existsSync(running), 'a check that is still running keeps its directory').toBe(true);
    expect(existsSync(runningButOld), 'no check runs a day: its pid names another process now').toBe(false);
    for (const d of notOurs) expect(existsSync(d), d).toBe(true);
    expect(existsSync(aFile), 'only directories').toBe(true);
  });

  // pid 1 runs as root: signalling it from another user fails with EPERM, which is a live process.
  it.skipIf(isRoot)('keeps a directory whose process runs as another user', () => {
    const dir = dataDir();
    const theirs = join(dir, '.snapshot-check-1-abcdef');
    mkdirSync(theirs);
    du.sweepSnapshotChecks(dir);
    expect(existsSync(theirs)).toBe(true);
  });

  it('records a REINDEX that fails, with its code', async () => {
    const { rebuildIndexes } = await import('../schema.mjs');
    const path = join(dataDir(), 'dup.db');
    const db = new Database(path);
    db.exec('CREATE TABLE t (a); CREATE INDEX t_a ON t (a); INSERT INTO t VALUES (1), (1);');
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = 'CREATE UNIQUE INDEX t_a ON t (a)' WHERE name = 't_a'").run();
    db.close();
    const h = new Database(path);
    try {
      const r = rebuildIndexes(h);
      expect(r.rebuilt).not.toContain('indexes');
      const at = r.errors.findIndex((e) => e.startsWith('indexes: '));
      expect(at, r.errors.join('\n')).toBeGreaterThan(-1);
      expect(r.codes[at]).toBe('SQLITE_CONSTRAINT_UNIQUE');
    } finally {
      h.close();
    }
  });
});

// The commands are run, not only read: each holds two `test` guards, a `touch` and two `mv`, and
// a wrong one destroys the file it exists to keep.
describe('the printed commands, run in a shell', () => {
  const shells = ['bash', 'sh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0);
  const NOW = Date.UTC(2026, 9, 23, 19, 30, 0, 0);
  const run = (shell, cmd) => spawnSync(shell, ['-c', cmd], { encoding: 'utf8' });
  const broken = (dir, { wal = true } = {}) => {
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'BROKEN MAIN FILE');
    if (wal) writeFileSync(`${db}-wal`, 'COMMITTED LOG FRAMES');
    writeFileSync(`${db}-shm`, 'SHM');
    return db;
  };

  it.each(shells)(
    '%s: set-aside keeps the broken file and its log, and a second run changes nothing',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
      expect(r.kind).toBe('set-aside');
      expect(run(shell, r.command).status).toBe(0);
      expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
      expect(readFileSync(`${r.keptAs}-wal`, 'utf8')).toBe('COMMITTED LOG FRAMES');
      expect(existsSync(db) || existsSync(`${db}-wal`) || existsSync(`${db}-shm`)).toBe(false);
      // Again, after a fresh store was created in its place: the guard stops it.
      writeFileSync(db, 'FRESH STORE');
      const after = listing(dir);
      expect(run(shell, r.command).status).not.toBe(0);
      expect(listing(dir)).toEqual(after);
      expect(readFileSync(db, 'utf8')).toBe('FRESH STORE');
      expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
    },
  );

  it.each(shells)('%s: set-aside with no log leaves an empty log beside the kept file', (shell) => {
    const dir = dataDir();
    const db = broken(dir, { wal: false });
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(run(shell, r.command).status).toBe(0);
    expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
    expect(readFileSync(`${r.keptAs}-wal`).length).toBe(0);
    expect(existsSync(db)).toBe(false);
  });

  // The restore runs the CLI (`fts-check rebuild`): HOME sandboxed and the opt-outs set, as for
  // every spawn of this repo's entry points.
  const cliEnv = () => ({
    ...process.env,
    HOME: dataDir(),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
  });
  const observations = (db) => {
    const copy = join(dataDir(), 'count.db');
    copyFileSync(db, copy);
    if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${copy}-wal`);
    const h = new Database(copy, { readonly: true });
    try {
      return h.prepare('SELECT count(*) FROM observations').pluck().get();
    } finally {
      h.close();
    }
  };

  it.each(shells)('%s: restore puts the snapshot in place, reindexed, and keeps the broken pair', (shell) => {
    const dir = dataDir();
    const db = broken(dir);
    const snap = writeStoreSnapshot(`${db}.pre-delete-x.bak`, { observations: 7, damage: 'fts' });
    const snapBytes = readFileSync(snap);
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
    expect(r.kind).toBe('restore');
    const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(observations(db)).toBe(7);
    // What the check vouched for: the restored store, reindexed, passes the integrity check.
    const h = new Database(db);
    expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
    h.close();
    expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
    expect(readFileSync(`${r.keptAs}-wal`, 'utf8')).toBe('COMMITTED LOG FRAMES');
    expect(readFileSync(snap).equals(snapBytes), 'the snapshot stays as it was').toBe(true);
    const after = listing(dir);
    expect(spawnSync(shell, ['-c', r.command], { env: cliEnv() }).status).not.toBe(0);
    expect(listing(dir)).toEqual(after);
  });

  it.each(shells)(
    '%s: restore of a snapshot whose only damage is an ordinary index leaves a clean store',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      writeStoreSnapshot(`${db}.pre-delete-x.bak`, { observations: 7, damage: 'index' });
      const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
      expect(r.kind).toBe('restore');
      const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      const h = new Database(db);
      try {
        expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
        expect(h.prepare('SELECT count(*) FROM observations').pluck().get()).toBe(7);
      } finally {
        h.close();
      }
    },
  );

  // r1 defects P2-3 of the second attempt: the kept name comes from the broken file's mtime, which
  // `mv` keeps, so once the kept file was moved back every printed command stopped at its guard,
  // with exit 1 and no message.
  it.each(shells)(
    '%s: once the kept file is moved back, the next command keeps it under a new name',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      const first = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
      expect(run(shell, first.command).status).toBe(0);
      renameSync(first.keptAs, db);
      const second = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
      expect(second.keptAs).toBe(`${first.keptAs}-1`);
      expect(run(shell, second.command).status).toBe(0);
      expect(readFileSync(second.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
      expect(readFileSync(`${first.keptAs}-wal`, 'utf8'), 'the first kept log stays').toBe(
        'COMMITTED LOG FRAMES',
      );
    },
  );

  // The restore command's last step: what the check ran on its copy after the open.
  it('fts-check rebuild repairs an ordinary index as well as the search index', () => {
    const dir = dataDir();
    const db = writeStoreSnapshot(join(dir, 'claude-mem-lite.db'), { damage: 'index' });
    expect(integrityRows(db).length, 'premise: integrity_check fails').toBeGreaterThan(0);
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'fts-check', 'rebuild'], {
      encoding: 'utf8',
      env: { ...cliEnv(), CLAUDE_MEM_DIR: dir },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const h = new Database(db);
    try {
      expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
    } finally {
      h.close();
    }
  });

  it.each(shells)('%s: restore of a hand-made copy brings its own log along', (shell) => {
    const dir = dataDir();
    const db = broken(dir);
    const live = join(dataDir(), 'live.db');
    copyFileSync(writeStoreSnapshot(join(dataDir(), 'src.db'), { observations: 10 }), live);
    const h = new Database(live);
    h.pragma('journal_mode = WAL');
    h.pragma('wal_autocheckpoint = 0');
    const insert = h.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'discovery', ?, 'n', datetime('now'), ?)`,
    );
    for (let i = 0; i < 50; i++) insert.run(`late ${i}`, 1_800_000_000_000 + i);
    const snap = `${db}.before-upgrade.bak`;
    copyFileSync(live, snap);
    copyFileSync(`${live}-wal`, `${snap}-wal`);
    h.close();
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
    expect(r.kind).toBe('restore');
    const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(observations(db)).toBe(60);
  });
});

describe('doctor wires the real check', () => {
  it('names an older sound snapshot over a newer one that does not restore cleanly', async () => {
    const { dbCheckRemedy } = await import('../install.mjs');
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'not actually sqlite');
    const older = writeStoreSnapshot(`${db}.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak`, {
      observations: 4,
    });
    const newer = writeStoreSnapshot(`${db}.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak`, {
      damage: 'header',
    });
    const t = Date.now() / 1000;
    utimesSync(older, t - 3600, t - 3600);
    utimesSync(newer, t, t);
    const out = await dbCheckRemedy(
      db,
      Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }),
    );
    expect(out).toContain(`cp ${shellWord(older)} ${shellWord(db)}`);
    expect(out).not.toContain(newer);
    expect(out).toContain('4 observation(s)');
    expect(out).toContain('1 does not open');
  });

  // r1 defects P3-7: a directory named like a snapshot stopped the walk with EISDIR.
  it('passes over a directory named like a snapshot', async () => {
    const { dbCheckRemedy } = await import('../install.mjs');
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'not actually sqlite');
    const older = writeStoreSnapshot(`${db}.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak`, {
      observations: 4,
    });
    const notAFile = `${db}.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak`;
    mkdirSync(notAFile);
    writeFileSync(join(notAFile, 'x'), 'x');
    const t = Date.now() / 1000;
    utimesSync(older, t - 3600, t - 3600);
    utimesSync(notAFile, t, t);
    const out = await dbCheckRemedy(
      db,
      Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }),
    );
    expect(out).toContain(`cp ${shellWord(older)} ${shellWord(db)}`);
  });

  // r1 P2 of the second attempt: the sweep ran only on a broken store's walk, so a copy a killed
  // check left stayed once the store was restored.
  it('doctor sweeps a directory a killed check left, on a healthy store', () => {
    const root = dataDir();
    const data = join(root, 'data');
    mkdirSync(data);
    writeStoreSnapshot(join(data, 'claude-mem-lite.db'), { observations: 3 });
    const left = join(data, `.snapshot-check-${deadPid()}-abcdef`);
    mkdirSync(left);
    writeFileSync(join(left, 'claude-mem-lite.db'), 'a full copy of a snapshot');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: data,
      PATH: pathWithClaudeStub(root),
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
    };
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      encoding: 'utf8',
      env,
      cwd: root,
    });
    expect(r.stdout, 'premise: doctor checked the store').toMatch(/FTS5 index: present/);
    expect(existsSync(left)).toBe(false);
  });
});

// The remedy's text, with the check stubbed.
describe('the remedy names the data directory and never stops silently', () => {
  const NOW = Date.UTC(2026, 9, 23, 19, 30, 0, 0);
  const brokenWith = (names) => {
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    let t = 1_700_000_000;
    for (const n of names) {
      writeFileSync(join(dir, n), 'snapshot bytes');
      utimesSync(join(dir, n), t, t);
      t += 3600;
    }
    return { dir, db };
  };
  const doctor = (dir) => `CLAUDE_MEM_DIR=${shellWord(dir)} ${CLI_INVOKE} doctor`;

  // r1 defects P2-2 and P3-5: under a data dir relocated only in Claude Code's env, a bare
  // `doctor` checks another store; and 6.30.5's install.mjs, left beside a newer lib by a killed
  // swap, renders any kind it does not know as a restore with an empty command.
  it('without a check, points at doctor with the data directory, under a kind every version renders as a note', () => {
    const { dir, db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const r = du.dbUnusableRemedy(db, new Error('file is not a database'));
    expect(r.kind).toBe('unknown');
    expect(r.command).toBe('');
    expect(r.note).toContain(
      `\`${doctor(dir)}\` checks which one restores cleanly before it gives a command.`,
    );
  });

  // r1 defects P3-4: doctor gives the schema family no command.
  it('without a check, promises the schema family no command', () => {
    const { db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const r = du.dbUnusableRemedy(db, new Error('malformed database schema (x)'));
    expect(r.kind).toBe('schema');
    expect(r.note).not.toMatch(/command/);
  });

  it('names what could not be checked, and how to re-run doctor', () => {
    const { dir, db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const r = du.dbUnusableRemedy(db, undefined, {
      check: () => ({ verdict: 'unchecked', withLog: false, reason: 'EACCES', where: dir }),
    });
    expect(r.kind).toBe('unknown');
    expect(r.note).toContain(`could not be checked (EACCES): ${dir}.`);
    expect(r.note).toContain(doctor(dir));
  });

  it('counts a snapshot whose indexes do not rebuild apart from one that fails the integrity check', () => {
    const { db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak', 'claude-mem-lite.db.pre-delete-b.bak']);
    const verdicts = [
      {
        verdict: 'bad',
        withLog: false,
        why: 'rebuild',
        reason: 'observations_fts: invalid fts5 file format',
      },
      { verdict: 'bad', withLog: false, why: 'integrity', reason: 'Tree 5 page 5' },
    ];
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: () => verdicts.shift() });
    expect(r.kind).toBe('set-aside');
    expect(r.found).toContain('1 fails the index rebuild, 1 fails the integrity check');
  });

  it('says by how much a snapshot is short of its own index', () => {
    const { db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const short = du.dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: () => ({ verdict: 'ok', withLog: false, observations: 3, listed: 12 }),
    });
    expect(short.found).toContain('holds 3 observation(s), 9 fewer than its own index lists.');
    const whole = du.dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: () => ({ verdict: 'ok', withLog: false, observations: 3 }),
    });
    expect(whole.found).toMatch(/holds 3 observation\(s\)\.$/);
  });

  it('keeps the broken file under a name nothing holds yet', () => {
    const { db } = brokenWith([]);
    const base = du.dbUnusableRemedy(db, undefined, { stampMs: NOW }).keptAs;
    writeFileSync(base, 'an earlier kept file');
    writeFileSync(`${base}-1-wal`, 'an earlier kept log');
    expect(du.dbUnusableRemedy(db, undefined, { stampMs: NOW }).keptAs).toBe(`${base}-2`);
  });

  it('both notices name doctor with the data directory', () => {
    const { dir, db } = brokenWith([]);
    const remedy = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(du.formatDbUnusableNotice({ dbPath: db, remedy })).toContain(`\`${doctor(dir)}\` re-checks.`);
    expect(du.formatDbUnusableModelNotice(db)).toContain(`\`${doctor(dir)}\``);
  });

  // An update killed between lib/db-unusable.mjs and hook.mjs leaves 6.30.5's hook, which passes
  // no path; a throw here would drop the model's notice.
  it('the model notice renders for a caller that passes no path', () => {
    expect(du.formatDbUnusableModelNotice()).toContain(`\`${CLI_INVOKE} doctor\``);
  });
});
