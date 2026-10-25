// doctor checks the integrity of a store that opens, and rebuilds what is only damage to its indexes
// (D#590 item (a), D#559).
//
// README says doctor checks "database integrity", and before this it never ran PRAGMA integrity_check
// on a store that opens: only FTS5's own integrity-check. Measured on HEAD 051dd70f (v6.30.8) with
// writeStoreSnapshot's shapes switched to WAL: an index on observations that lost its entries read
// green with "DB stats: 0 observations" (count(*) walked the damaged index; the table held 12); an
// FTS5 shadow table whose rows are out of key order read green on every line, FTS5's check included.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { checkStoreIntegrity } from '../schema.mjs';
import { writeStoreSnapshot } from './test-helpers.mjs';

const REPO = resolve(import.meta.dirname, '..');

let root, dataDir, dbPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cml-doctor-integrity-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  dbPath = join(dataDir, 'claude-mem-lite.db');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A live store in production shape: writeStoreSnapshot writes rollback mode, a store is WAL. */
function liveStore(damage, observations = 12) {
  writeStoreSnapshot(dbPath, { observations, damage });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.close();
}

/**
 * One byte of the header of `table`'s first leaf page set to `value`: offset 0 (the page type) to 0
 * makes the page unreadable; offset 7 (the fragmented-bytes count) to a wrong count is damage that
 * integrity_check reports and every read gets past.
 */
function pokeLeaf(table, offset, value) {
  const ro = new Database(dbPath, { readonly: true });
  const pageno = ro
    .prepare("SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY pageno LIMIT 1")
    .pluck()
    .get(table);
  ro.close();
  if (!pageno || pageno === 1) throw new Error(`fixture found no leaf page of ${table} past page 1`);
  const image = readFileSync(dbPath);
  const at = (pageno - 1) * image.readUInt16BE(16) + offset;
  if (image[at] === value) throw new Error('fixture changed nothing');
  image[at] = value;
  writeFileSync(dbPath, image);
}

const tableRows = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT count(*) FROM observations NOT INDEXED').pluck().get();
  } finally {
    db.close();
  }
};

const integrity = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('PRAGMA integrity_check(3)').pluck().all().join('; ');
  } finally {
    db.close();
  }
};

function doctorReport() {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'doctor', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        CLAUDE_MEM_DIR: dataDir,
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_SKIP_UPDATE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
  } catch (e) {
    // doctor exits 1 on any issue, and a sandbox HOME without hooks always has some.
    stdout = e.stdout || '';
  }
  return JSON.parse(stdout);
}
const doctorChecks = () => doctorReport().checks;

const integrityChecks = (checks) => checks.filter((c) => /^Database integrity/.test(c.message));
const statsLine = (checks) => checks.find((c) => /^DB stats:/.test(c.message))?.message ?? '';

