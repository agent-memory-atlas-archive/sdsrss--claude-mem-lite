// server/fts-check.mjs — MCP `mem_fts_check` handler.
// Extracted from server.mjs (v2.41, god-module split).
//
// Pure delegate to schema.mjs helpers; Zod filters args.action before we get
// here (see memFtsCheckSchema). No shared state beyond the `db` handle passed
// in from the server-process module scope.

import { dirname } from 'node:path';
import { checkFTSIntegrity, rebuildIndexes } from '../schema.mjs';
import { PAGE_DAMAGE_COPY_ADVICE } from '../lib/db-unusable.mjs';

/**
 * Handle `mem_fts_check({ action })`. Returns an MCP content wrapper.
 * @param {import('better-sqlite3').Database} db
 * @param {{ action: 'check' | 'rebuild' }} args
 */
export function handleMemFtsCheck(db, args) {
  if (args.action === 'check') {
    const result = checkFTSIntegrity(db);
    // A busy store is not a finding: "issues found" invited mem_fts_check rebuild on a healthy
    // store, a long write that blocks the live hooks (E2E 2026-10-16 round 2).
    const text = result.healthy
      ? 'FTS5 indexes are healthy — all integrity checks passed.'
      : result.busy
        ? 'FTS5 check not run — the database is in use by another process. This is not corruption; do not rebuild. Check again when the store is idle.'
        : `FTS5 issues found:\n${result.details.join('\n')}`;
    return { content: [{ type: 'text', text }] };
  }
  // args.action === 'rebuild' (Zod enum enforces one of the two). The FTS5 indexes, then every
  // other index, as `fts-check rebuild` does (D#558).
  const result = rebuildIndexes(db);
  // Nothing was written: over damaged pages a rebuild overwrites rows (D#591). The model gets the
  // advice and the directory, not the copy command: it cannot close every session first.
  if (result.pages && result.pages.state !== 'ok') {
    const text =
      result.pages.state === 'damaged'
        ? [
            `Not rebuilt: the database's pages are damaged, so a rebuild could overwrite rows on them:`,
            ...result.pages.lines,
            ...(result.pages.more > 0 ? [`… and ${result.pages.more} more`] : []),
            `Do not retry the rebuild. Tell the user: ${PAGE_DAMAGE_COPY_ADVICE} The data directory is ${dirname(db.name)}.`,
          ].join('\n')
        : `Not rebuilt: the database's pages could not be checked first (${result.pages.error}).`;
    return { content: [{ type: 'text', text }] };
  }
  const summary =
    result.errors.length > 0
      ? `Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`
      : `Successfully rebuilt: ${result.rebuilt.join(', ')}`;
  return { content: [{ type: 'text', text: summary }] };
}
