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
// read `ok` there and `CHECK constraint failed in t` read-write (the v6.31.0 round-3 claims review,
// F2). An FTS5 table whose stored definition names a column its content table lacks passes it
// too (p61-v10 of the 869-plant sweep). Both are checked here after integrity_check passes.

import Database from 'better-sqlite3';

const message = (e) => String(e?.message ?? e);
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

// SQLite could not open or check the file at all, which says nothing about its pages: a path, a
// permission, a lock, a full disk, an I/O error. Every other SQLite error from opening or checking
// the store is damage: SQLITE_ERROR included (an FTS5 table whose stored options are damaged fails
// to connect with it), and SQLITE_NOMEM, which integrity_check raises on damaged FTS5 data (4 of
// the 869 plants, every row readable).
const NOT_DAMAGE_RE = /^SQLITE_(CANTOPEN|IOERR|BUSY|LOCKED|READONLY|PERM|AUTH|FULL)/;
const isDamage = (e) => /^SQLITE_/.test(e?.code ?? '') && !NOT_DAMAGE_RE.test(e.code);

/**
 * `PRAGMA integrity_check` on an open handle, then a full read of each FTS5 table's first row,
 * which reads its content table through the columns its stored definition names. The pragma
 * yields its first problem rows and then can THROW from the iterator (SQLITE_CORRUPT on a damaged
 * b-tree page, measured 2026-10-21), so it is iterated rather than `.all()`-ed, which would lose
 * the rows read before the throw. A throw that is damage, or that follows a problem row, is a
 * failed check; any other throw before a row (SQLITE_CANTOPEN) means it did not run.
 * @param {import('better-sqlite3').Database} db
 * @param {number} [max] stop after this many problems
 * @returns {{ok: boolean, problems: string[], notChecked?: string, unchecked?: string[]}} `unchecked`:
 *   tables whose CHECK constraints could not be evaluated, on a store that otherwise passed
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
  if (rows.length === 1 && rows[0] === 'ok') {
    rows.length = 0;
    let fts;
    try {
      fts = db
        .prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'virtual'`)
        .pluck()
        .all();
    } catch (e) {
      return isDamage(e)
        ? { ok: false, problems: [message(e)] }
        : { ok: false, problems: [], notChecked: message(e) };
    }
    for (const v of fts) {
      try {
        db.prepare(`SELECT * FROM ${q(v)} LIMIT 1`).all();
      } catch (e) {
        if (!isDamage(e)) return { ok: false, problems: [], notChecked: message(e) };
        rows.push(`${v}: ${message(e)}`);
      }
    }
    if (rows.length === 0) {
      const checks = checkConstraints(db);
      if (checks.problems.length === 0) {
        return checks.unchecked.length > 0
          ? { ok: true, problems: [], unchecked: checks.unchecked }
          : { ok: true, problems: [] };
      }
      rows.push(...checks.problems);
    }
  }
  return {
    ok: false,
    problems: rows.map((r) => r.replace(/^\*\*\* in database \w+ \*\*\*\s*/, '').replace(/\s*\n\s*/g, ' ')),
  };
}

/**
 * The CHECK constraints of a CREATE TABLE statement, as expression texts; null when a `CHECK (`
 * has no closing parenthesis. The text is walked token by token: string literals, quoted
 * identifiers and comments are stepped over, so a `CHECK` or a parenthesis inside one is not
 * read as one.
 * @param {string} sql
 * @returns {string[] | null}
 */
export function checkClauses(sql) {
  const n = sql.length;
  let i = 0;
  // From an opening quote at i to just past its closing one; a doubled quote is an escaped one.
  const skipQuoted = (close) => {
    for (i++; i < n; i++) {
      if (sql[i] !== close) continue;
      if (close !== ']' && sql[i + 1] === close) i++;
      else {
        i++;
        return;
      }
    }
  };
  const skipComment = () => {
    const end = sql.startsWith('--', i) ? sql.indexOf('\n', i) : sql.indexOf('*/', i + 2);
    i = end < 0 ? n : end + (sql[end] === '\n' ? 1 : 2);
  };
  // Steps over one quoted token or comment at i; false when there is none there.
  const skipped = () => {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') skipQuoted(c);
    else if (c === '[') skipQuoted(']');
    else if (sql.startsWith('--', i) || sql.startsWith('/*', i)) skipComment();
    else return false;
    return true;
  };
  const WORD = /[\p{L}\p{N}_$]/u;
  const out = [];
  while (i < n) {
    if (skipped()) continue;
    if (!WORD.test(sql[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && WORD.test(sql[i])) i++;
    if (sql.slice(start, i).toUpperCase() !== 'CHECK') continue;
    for (;;) {
      if (i < n && /\s/.test(sql[i])) i++;
      else if (sql.startsWith('--', i) || sql.startsWith('/*', i)) skipComment();
      else break;
    }
    if (sql[i] !== '(') continue;
    const from = ++i;
    let depth = 1;
    while (i < n && depth > 0) {
      if (skipped()) continue;
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    if (depth > 0) return null;
    out.push(sql.slice(from, i - 1));
  }
  return out;
}

/**
 * The rows of each table that fail one of its CHECK constraints, counted with a read-only query: a
 * row fails when an expression is false, and NULL passes, as in SQLite. `unchecked` names the
 * tables whose constraints could not be read or run, which says nothing about their rows.
 * @param {import('better-sqlite3').Database} db
 * @returns {{problems: string[], unchecked: string[]}}
 */
function checkConstraints(db) {
  const problems = [];
  const unchecked = [];
  let tables;
  try {
    tables = db
      .prepare(
        `SELECT l.name, m.sql FROM pragma_table_list l JOIN sqlite_master m ON m.name = l.name
         WHERE l.schema = 'main' AND l.type = 'table' AND m.type = 'table' AND l.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
      )
      .all();
  } catch (e) {
    return { problems, unchecked: [`every table (${message(e)})`] };
  }
  for (const { name, sql } of tables) {
    const clauses = checkClauses(sql ?? '');
    if (clauses === null) {
      unchecked.push(`${name} (its CHECK constraints could not be read)`);
      continue;
    }
    if (clauses.length === 0) continue;
    const where = clauses.map((c) => `NOT (${c})`).join(' OR ');
    try {
      const failing = db
        .prepare(`SELECT count(*) FROM ${q(name)} NOT INDEXED WHERE ${where}`)
        .pluck()
        .get();
      if (failing > 0)
        problems.push(`CHECK constraint failed in ${name} (${failing} ${failing === 1 ? 'row' : 'rows'})`);
    } catch (e) {
      if (/^SQLITE_CORRUPT/.test(e?.code ?? '')) problems.push(`${name}: ${message(e)}`);
      else unchecked.push(`${name} (${message(e)})`);
    }
  }
  return { problems, unchecked };
}

/**
 * readIntegrity on a read-only handle of `dbPath`, classifying an open failure the same way.
 * @param {string} dbPath
 * @returns {{ok: boolean, problems: string[], notChecked?: string, unchecked?: string[]}}
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
