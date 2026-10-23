// D#558: the restore command names a snapshot only when restoring it gives a store this version
// opens and SQLite's integrity check passes once doctor has rebuilt the search index. The check
// restores a copy into a private directory and opens it in a child process with the product's
// own opener (lib/snapshot-probe.mjs). These cases run the real check, and the printed commands
// in a shell; tests/db-unusable.test.mjs drives the walk with a stub.
//
// The first attempt (v6.30.5, withdrawn at its round-2 review) checked the snapshot FILE with
// integrity_check and rejected snapshots whose only damage was the search index, which doctor
// rebuilds without loss; the 'fts' case below is that shape.

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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellWord } from '../cli-path.mjs';
import { spawnSync } from 'node:child_process';
import * as du from '../lib/db-unusable.mjs';
import { makeFixtureTracker, writeStoreSnapshot } from './test-helpers.mjs';

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-snapcheck-')));
const listing = (dir) => readdirSync(dir).sort();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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

  it('fails a snapshot whose observations table is damaged', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'page' });
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'bad', why: 'integrity' });
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
      { opened: true, integrity: 'Tree 5 page 5 cell 1: bad', observations: 3, ftsErrors: [] },
      { verdict: 'bad', why: 'integrity', reason: 'Tree 5 page 5 cell 1: bad' },
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
      reason: 'ETIMEDOUT',
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
    const line = JSON.stringify({ opened: true, integrity: 'ok', observations: 3, ftsErrors: [] });
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

  it('removes a private directory a killed check left, and nothing else', () => {
    const dir = dataDir();
    const stale = join(dir, '.snapshot-check-4242-abcdef');
    const fresh = join(dir, '.snapshot-check-4243-ghijkl');
    const other = join(dir, 'snapshot-check-notours');
    for (const d of [stale, fresh, other]) {
      mkdirSync(d);
      writeFileSync(join(d, 'claude-mem-lite.db'), 'x');
    }
    const aFile = join(dir, '.snapshot-check-a-file');
    writeFileSync(aFile, 'not a directory');
    const old = Date.now() / 1000 - 2 * 3600;
    for (const p of [stale, other, aFile]) utimesSync(p, old, old);
    du.sweepSnapshotChecks(dir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh), 'a check that may still be running keeps its directory').toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(aFile), 'only directories').toBe(true);
  });

  it('the walk sweeps before it checks', () => {
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    writeFileSync(`${db}.pre-delete-x.bak`, 'snapshot');
    const stale = join(dir, '.snapshot-check-4242-abcdef');
    mkdirSync(stale);
    const old = Date.now() / 1000 - 2 * 3600;
    utimesSync(stale, old, old);
    du.dbUnusableRemedy(db, undefined, { check: () => ({ verdict: 'ok', observations: 1, withLog: false }) });
    expect(existsSync(stale)).toBe(false);
  });
});

// The commands are run, not only read: each holds a `test` guard, a `touch` and two `mv`, and
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
});
