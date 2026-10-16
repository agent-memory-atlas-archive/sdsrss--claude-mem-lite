// lib/db-busy.mjs — "another connection holds the lock".
//
// A leaf with no imports, so a hook script can tell a lock wait that ran out from any other
// write failure without loading the hook layer: scripts/user-prompt-search.js stops its
// best-effort counter bumps on the first one (E2E 2026-10-16 F9), and hook.mjs skips the prompt
// row's dependants. mem-cli.mjs carries its own copy of this test for its exit message.

/**
 * SQLITE_BUSY / SQLITE_LOCKED and their extended codes (SQLITE_BUSY_SNAPSHOT,
 * SQLITE_LOCKED_SHAREDCACHE, ...).
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isDbBusyError(e) {
  const code = e && typeof e.code === 'string' ? e.code : '';
  return /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code);
}
