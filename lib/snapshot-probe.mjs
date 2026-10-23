// lib/snapshot-probe.mjs — what restoring one backup snapshot would give (D#558).
//
// Run as a CHILD by lib/db-unusable.mjs `checkSnapshot`, with CLAUDE_MEM_DIR set to a private
// directory that holds a copy of the snapshot as claude-mem-lite.db. It does what the restore
// command does after its `cp`: opens the copy with the opener every product face uses
// (ensureDbWithWalRecovery, its FTS-rebuild and WAL branches included) and rebuilds the FTS
// indexes, as `fts-check rebuild` does. Then it runs SQLite's integrity check on that read-write
// connection and counts observations. One JSON line on stdout.
//
// A child process, not a call: ensureDb opens DB_PATH, which lib/data-paths.mjs fixes from
// CLAUDE_MEM_DIR when it is first imported, so the product's own opener reaches a copy only in a
// process whose data directory is the copy's. A second opener written for the copy would be a
// twin of ensureDb, and the first attempt at this check (v6.30.5, withdrawn) failed on exactly
// that kind of gap: a stand-in check that disagreed with what a restore gives.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDbWithWalRecovery, rebuildFTS } from '../schema.mjs';

/**
 * The checks after the open, on a connection to the restored copy. Exported for tests.
 * @param {import('better-sqlite3').Database} db
 * @returns {{integrity: string, observations: number, ftsErrors: string[]}}
 */
export function probeOpenedStore(db) {
  const { errors } = rebuildFTS(db);
  const rows = db.prepare('PRAGMA integrity_check(1)').pluck().all();
  const observations = db.prepare('SELECT count(*) FROM observations').pluck().get();
  return { integrity: rows.join('; '), observations, ftsErrors: errors };
}

function main() {
  let db = null;
  let result;
  try {
    db = ensureDbWithWalRecovery();
    result = { opened: true, ...probeOpenedStore(db) };
  } catch (e) {
    result = { opened: db !== null, error: { code: e?.code ?? null, message: String(e?.message ?? e) } };
  } finally {
    try {
      db?.close();
    } catch {
      /* a private copy: nothing to keep */
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
