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
