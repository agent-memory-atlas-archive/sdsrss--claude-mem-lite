/**
 * What counts as stale temp residue, and — the half that kept drifting — what does NOT.
 *
 * Extracted from install.mjs because the scanner (`doctor`) and the deleter (`cleanup`)
 * were two hand-kept copies of the same rules, and they have now diverged twice:
 *
 *   • v3.93.0 moved the deleter to MEM_RUNTIME_DIR and left the scanner on
 *     join(MEM_DATA_DIR,'runtime'), so under a runtime override doctor reported "none"
 *     while the cleanup it recommends removed files. Fixed by moving the scanner.
 *   • D#53 (measured 2026-09-22): the deleter age-gates `pending-*` / `ep-flush-*` at
 *     ORPHAN_EPISODE_AGE_MS and the scanner did not, so with three in-flight episode
 *     files doctor printed "Stale temp files: 3 found (run: node install.mjs cleanup)"
 *     and cleanup answered "Kept 3 episode file(s) newer than 1h" then "No stale files
 *     found." Two faces of one install contradicting each other, verbatim.
 *
 * Both were the same defect class on different axes — first the directory, then the age
 * gate — which is why this module exports the CLASSIFIER and not just the prefixes.
 * Sharing the prefixes alone would leave the age gate implemented twice, which is the
 * shape that produced D#53 in the first place.
 *
 * A leaf: node:fs, node:path, and one constants module that imports nothing.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORPHAN_EPISODE_AGE_MS } from './time-constants.mjs';

/** Residue from an interrupted self-update, written under the data dir by hook-update. */
const UPDATE_RESIDUE_PREFIXES = ['.update-staging-', '.update-backup-'];

/** Episode hand-off files under the runtime dir. Age-gated: see classifyEpisodeFile. */
const EPISODE_RESIDUE_PREFIXES = ['pending-', 'ep-flush-'];

export const isUpdateResidue = (name) => UPDATE_RESIDUE_PREFIXES.some((p) => name.startsWith(p));

export const isEpisodeResidue = (name) => EPISODE_RESIDUE_PREFIXES.some((p) => name.startsWith(p));

/**
 * How the age gate is SPOKEN, derived from the gate itself rather than hand-written.
 *
 * Both faces print this window to the user. Before it existed, cleanup printed a literal
 * "1h" while the rule lived in ORPHAN_EPISODE_AGE_MS, and this change's own first draft
 * added a second literal to doctor's new in-flight line — a hand-kept twin of the gate, in
 * the change whose headline was that the rule has one home. Pre-ship review counted it.
 *
 * Whole hours only: a 20-minute gate would print "0h". The gate is HOUR_MS today, and
 * tests/doctor-stale-temp-agreement.test.mjs parses this label back and requires it to
 * equal the gate, so a gate that is not a whole number of hours fails there rather than
 * printing a wrong window to the user.
 */
export const EPISODE_AGE_LABEL = `${Math.round(ORPHAN_EPISODE_AGE_MS / 3600000)}h`;

/**
 * Is this episode file residue, or is it work in progress?
 *
 * The single definition of the age gate that doctor and cleanup share. (The automatic
 * sweep in hook-shared.mjs and the summarizer's wait in hook-llm.mjs apply the same
 * constant in their own code.) `ep-flush-<ts>-<id>.json` is the episode handed to the
 * summarizer, not leftovers: the round-trip is up to ~60s, and deleting one mid-flight
 * discards that episode's observations silently. An unreadable mtime counts as in-flight,
 * because failing safe costs one stale file until the next sweep and failing open costs
 * an episode.
 *
 * @returns {'stale'|'in-flight'}
 */
export function classifyEpisodeFile(
  runtimeDir,
  name,
  { now = Date.now(), episodeAgeMs = ORPHAN_EPISODE_AGE_MS } = {},
) {
  let mtimeMs;
  try {
    mtimeMs = statSync(join(runtimeDir, name)).mtimeMs;
  } catch {
    return 'in-flight';
  }
  // `>=`, so a file aged exactly the gate is KEPT — the side hook-shared.mjs's sweep
  // (deletes only `< cutoff`) and hook-llm.mjs (`>= cutoff` is live) already chose. `>`
  // put the tie on cleanup's delete side, making the manual command the aggressive one.
  return mtimeMs >= now - episodeAgeMs ? 'in-flight' : 'stale';
}

/**
 * Count what `cleanup` would actually remove, split from what it would deliberately keep.
 *
 * `stale` is the number doctor may recommend cleanup for; `inFlight` is reported as a
 * detail rather than a warning, because a file that is supposed to exist right now is not
 * a fault. Note the asymmetry, which is deliberate and is NOT the age gate being applied
 * inconsistently: update residue is guarded by install.lock in cleanup, not by age, so
 * there is no age gate here for it to mirror.
 *
 * @returns {{stale: number, inFlight: number}}
 */
export function scanStaleTempFiles({ dataDir, runtimeDir, now = Date.now(), episodeAgeMs }) {
  let stale = 0;
  let inFlight = 0;

  if (existsSync(dataDir)) {
    for (const f of readdirSync(dataDir)) if (isUpdateResidue(f)) stale++;
  }

  if (existsSync(runtimeDir)) {
    for (const f of readdirSync(runtimeDir)) {
      if (!isEpisodeResidue(f)) continue;
      if (classifyEpisodeFile(runtimeDir, f, { now, episodeAgeMs }) === 'in-flight') inFlight++;
      else stale++;
    }
  }

  return { stale, inFlight };
}
