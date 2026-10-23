// `doctor` printed `✗ Database: file is not a database` with no remedy, while every other
// ✗ on the same screen carried one (orphan hooks, hook self-heal, schema skew). The user is
// left with a red line and nowhere to go — and the remedy exists: this repo takes VACUUM
// INTO snapshots before every irreversible maintenance pass (lib/db-backup.mjs).
//
// Three outcomes, never two. "There is no snapshot" and "I could not read the directory"
// get different sentences, because a diagnostic that says "no backup exists" when it never
// looked ends the reader's search with a false fact.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dbCheckRemedy } from '../install.mjs';
import { readSnapshots } from '../lib/db-backup.mjs';
import { makeFixtureTracker, writeSnapshotFixture } from './test-helpers.mjs';

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const corrupt = () => Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });

function dataDir() {
  return fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-remedy-')));
}

// Snapshots oldest first; a name in `damaged` gets a snapshot that fails SQLite's integrity check.
function withDb(snapshotNames = [], { damaged = [] } = {}) {
  const dir = dataDir();
  const db = join(dir, 'claude-mem-lite.db');
  writeFileSync(db, 'not actually sqlite');
  let t = 1_700_000_000;
  for (const n of snapshotNames) {
    const p = writeSnapshotFixture(join(dir, n), { damage: damaged.includes(n) });
    // Deterministic ordering: the newest snapshot is the one the remedy must name, and
    // two files written in the same millisecond would make "newest" arbitrary (D#9).
    utimesSync(p, t, t);
    t += 3600;
  }
  return { dir, db };
}

