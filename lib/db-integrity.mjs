// lib/db-integrity.mjs — SQLite's integrity check of the store, read-only, for doctor (D#541, D#550).
//
// READ-ONLY. A read-write connection's close checkpoints the log into the main file and checks no
// page, so a damaged log frame becomes a damaged main file, and the older, intact copy of that page
// the main file held is gone (the v6.31.0 pre-tag reviews measured it on the 869-plant set). This
// module opens the store read-only and writes nothing.
//
// WHAT A READ-ONLY CHECK MISSES. SQLite does not keep a table's CHECK constraints when it parses
// the schema of a read-only database (sqlite3AddCheckConstraint skips a read-only btree), so
// `PRAGMA integrity_check` on a read-only handle never evaluates them: a value outside a CHECK list
// reads `ok` here and `CHECK constraint failed in t` read-write. An FTS5 table whose stored
// definition names a column its content table lacks passes it too (p61-v10 of the 869-plant sweep).

import Database from 'better-sqlite3';

const message = (e) => String(e?.message ?? e);

// SQLite could not open or check the file at all, which says nothing about its pages: a path, a
// permission, a lock, a full disk, an I/O error, or an index whose collation this build lacks (one
// the sqlite3 command-line tool provides, say). Every other SQLite error from opening or checking
// the store is damage: SQLITE_ERROR included (a damaged FTS5 config row fails the check with it),
// and SQLITE_NOMEM, which integrity_check raises on damaged FTS5 data (4 of the 869 plants, every
// row readable).
const NOT_DAMAGE_RE = /^SQLITE_(CANTOPEN|IOERR|BUSY|LOCKED|READONLY|PERM|AUTH|FULL|ERROR_MISSING_COLLSEQ)/;
const isDamage = (e) => /^SQLITE_/.test(e?.code ?? '') && !NOT_DAMAGE_RE.test(e.code);

/**
 * `PRAGMA integrity_check` on an open handle. It yields its first problem rows and then can THROW
 * from the iterator (SQLITE_CORRUPT on a damaged b-tree page, measured 2026-10-21), so it is
 * iterated rather than `.all()`-ed, which would lose the rows read before the throw. A throw that
 * is damage, or that follows a problem row, is a failed check; any other throw before a row
 * (SQLITE_CANTOPEN) means it did not run.
 * @param {import('better-sqlite3').Database} db
 * @param {number} [max] stop after this many problems
 * @returns {{ok: boolean, problems: string[], notChecked?: string}}
 */
export function readIntegrity(db, max = 100) {
  const rows = [];
  try {
    for (const row of db
      .prepare(`PRAGMA integrity_check(${Math.trunc(max)})`)
      .pluck()
      .iterate()) {
      rows.push(String(row));
    }
  } catch (e) {
    if (rows.length === 0 && !isDamage(e)) return { ok: false, problems: [], notChecked: message(e) };
    rows.push(message(e));
  }
  if (rows.length === 1 && rows[0] === 'ok') return { ok: true, problems: [] };
  return {
    ok: false,
    problems: rows.map((r) => r.replace(/^\*\*\* in database \w+ \*\*\*\s*/, '').replace(/\s*\n\s*/g, ' ')),
  };
}

/**
 * readIntegrity on a read-only handle of `dbPath`, classifying an open failure the same way.
 * @param {string} dbPath
 * @returns {{ok: boolean, problems: string[], notChecked?: string}}
 */
export function checkIntegrity(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readIntegrity(db);
  } catch (e) {
    return isDamage(e)
      ? { ok: false, problems: [message(e)] }
      : { ok: false, problems: [], notChecked: message(e) };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing was written */
    }
  }
}

/** One line for a list of integrity problems: the first, and how many more. */
export function summarizeIntegrity(problems) {
  const first = problems[0] ?? 'no result';
  return problems.length > 1 ? `${first} (and ${problems.length - 1} more)` : first;
}
