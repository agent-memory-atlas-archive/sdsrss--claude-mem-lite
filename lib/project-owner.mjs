// D16: which directory owns a plain project id, decided once and recorded for the hot path.
//
// ~/a/packages/api and ~/b/packages/api both map to `packages--api`. project-utils.mjs
// projectIdForDir() reads the owner record and gives every other directory `<id>~<hash>`; this
// module WRITES that record, from SessionStart only (it needs the database, the reader must
// not).
//
// The first claim after an upgrade is the one that matters, because the id already holds rows
// from every directory that shared it. "Whoever opens first" would hand an existing
// repository's id — and its history — to a checkout made yesterday. So the owner is ELECTED
// from the data: the existing directory the most path-attributed rows under the id came from.
// Only with no such evidence does the opening directory take it. After that the record stands
// until its directory is gone.

import { existsSync, readFileSync, writeFileSync, linkSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { projectNameFromDir, canonicalProjectDir, PROJECT_OWNER_PREFIX } from '../project-utils.mjs';

/** Distinct absolute paths sampled per election. A project's paths number in the hundreds. */
const ELECTION_PATH_CAP = 5000;
/** Enough to climb from a file to any plausible project root. */
const MAX_ANCESTORS = 64;

/**
 * The directory that should own `id`: the existing directory most of the id's path-attributed
 * rows came from (ties go to `dir`), else `dir`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{dir: string, id: string, alsoProjects?: string[]}} opts `alsoProjects`: other ids
 *   whose rows may still belong to this id's directories (a pre-D9 id not yet re-keyed)
 * @returns {string} canonical directory
 */
export function electProjectOwner(db, { dir, id, alsoProjects = [] }) {
  const self = canonicalProjectDir(dir);
  const projects = [...new Set([id, ...alsoProjects])];
  const paths = db
    .prepare(
      `SELECT DISTINCT f.filename p FROM observation_files f JOIN observations o ON o.id = f.obs_id
       WHERE o.project IN (${projects.map(() => '?').join(',')}) AND (f.filename LIKE '/%' OR f.filename LIKE '_:%')
       LIMIT ${ELECTION_PATH_CAP}`,
    )
    .all(...projects)
    .map((r) => r.p);
  const votes = new Map();
  for (const p of paths) {
    let a = dirname(p);
    for (let i = 0; i < MAX_ANCESTORS; i++) {
      if (projectNameFromDir(a) === id) {
        const root = canonicalProjectDir(a);
        votes.set(root, (votes.get(root) || 0) + 1);
        break;
      }
      const up = dirname(a);
      if (up === a) break;
      a = up;
    }
  }
  let best = self;
  let bestVotes = votes.get(self) || 0;
  for (const [root, n] of [...votes].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (n > bestVotes && root !== self && existsSync(root)) {
      best = root;
      bestVotes = n;
    }
  }
  return best;
}

/**
 * Record `ownerDir` as the owner of `id` unless a live owner is already recorded. Atomic: the
 * record is filled privately and linked into place, so no reader sees it empty and two
 * SessionStarts cannot both win. An owner whose directory is gone is replaced.
 *
 * @param {string} runtimeDir
 * @param {string} id
 * @param {string} ownerDir
 * @returns {string} the owner now recorded
 */
export function claimProjectOwner(runtimeDir, id, ownerDir) {
  const file = join(runtimeDir, `${PROJECT_OWNER_PREFIX}${id}`);
  const tmp = `${file}.tmp-${process.pid}`;
  const want = canonicalProjectDir(ownerDir);
  writeFileSync(tmp, want, { mode: 0o600 });
  try {
    try {
      linkSync(tmp, file);
      return want;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let current = '';
    try {
      current = readFileSync(file, 'utf8').trim();
    } catch {
      /* raced with a sweep: treat as gone */
    }
    if (current && existsSync(current)) return current;
    renameSync(tmp, file); // the recorded owner is gone
    return want;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* linked or renamed away */
    }
  }
}

/**
 * Remove owner records whose directory no longer exists. Readers already ignore them; this only
 * keeps one file per project ever opened from accumulating. Never age-based: deleting a LIVE
 * record would switch a running session in a non-owning directory onto the owner's id.
 *
 * @param {string} runtimeDir
 * @returns {number} records removed
 */
export function sweepDeadProjectOwners(runtimeDir) {
  let n = 0;
  let names;
  try {
    names = readdirSync(runtimeDir);
  } catch {
    return 0;
  }
  for (const f of names) {
    if (!f.startsWith(PROJECT_OWNER_PREFIX) || /\.tmp-\d+$/.test(f)) continue;
    const full = join(runtimeDir, f);
    try {
      const owner = readFileSync(full, 'utf8').trim();
      if (owner && !existsSync(owner)) {
        unlinkSync(full);
        n++;
      }
    } catch {
      /* concurrent removal */
    }
  }
  return n;
}
