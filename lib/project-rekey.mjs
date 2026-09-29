// D9 part 2: move a project's rows from the id the pre-D9 naming rule gave it to the new one.
//
// Before D9, projectNameFromDir kept ASCII alone, so ~/projects/博客 and ~/projects/商城 were
// both `projects----`. The new rule separates them, which on its own strands every existing
// row under the old, shared id. A row can be moved only when it PROVES which directory it came
// from — a recorded file path inside the directory. Everything else (rows with no path, with
// a relative path, from a sibling directory) stays where it is: guessing would put another
// project's memories into this one, which is the defect being fixed. Compression clusters are
// moved whole, so a keeper and its members never end up in two projects.
//
// Leaf over project-utils.mjs; lives in lib/ so coverage reaches it (hook.mjs is excluded).

import { likeLiteral } from '../project-utils.mjs';
import { basename, dirname } from 'path';

/** Runtime marker: the re-key ran for this project (a one-shot record — never GC'd). */
export const PROJECT_REKEY_MARKER_PREFIX = '.project-rekeyed-';

/**
 * The project id the naming rule gave a directory before D9: ASCII letters, digits and `_.-`
 * kept, everything else '-', first 100 characters. Only for finding rows stored under it.
 *
 * @param {string} p Absolute directory path
 * @returns {string}
 */
export function legacyProjectNameFromDir(p) {
  const base = basename(p);
  const parent = basename(dirname(p));
  const raw = parent && parent !== '.' && parent !== '/' ? `${parent}--${base}` : base;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
}

/**
 * Move rows stored under `legacy` whose files lie in `dir` to `project`. One transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{dir: string, project: string, legacy: string}} opts
 * @returns {{moved: number, left: number}} rows moved; rows still under `legacy` afterwards
 *   (they may belong to other directories that shared the old id)
 */
export function rekeyLegacyProject(db, { dir, project, legacy }) {
  const root = dir.replace(/[\\/]+$/, '') || dir;
  // The same directory can reach us composed or decomposed (macOS), and paths were stored
  // exactly as the tool reported them.
  const spellings = [...new Set([root, root.normalize('NFC'), root.normalize('NFD')])];
  const pathClause = spellings.map(() => "(f.filename = ? OR f.filename LIKE ? ESCAPE '\\')").join(' OR ');
  const pathArgs = spellings.flatMap((s) => [s, `${likeLiteral(s)}/%`]);
  return db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _rekey_ids (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM _rekey_ids');
    db.prepare(
      `INSERT OR IGNORE INTO _rekey_ids
       SELECT o.id FROM observations o JOIN observation_files f ON f.obs_id = o.id
       WHERE o.project = ? AND (${pathClause})`,
    ).run(legacy, ...pathArgs);
    // Whole clusters: the keepers of moved members, then every member of a moved keeper.
    db.prepare(
      `INSERT OR IGNORE INTO _rekey_ids
       SELECT k.id FROM observations k
       WHERE k.project = ? AND k.id IN (SELECT o.compressed_into FROM observations o
         WHERE o.id IN (SELECT id FROM _rekey_ids) AND o.compressed_into > 0)`,
    ).run(legacy);
    db.prepare(
      `INSERT OR IGNORE INTO _rekey_ids
       SELECT m.id FROM observations m
       WHERE m.project = ? AND m.compressed_into IN (SELECT id FROM _rekey_ids)`,
    ).run(legacy);
    const moved = db
      .prepare('UPDATE observations SET project = ? WHERE project = ? AND id IN (SELECT id FROM _rekey_ids)')
      .run(project, legacy).changes;
    db.exec('DELETE FROM _rekey_ids');
    const left = db.prepare('SELECT COUNT(*) n FROM observations WHERE project = ?').get(legacy).n;
    return { moved, left };
  })();
}

/** Every table that carries a `project` column. */
const PROJECT_TABLES = [
  'observations',
  'sdk_sessions',
  'session_summaries',
  'session_handoffs',
  'events',
  'deferred_work',
  'citation_log',
  'citation_surface_log',
];

/**
 * True when nothing stored under the pre-D9 id `legacy` points at a directory OTHER than `dir`
 * that also maps to `legacy` — no sibling such as ~/projects/商城 next to ~/projects/博客. Paths
 * outside every such directory (~/.bashrc, /etc/hosts) and rows without paths are no evidence
 * either way. A sibling counts whether or not it still exists: its rows are not this
 * directory's to take.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{dir: string, legacy: string}} opts
 * @returns {boolean}
 */
export function legacyIdIsExclusive(db, { dir, legacy }) {
  const self = (dir.replace(/[\\/]+$/, '') || dir).normalize('NFC');
  const paths = db
    .prepare(
      `SELECT DISTINCT f.filename p FROM observation_files f JOIN observations o ON o.id = f.obs_id
       WHERE o.project = ? AND (f.filename LIKE '/%' OR f.filename LIKE '_:%')`,
    )
    .all(legacy)
    .map((r) => r.p);
  for (const p of paths) {
    let a = dirname(p);
    for (let i = 0; i < 64; i++) {
      if (legacyProjectNameFromDir(a) === legacy) {
        if (a.normalize('NFC') !== self) return false;
        break;
      }
      const up = dirname(a);
      if (up === a) break;
      a = up;
    }
  }
  return true;
}

/**
 * Move every row of every project-carrying table from `from` to `to`, in one transaction — for
 * an old id this directory used alone (legacyIdIsExclusive), where its sessions, summaries,
 * handoffs, events and deferred items belong to it as much as its memories do. A handoff whose
 * key already exists under `to` stays (OR IGNORE on its primary key).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{from: string, to: string}} opts
 * @returns {{moved: number, other: number}} observations moved; rows of the other tables moved
 */
export function moveProjectRows(db, { from, to }) {
  return db.transaction(() => {
    let moved = 0;
    let other = 0;
    for (const t of PROJECT_TABLES) {
      let n = 0;
      try {
        n = db.prepare(`UPDATE OR IGNORE ${t} SET project = ? WHERE project = ?`).run(to, from).changes;
      } catch (e) {
        if (!/no such table/.test(String(e?.message))) throw e;
      }
      if (t === 'observations') moved = n;
      else other += n;
    }
    return { moved, other };
  })();
}
