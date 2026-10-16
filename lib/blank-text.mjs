// lib/blank-text.mjs — "would a reader see nothing here?", the one test every title writer asks.
//
// trim() keeps the invisible format characters, so a title of U+200B (zero width space), U+00AD
// (soft hyphen) or U+FEFF alone passed every blank check and was stored as a title no listing
// could show (E2E 2026-10-16, rounds 2 and 3). A leaf with no imports: tool-schemas.mjs and
// lib/deferred-work.mjs ask it too.

const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;

/**
 * @param {unknown} s
 * @returns {boolean} true for a non-string, and for a string of whitespace and invisible format
 *   characters only
 */
export function isBlankText(s) {
  return typeof s !== 'string' || s.replace(INVISIBLE_RE, '').trim() === '';
}
