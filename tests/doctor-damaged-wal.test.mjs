// D#525: doctor's FTS check opened a read-write handle on any store whose read-only
// `sqlite_master` probe passed, and closed it plainly. With no other connection open that close
// is the last one, so SQLite copied the WAL, damaged frame included, into the main file and
// emptied the WAL. A store whose main file was intact came out of doctor with a damaged one,
// and doctor printed no ✗ Database line and no repair step
// (docs/audits/20261021-v6.31.0-pretag-defects.md, P1-1 and P2-2).
//
// The fixture is that review's: a WAL holding 40 inserts, a VACUUM and one more insert over a
// checkpointed main file, with bytes 0..63 of the newest frame of one small table's leaf set to
// 0xff and the checksum chain re-signed. Of 474 such plants (79 pages x 6 offsets, 2026-10-21),
// 38 fail to open and 6 of those pass the read-only probe: the leaves of `events_fts_config`
// and `schema_version`, the two cases below.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'claude-mem-lite.db';
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const INSERT_OBS = `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
  VALUES (?, 'p', 'discovery', ?, ?, datetime('now'), ?)`;

let PRISTINE;

beforeAll(() => {
  const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-wal-base-')));
  const db = new Database(join(dir, DB_NAME));
  db.pragma('journal_mode = WAL');
  initSchema(db);
  for (const s of ['s1', 's2']) {
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
       VALUES (?, ?, 'p', datetime('now'), 1)`,
    ).run(`c-${s}`, s);
  }
  const ins = db.prepare(INSERT_OBS);
  for (let i = 0; i < 200; i++)
    ins.run('s1', `title ${i} alpha`, `narrative ${i} gamma`, 1_700_000_000_000 + i);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  PRISTINE = readFileSync(join(dir, DB_NAME));
});

// SQLite discards a WAL frame whose checksum does not verify, so damage reaches an opener only
// in a re-signed frame (fileformat2 §4.1; the same arithmetic as tests/wal-recovery.test.mjs).
function walChecksum(buf, s0, s1, bigEndian) {
  for (let i = 0; i + 7 < buf.length; i += 8) {
    const a = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const b = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + a + s1) >>> 0;
    s1 = (s1 + b + s0) >>> 0;
  }
  return [s0, s1];
}

const rootPage = (table) => (live) =>
  live.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(table).rootpage;

/**
 * A store whose main file is PRISTINE and whose WAL carries a damaged page: bytes
 * [offset, offset + 64) of the newest frame of the page `pageOf` names.
 */
function plantDamagedWal(pageOf, offset = 0) {
  const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-wal-')));
  const dbPath = join(dir, DB_NAME);
  writeFileSync(dbPath, PRISTINE);
  const live = new Database(dbPath);
  const ins = live.prepare(INSERT_OBS);
  for (let i = 0; i < 40; i++) ins.run('s2', `late ${i}`, `late narrative ${i}`, 1_800_000_000_000 + i);
  live.exec('VACUUM');
  ins.run('s2', 'last', 'last narrative', 1_900_000_000_000);
  const pgno = pageOf(live);
  const wal = readFileSync(dbPath + '-wal'); // read while the handle is open: its close checkpoints
  live.close();
  writeFileSync(dbPath, PRISTINE);
  rmSync(dbPath + '-shm', { force: true });

  const bigEndian = wal.readUInt32BE(0) === 0x377f0683;
  const pageSize = wal.readUInt32BE(8);
  const frames = [];
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    frames.push({ off, pgno: wal.readUInt32BE(off) });
  }
  const target = frames.filter((f) => f.pgno === pgno).at(-1);
  expect(target, `the WAL must hold a frame of page ${pgno}`).toBeTruthy();
  const bad = Buffer.from(wal);
  bad.fill(0xff, target.off + 24 + offset, target.off + 24 + offset + 64);
  let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, bigEndian);
  for (const f of frames) {
    [s0, s1] = walChecksum(bad.subarray(f.off, f.off + 8), s0, s1, bigEndian);
    [s0, s1] = walChecksum(bad.subarray(f.off + 24, f.off + 24 + pageSize), s0, s1, bigEndian);
    bad.writeUInt32BE(s0, f.off + 16);
    bad.writeUInt32BE(s1, f.off + 20);
  }
  writeFileSync(dbPath + '-wal', bad);
  writeFileSync(dbPath + '-shm', Buffer.alloc(32768));
  return { dir, dbPath, wal: bad };
}

function runDoctor(dataDir) {
  // HOME sandboxed for the reason tests/doctor-db-remedy.test.mjs gives: otherwise the output is
  // graded against whatever plugin cache this machine holds.
  const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-wal-home-')));
  const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
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
  return r.stdout;
}

/** The command doctor's WAL step prints, run as a user would run it. */
function runWalStep(out) {
  const m = /move the log aside: (.+?) — then run doctor again/.exec(out);
  expect(m, `doctor printed no WAL step:\n${out}`).toBeTruthy();
  const r = spawnSync('sh', ['-c', m[1]], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}

const walAside = (dir) => readdirSync(dir).filter((f) => f.startsWith(`${DB_NAME}-wal.corrupt-`));

describe('doctor on a damaged WAL its read-only probe cannot see', () => {
  for (const table of ['events_fts_config', 'schema_version']) {
    it(`leaves the main file and the WAL as they were, and its step recovers the store (${table})`, () => {
      const { dir, dbPath, wal } = plantDamagedWal(rootPage(table));
      // Premise: the probe doctor used to gate on passes, so these stores reached its RW handle.
      const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
      expect(() =>
        ro.prepare("SELECT 1 FROM sqlite_master WHERE name = 'observations_fts'").get(),
      ).not.toThrow();
      ro.close();

      const out = runDoctor(dir);

      expect(readFileSync(dbPath).equals(PRISTINE), 'main file changed').toBe(true);
      expect(readFileSync(dbPath + '-wal').equals(wal), 'WAL changed').toBe(true);
      expect(out).toMatch(/✗ Database: database disk image is malformed/);
      expect(out).not.toMatch(/FTS5 rebuilt/);

      runWalStep(out);
      const kept = walAside(dir);
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(dir, kept[0])).equals(wal), 'the moved log is not the log').toBe(true);
      const again = runDoctor(dir);
      expect(again).not.toMatch(/✗ Database/);
      expect(again).toMatch(/✓ FTS5 integrity: all indexes healthy/);
    });
  }

  it('names the next step when the database file is damaged too', () => {
    // A damaged schema_version leaf in the main file under a healthy WAL that never touches it.
    const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-wal-main-')));
    const dbPath = join(dir, DB_NAME);
    writeFileSync(dbPath, PRISTINE);
    const live = new Database(dbPath);
    const pgno = live
      .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'schema_version'")
      .get().rootpage;
    const pageSize = live.pragma('page_size', { simple: true });
    const ins = live.prepare(INSERT_OBS);
    for (let i = 0; i < 5; i++) ins.run('s2', `late ${i}`, `late narrative ${i}`, 1_800_000_000_000 + i);
    const wal = readFileSync(dbPath + '-wal');
    live.close();
    const main = Buffer.from(PRISTINE);
    main.fill(0xff, (pgno - 1) * pageSize, (pgno - 1) * pageSize + 64);
    writeFileSync(dbPath, main);
    writeFileSync(dbPath + '-wal', wal);
    writeFileSync(dbPath + '-shm', Buffer.alloc(32768));

    const out = runDoctor(dir);
    expect(out).toMatch(/✗ Database: database disk image is malformed/);
    runWalStep(out);
    const again = runDoctor(dir);
    expect(again).toMatch(/✗ Database: database disk image is malformed/);
    expect(again).not.toMatch(/move the log aside/);
    expect(again).toMatch(/No backup snapshot exists beside the database/);
  });
});

describe('the checks the integrity gate must still let through', () => {
  it('an FTS5 leaf whose damage makes the integrity check run out of memory is still rebuilt', () => {
    // FTS5 reads a damaged doclist varint as an absurd allocation, so quick_check throws
    // SQLITE_NOMEM rather than returning a row. Of the 474 sweep plants 3 did; doctor rebuilt
    // all 3 before the gate, and the first draft of the gate reported "✗ Database: out of memory".
    const largestLeaf = (live) =>
      live
        .prepare(
          "SELECT pageno FROM dbstat WHERE name = 'observations_fts_data' AND pagetype = 'leaf' ORDER BY payload DESC, pageno LIMIT 1",
        )
        .get().pageno;
    const { dir, dbPath } = plantDamagedWal(largestLeaf, 2048);
    const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
    let code = null;
    try {
      ro.pragma('quick_check');
    } catch (e) {
      code = e.code;
    }
    ro.close();
    expect(code, 'premise: quick_check runs out of memory on this plant').toBe('SQLITE_NOMEM');

    const out = runDoctor(dir);
    expect(out).toMatch(/✓ FTS5 rebuilt: .*observations_fts/);
    expect(out).not.toMatch(/✗ Database/);
    const after = new Database(dbPath, { readonly: true });
    expect(after.pragma('quick_check', { simple: true })).toBe('ok');
    after.close();
  });

  it('a healthy store gets the FTS check and no ✗ Database', () => {
    const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-wal-ok-')));
    writeFileSync(join(dir, DB_NAME), PRISTINE);
    const out = runDoctor(dir);
    expect(out).toMatch(/✓ FTS5 integrity: all indexes healthy/);
    expect(out).not.toMatch(/✗ Database/);
  });

  it('a damaged FTS index (pages sound) is still rebuilt', () => {
    const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-wal-fts-')));
    const dbPath = join(dir, DB_NAME);
    writeFileSync(dbPath, PRISTINE);
    const db = new Database(dbPath);
    db.unsafeMode(true); // shadow tables are read-only under SQLite's defensive mode
    db.exec("UPDATE observations_fts_data SET block = X'0102030405' WHERE id = 10"); // structure record
    db.close();
    const out = runDoctor(dir);
    expect(out).toMatch(/FTS5 integrity issues detected/);
    expect(out).toMatch(/✓ FTS5 rebuilt: .*observations_fts/);
    expect(out).not.toMatch(/✗ Database/);
    const after = new Database(dbPath);
    expect(() =>
      after.exec("INSERT INTO observations_fts(observations_fts, rank) VALUES('integrity-check', 1)"),
    ).not.toThrow();
    after.close();
  });
});