describe('readSnapshots separates empty from unreadable', () => {
  it('reports ok with an empty list when the directory has no snapshots', () => {
    const { db } = withDb();
    expect(readSnapshots(db)).toEqual({ ok: true, snapshots: [] });
  });

  it('reports NOT ok when the directory cannot be read', () => {
    const dir = dataDir();
    const notADir = join(dir, 'file-where-a-dir-should-be');
    writeFileSync(notADir, 'x');
    // ENOTDIR rather than a chmod: deterministic, and it still reproduces when the suite
    // runs as root.
    const r = readSnapshots(join(notADir, 'claude-mem-lite.db'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ENOTDIR');
  });
});

describe('dbCheckRemedy', () => {
  it('names the newest snapshot when one exists', async () => {
    const { db } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toContain('2026-09-06T00-00-00-000Z');
    expect(out).not.toContain('2026-09-01T00-00-00-000Z');
    expect(out).toContain('cp ');
    // The stale WAL/SHM must go first or the restored file is corrupted again by replay.
    expect(out).toContain('-wal');
    expect(out).toContain('-shm');
  });

  // D#553: the restore command named the newest non-empty snapshot by its time alone, and one
  // taken after the damage can hold it.
  it('skips a newer snapshot that fails the integrity check', async () => {
    const { db } = withDb(
      [
        'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
        'claude-mem-lite.db.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak',
      ],
      { damaged: ['claude-mem-lite.db.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak'] },
    );
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toContain('cp ');
    expect(out).toContain('pre-maintain-2026-09-01T00-00-00-000Z');
    expect(out).not.toContain('pre-delete-2026-09-06T00-00-00-000Z');
    expect(out).toMatch(/fails SQLite's integrity check or holds no observations table; the next one passes/);
  });

  it('offers set-aside when no snapshot passes the integrity check', async () => {
    const name = 'claude-mem-lite.db.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak';
    const { db } = withDb([name], { damaged: [name] });
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toMatch(
      /^None of the 1 backup snapshot\(s\) beside the database passes SQLite's integrity check and holds an observations table\./,
    );
    expect(out).not.toContain('cp ');
    expect(out).toContain('mv ');
  });

  it('says so plainly when no snapshot exists, and does not offer a restore', async () => {
    const { db } = withDb();
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toMatch(/^No backup snapshot exists beside the database\./);
    expect(out).not.toContain('cp ');
    expect(out).toContain('mv ');
    // D#554: a store whose damage is in its log can read most of its rows once the log is gone.
    expect(out).not.toMatch(/not recoverable/);
  });

  // D#551: an empty .bak (what a failed snapshot of a damaged store left before 6.30.4) is
  // skipped, so the set-aside arm runs with a .bak beside the database; it is not "none exists".
  it('does not say no snapshot exists when it skipped an empty one', async () => {
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'not actually sqlite');
    writeFileSync(join(dir, 'claude-mem-lite.db.pre-delete-2026-09-07T00-00-00-000Z-1-0.bak'), '');
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toContain('mv ');
    expect(out).not.toMatch(/No backup snapshot exists/);
    expect(out).toMatch(
      /No backup snapshot beside the database holds any data \(1 empty \.bak file skipped\)/,
    );
  });

  it('distinguishes "could not look" from "there are none"', async () => {
    const dir = dataDir();
    const notADir = join(dir, 'wall');
    writeFileSync(notADir, 'x');
    const out = await dbCheckRemedy(join(notADir, 'claude-mem-lite.db'), corrupt());
    expect(out).toMatch(/could not read/i);
    expect(out).toContain('ENOTDIR');
    // The whole point of the third outcome: it must NOT assert the absence it never checked.
    expect(out).not.toMatch(/no backup snapshot|none of the/i);
  });

  it('hands a native-binding failure the binding repair chain, not a backup', async () => {
    const { db } = withDb();
    const err = new Error('Could not locate the bindings file. Tried:\n → build/Release/better_sqlite3.node');
    const out = await dbCheckRemedy(db, err);
    expect(out).toMatch(/npm rebuild better-sqlite3/);
    expect(out).not.toMatch(/backup snapshot/i);
  });

  it('invents no remedy for an error it cannot classify', async () => {
    // Control. A diagnostic that always prints a fix will eventually print the wrong one;
    // an unclassified failure keeps the bare message it had before.
    const { db } = withDb();
    expect(await dbCheckRemedy(db, new Error('EACCES: permission denied, open'))).toBeNull();
  });

  // A schema row SQLite cannot parse: name the snapshots, run nothing (lib/db-unusable.mjs).
  it('names the newest snapshot for an unreadable schema, with no command', async () => {
    const { db } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const err = Object.assign(new Error('malformed database schema (idx_t_a) - incomplete input'), {
      code: 'SQLITE_CORRUPT',
    });
    const out = await dbCheckRemedy(db, err);
    expect(out).toMatch(/schema/);
    expect(out).toContain('2026-09-06T00-00-00-000Z');
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|&&/);
  });

  // D#534: both commands start by deleting the -wal and -shm and then replace or move the
  // database file, under any session still holding the store.
  it('says to close every Claude Code session before the restore or set-aside command', async () => {
    const snap = withDb(['claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak']).db;
    for (const [what, out] of [
      ['restore', await dbCheckRemedy(snap, corrupt())],
      ['set-aside', await dbCheckRemedy(withDb().db, corrupt())],
    ]) {
      const at = out.indexOf('every Claude Code session is closed');
      expect(at, what).toBeGreaterThan(-1);
      expect(at, `${what}: before the command`).toBeLessThan(out.indexOf('rm -f'));
    }
  });

  it('accepts the other spellings SQLite uses for a damaged file', async () => {
    const { db } = withDb();
    for (const msg of ['database disk image is malformed', 'file is encrypted or is not a database']) {
      expect(await dbCheckRemedy(db, new Error(msg)), msg).toMatch(
        /^No backup snapshot exists beside the database/,
      );
    }
  });
});

// WIRING. The cases above prove the function; nothing above proves anyone calls it, and
// this repo has shipped exactly that gap more than once (doctor's UNKNOWN bash-hook arm had
// seven green unit cases and no caller). So drive the SHIPPED doctor over a corrupt file.
describe('doctor prints the remedy it computes', () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  function runDoctor(dataDir) {
    // HOME is sandboxed: without it these assertions are graded against whatever plugin
    // cache the developer's machine holds, which is how an earlier doctor test failed its
    // own control (tests/schema-skew-wiring.test.mjs records that round).
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-remedy-home-')));
    return spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
  }

  it('emits the no-snapshot remedy under the ✗ Database line', () => {
    const { dir } = withDb();
    const out = runDoctor(dir).stdout;
    // Premise: the check really did fail. Without this the remedy assertion could pass on
    // output where the database line never appeared at all.
    expect(out).toMatch(/Database: .*not a database|Database: .*malformed/);
    expect(out).toMatch(/No backup snapshot exists beside the database/);
  });

  it('emits the restore remedy naming the newest snapshot', () => {
    const { dir } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const out = runDoctor(dir).stdout;
    expect(out).toMatch(/The newest of the 2 backup snapshot\(s\) beside the database passes/);
    expect(out).toMatch(/cp \S*2026-09-06T00-00-00-000Z/);
  });

  // D#553 through the shipped doctor: the damaged newest snapshot is skipped.
  it('names the snapshot that passes, not a newer damaged one', () => {
    const damaged = 'claude-mem-lite.db.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak';
    const { dir } = withDb(['claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak', damaged], {
      damaged: [damaged],
    });
    const out = runDoctor(dir).stdout;
    expect(out).toMatch(/cp \S*pre-maintain-2026-09-01T00-00-00-000Z/);
    expect(out).not.toContain('pre-delete-2026-09-06T00-00-00-000Z');
  });

  it('says nothing extra when the database opens cleanly (control)', () => {
    const dir = dataDir();
    const out = runDoctor(dir).stdout;
    // No DB file at all → the "not found (will be created)" arm, which must not acquire a
    // corruption remedy. Guards the fix against over-reaching.
    //
    // Asserted against the remedy's OWN sentences, not the bare phrase "backup snapshot":
    // a healthy doctor already prints `Disk footprint: … 0 backup snapshot(s)`, and the
    // first draft of this control matched that unrelated line and failed. A control that
    // greps too widely reports the wrong thing as a regression.
    expect(out).toMatch(/Database: not found/);
    expect(out).not.toMatch(/No backup snapshot exists beside the database/);
    expect(out).not.toMatch(/backup snapshot\(s\) beside the database/);
    expect(out).not.toMatch(/Could not read .* to look for a backup snapshot/);
  });
});
