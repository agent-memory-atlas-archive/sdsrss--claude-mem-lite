// Units for lib/db-unusable.mjs and lib/record-once.mjs.
// tests/db-unusable-wiring.test.mjs proves anything CALLS them.

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import { shellWord } from '../cli-path.mjs';
import {
  isDbUnusableError,
  dbUnusableRemedy,
  checkSnapshot,
  formatDbUnusableNotice,
  formatDbUnusableModelNotice,
  DB_UNUSABLE_MARKER_PREFIX,
} from '../lib/db-unusable.mjs';
import { shouldRecordOnce, RELOG_INTERVAL_MS } from '../lib/record-once.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';
import { writeSnapshotFixture } from './test-helpers.mjs';

const dirs = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('isDbUnusableError', () => {
  it.each([
    ['file is not a database', true],
    ['SqliteError: file is not a database', true],
    ['database disk image is malformed', true],
    ['DISK IMAGE IS MALFORMED', true],
    // A damaged sqlite_master row: every statement fails, so memory is as off as with a damaged
    // header, and it took the silent generic branch (triage 2026-10-20, reproduced).
    ['malformed database schema (idx_t_a) - incomplete input', true],
  ])('classifies %j as unusable=%s', (msg, expected) => {
    expect(isDbUnusableError(new Error(msg))).toBe(expected);
    expect(isDbUnusableError(msg), 'a bare string reaches recordHookError too').toBe(expected);
  });

  // The discriminator that matters, and the reason the regex is not just /database/: these
  // are a PERMISSIONS or missing-directory failure whose remedy is nothing like "move the
  // file aside". Answering them with the corruption remedy would tell a user to destroy a
  // healthy store — and "unable to open database file" is the message a read-only or absent
  // data dir produces, which is a far more common accident than corruption.
  it.each([
    ['unable to open database file'],
    ['SQLITE_CANTOPEN: unable to open database file'],
    ['EACCES: permission denied'],
    ['DB schema is v999 but this claude-mem-lite binary supports up to v49'],
    ['Cannot find module better_sqlite3.node'],
  ])('does NOT classify %j as unusable', (msg) => {
    expect(isDbUnusableError(new Error(msg))).toBe(false);
  });

  // THE ONE THAT DESTROYS DATA IF IT IS WRONG. SQLite reports a damaged FTS5 INDEX over an
  // otherwise healthy file as SQLITE_CORRUPT_VTAB, whose message text is byte-identical to
  // the file-level fault — so the code is the only thing separating them, and schema.mjs's
  // own docblock says "matching on message alone is what conflated them" (R10 P3-9). The
  // first cut of this classifier matched on message alone and reintroduced the conflation on
  // a new surface: the remedy for a VTAB error would have been `cp <old snapshot> <db>`,
  // overwriting a database whose rows are all intact. The right remedy is rebuildFTS, which
  // ensureDbWithWalRecovery already runs.
  it('does NOT classify a damaged FTS index (SQLITE_CORRUPT_VTAB) as an unusable file', () => {
    const vtab = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT_VTAB',
    });
    expect(isDbUnusableError(vtab)).toBe(false);
    // The control: the same message WITHOUT the VTAB code is a real file-level fault.
    expect(isDbUnusableError(new Error('database disk image is malformed'))).toBe(true);
  });

  it('agrees with schema.mjs, which owns the file-vs-index distinction', async () => {
    // One definition, not two: a second copy of the VTAB rule is the twin-drift class this
    // repo keeps paying for. Pinned so a future edit to either side turns this red.
    const { isDbCorruptionError, isFtsCorruptionError } = await import('../schema.mjs');
    const vtab = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT_VTAB',
    });
    expect(isFtsCorruptionError(vtab)).toBe(true);
    expect(isDbCorruptionError(vtab), 'schema.mjs excludes it from the file-level family').toBe(false);
    expect(isDbUnusableError(vtab), 'and so must this one').toBe(false);
  });

  it('is total on the shapes recordHookError accepts', () => {
    for (const v of [null, undefined, 0, '', {}, []]) {
      expect(() => isDbUnusableError(v)).not.toThrow();
      expect(isDbUnusableError(v)).toBe(false);
    }
  });
});

