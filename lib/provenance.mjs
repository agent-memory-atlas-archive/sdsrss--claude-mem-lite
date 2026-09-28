// Which writer produced an observation, read back from its memory_session_id. saveObservation
// writes every explicit save under MANUAL_SESSION_ID_PREFIX. The hook capture (`hook-`),
// transcript import (`import-`), compression summaries and cluster-merge keepers (`compress-`),
// promoted events (`promote-`) and rows imported from older stores (a bare session uuid) are
// machine-written.
//
// Search and get mark the machine-written side, because explicit saves are the large majority
// of a typical store and a mark on nearly every line would carry no information. An unknown id
// renders unmarked, as every row did before the mark existed.

export const MANUAL_SESSION_ID_PREFIX = 'manual-';

// sdk_sessions refuses a row whose two ids are equal and 36 characters long with dashes where a
// uuid has them (schema.mjs, sdk_sessions_id_mix_check_ai). A writer row uses `<prefix><project>`
// for both, which has that shape for one project length and dash layout (27 characters under
// `compress-`, 29 under `manual-`), and the refusal failed every write in such a project (D#147).
// That id gets one more character; every other id is unchanged. Counted in code points, as
// SQLite's length() and LIKE's `_` count them.
const UUID_SHAPED_RE = /^[\s\S]{8}-[\s\S]{4}-[\s\S]{4}-[\s\S]{4}-[\s\S]{12}$/u;

/** The session id a non-hook writer (`manual-`, `compress-`, `promote-`) stores for a project. */
export function writerSessionId(prefix, project) {
  const id = `${prefix}${project}`;
  return UUID_SHAPED_RE.test(id) ? `${id}~` : id;
}

const AUTO_MARK = '🤖';
const AUTO_TEXT = 'auto-written, not an explicit save';

/** @param {string|null|undefined} memorySessionId */
export function isAutoWritten(memorySessionId) {
  return (
    typeof memorySessionId === 'string' &&
    memorySessionId !== '' &&
    !memorySessionId.startsWith(MANUAL_SESSION_ID_PREFIX)
  );
}

/** Search row tag; `auto` is set on obs rows by attachBodyTokens. */
export const autoTag = (r) => (r.auto ? ` ${AUTO_MARK}` : '');

/** Search result-line legend, shown only when a rendered row carries the tag. */
export const autoLegend = (rows) => (rows.some((r) => r.auto) ? ` · ${AUTO_MARK} = ${AUTO_TEXT}` : '');

/** Get header note for a full observation row. */
export const autoHeaderNote = (row) =>
  isAutoWritten(row.memory_session_id) ? ` · ${AUTO_MARK} ${AUTO_TEXT}` : '';
