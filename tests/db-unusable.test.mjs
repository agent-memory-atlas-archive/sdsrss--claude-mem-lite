// Units for lib/db-unusable.mjs and lib/record-once.mjs.
// tests/db-unusable-wiring.test.mjs proves anything CALLS them.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shellWord } from '../cli-path.mjs';
import {
  isDbUnusableError,
  dbUnusableRemedy,
  formatDbUnusableNotice,
  formatDbUnusableModelNotice,
  DB_UNUSABLE_MARKER_PREFIX,
} from '../lib/db-unusable.mjs';
import { shouldRecordOnce, RELOG_INTERVAL_MS } from '../lib/record-once.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

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

// The walk takes the snapshot check as `check`, so these cases drive it with a stub and stay fast;
// tests/snapshot-check.test.mjs runs the real check (a child process per snapshot) and the
// printed commands in a shell.
const NOW = Date.UTC(2026, 9, 23, 19, 30, 0, 0);
const KEPT = (db) => `${db}.corrupt-2026-10-23T19-30-00-000Z`;
const ok = (observations = 5) => ({ verdict: 'ok', observations, withLog: false });
const snapshotsAt = (db, names) => {
  // Distinct mtimes so "newest" is decided by the field the code sorts on, not by luck.
  const now = Date.now() / 1000;
  return names.map((n, i) => {
    const p = `${db}.${n}.bak`;
    writeFileSync(p, `snapshot ${n}`);
    utimesSync(p, now - 1000 * (names.length - i), now - 1000 * (names.length - i));
    return p;
  });
};
const stubCheck = (verdicts) => {
  const seen = [];
  const check = (path) => {
    seen.push(path);
    return verdicts[path] ?? ok();
  };
  return { check, seen };
};