describe('dbUnusableRemedy', () => {
  // Distinct mtimes so "newest" is decided by the field the code sorts on, not by luck.
  const age = (path, secondsAgo) => {
    const t = Date.now() / 1000 - secondsAgo;
    utimesSync(path, t, t);
    return path;
  };
  const garbageDb = (prefix) => {
    const db = join(tmp(prefix), 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    return db;
  };

  it('offers set-aside when no snapshot exists, and says so rather than staying vague', () => {
    const db = garbageDb('rem-none-');
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('set-aside');
    expect(r.snapshotCount).toBe(0);
    expect(r.found).toBe('No backup snapshot exists beside the database.');
    expect(r.command).toContain(`mv ${shellWord(db)} ${shellWord(`${db}.corrupt`)}`);
    expect(r.command, 'stale WAL/SHM would resurrect the broken state').toContain(`${db}-wal`);
  });

  // D#554: the set-aside note said the memories in the set-aside file were not recoverable
  // without a backup. A store whose damage is in its log can read most of its rows once the log
  // is gone (200 of 241 in the v6.31.0 round-2 review), so the note no longer says either way.
  it('does not say the set-aside file cannot be recovered', () => {
    const r = dbUnusableRemedy(garbageDb('rem-none-note-'));
    expect(r.kind).toBe('set-aside');
    expect(r.note).toBe(
      'No backup snapshot exists beside the database. That command sets the broken file aside so a fresh store is created on the next session.',
    );
  });

  it('offers restore, naming the NEWEST snapshot, when it passes the integrity check', () => {
    const db = garbageDb('rem-snap-');
    const older = age(writeSnapshotFixture(`${db}.2026-09-01.bak`), 1000);
    const newer = age(writeSnapshotFixture(`${db}.2026-09-07.bak`), 0);
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('restore');
    expect(r.snapshotCount).toBe(2);
    expect(r.command).toContain(newer);
    expect(r.command).not.toContain(older);
    expect(r.found).toBe(
      "The newest of the 2 backup snapshot(s) beside the database passes SQLite's integrity check and holds an observations table.",
    );
  });

  // D#553: VACUUM INTO succeeds on some damaged stores and copies the damage, so the newest
  // snapshot can hold it; the restore command named it by its time alone.
  it('skips a newer snapshot that fails the integrity check and names the next one', () => {
    const db = garbageDb('rem-damaged-');
    const good = age(writeSnapshotFixture(`${db}.pre-maintain-2026-09-01.bak`), 2000);
    const damaged = age(writeSnapshotFixture(`${db}.pre-delete-2026-09-07.bak`, { damage: true }), 0);
    // Premise: the damaged one is the newest, opens, and fails SQLite's own check.
    const ro = new Database(damaged, { readonly: true });
    expect(ro.prepare('PRAGMA integrity_check(1)').pluck().get()).not.toBe('ok');
    ro.close();
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('restore');
    expect(r.command).toContain(good);
    expect(r.command).not.toContain(damaged);
    expect(r.found).toBe(
      "The newest one of the 2 backup snapshot(s) beside the database fails SQLite's integrity check or holds no observations table; the next one passes SQLite's integrity check and holds an observations table.",
    );
  });

  it('offers set-aside when no snapshot passes, and says none passes', () => {
    const db = garbageDb('rem-alldamaged-');
    age(writeSnapshotFixture(`${db}.pre-delete-2026-09-07.bak`, { damage: true }), 0);
    writeFileSync(`${db}.pre-maintain-2026-09-01.bak`, 'not a database');
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('set-aside');
    expect(r.command).not.toMatch(/\bcp\b/);
    expect(r.found).toBe(
      "None of the 2 backup snapshot(s) beside the database passes SQLite's integrity check and holds an observations table.",
    );
  });

  // The SessionStart notice passes no binding: checking reads every candidate whole, on every
  // session start while the store is broken. It names no snapshot and points at doctor.
  it('names no snapshot without the binding, and points at doctor', () => {
    const db = garbageDb('rem-unchecked-');
    age(writeSnapshotFixture(`${db}.pre-delete-2026-09-07.bak`, { damage: true }), 0);
    writeFileSync(`${db}.pre-maintain-2026-09-01.bak`, '');
    const r = dbUnusableRemedy(db);
    expect(r.found).toBe('1 backup snapshot(s) exist beside the database (1 empty .bak file skipped).');
    expect(r.kind).toBe('unchecked');
    expect(r.command).toBe('');
    expect(r.snapshotCount).toBe(1);
    expect(r.note).not.toContain(`${db}.pre-delete`);
    expect(r.note).toContain(`${CLI_INVOKE} doctor`);
  });

  // D#551: versions before 6.30.4 left a 0-byte `.bak` when a snapshot of a damaged store
  // failed, and it was the newest; restoring it emptied the store.
  it('skips an empty snapshot and names the newest one that holds data', () => {
    const db = garbageDb('rem-empty-');
    const good = age(writeSnapshotFixture(`${db}.pre-maintain-2026-09-01.bak`), 1000);
    const empty = `${db}.pre-delete-2026-09-07.bak`;
    writeFileSync(empty, '');
    age(empty, 0);
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('restore');
    expect(r.snapshotCount).toBe(1);
    expect(r.command).toContain(good);
    expect(r.command).not.toContain(empty);
  });

  it('offers set-aside when every snapshot is empty, and says they were skipped', () => {
    const db = garbageDb('rem-allempty-');
    writeFileSync(`${db}.pre-delete-2026-09-07.bak`, '');
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('set-aside');
    expect(r.snapshotCount).toBe(0);
    expect(r.found).toBe(
      'No backup snapshot beside the database holds any data (1 empty .bak file skipped).',
    );
  });

  // v6.30.5 pre-tag review P2-2: a hand-made `cp db x.bak` of a WAL store taken before a
  // checkpoint is a main file with no table in it and every row in `x.bak-wal`. It passes
  // SQLite's integrity check, and restoring it (the command copies the main file alone) left no
  // observations table.
  it('skips a newer snapshot that passes the integrity check but holds no store', () => {
    const db = garbageDb('rem-nostore-');
    const good = age(writeSnapshotFixture(`${db}.pre-maintain-2026-09-01.bak`), 2000);
    const live = new Database(join(dirname(db), 'live.db'));
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec("CREATE TABLE observations (a TEXT); INSERT INTO observations VALUES ('in the log')");
    const copy = `${db}.before-upgrade.bak`;
    writeFileSync(copy, readFileSync(join(dirname(db), 'live.db')));
    writeFileSync(`${copy}-wal`, readFileSync(join(dirname(db), 'live.db-wal')));
    live.close();
    age(copy, 0);
    const main = new Database(readFileSync(copy).fill(1, 18, 20));
    expect(main.prepare('PRAGMA integrity_check').pluck().get(), 'premise: the main file passes').toBe('ok');
    expect(main.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'observations'").pluck().get()).toBe(
      0,
    );
    main.close();
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('restore');
    expect(r.command).toContain(good);
    expect(r.command).not.toContain(copy);
  });

  // v6.30.5 pre-tag review P2-1: a snapshot the check could not read (permissions, a file over
  // readFileSync's 2 GiB limit, a directory) was reported as failing it, and the remedy moved on
  // to an older snapshot or the set-aside command. It cannot say the snapshot is bad, so it names
  // nothing and says why.
  it('names nothing when the newest snapshot cannot be checked, and says why', () => {
    const db = garbageDb('rem-cannotcheck-');
    age(writeSnapshotFixture(`${db}.pre-maintain-2026-09-01.bak`), 2000);
    const unreadable = `${db}.pre-delete-2026-09-07.bak`;
    mkdirSync(unreadable);
    writeFileSync(join(unreadable, 'pad'), 'x');
    age(unreadable, 0);
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('unknown');
    expect(r.command).toBe('');
    expect(r.note).toContain(unreadable);
    expect(r.note).toContain('EISDIR');
    expect(r.note).not.toMatch(/None of the/);
  });

  // The order is total: equal times fall back to the path, so the answer never depends on readdir.
  it('breaks a tie in mtime by path', () => {
    const db = garbageDb('rem-tie-');
    const a = writeSnapshotFixture(`${db}.pre-delete-2026-09-07.bak`);
    const b = writeSnapshotFixture(`${db}.pre-maintain-2026-09-01.bak`);
    utimesSync(a, 1_700_000_000, 1_700_000_000);
    utimesSync(b, 1_700_000_000, 1_700_000_000);
    expect(statSync(a).mtimeMs, 'premise: equal mtimes').toBe(statSync(b).mtimeMs);
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.command).toContain(b);
    expect(r.command).not.toContain(a);
  });

  // integrity_check, not quick_check: a stale index passes the second and fails the first.
  it('skips a newer snapshot whose index disagrees with its table', () => {
    const db = garbageDb('rem-index-');
    const good = age(writeSnapshotFixture(`${db}.pre-maintain-2026-09-01.bak`), 2000);
    const stale = `${db}.pre-delete-2026-09-07.bak`;
    const s = new Database(stale);
    s.exec(
      "CREATE TABLE observations (a TEXT); CREATE INDEX obs_a ON observations(a); INSERT INTO observations VALUES ('x'), ('y')",
    );
    const idx = s
      .prepare("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master WHERE name = 'obs_a'")
      .get();
    s.unsafeMode(true);
    s.pragma('writable_schema = ON');
    s.prepare("DELETE FROM sqlite_master WHERE name = 'obs_a'").run();
    s.close();
    const s2 = new Database(stale);
    s2.exec("UPDATE observations SET a = a || '!'");
    s2.unsafeMode(true);
    s2.pragma('writable_schema = ON');
    s2.prepare('INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES (?, ?, ?, ?, ?)').run(
      idx.type,
      idx.name,
      idx.tbl_name,
      idx.rootpage,
      idx.sql,
    );
    s2.close();
    age(stale, 0);
    const ro = new Database(stale, { readonly: true });
    expect(ro.prepare('PRAGMA quick_check').pluck().get(), 'premise: quick_check passes').toBe('ok');
    expect(ro.prepare('PRAGMA integrity_check').pluck().get(), 'premise: integrity_check fails').not.toBe(
      'ok',
    );
    ro.close();
    const r = dbUnusableRemedy(db, undefined, { Database });
    expect(r.kind).toBe('restore');
    expect(r.command).toContain(good);
    expect(r.command).not.toContain(stale);
  });

  // Three outcomes, never two — "there is no backup" and "I could not look" must not print in
  // the same voice, which is the rule lib/schema-skew.mjs states and the v6.2.0 doctor check
  // broke. Driven with a path whose parent is a FILE, so readdirSync fails with ENOTDIR.
  it('says "could not look" rather than "no backup" when the directory is unreadable', () => {
    const dir = tmp('rem-unread-');
    const notADir = join(dir, 'blocker');
    writeFileSync(notADir, 'x');
    const r = dbUnusableRemedy(join(notADir, 'claude-mem-lite.db'), undefined, { Database });
    expect(r.kind).toBe('unknown');
    expect(r.command, 'a command we cannot justify must not be printed').toBe('');
    expect(r.note).toMatch(/Could not read/);
    expect(r.note).not.toMatch(/No backup snapshot exists/);
  });
});

