// doctor checks the integrity of a store that opens, and rebuilds what is damage to its indexes alone
// (D#590 item (a), D#559; second attempt, D#592).
//
// README says doctor checks "database integrity", and v6.30.8 never ran PRAGMA integrity_check on a
// store that opens, only FTS5's own check: an index on observations that lost its entries read green
// with "DB stats: 0 observations" (count(*) walked the damaged index; the table held 12), and an FTS5
// shadow table whose rows are out of key order read green on every line.
//
// The first attempt (28f57552..52d93690, withdrawn at v6.30.9 r1) rebuilt on any failed check, page
// damage included, and destroyed rows on a store whose freelist listed live pages; it read "ok" on such
// a store once VACUUMed, where SQLite 3.53.4's integrity check skips the freelist. The pages are now
// checked first (checkStorePages, D#591), and the rebuild is the one fts-check runs.

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema.mjs';
import { pathWithClaudeStub } from './claude-stub.mjs';
import {
  intactObservations,
  makeFixtureTracker,
  writeCrossLinkedStore,
  writeStoreSnapshot,
} from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const newRoot = () => {
  const root = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-integrity-')));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  return { root, dataDir: join(root, 'data'), dbPath: join(root, 'data', 'claude-mem-lite.db') };
};
const sha = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');

/** A live store in production shape: writeStoreSnapshot writes rollback mode, a store is WAL. */
function liveStore(dbPath, damage, observations = 12) {
  writeStoreSnapshot(dbPath, { observations, damage });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.close();
  return dbPath;
}

const tableRows = (dbPath) => {
  const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-integrity-copy-')));
  const copy = join(dir, 'copy.db');
  copyFileSync(dbPath, copy);
  if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
  const db = new Database(copy, { readonly: true });
  try {
    return {
      table: db.prepare('SELECT count(*) FROM observations NOT INDEXED').pluck().get(),
      integrity: db.prepare('PRAGMA integrity_check(3)').pluck().all().join('; '),
    };
  } finally {
    db.close();
  }
};

/** checkStoreIntegrity on a fresh read-write handle. */
const check = (dbPath) => {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 0');
  try {
    return schema.checkStoreIntegrity(db);
  } finally {
    db.close();
  }
};

function doctor({ root, dataDir }, { json = true } = {}) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'doctor', ...(json ? ['--json'] : [])], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        PATH: pathWithClaudeStub(root),
        CLAUDE_MEM_DIR: dataDir,
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (e) {
    // doctor exits 1 on any issue, and a sandbox HOME without hooks always has some.
    stdout = e.stdout || '';
  }
  return json ? JSON.parse(stdout).checks : stdout;
}
const integrityChecks = (checks) => checks.filter((c) => /^Database integrity/.test(c.message));
const statsLine = (checks) => checks.find((c) => /^DB stats:/.test(c.message))?.message ?? '';