describe('dbUnusableRemedy', () => {
  it('offers set-aside when no snapshot exists, and says so rather than staying vague', () => {
    const dir = tmp('rem-none-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(r.kind).toBe('set-aside');
    expect(r.snapshotCount).toBe(0);
    expect(r.keptAs).toBe(KEPT(db));
    expect(r.command).toContain(`mv ${shellWord(db)} ${shellWord(KEPT(db))}`);
    // D#539 and the log the old command deleted: the broken file's -wal goes with it, under the
    // name SQLite looks for beside the kept file.
    expect(r.command).toContain(`mv ${shellWord(`${db}-wal`)} ${shellWord(`${KEPT(db)}-wal`)}`);
    expect(r.command).not.toMatch(/rm -f [^&]*-wal/);
    expect(r.command, 'the -shm is derived state and goes').toContain(`rm -f ${shellWord(`${db}-shm`)}`);
  });

  it('starts every command with a guard, so running it twice cannot overwrite the first kept copy', () => {
    const dir = tmp('rem-guard-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const setAside = dbUnusableRemedy(db, undefined, { stampMs: NOW });
    const [restoreSnap] = snapshotsAt(db, ['pre-delete-2026-09-07']);
    const restore = dbUnusableRemedy(db, undefined, { stampMs: NOW, check: stubCheck({}).check });
    expect(restore.kind).toBe('restore');
    const guard = `test ! -e ${shellWord(KEPT(db))} && test ! -e ${shellWord(`${KEPT(db)}-wal`)} && `;
    expect(setAside.command.startsWith(guard)).toBe(true);
    // The restore first checks that the snapshot is still there, so nothing moves without it
    // (D#570, v6.30.6 r1 defects P3-5).
    expect(restore.command.startsWith(`test -s ${shellWord(restoreSnap)} && ${guard}`)).toBe(true);
    // Then the snapshot in place, writable, and the reindex the check ran after the product's open,
    // against this data directory.
    expect(
      restore.command.endsWith(
        `cp ${shellWord(restoreSnap)} ${shellWord(db)} && chmod 600 ${shellWord(db)} && CLAUDE_MEM_DIR=${shellWord(dir)} ${CLI_INVOKE} fts-check rebuild`,
      ),
    ).toBe(true);
  });

  // doctor --json runs doctor a second time and its lines must match the human face's; and a
  // user comparing two doctor runs should not see two different commands for one broken file.
  it('names the kept copy after the broken file, so two runs print one command', () => {
    const dir = tmp('rem-stamp-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    utimesSync(db, NOW / 1000, NOW / 1000);
    const a = dbUnusableRemedy(db);
    const b = dbUnusableRemedy(db);
    expect(a.keptAs).toBe(KEPT(db));
    expect(b.command).toBe(a.command);
    utimesSync(db, NOW / 1000 + 60, NOW / 1000 + 60);
    expect(dbUnusableRemedy(db).keptAs, 'a later broken file gets another name').not.toBe(a.keptAs);
  });

  it('does not say the set-aside file cannot be recovered', () => {
    const dir = tmp('rem-none-note-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(r.kind).toBe('set-aside');
    expect(r.note).toBe(
      `No backup snapshot exists beside the database. That command moves the broken file and its log aside, as ${KEPT(db)} and ${KEPT(db)}-wal, so a fresh store is created on the next session.`,
    );
  });

  // Without a check (the SessionStart notice), no snapshot goes into a command: the check copies
  // and opens each candidate, which a session start must not pay for while the store is broken.
  it('names no snapshot in a command when it was not asked to check them, and points at doctor', () => {
    const dir = tmp('rem-nocheck-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const r = dbUnusableRemedy(db, new Error('file is not a database'), { stampMs: NOW });
    // 'unknown', which every version's doctor renders as its note (r1 defects P3-5).
    expect(r.kind).toBe('unknown');
    expect(r.command).toBe('');
    expect(r.snapshotCount).toBe(2);
    expect(r.note).toContain('2 backup snapshot(s) exist beside the database');
    expect(r.note).toContain(`${CLI_INVOKE} doctor`);
  });

  it('checks newest first, names the newest that restores cleanly, and checks the older ones too', () => {
    const dir = tmp('rem-snap-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [older, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const { check, seen } = stubCheck({});
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW, check });
    expect(r.kind).toBe('restore');
    expect(r.snapshotCount).toBe(2);
    expect(r.command).toContain(newer);
    expect(r.command).not.toContain(older);
    // Every older snapshot is checked so each that passes can be listed (D#577).
    expect(seen).toEqual([newer, older]);
    expect(r.alternatives.map((x) => x.path)).toEqual([older]);
    expect(r.found).toMatch(/The newest of the 2 backup snapshot\(s\) beside the database restores cleanly/);
    expect(r.found).toContain('5 observation(s)');
  });

  it.each([
    ['does not open', { verdict: 'bad', why: 'open', reason: 'SQLITE_NOTADB' }],
    ['fails the integrity check', { verdict: 'bad', why: 'integrity', reason: 'Tree 5 page 5 cell 1: …' }],
    ['holds no rows', { verdict: 'empty' }],
  ])('skips a newer snapshot that %s and names the next one', (label, verdict) => {
    const dir = tmp('rem-skip-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [older, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const { check, seen } = stubCheck({ [newer]: verdict });
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW, check });
    expect(r.kind).toBe('restore');
    expect(r.command).toContain(older);
    expect(r.command).not.toContain(newer);
    expect(seen).toEqual([newer, older]);
    expect(r.found).toContain(`1 ${label}`);
  });

  it('counts several passed-over snapshots of one kind in the plural', () => {
    const dir = tmp('rem-plural-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [older, mid, newer] = snapshotsAt(db, ['a-2026-09-01', 'b-2026-09-04', 'c-2026-09-07']);
    const bad = { verdict: 'bad', why: 'open', reason: 'SQLITE_NOTADB' };
    const r = dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: stubCheck({ [newer]: bad, [mid]: bad }).check,
    });
    expect(r.command).toContain(older);
    expect(r.found).toContain('the newest 2 do not restore cleanly (2 do not open); the next one does');
    const none = dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: () => ({ verdict: 'bad', why: 'integrity', reason: 'x' }),
    });
    expect(none.found).toContain('(3 fail the integrity check)');
  });

  it("copies the snapshot's own log too when the check restored it with that log", () => {
    const dir = tmp('rem-log-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [snap] = snapshotsAt(db, ['before-upgrade']);
    const r = dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: () => ({ verdict: 'ok', observations: 60, withLog: true }),
    });
    expect(r.command).toContain(`test -s ${shellWord(`${snap}-wal`)} && `);
    expect(r.command).toContain(
      `cp ${shellWord(snap)} ${shellWord(db)} && chmod 600 ${shellWord(db)} && cp ${shellWord(`${snap}-wal`)} ${shellWord(`${db}-wal`)} && chmod 600 ${shellWord(`${db}-wal`)} && `,
    );
  });

  it('stops at a snapshot it could not check: no command, the reason and the path', () => {
    const dir = tmp('rem-unchecked-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [older, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const { check, seen } = stubCheck({ [newer]: { verdict: 'unchecked', reason: 'ENOSPC' } });
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW, check });
    expect(r.kind).toBe('unknown');
    expect(r.command).toBe('');
    expect(seen, 'an older snapshot named past it could hold less').toEqual([newer]);
    expect(r.note).toContain('could not be checked (ENOSPC)');
    expect(r.note).toContain(newer);
    expect(r.note).not.toContain(older);
  });

  it('offers set-aside when no snapshot restores cleanly, and says how many it checked', () => {
    const dir = tmp('rem-nonepass-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [older, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const { check } = stubCheck({
      [newer]: { verdict: 'bad', why: 'integrity', reason: 'x' },
      [older]: { verdict: 'empty' },
    });
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW, check });
    expect(r.kind).toBe('set-aside');
    expect(r.found).toMatch(/^None of the 2 backup snapshot\(s\) beside the database restores cleanly/);
    expect(r.found).toContain('1 fails the integrity check');
    expect(r.found).toContain('1 holds no rows');
    expect(r.command).not.toContain(newer);
    expect(r.command).not.toContain(older);
  });

  // D#551: versions before 6.31.0 left a 0-byte `.bak` when a snapshot of a damaged store
  // failed, and it was the newest; restoring it emptied the store. It is never checked.
  it('skips an empty .bak file without checking it, and says so in every sentence', () => {
    const dir = tmp('rem-empty-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const [good] = snapshotsAt(db, ['pre-maintain-2026-09-01']);
    const empty = `${db}.pre-delete-2026-09-07.bak`;
    writeFileSync(empty, '');
    const { check, seen } = stubCheck({});
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW, check });
    expect(r.kind).toBe('restore');
    expect(r.snapshotCount).toBe(1);
    expect(r.command).toContain(good);
    expect(seen).toEqual([good]);
    expect(r.found).toContain('1 empty .bak file skipped');
    const unchecked = dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(unchecked.note).toContain('1 empty .bak file skipped');
  });

  it('offers set-aside when every snapshot is empty, and says they were skipped', () => {
    const dir = tmp('rem-allempty-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    writeFileSync(`${db}.pre-delete-2026-09-07.bak`, '');
    const r = dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(r.kind).toBe('set-aside');
    expect(r.snapshotCount).toBe(0);
    expect(r.note).toContain('1 empty .bak file');
  });

  // Three outcomes, never two — "there is no backup" and "I could not look" must not print in
  // the same voice, which is the rule lib/schema-skew.mjs states and the v6.2.0 doctor check
  // broke. Driven with a path whose parent is a FILE, so readdirSync fails with ENOTDIR.
  it('says "could not look" rather than "no backup" when the directory is unreadable', () => {
    const dir = tmp('rem-unread-');
    const notADir = join(dir, 'blocker');
    writeFileSync(notADir, 'x');
    const r = dbUnusableRemedy(join(notADir, 'claude-mem-lite.db'));
    expect(r.kind).toBe('unknown');
    expect(r.command, 'a command we cannot justify must not be printed').toBe('');
    expect(r.note).toMatch(/Could not read/);
    expect(r.note).not.toMatch(/No backup snapshot exists/);
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

  it('gives no command, and names the newest snapshot that restores cleanly', () => {
    const dir = tmp('rem-schema-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    const [older, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const r = dbUnusableRemedy(db, err, { stampMs: NOW, check: stubCheck({}).check });
    expect(r.kind).toBe('schema');
    expect(r.command).toBe('');
    expect(r.snapshotCount).toBe(2);
    expect(r.note).toContain(`It is ${newer}.`);
    // The older one that passes is listed, as on the restore path (D#577).
    expect(r.found).toContain(`An older snapshot also restores: ${older}, 5 observation(s).`);
  });

  it('without a check, counts the snapshots and points at doctor, with no command', () => {
    const dir = tmp('rem-schema-nocheck-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    const [, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const r = dbUnusableRemedy(db, err, { stampMs: NOW });
    expect(r.kind).toBe('schema');
    expect(r.command).toBe('');
    expect(r.note).toContain('2 backup snapshot(s) exist beside the database');
    expect(r.note).not.toContain(newer);
  });

  it('gives no command when no snapshot restores cleanly either, or when one could not be checked', () => {
    const dir = tmp('rem-schema-nonepass-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'x');
    const [, newer] = snapshotsAt(db, ['pre-maintain-2026-09-01', 'pre-delete-2026-09-07']);
    const none = dbUnusableRemedy(db, err, { stampMs: NOW, check: () => ({ verdict: 'empty' }) });
    expect(none.kind).toBe('schema');
    expect(none.command).toBe('');
    expect(none.found).toMatch(/^None of the 2 /);
    const unchecked = dbUnusableRemedy(db, err, {
      stampMs: NOW,
      check: () => ({ verdict: 'unchecked', reason: 'EACCES' }),
    });
    expect(unchecked.kind).toBe('schema');
    expect(unchecked.command).toBe('');
    expect(unchecked.note).toContain(`could not be checked (EACCES): ${newer}`);
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
    note: 'Restores the newest of 1 backup snapshot(s).',
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
    writeFileSync(`${dbp}.2026-09-07.bak`, 'b');
    const restoreReal = dbUnusableRemedy(dbp, new Error('file is not a database'), { check: () => ok() });
    expect([setAside.kind, restoreReal.kind]).toEqual(['set-aside', 'restore']);
    for (const remedy of [setAside, restoreReal]) {
      const lines = formatDbUnusableNotice({ dbPath: dbp, remedy }).split('\n');
      const say = lines.findIndex((l) => /every Claude Code session is closed, this one included/.test(l));
      expect(say, remedy.kind).toBeGreaterThan(-1);
      expect(say, `${remedy.kind}: before the command`).toBeLessThan(
        lines.findIndex((l) => l.includes(remedy.command)),
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

  // The model channel gets the FACT, never the command — this family's remedy moves the
  // database, and an agent holding Bash is not the same audience as a human reading a banner.
  // Asserted here as well as end-to-end so the property survives a refactor of either caller.
  it('the model notice contains no shell command at all', () => {
    const out = formatDbUnusableModelNotice(db);
    expect(out).toMatch(/Memory is OFF/);
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|&&/);
    expect(out, 'it must still route the user somewhere').toContain(`${CLI_INVOKE} doctor`);
  });

  it('the two notices are not the same string', () => {
    // The premise for the wiring test: if these ever converged, the end-to-end assertion that
    // the model channel is command-free would be graded against the human one.
    expect(formatDbUnusableModelNotice(db)).not.toBe(formatDbUnusableNotice({ dbPath: db, remedy: restore }));
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