describe('checkSnapshot', () => {
  // A hand-made `cp db x.bak` of a live store is in WAL mode. A read-only open of it creates its
  // -wal and -shm and leaves them; the check reads the file into memory instead.
  it('checks a WAL-mode copy and writes nothing beside it', () => {
    const dir = tmp('snapcheck-wal-');
    const live = new Database(join(dir, 'live.db'));
    live.pragma('journal_mode = WAL');
    live.exec("CREATE TABLE observations (a); INSERT INTO observations VALUES ('kept')");
    live.pragma('wal_checkpoint(TRUNCATE)');
    const copy = join(dir, 'claude-mem-lite.db.before-upgrade.bak');
    writeFileSync(copy, readFileSync(join(dir, 'live.db')));
    live.close();
    expect([...readFileSync(copy).subarray(18, 20)], 'premise: the copy is in WAL mode').toEqual([2, 2]);
    const before = readdirSync(dir).sort();
    expect(checkSnapshot(copy, Database)).toEqual({ verdict: 'ok' });
    expect(readdirSync(dir).sort()).toEqual(before);
    expect([...readFileSync(copy).subarray(18, 20)], 'the file itself is not touched').toEqual([2, 2]);
  });

  // A read-only connection skips CHECK constraints, so a read-only check passes this file.
  it('evaluates CHECK constraints', () => {
    const dir = tmp('snapcheck-check-');
    const path = join(dir, 'claude-mem-lite.db.pre-delete-x.bak');
    const db = new Database(path);
    db.exec("CREATE TABLE t (a TEXT CHECK (a IN ('x', 'y')))");
    db.pragma('ignore_check_constraints = ON');
    db.prepare('INSERT INTO t VALUES (?)').run('z');
    db.close();
    const ro = new Database(path, { readonly: true });
    expect(ro.prepare('PRAGMA integrity_check').pluck().get(), 'premise: read-only reads it as ok').toBe(
      'ok',
    );
    ro.close();
    expect(checkSnapshot(path, Database)).toEqual({ verdict: 'bad' });
  });

  // A 0-byte file reads as an empty database: it passes SQLite's check and holds no table.
  it('tells a file that is not a store from one it could not check', () => {
    const dir = tmp('snapcheck-bad-');
    writeFileSync(join(dir, 'text.bak'), 'not a database');
    writeFileSync(join(dir, 'empty.bak'), '');
    mkdirSync(join(dir, 'dir.bak'));
    expect(checkSnapshot(join(dir, 'text.bak'), Database)).toEqual({ verdict: 'bad' });
    expect(checkSnapshot(join(dir, 'empty.bak'), Database)).toEqual({ verdict: 'bad' });
    expect(checkSnapshot(join(dir, 'missing.bak'), Database)).toEqual({
      verdict: 'unchecked',
      reason: 'ENOENT',
    });
    expect(checkSnapshot(join(dir, 'dir.bak'), Database)).toEqual({ verdict: 'unchecked', reason: 'EISDIR' });
  });
});

