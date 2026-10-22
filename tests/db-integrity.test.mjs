// D#541, D#550: the read-only integrity check doctor runs. The plants are page damage at offsets
// calibrated on 2026-10-21 (SQLite 3.53.4): a table leaf's header stops a scan part-way and page
// 1's header makes the file "not a database"; the log plant damages the newest frame of a page in
// a valid log, re-signed.
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema } from '../schema.mjs';
import { insertObs, insertSession, makeFixtureTracker } from './test-helpers.mjs';
import { readIntegrity, checkIntegrity, summarizeIntegrity } from '../lib/db-integrity.mjs';

const DB = 'claude-mem-lite.db';
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const newDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-integrity-')));

function buildStore(dir, { rows = 300 } = {}) {
  const p = join(dir, DB);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'sess-1' });
  for (let i = 0; i < rows; i++)
    insertObs(db, { title: `obs ${i} alpha`, narrative: `${'n'.repeat(300)} word${i}`, epochOffset: i });
  db.close();
  return p;
}

function pages(p, name, type = 'leaf') {
  const db = new Database(p, { readonly: true });
  try {
    return db
      .prepare(`SELECT pageno FROM dbstat WHERE name = ? AND pagetype = ? ORDER BY pageno`)
      .pluck()
      .all(name, type);
  } finally {
    db.close();
  }
}

function plant(p, pageno, offset, bytes) {
  const fd = openSync(p, 'r+');
  try {
    writeSync(fd, Buffer.from(bytes), 0, bytes.length, (pageno - 1) * 4096 + offset);
  } finally {
    closeSync(fd);
  }
}

/** Replace `from` with `to` (same length) wherever it occurs in the file's bytes. */
function patchBytes(p, from, to) {
  const buf = readFileSync(p);
  let n = 0;
  for (let at = buf.indexOf(from); at >= 0; at = buf.indexOf(from, at + 1)) {
    Buffer.from(to).copy(buf, at);
    n++;
  }
  writeFileSync(p, buf);
  return n;
}

describe('readIntegrity', () => {
  it('keeps the rows integrity_check yields before it throws', () => {
    const p = buildStore(newDir());
    const leaf = pages(p, 'observations');
    plant(p, leaf[Math.floor(leaf.length / 2)], 0, Array(8).fill(0x41));
    const db = new Database(p, { readonly: true });
    try {
      const r = readIntegrity(db);
      expect(r.ok).toBe(false);
      // Measured: two problem rows, then SQLITE_CORRUPT from the iterator. `.all()` loses the rows.
      expect(r.problems.length).toBeGreaterThan(1);
      expect(r.problems.some((x) => /btreeInitPage|Tree \d+ page/.test(x))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reads a sound store as ok with no problems', () => {
    expect(checkIntegrity(buildStore(newDir(), { rows: 3 }))).toEqual({ ok: true, problems: [] });
  });

  it('reports a file that is not a database as damage rather than throwing', () => {
    const p = buildStore(newDir(), { rows: 3 });
    plant(p, 1, 0, Array(16).fill(0x41));
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.notChecked).toBeUndefined();
    expect(r.problems.join(' ')).toMatch(/not a database/);
  });

  // "unable to open database file" is a permission or path fault, not damage.
  it('says it did not check a store it cannot open', () => {
    const p = buildStore(newDir(), { rows: 3 });
    mkdirSync(`${p}-wal`);
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([]);
    expect(r.notChecked).toMatch(/unable to open/);
  });

  // A damaged FTS5 config row fails integrity_check with SQLITE_ERROR.
  it('reads an FTS5 table whose config row is damaged as damage', () => {
    const p = buildStore(newDir(), { rows: 3 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.exec("UPDATE observations_fts_config SET v = 99 WHERE k = 'version'");
    db.close();
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.notChecked).toBeUndefined();
    expect(r.problems.join(' ')).toMatch(/fts5/i);
  });

  // A read-write close would checkpoint the log into the main file.
  it('writes nothing to a store whose log holds frames', () => {
    const p = buildStore(newDir(), { rows: 200 });
    const db = new Database(p);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const keep = readFileSync(p);
    db.pragma('wal_autocheckpoint = 0');
    for (let i = 0; i < 40; i++)
      insertObs(db, { title: `late ${i}`, narrative: 'm'.repeat(300), epochOffset: 500 + i });
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    expect(checkIntegrity(p).ok).toBe(true);
    expect(readFileSync(p).equals(keep), 'main file').toBe(true);
    expect(readFileSync(`${p}-wal`).equals(wal), 'log').toBe(true);
  });

  // A collation the sqlite3 command-line tool provides (uint, say) is missing here: the check
  // cannot compare that index's keys, which says nothing about the file.
  it('says it did not check a store with an index whose collation this build lacks', () => {
    const p = buildStore(newDir(), { rows: 3 });
    const db = new Database(p);
    db.exec(
      `CREATE TABLE zz_n (n TEXT); CREATE INDEX zz_n_i ON zz_n (n COLLATE NOCASE); INSERT INTO zz_n VALUES ('a2'), ('a10')`,
    );
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(`UPDATE sqlite_master SET sql = replace(sql, 'NOCASE', 'ZZCASE') WHERE name = 'zz_n_i'`).run();
    db.close();
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([]);
    expect(r.notChecked).toMatch(/no such collation sequence: ZZCASE/);
  });

  // A virtual table of a module this build does not load (sqlite-vec's vec0, say) is the user's.
  it('reads a sound store holding a virtual table of an unloaded module as ok', () => {
    const p = buildStore(newDir(), { rows: 3 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'zz_vec', 'zz_vec', 0, 'CREATE VIRTUAL TABLE zz_vec USING vec0(embedding float[4])')`,
    ).run();
    db.close();
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
  });
});

// What a read-only check does not see; doctor's own FTS check, which opens the store read-write,
// runs after it passes, as in 6.30.3. The header of lib/db-integrity.mjs says the same.
describe('what a read-only check does not see', () => {
  // SQLite drops a table's CHECK constraints when it parses a read-only database's schema.
  it('reads a value outside a CHECK list as ok, where a read-write check fails it', () => {
    const p = buildStore(newDir(), { rows: 20 });
    const db = new Database(p);
    db.prepare(`UPDATE observations SET type = 'decision' WHERE id = 7`).run();
    db.close();
    expect(patchBytes(p, Buffer.from('decisionobs 6'), 'decisioZobs 6'), 'premise: patched').toBeGreaterThan(
      0,
    );
    const rw = new Database(p);
    try {
      expect(rw.pragma('integrity_check', { simple: true }), 'premise: read-write fails').toMatch(
        /CHECK constraint failed in observations/,
      );
    } finally {
      rw.close();
    }
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
  });

  // p61-v10 of the 869-plant sweep.
  it('reads an FTS5 definition that names a column its content table lacks as ok', () => {
    const p = buildStore(newDir(), { rows: 20 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(sql, 'learned,', 'AAAAAAAAed,') WHERE name = 'session_summaries_fts'`,
    ).run();
    db.close();
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
  });
});

describe('summarizeIntegrity', () => {
  it('names the first problem and how many more', () => {
    expect(summarizeIntegrity(['a'])).toBe('a');
    expect(summarizeIntegrity(['a', 'b', 'c'])).toBe('a (and 2 more)');
  });
});
