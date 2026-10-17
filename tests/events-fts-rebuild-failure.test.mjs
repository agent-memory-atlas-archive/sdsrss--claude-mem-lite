// CLI pre-tag review 2026-10-16 P3-10: ensureEventsFTS drops a drifted events_fts, creates the
// 5-column one and repopulates it with the 'rebuild' command, and a throw from that rebuild was
// swallowed ("index repopulates lazily on next write"). The empty index then committed with the
// migration, and its search_terms column is the sentinel the version fast path checks, so no open
// ever retried; an external-content index does not repopulate old rows on its own. Every v6.27.0
// store takes this path on its first open since d366. A failed rebuild now leaves the index it
// found, so the sentinel stays absent and the next open runs the pass again.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { ensureEventsFTS, initSchema } from '../schema.mjs';

let db;
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
});

const ftsCols = (d) =>
  d
    .prepare(`PRAGMA table_info(events_fts)`)
    .all()
    .map((c) => c.name);
const ftsHits = (d, q) =>
  d
    .prepare(
      `SELECT e.title FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH ?`,
    )
    .all(q)
    .map((r) => r.title);
const addEvent = (d, title) =>
  d
    .prepare(
      `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES ('p', 'bugfix', ?, '', 2, ?)`,
    )
    .run(title, Date.now());

/** A v6.27.0 events shape: no search_terms column, the 4-column index and its triggers, two rows. */
function legacyStore() {
  const d = createTestDb();
  d.exec(`DROP TRIGGER IF EXISTS events_fts_ai`);
  d.exec(`DROP TRIGGER IF EXISTS events_fts_ad`);
  d.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
  d.exec(`DROP TABLE IF EXISTS events_fts`);
  d.exec(`ALTER TABLE events DROP COLUMN search_terms`);
  d.exec(`
    CREATE VIRTUAL TABLE events_fts USING fts5(
      title, body, event_type UNINDEXED, project UNINDEXED,
      content='events', content_rowid='id',
      tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
    );
    CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, body, event_type, project)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
    END;
  `);
  addEvent(d, 'zebracrossing written by the old build');
  addEvent(d, 'okapiwalk written by the old build');
  return d;
}

describe('a events_fts rebuild that throws (P3-10)', () => {
  it('leaves the index it found, so the store is searchable as before and has no sentinel', () => {
    db = legacyStore();
    // A real failure of the rebuild itself: the 5-column index reads events.search_terms, which
    // this store does not have, so 'rebuild' throws after the drop and the CREATE succeeded.
    ensureEventsFTS(db);
    expect(ftsCols(db), 'the sentinel column must not be committed').not.toContain('search_terms');
    expect(ftsHits(db, 'zebracrossing')).toEqual(['zebracrossing written by the old build']);
    // The old triggers came back with the old index: a write still reaches it.
    addEvent(db, 'zebracrossing after the failed rebuild');
    expect(ftsHits(db, 'zebracrossing')).toHaveLength(2);
    expect(db.inTransaction, 'no savepoint left open').toBe(false);
  });

  it('is retried by the next open, which builds the index with every row', () => {
    db = legacyStore();
    ensureEventsFTS(db); // fails as above
    initSchema(db); // the next open: the sentinel is absent, so the migration pass runs again
    expect(ftsCols(db)).toContain('search_terms');
    expect(ftsHits(db, 'zebracrossing')).toEqual(['zebracrossing written by the old build']);
    expect(ftsHits(db, 'okapiwalk')).toEqual(['okapiwalk written by the old build']);
  });

  it('inside the migration transaction, rolls back only its own work and lets the pass commit', () => {
    db = legacyStore();
    db.exec(`ALTER TABLE events ADD COLUMN search_terms TEXT`);
    // Fail the rebuild statement the way NOMEM or a damaged row would, once.
    const exec = db.exec.bind(db);
    let failed = 0;
    db.exec = (sql) => {
      if (!failed && /INSERT INTO events_fts\(events_fts\) VALUES\('rebuild'\)/.test(sql)) {
        failed++;
        throw new Error('simulated rebuild failure');
      }
      return exec(sql);
    };
    db.exec('BEGIN IMMEDIATE');
    ensureEventsFTS(db);
    expect(db.inTransaction, 'the enclosing transaction is still open').toBe(true);
    db.exec('COMMIT');
    delete db.exec;
    expect(failed, 'premise: the rebuild was made to fail').toBe(1);
    expect(ftsCols(db)).not.toContain('search_terms');
    expect(ftsHits(db, 'okapiwalk')).toEqual(['okapiwalk written by the old build']);
    initSchema(db);
    expect(ftsCols(db)).toContain('search_terms');
    expect(ftsHits(db, 'okapiwalk')).toEqual(['okapiwalk written by the old build']);
  });

  it('a DDL error is thrown as before, and leaves neither its half-done work nor a transaction', () => {
    db = legacyStore();
    const exec = db.exec.bind(db);
    db.exec = (sql) => {
      if (/CREATE VIRTUAL TABLE IF NOT EXISTS events_fts/.test(sql)) throw new Error('simulated DDL failure');
      return exec(sql);
    };
    expect(() => ensureEventsFTS(db)).toThrow(/simulated DDL failure/);
    delete db.exec;
    expect(db.inTransaction).toBe(false);
    expect(ftsHits(db, 'okapiwalk')).toEqual(['okapiwalk written by the old build']);
  });

  it('rethrows when SQLite rolled the whole transaction back itself', () => {
    db = legacyStore();
    db.exec(`ALTER TABLE events ADD COLUMN search_terms TEXT`);
    const exec = db.exec.bind(db);
    db.exec = (sql) => {
      if (/INSERT INTO events_fts\(events_fts\) VALUES\('rebuild'\)/.test(sql)) {
        exec('ROLLBACK'); // what SQLITE_NOMEM / IOERR / FULL may do to the enclosing transaction
        throw new Error('simulated rebuild failure after an automatic rollback');
      }
      return exec(sql);
    };
    db.exec('BEGIN IMMEDIATE');
    expect(() => ensureEventsFTS(db)).toThrow(/automatic rollback/);
    delete db.exec;
    expect(db.inTransaction).toBe(false);
    expect(ftsCols(db)).not.toContain('search_terms');
  });
});