// SQLite says "malformed database schema" when it cannot parse a row of sqlite_master. A
// damaged row is one cause; SQL its parser does not know is another (reasoned, not
// reproduced), and there restoring a snapshot or setting the file aside is wrong. So this
// family names the snapshots and gives no command.
describe('a schema SQLite cannot read', () => {
  const err = Object.assign(new Error('malformed database schema (idx_t_a) - incomplete input'), {
    code: 'SQLITE_CORRUPT',
  });

  it('gives no command, and names the newest snapshot that passes the integrity check', () => {
    const dir = tmp('rem-schema-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    const now = Date.now() / 1000;
    writeSnapshotFixture(`${db}.2026-09-01.bak`);
    writeSnapshotFixture(`${db}.2026-09-04.bak`);
    writeSnapshotFixture(`${db}.2026-09-07.bak`, { damage: true });
    utimesSync(`${db}.2026-09-01.bak`, now - 2000, now - 2000);
    utimesSync(`${db}.2026-09-04.bak`, now - 1000, now - 1000);
    utimesSync(`${db}.2026-09-07.bak`, now, now);
    const r = dbUnusableRemedy(db, err, { Database });
    expect(r.kind).toBe('schema');
    expect(r.command).toBe('');
    expect(r.snapshotCount).toBe(3);
    expect(r.note).toContain(`${db}.2026-09-04.bak`);
    expect(r.note).not.toContain(`${db}.2026-09-07.bak`);
    expect(r.note).not.toContain(`${db}.2026-09-01.bak`);
    // Without the binding (the SessionStart notice) it names none and points at doctor.
    const unchecked = dbUnusableRemedy(db, err);
    expect(unchecked.kind).toBe('schema');
    expect(unchecked.note).not.toContain('.bak');
    expect(unchecked.note).toContain(`${CLI_INVOKE} doctor`);
  });

  it('gives no command when no snapshot passes either', () => {
    const dir = tmp('rem-schema-bad-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    writeSnapshotFixture(`${db}.2026-09-07.bak`, { damage: true });
    const r = dbUnusableRemedy(db, err, { Database });
    expect(r.kind).toBe('schema');
    expect(r.command).toBe('');
    expect(r.note).not.toMatch(/rm -f|\bcp\b|\bmv\b/);
  });

  it('says so when no snapshot exists, still with no command', () => {
    const dir = tmp('rem-schema-none-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    const r = dbUnusableRemedy(db, err);
    expect(r.kind).toBe('schema');
    expect(r.command).toBe('');
    expect(r.note).toMatch(/No backup snapshot exists/);
  });

  it('keeps the other families on their own remedies', () => {
    const dir = tmp('rem-schema-ctl-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    expect(dbUnusableRemedy(db, new Error('file is not a database')).kind).toBe('set-aside');
    expect(dbUnusableRemedy(db).kind).toBe('set-aside');
  });

  it('the human notice says the schema cannot be read, not that the file is not a database', () => {
    const dir = tmp('rem-schema-notice-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    const out = formatDbUnusableNotice({ dbPath: db, remedy: dbUnusableRemedy(db, err) });
    expect(out).toMatch(/Memory is OFF/);
    expect(out).toMatch(/schema/);
    expect(out).not.toMatch(/does not recognise it as a database/);
    // The file opens; its schema is what SQLite cannot read (v6.30.0 review leftover, D#499(5)).
    expect(out).not.toMatch(/cannot be opened/);
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|&&/);
    // No command here, so nothing for "until then" to wait on (v6.30.0 pre-tag claims review P3-6).
    expect(out).not.toMatch(/until then/i);
  });
});

describe('the two notices', () => {
  const db = '/tmp/x/claude-mem-lite.db';
  const restore = {
    kind: 'restore',
    command: `rm -f "${db}-wal" "${db}-shm" && cp "${db}.v1.bak" "${db}"`,
    snapshotCount: 1,
    note: "The newest of the 1 backup snapshot(s) beside the database passes SQLite's integrity check and holds an observations table.",
  };

  it('the human notice carries the path, the command and the note', () => {
    const out = formatDbUnusableNotice({ dbPath: db, remedy: restore });
    expect(out).toMatch(/Memory is OFF/);
    expect(out).toContain(db);
    expect(out).toContain(restore.command);
    expect(out).toContain(restore.note);
  });

  // D#534: the command deletes the -wal and -shm, then copies over or moves the database file
  // under any session still holding it, this one included.
  it('the human notice says to close every session, this one included, before the command', () => {
    const dir = tmp('rem-sessions-');
    const dbp = join(dir, 'claude-mem-lite.db');
    writeFileSync(dbp, 'x');
    const setAside = dbUnusableRemedy(dbp, new Error('file is not a database'));
    writeSnapshotFixture(`${dbp}.2026-09-07.bak`);
    const restoreReal = dbUnusableRemedy(dbp, new Error('file is not a database'), { Database });
    expect([setAside.kind, restoreReal.kind]).toEqual(['set-aside', 'restore']);
    for (const remedy of [setAside, restoreReal]) {
      const lines = formatDbUnusableNotice({ dbPath: dbp, remedy }).split('\n');
      const say = lines.findIndex((l) => /every Claude Code session is closed, this one included/.test(l));
      expect(say, remedy.kind).toBeGreaterThan(-1);
      expect(say, `${remedy.kind}: before the command`).toBeLessThan(
        lines.findIndex((l) => l.includes('rm -f')),
      );
    }
    const none = formatDbUnusableNotice({
      dbPath: dbp,
      remedy: { kind: 'unknown', command: '', snapshotCount: 0, note: 'Could not read /tmp/x' },
    });
    expect(none).not.toMatch(/session is closed/);
  });

  it('renders without a command when there is none to give', () => {
    const out = formatDbUnusableNotice({
      dbPath: db,
      remedy: { kind: 'unknown', command: '', snapshotCount: 0, note: 'Could not read /tmp/x' },
    });
    expect(out).toMatch(/Memory is OFF/);
    expect(out).toContain('Could not read');
    // No stray blank remedy line where the command would have been.
    expect(out.split('\n').every((l) => l.trim().length > 0)).toBe(true);
  });

  // The model channel gets the FACT, never the command — this family's remedy overwrites the
  // database, and an agent holding Bash is not the same audience as a human reading a banner.
  // Asserted here as well as end-to-end so the property survives a refactor of either caller.
  it('the model notice contains no shell command at all', () => {
    const out = formatDbUnusableModelNotice();
    expect(out).toMatch(/Memory is OFF/);
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|&&/);
    expect(out, 'it must still route the user somewhere').toContain(`${CLI_INVOKE} doctor`);
  });

  it('the two notices are not the same string', () => {
    // The premise for the wiring test: if these ever converged, the end-to-end assertion that
    // the model channel is command-free would be graded against the human one.
    expect(formatDbUnusableModelNotice()).not.toBe(formatDbUnusableNotice({ dbPath: db, remedy: restore }));
  });
});

describe('shouldRecordOnce', () => {
  it('records the first time and suppresses within the interval', () => {
    const dir = tmp('once-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(false);
  });

  it('records again once the interval has passed', () => {
    const dir = tmp('once-int-');
    const t0 = Date.now();
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k', { now: t0 })).toBe(true);
    expect(
      shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k', { now: t0 + RELOG_INTERVAL_MS + 1 }),
    ).toBe(true);
  });

  it('keys per project, so one project cannot silence another', () => {
    const dir = tmp('once-proj-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projB', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(false);
  });

  // E2E 2026-10-16 round 2 (hooks NEW-3): non-ASCII letters became `_`, so `项目--博客` and
  // `项目--商城` shared one marker and one project's record silenced the other's for an hour.
  it('keys two non-ASCII projects of the same shape apart', () => {
    const dir = tmp('once-cjk-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, '项目--博客', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, '项目--商城', 'k')).toBe(true);
  });

  it('re-records when the key changes — new information is not the fault already logged', () => {
    const dir = tmp('once-key-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k1')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k2')).toBe(true);
  });

  it('keeps two prefixes independent, so skew and corruption do not silence each other', () => {
    const dir = tmp('once-prefix-');
    expect(shouldRecordOnce(dir, '.a-', 'p', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, '.b-', 'p', 'k')).toBe(true);
  });

  // FAILS TOWARD RECORDING, and it is total: both properties were paid for by a review round
  // on the skew twin, where the first cut made openDb() itself throw.
  it('records, and does not throw, when the runtime dir cannot be written', () => {
    const dir = tmp('once-ro-');
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const runtime = join(blocker, 'runtime');
    let out;
    expect(() => {
      out = shouldRecordOnce(runtime, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k');
    }).not.toThrow();
    expect(out).toBe(true);
    // And it stays true — an unwritable marker must never become a permanent silence.
    expect(shouldRecordOnce(runtime, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k')).toBe(true);
  });

  it('records when the marker is present but corrupt', () => {
    const dir = tmp('once-corrupt-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${DB_UNUSABLE_MARKER_PREFIX}p`), '{ not json');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k')).toBe(true);
    // …and repairs itself, so the flood stops after one line rather than never.
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k')).toBe(false);
  });

  // The property the extraction briefly lost. `shouldRecordSkew` is called from inside
  // `openDb()`'s catch, whose contract is return-null-never-throw, and moving the key
  // derivation outside the try made a hostile `info` propagate. Pinned on the WRAPPER, not on
  // shouldRecordOnce, because the wrapper is where the derivation lives.
  it('shouldRecordSkew stays TOTAL against an info that throws on access', async () => {
    const { shouldRecordSkew } = await import('../lib/schema-skew.mjs');
    const dir = tmp('once-total-');
    const throwingGetter = {
      get dbVersion() {
        throw new Error('boom');
      },
      binaryVersion: 1,
    };
    const throwingToString = {
      dbVersion: {
        toString() {
          throw new Error('ts');
        },
      },
      binaryVersion: 1,
    };
    // A FRESH dir per input: every hostile shape degrades to the same `?:?` key, so reusing
    // one dir would dedup the 2nd..4th to `false` and the assertion would be about the dedup,
    // not about totality. (It did, on the first run of this case.)
    for (const info of [throwingGetter, throwingToString, null, undefined]) {
      let out;
      expect(() => {
        out = shouldRecordSkew(tmp('once-total-'), 'p', info);
      }, 'nothing called from openDb()s catch may throw').not.toThrow();
      expect(out).toBe(true);
    }
    // And the degraded key still dedups on a second call, so totality did not cost the flood
    // control it exists for.
    expect(shouldRecordSkew(dir, 'p', throwingGetter)).toBe(true);
    expect(shouldRecordSkew(dir, 'p', throwingGetter)).toBe(false);
  });

  it('sanitises the project into a single path segment', () => {
    const dir = tmp('once-path-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, '../../etc/passwd', 'k')).toBe(true);
    // `-`, not `_`, since round 2 (the shared projectFileKey); still one segment, no traversal.
    const written = readFileSync(join(dir, `${DB_UNUSABLE_MARKER_PREFIX}..-..-etc-passwd`), 'utf8');
    expect(JSON.parse(written).key).toBe('k');
  });
});