describe('checkStoreIntegrity', () => {
  it('passes a sound store and rebuilds nothing', () => {
    liveStore(null);
    const db = new Database(dbPath);
    try {
      expect(checkStoreIntegrity(db)).toEqual({ state: 'ok', rows: ['ok'] });
    } finally {
      db.close();
    }
  });

  it('rebuilds an ordinary index that lost its entries, and the table keeps every row', () => {
    liveStore('index');
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('rebuilt');
      expect(r.rows.join('\n')).toMatch(/missing from index/);
      // count(*) read the damaged index before (0) and reads 12 after: a count that rose is not reported.
      expect(r.fell).toEqual([]);
    } finally {
      db.close();
    }
    expect(integrity()).toBe('ok');
    expect(tableRows()).toBe(12);
  });

  it('rebuilds an FTS5 shadow table whose rows are out of key order, which FTS5 itself passes', () => {
    liveStore('fts-order');
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('rebuilt');
      expect(r.rows.join('\n')).toMatch(/not in PRIMARY KEY order for observations_fts_idx/);
    } finally {
      db.close();
    }
    expect(integrity()).toBe('ok');
  });

  it('calls damage to a table damaged, with the lines of the check after the rebuild', () => {
    liveStore('page');
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('damaged');
      // SQLite returns this one as a single row with line breaks; each line is its own entry.
      expect(r.after.length).toBeGreaterThan(1);
      expect(r.after.every((l) => !l.includes('\n'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('says the check could not run when integrity_check itself throws', () => {
    liveStore('fts-config');
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('unchecked');
      expect(r.error).toMatch(/invalid fts5 file format/);
    } finally {
      db.close();
    }
  });

  it('names a table whose count fell when its indexes listed rows it does not hold', () => {
    liveStore('lost-rows');
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('rebuilt');
      expect(r.fell).toEqual([{ table: 'observations', before: 12, after: 3 }]);
    } finally {
      db.close();
    }
    expect(tableRows()).toBe(3);
  });

  it('takes a check that throws on damage as a failed check, not as one that did not run', () => {
    liveStore(null);
    pokeLeaf('observations', 0, 0);
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('damaged');
      expect(r.rows).toEqual(['database disk image is malformed']);
    } finally {
      db.close();
    }
  });

  it('returns with no transaction left open when the rebuild meets damage it cannot get past', () => {
    liveStore(null);
    pokeLeaf('sdk_sessions', 0, 0);
    const db = new Database(dbPath);
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('damaged');
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rolls the rebuild back when the disk fills, and does not call the store damaged', () => {
    // 300 rows: the index the rebuild writes needs more pages than the one it replaces (at 12 it does not).
    liveStore('index', 300);
    const db = new Database(dbPath);
    try {
      // No page past the ones the file has: the rebuild's first new page meets SQLITE_FULL.
      db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true })}`);
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('unrebuilt');
      expect(r.busy).toBe(false);
      expect(r.rebuildErrors.join('\n')).toMatch(/database or disk is full/);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
    expect(integrity(), 'the rebuild was rolled back').toMatch(/missing from index/);
  });

  it('does not call the store damaged when another connection holds the lock the rebuild needs', () => {
    liveStore('index');
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 0');
    try {
      const r = checkStoreIntegrity(db);
      expect(r.state).toBe('unrebuilt');
      expect(r.busy).toBe(true);
      expect(r.rows.join('\n')).toMatch(/missing from index/);
    } finally {
      holder.exec('COMMIT');
      holder.close();
      db.close();
    }
    expect(integrity(), 'nothing was rebuilt').not.toBe('ok');
  });
});

describe('doctor on a store that opens', () => {
  it('reports a sound store as ok', () => {
    liveStore(null);
    const lines = integrityChecks(doctorChecks());
    expect(lines).toEqual([{ level: 'ok', message: 'Database integrity: ok' }]);
  });

  it('finds an index that lost its entries, rebuilds it, and then counts every observation', () => {
    liveStore('index');
    const checks = doctorChecks();
    const lines = integrityChecks(checks);
    expect(lines.map((c) => c.level)).toEqual(['warn', 'ok']);
    expect(lines[0].message).toBe('Database integrity issues detected:');
    expect(lines[0].details.join('\n')).toMatch(/missing from index/);
    expect(lines[1].message).toBe('Database integrity: ok after rebuilding the indexes');
    expect(statsLine(checks)).toMatch(/ 12 observations/);
    expect(integrity()).toBe('ok');
  });

  it('finds FTS5 shadow rows out of key order that its FTS5 check passes, and rebuilds them', () => {
    liveStore('fts-order');
    const checks = doctorChecks();
    expect(checks.map((c) => c.message)).toContain('FTS5 integrity: all indexes healthy');
    const lines = integrityChecks(checks);
    expect(lines.map((c) => c.level)).toEqual(['warn', 'ok']);
    expect(lines[0].details.join('\n')).toMatch(/not in PRIMARY KEY order for observations_fts_idx/);
    expect(integrity()).toBe('ok');
  });

  it('fails on damage to a table that rebuilding the indexes does not repair, and counts it', () => {
    liveStore(null);
    const sound = doctorReport();
    for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
    liveStore('page');
    const damaged = doctorReport();
    const lines = integrityChecks(damaged.checks);
    expect(lines.map((c) => c.level)).toEqual(['warn', 'fail']);
    expect(lines[1].message).toBe('Database integrity: not repaired by rebuilding the indexes');
    expect(lines[1].details.join('\n')).toMatch(/Tree \d+ page \d+/);
    // Every ✗ adds one issue, so doctor exits 1 on it: the same environment with a sound store as the base.
    const fails = (r) => r.checks.filter((c) => c.level === 'fail').length;
    expect(damaged.issues - sound.issues).toBe(fails(damaged) - fails(sound));
  });

  it('names the tables that count fewer rows after a rebuild that leaves damage', () => {
    liveStore('lost-rows');
    pokeLeaf('observations', 7, 5);
    const lines = integrityChecks(doctorChecks());
    expect(lines.map((c) => c.level)).toEqual(['warn', 'fail']);
    const details = lines[1].details;
    expect(details.join('\n')).toMatch(/Fragmentation of \d+ bytes reported as 5/);
    expect(details.slice(-2)).toEqual([
      'These tables now count fewer rows:',
      'observations: 12 before, 3 after',
    ]);
    expect(tableRows()).toBe(3);
  });

  it('says it did not check when integrity_check itself throws', () => {
    liveStore('fts-config');
    const lines = integrityChecks(doctorChecks());
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].message).toMatch(/^Database integrity: not checked — .*invalid fts5 file format/);
  });

  it('rebuilds the indexes of a store whose table holds fewer rows than they list, and removes no row', () => {
    liveStore('lost-rows');
    expect(tableRows(), 'premise: the table holds 3 rows').toBe(3);
    const checks = doctorChecks();
    const lines = integrityChecks(checks);
    expect(lines.map((c) => c.level)).toEqual(['warn', 'warn']);
    expect(lines[0].details.join('\n')).toMatch(/wrong # of entries in index/);
    // Before this, DB stats said 12 here: count(*) read an index that still listed the 9 rows.
    expect(lines[1].message).toBe(
      'Database integrity: ok after rebuilding the indexes, and these tables now count fewer rows:',
    );
    expect(lines[1].details).toEqual(['observations: 12 before, 3 after']);
    expect(statsLine(checks)).toMatch(/ 3 observations/);
    expect(tableRows()).toBe(3);
  });

  it('says it did not check a store newer than this code, and leaves the file as it was', () => {
    liveStore('index');
    const db = new Database(dbPath);
    db.prepare('UPDATE schema_version SET version = 99').run();
    db.close();
    const lines = integrityChecks(doctorChecks());
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].message).toMatch(/^Database integrity: not checked — /);
    expect(integrity(), 'the damaged index was not rebuilt').not.toBe('ok');
  });
});
