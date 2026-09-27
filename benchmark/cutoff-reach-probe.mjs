#!/usr/bin/env node
// benchmark/cutoff-reach-probe.mjs — what PreToolUse recall's 60-day cut removes (proposal B3).
//
// scripts/pre-tool-recall.js drops every observation and event created before
// `now - PRETOOL_LOOKBACK_MS`, whatever happened to it since. The OSS landscape review
// (docs/audits/20260927-oss-landscape-optimization-proposal.md, B3) proposes timing that cut
// from a row's last USE instead. This probe answers the prior question — does the cut remove
// anything that is still in use — and it has to be ready before the cut first bites
// (2026-11-04 on the maintainer DB, whose oldest live row is 2026-09-05).
//
// POPULATION (doctrine rule 3), per source, restricted exactly as the recall SELECTs are
// except for the age predicate, which is inverted:
//   • observations: file-edged (observation_files), importance >= 2, liveObsFilterSql, and
//     created_at_epoch <= cutoff. Each (obs, file) EDGE is one row, because recall fires per
//     file. Split by the edge's own record of use: `cited` (last_cited_session_id set — the
//     model cited it after a file injection), `miss_streak = 0` (never passed over), and the
//     rest. The first two are what the cut would evict while still in use.
//   • events: importance >= 2, not superseded, carrying file_paths, created_at_epoch <= cutoff.
//     Events keep no per-file use record, so they are counted, not split.
//
// PREMISE the proposal got wrong, stated so nobody re-derives it: "expiry is miss_streak's
// job" holds only with CLAUDE_MEM_EDGE_DECAY on. It is OFF by default, so on a stock install
// the 60-day cut is the ONLY thing that ever retires a file lesson. Removing it is not
// covered by decay unless decay ships on too.
//
// Read-only: the database is opened { readonly: true } and nothing else is written.
//
//   node benchmark/cutoff-reach-probe.mjs [--project P] [--json] [--now ISO]

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';
import { PRETOOL_LOOKBACK_MS, DAY_MS } from '../lib/time-constants.mjs';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{now?: number, project?: string|null}} [opts]
 */
export function probeCutoffReach(db, { now = Date.now(), project = null } = {}) {
  const cutoff = now - PRETOOL_LOOKBACK_MS;
  const projClause = project ? 'AND o.project = ?' : '';
  const projArgs = project ? [project] : [];
  const edges = db
    .prepare(
      `SELECT o.id, o.project, of2.filename, of2.miss_streak, of2.last_cited_session_id, o.created_at_epoch
       FROM observations o JOIN observation_files of2 ON of2.obs_id = o.id
       WHERE o.importance >= 2 AND ${liveObsFilterSql('o')} AND o.created_at_epoch <= ? ${projClause}
       ORDER BY o.created_at_epoch ASC, o.id ASC`,
    )
    .all(cutoff, ...projArgs);
  const cited = edges.filter((e) => e.last_cited_session_id);
  const neverMissed = edges.filter((e) => !e.last_cited_session_id && e.miss_streak === 0);
  const rest = edges.length - cited.length - neverMissed.length;

  const evProj = project ? 'AND project = ?' : '';
  let events = [];
  try {
    events = db
      .prepare(
        `SELECT id, project, created_at_epoch FROM events
         WHERE importance >= 2 AND superseded_at_epoch IS NULL
           AND file_paths IS NOT NULL AND file_paths != '' AND file_paths != '[]'
           AND created_at_epoch <= ? ${evProj}
         ORDER BY created_at_epoch ASC, id ASC`,
      )
      .all(cutoff, ...projArgs);
  } catch {
    /* no events table on a very old DB */
  }

  // When the cut first bites: the oldest row that WOULD be in the population once old enough.
  const oldest = db
    .prepare(
      `SELECT MIN(o.created_at_epoch) AS e FROM observations o JOIN observation_files of2 ON of2.obs_id = o.id
       WHERE o.importance >= 2 AND ${liveObsFilterSql('o')} ${projClause}`,
    )
    .get(...projArgs)?.e;

  return {
    now: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    lookbackDays: PRETOOL_LOOKBACK_MS / DAY_MS,
    firstBites: Number.isFinite(oldest) ? new Date(oldest + PRETOOL_LOOKBACK_MS).toISOString() : null,
    obsEdges: {
      total: edges.length,
      cited: cited.length,
      neverMissed: neverMissed.length,
      rest,
      // The NAME SET is the evidence (doctrine rule 4) — ids of the rows the cut removes while in use.
      inUse: [...cited, ...neverMissed].map((e) => ({ id: e.id, project: e.project, file: e.filename })),
    },
    events: { total: events.length, ids: events.map((e) => e.id) },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  const nowArg = arg('--now');
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(now)) {
    process.stderr.write(`cutoff-reach-probe: --now ${nowArg} is not a date\n`);
    process.exit(2);
  }
  const db = new Database(join(resolveDataDir(), 'claude-mem-lite.db'), { readonly: true });
  let r;
  try {
    r = probeCutoffReach(db, { now, project: arg('--project') });
  } finally {
    db.close();
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  const o = r.obsEdges;
  console.log(`PreToolUse ${r.lookbackDays}-day cut at ${r.now} (removes rows created <= ${r.cutoff})`);
  console.log(`first bites: ${r.firstBites ?? 'never (no file-edged live row)'}`);
  console.log(
    `observation edges removed: ${o.total}  ·  in use: cited ${o.cited}, never missed ${o.neverMissed}  ·  other ${o.rest}`,
  );
  console.log(`events removed: ${r.events.total}`);
  if (o.inUse.length) console.table(o.inUse);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
