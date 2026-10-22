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
import { readIntegrity, checkIntegrity, checkClauses, summarizeIntegrity } from '../lib/db-integrity.mjs';
import { ensureSearchTelemetrySchema } from '../lib/search-telemetry.mjs';

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

  // An FTS5 table whose stored options are damaged fails to connect with SQLITE_ERROR.
  it('reads an FTS5 table that will not connect as damage', () => {
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

  // p61-v10: an FTS5 definition naming a column its content table lacks passes integrity_check.
  it('reads an FTS5 definition that names a column its content table lacks as damage', () => {
    const p = buildStore(newDir(), { rows: 20 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(sql, 'learned,', 'AAAAAAAAed,') WHERE name = 'session_summaries_fts'`,
    ).run();
    db.close();
    const ro = new Database(p, { readonly: true });
    try {
      expect(ro.pragma('integrity_check', { simple: true }), 'premise: integrity_check passes').toBe('ok');
    } finally {
      ro.close();
    }
    expect(checkIntegrity(p)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/session_summaries_fts: no such column/)],
    });
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
});

// SQLite drops a table's CHECK constraints when it parses a read-only database's schema, so
// integrity_check on a read-only handle never evaluates them (the v6.31.0 round-3 claims review,
// F2: doctor showed ✓ on a store a read-write check failed).
describe('CHECK constraints, on a read-only handle', () => {
  function checkViolating() {
    const p = buildStore(newDir(), { rows: 20 });
    const db = new Database(p);
    db.prepare(`UPDATE observations SET type = 'decision' WHERE id = 7`).run();
    db.close();
    expect(patchBytes(p, Buffer.from('decisionobs 6'), 'decisioZobs 6'), 'premise: patched').toBeGreaterThan(
      0,
    );
    return p;
  }

  it('reports a value outside a CHECK list as damage', () => {
    const p = checkViolating();
    const ro = new Database(p, { readonly: true });
    const rw = new Database(p);
    try {
      expect(ro.pragma('integrity_check', { simple: true }), 'premise: read-only passes').toBe('ok');
      expect(rw.pragma('integrity_check', { simple: true }), 'premise: read-write fails').toMatch(
        /CHECK constraint failed in observations/,
      );
    } finally {
      ro.close();
      rw.close();
    }
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['CHECK constraint failed in observations (1 row)']);
  });

  it('passes NULL, as SQLite does', () => {
    const p = join(newDir(), 'x.db');
    const db = new Database(p);
    db.exec(`CREATE TABLE t (a TEXT CHECK (a IN ('x', 'y'))); INSERT INTO t VALUES ('x'), (NULL)`);
    db.close();
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
  });
});

describe('CHECK constraints, evaluated', () => {
  it("evaluates every CHECK constraint of this version's tables on a sound store", () => {
    const p = buildStore(newDir(), { rows: 3 });
    const db = new Database(p);
    ensureSearchTelemetrySchema(db);
    const withChecks = db
      .prepare(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND sql LIKE '%CHECK%'`)
      .pluck()
      .get();
    db.close();
    expect(withChecks, 'premise: tables with CHECK constraints').toBeGreaterThanOrEqual(5);
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
  });

  it('says which table it could not evaluate, without failing the store', () => {
    const p = join(newDir(), 'x.db');
    const db = new Database(p);
    db.function('twice', (x) => x * 2);
    db.exec('CREATE TABLE t (a INTEGER CHECK (twice(a) > 0)); INSERT INTO t VALUES (1)');
    db.close();
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [], unchecked: ['t (no such function: twice)'] });
  });
});

describe('checkClauses', () => {
  it("reads this version's observations statement, a comment with parentheses after its CHECK", () => {
    const db = new Database(':memory:');
    initSchema(db);
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'observations'`).pluck().get();
    db.close();
    expect(sql, 'premise: a comment holding parentheses').toMatch(/--[^\n]*\(/);
    expect(checkClauses(sql)).toEqual([
      "type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')",
    ]);
  });

  it('steps over strings, quoted identifiers and comments', () => {
    expect(
      checkClauses(
        `CREATE TABLE t ("check" INT, [CHECK] INT, \`check\` INT, a TEXT DEFAULT 'x) CHECK(y', /* CHECK(z) */ b INT -- CHECK (w)
         CHECK (b > 0))`,
      ),
    ).toEqual(['b > 0']);
  });

  it('reads column and table constraints, nested parentheses, and a comment before the parenthesis', () => {
    expect(
      checkClauses(
        `CREATE TABLE t (a INT CHECK ((a + 1) * 2 > (0)), b TEXT CHECK /* why */ (b <> ')'), CONSTRAINT k CHECK (a < length(b)))`,
      ),
    ).toEqual(['(a + 1) * 2 > (0)', "b <> ')'", 'a < length(b)']);
  });

  it('does not read a word that only contains CHECK', () => {
    expect(checkClauses(`CREATE TABLE t (rechecked INT, check_mark INT, ücheck INT, checks2 INT)`)).toEqual(
      [],
    );
  });

  it('returns null for a CHECK with no closing parenthesis', () => {
    expect(checkClauses(`CREATE TABLE t (a INT CHECK (a > (0)`)).toBeNull();
  });
});

describe('summarizeIntegrity', () => {
  it('names the first problem and how many more', () => {
    expect(summarizeIntegrity(['a'])).toBe('a');
    expect(summarizeIntegrity(['a', 'b', 'c'])).toBe('a (and 2 more)');
  });
});
