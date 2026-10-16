// lib/recent-table.mjs — how many rows the SessionStart `### Recent` table shows, and which
// (injection budget C4, docs/audits/20261016-injection-budget-baseline.md).
//
// The table used to render the whole token-budget pick: 7–13 rows per session on the frozen
// 52-session corpus, 1.02 KB/session, ids cited 2 times in 498 (session, id) pairs. It now shows
// `recentTableRowCap()` rows (5).
//
// WHICH five matters on a thin project: below MIN_LOCAL_OBS own rows, hook-context tops the pick up
// with other projects' rows, which are often newer. A newest-5 cut over that union evicted the
// project's OWN rows (pre-ship defect review P2-1: 5 of the 60 corpus tables, 10 own rows), so
// the cut ranks own rows first and only then fills with foreign ones.
//
// Leaf (env-number only): benchmark/injection-budget.mjs replays these two functions, and
// importing hook-context.mjs would create the data dir's runtime directory as a side effect.

import { envNumber } from './env-number.mjs';

/**
 * Rows the table shows. Read per call so the CLI `context` command and tests see the current env.
 * 0 hides the table.
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function recentTableRowCap(env = process.env) {
  return envNumber(env.CLAUDE_MEM_STARTUP_RECENT_ROWS, {
    name: 'CLAUDE_MEM_STARTUP_RECENT_ROWS',
    defaultValue: 5,
    min: 0,
    integer: true,
  });
}

/**
 * The rows the table keeps, in display order: the project's own rows first (a row with no
 * `project`, or this project), then other projects' rows, each newest first by `newer`; cut to
 * `cap`; then sorted by `newer` for display. Copies — the caller's array is not reordered.
 *
 * @template {{project?: string|null}} T
 * @param {T[]} rows
 * @param {string} project
 * @param {number} cap
 * @param {(a: T, b: T) => number} newer  the display comparator (newest first)
 * @returns {T[]}
 */
export function capRecentRows(rows, project, cap, newer) {
  const own = (o) => !o.project || o.project === project;
  const ranked = [...rows.filter(own).sort(newer), ...rows.filter((o) => !own(o)).sort(newer)];
  return ranked.slice(0, Math.max(0, cap)).sort(newer);
}