describe('checkStoreIntegrity', () => {
  it('passes a sound store and writes nothing', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, null);
    const before = sha(dbPath);
    expect(check(dbPath)).toEqual({ state: 'ok' });
    expect(sha(dbPath)).toBe(before);
  });

  it('rebuilds an ordinary index that lost its entries, and the table keeps every row', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'index');
    const r = check(dbPath);
    expect(r.state).toBe('rebuilt');
    expect(r.rows.join('\n')).toMatch(/missing from index/);
    expect(tableRows(dbPath)).toEqual({ table: 12, integrity: 'ok' });
  });

  it('rebuilds an FTS5 shadow table whose rows are out of key order, which FTS5 itself passes', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'fts-order');
    const db = new Database(dbPath);
    try {
      expect(schema.checkFTSIntegrity(db).healthy, 'premise: FTS5 passes it').toBe(true);
    } finally {
      db.close();
    }
    const r = check(dbPath);
    expect(r.state).toBe('rebuilt');
    expect(r.rows.join('\n')).toMatch(/not in PRIMARY KEY order for observations_fts_idx/);
    expect(tableRows(dbPath).integrity).toBe('ok');
  });

  it('makes indexes that list rows the table lost agree with the table, and loses no row', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'lost-rows');
    expect(tableRows(dbPath).table, 'premise').toBe(3);
    const r = check(dbPath);
    expect(r.state).toBe('rebuilt');
    expect(r.rows.join('\n')).toMatch(/wrong # of entries in index/);
    expect(tableRows(dbPath)).toEqual({ table: 3, integrity: 'ok' });
  });

  // r1 P1-2 of the first attempt: SQLite's check reads 'ok' here.
  it('finds a VACUUMed store whose freelist lists a live leaf, and writes nothing', () => {
    const { dbPath } = newRoot();
    const { truth, linked } = writeCrossLinkedStore(dbPath, { vacuum: true, ftsDamage: false });
    expect(tableRows(dbPath).integrity, 'premise: the integrity check misses it').toBe('ok');
    const before = sha(dbPath);
    const r = check(dbPath);
    expect(r.state).toBe('damaged');
    expect(r.pages.lines.join('\n')).toContain(`page ${linked[0]}: in the freelist and in observations`);
    expect(sha(dbPath)).toBe(before);
    expect(intactObservations(dbPath, truth)).toBe(truth.length);
  });

  // r1 P1-1 of the first attempt: an index fault beside page damage, where it rebuilt and 18 of 400
  // observations were overwritten.
  it('rebuilds nothing on an index fault beside page damage', () => {
    const { dbPath } = newRoot();
    const { truth } = writeCrossLinkedStore(dbPath, { ftsDamage: false });
    const db = new Database(dbPath);
    db.unsafeMode(true);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observations' AND sql IS NOT NULL ORDER BY name LIMIT 1",
      )
      .pluck()
      .get();
    db.pragma('writable_schema = ON');
    db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?').run(
      `CREATE INDEX ${idx} ON observations(title)`,
      idx,
    );
    db.close();
    const before = sha(dbPath);
    expect(check(dbPath).state).toBe('damaged');
    expect(sha(dbPath)).toBe(before);
    expect(intactObservations(dbPath, truth)).toBe(truth.length);
  });

  // Two stores of the D#546 regression set: SQLite's check throws on an index entry it cannot
  // decode, where the pages are sound and REINDEX rebuilds the entry from the table.
  it('takes an integrity check that throws on a garbled index entry as a failed check, and rebuilds', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'index-key');
    expect(() => tableRows(dbPath), 'premise: the integrity check throws').toThrow(/malformed/);
    const r = check(dbPath);
    expect(r).toEqual({ state: 'rebuilt', rows: ['database disk image is malformed'] });
    expect(tableRows(dbPath)).toEqual({ table: 12, integrity: 'ok' });
  });

  it('calls garbled cell pointers damage, and rebuilds nothing', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'page');
    const before = sha(dbPath);
    expect(check(dbPath).state).toBe('damaged');
    expect(sha(dbPath)).toBe(before);
  });

  // A page check that could not run is not a pass, even where SQLite's own check would read 'ok'.
  it('says it could not check when the page check cannot run', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, null);
    const db = new Database(dbPath);
    try {
      db.serialize = () => {
        throw new Error('Out of memory');
      };
      expect(schema.checkStoreIntegrity(db)).toEqual({ state: 'unchecked', error: 'Out of memory' });
    } finally {
      db.close();
    }
  });

  it('says it could not check an FTS5 table whose config row FTS5 refuses', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'fts-config');
    expect(check(dbPath)).toMatchObject({
      state: 'unchecked',
      error: expect.stringMatching(/invalid fts5 file format/),
    });
  });

  it('reports a rebuild that meets the lock as unrepaired on the lock, and rebuilds nothing', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'index');
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    let r;
    try {
      r = check(dbPath);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(r).toMatchObject({ state: 'unrepaired', busy: true });
    expect(r.rows.join('\n')).toMatch(/missing from index/);
    // The first statement met the lock, and the rest, which would wait for it too, did not run.
    expect(r.errors).toEqual([expect.stringMatching(/^observations_fts: database is locked/)]);
    expect(tableRows(dbPath).integrity).toMatch(/missing from index/);
  });

  it('reports a rebuild that fills the disk as unrepaired, not on the lock', () => {
    const { dbPath } = newRoot();
    liveStore(dbPath, 'index', 200);
    const db = new Database(dbPath);
    let r;
    try {
      db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true })}`);
      r = schema.checkStoreIntegrity(db);
    } finally {
      db.close();
    }
    expect(r).toMatchObject({ state: 'unrepaired', busy: false });
    expect(r.errors.join('\n')).toMatch(/full/);
  });
});

describe('doctor on a store that opens', () => {
  it('prints "Database integrity: ok" on a sound store', () => {
    const ctx = newRoot();
    liveStore(ctx.dbPath, null);
    expect(integrityChecks(doctor(ctx))).toEqual([{ level: 'ok', message: 'Database integrity: ok' }]);
  });

  it('rebuilds a damaged index, after which DB stats counts the table', () => {
    const ctx = newRoot();
    liveStore(ctx.dbPath, 'index');
    const checks = doctor(ctx);
    const lines = integrityChecks(checks);
    expect(lines.map((c) => [c.level, c.message])).toEqual([
      ['warn', 'Database integrity issues detected:'],
      ['ok', 'Database integrity: ok after rebuilding the indexes'],
    ]);
    expect(lines[0].details.join('\n')).toMatch(/missing from index/);
    expect(statsLine(checks)).toMatch(/ 12 observations/);
  });

  it('fails on damaged pages with the copy command, and writes nothing', () => {
    const ctx = newRoot();
    const { truth, linked } = writeCrossLinkedStore(ctx.dbPath, { vacuum: true, ftsDamage: false });
    const lines = integrityChecks(doctor(ctx));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'fail',
      message: "Database integrity: the database's pages are damaged, so nothing was rebuilt",
    });
    expect(lines[0].details.join('\n')).toContain(`page ${linked[0]}: in the freelist and in observations`);
    expect(lines[0].details.join('\n')).toContain(`cp -a ${ctx.dataDir} ${ctx.dataDir}.copy-`);
    expect(intactObservations(ctx.dbPath, truth)).toBe(truth.length);
  });

  // r1 P3-1 of the first attempt: the step sat inside the branch for a store with observations_fts.
  it('checks a store that has no observations_fts', () => {
    const ctx = newRoot();
    liveStore(ctx.dbPath, 'index');
    const db = new Database(ctx.dbPath);
    db.exec('DROP TABLE observations_fts');
    db.close();
    const lines = integrityChecks(doctor(ctx));
    expect(lines.map((c) => c.message)).toEqual([
      'Database integrity issues detected:',
      'Database integrity: ok after rebuilding the indexes',
    ]);
  });

  it('says not checked, and does not open the store for writing, when it is newer than this install', () => {
    const ctx = newRoot();
    liveStore(ctx.dbPath, 'index');
    const db = new Database(ctx.dbPath);
    db.prepare('UPDATE schema_version SET version = ?').run(schema.CURRENT_SCHEMA_VERSION + 1);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const before = sha(ctx.dbPath);
    const lines = integrityChecks(doctor(ctx));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].message).toMatch(/^Database integrity: not checked — /);
    expect(sha(ctx.dbPath)).toBe(before);
  });

  // In use is not damage it could not repair: a warning, as for the FTS5 check above it.
  it('warns that the indexes were not rebuilt while another connection holds the lock', () => {
    const ctx = newRoot();
    liveStore(ctx.dbPath, 'index');
    const holder = new Database(ctx.dbPath);
    holder.exec('BEGIN IMMEDIATE');
    let checks;
    try {
      checks = doctor(ctx);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(integrityChecks(checks).map((c) => [c.level, c.message])).toEqual([
      ['warn', 'Database integrity issues detected:'],
      [
        'warn',
        'Database integrity: indexes not rebuilt — the database is in use by another process (a hook or session writing). Run doctor again in a moment.',
      ],
    ]);
  }, 60_000);

  it('prints the same on the human face', () => {
    const ctx = newRoot();
    liveStore(ctx.dbPath, 'index');
    const out = doctor(ctx, { json: false });
    expect(out).toMatch(
      /⚠ Database integrity issues detected:\n(\s{4,}\S.*\n)*\s{4,}row \d+ missing from index/,
    );
    expect(out).toContain('✓ Database integrity: ok after rebuilding the indexes');
  });
});
