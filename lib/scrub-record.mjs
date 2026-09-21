// claude-mem-lite: per-table scrub helper. Applies scrubSecrets to the known
// text fields of a table row. Numeric / JSON-blob / id fields are passed
// through untouched.
//
// Failsafe policy: when the table is unknown, scrub every string field by
// default. Newly added tables stay safe even before TEXT_FIELDS_BY_TABLE is
// updated — over-scrubbing is the safe direction; under-scrubbing leaks.
//
// JSON-stringified array fields (e.g. session_handoffs.key_files,
// session_handoffs.match_keywords-when-array) are NOT listed here — running
// scrubSecrets over the JSON string can rewrite quoted values and break
// downstream JSON.parse. Pre-scrub each element upstream of the
// JSON.stringify call instead, via `scrubFilePaths` below.
//
// D#44: that instruction sat here for four releases and exactly ONE call site
// followed it (hook-handoff.mjs, session_handoffs.key_files). observations
// .files_modified / .files_read, observation_files.filename and events
// .file_paths all stored raw paths while the title DERIVED FROM THE SAME PATH
// was scrubbed. A prescription in a comment is not a mechanism; the helper is.
//
// Second axis, found after D#44 closed: that one compliant call site was compliant
// in SHAPE only. It mapped `scrubSecrets` over the elements — element-wise, as
// prescribed — and so read as the model the other five were measured against, while
// taking the whole-string function this module exists to keep off a path. "Follows the
// rule" and "calls the helper" are different claims, and only the second is checkable.
// Which is why the prescription above names `scrubFilePaths` rather than describing it.

import { scrubSecrets } from '../secret-scrub.mjs';

export const TEXT_FIELDS_BY_TABLE = {
  observations: [
    'title',
    'subtitle',
    'text',
    'narrative',
    'concepts',
    'facts',
    'lesson_learned',
    'search_aliases',
  ],
  // events: the auto-captured bugfix/lesson/decision path (saveEvent) and the
  // CLI /bug + /lesson commands both land here. title/body carry LLM output and
  // user-pasted repro text verbatim, so they must scrub like observations do —
  // event_type/project/git_sha are enums/identifiers/hash, left untouched.
  events: ['title', 'body'],
  session_summaries: [
    'request',
    'investigated',
    'learned',
    'completed',
    'next_steps',
    'remaining_items',
    'notes',
    'lessons',
    'key_decisions',
  ],
  session_handoffs: [
    'working_on',
    'completed',
    'unfinished',
    // Excluded:
    //   key_files       — JSON.stringify(array); pre-scrubbed at the call site via
    //                     `scrubFilePaths`, NOT a bare per-element scrubSecrets. It held
    //                     filesystem paths and took the whole-string function through
    //                     v6.10.0, which is the defect scrubFilePath's own docblock
    //                     describes; the renderer emits basename(), so the destroyed
    //                     filename was what the resuming session was shown.
    //   next_steps      — same shape, same reason: JSON.stringify({file,title,items}),
    //                     pre-scrubbed element-wise in buildAndSaveHandoff. Listing it
    //                     here would let scrubSecrets rewrite the SERIALIZED JSON, and the
    //                     renderer's JSON.parse sits behind a `catch {}` — so the whole
    //                     Next steps section would disappear silently rather than fail.
    //                     Named here because the pre-ship review found the column had been
    //                     added without updating this block, which is the file's contract.
    //   match_keywords  — currently a space-joined plain string. Excluded because the
    //                     value is scrubbed at its DERIVATION in buildAndSaveHandoff
    //                     (`scrubSecrets(allText)` + the shared `safeFiles` array), which
    //                     also future-proofs against a refactor to JSON.stringify.
    //
    //                     RETRACTED, measured: the reason recorded here until v6.10.0 was
    //                     "built from tokenizeHandoff() output (alphanumeric tokens only),
    //                     so secrets cannot survive the upstream tokenizer." Neither half
    //                     holds. extractMatchKeywords has TWO arms and the FILE arm never
    //                     reaches the tokenizer at all — it takes basename-minus-extension
    //                     off the raw path set. And the tokenizer splits a secret from its
    //                     keyword rather than removing it: `token=ghp_…` yields `ghp_…` as
    //                     a term of its own. A no-op justification is worse than no
    //                     justification, because it retires the question.
    // key_decisions is kept: call site uses '\n'.join (plain string), and
    // decision titles can carry secrets verbatim (LLM output).
    'key_decisions',
  ],
  // deferred_work: the `mem_defer` free-text surface. R10 P1-5 — this table was absent,
  // and insertDeferred never called scrubRecord at all, so neither the listed path nor
  // the unknown-table failsafe ever ran. title/detail are written verbatim by the agent
  // ("rotate ghp_… before release", a connection string in detail) and replayed into
  // model context by the SessionStart dashboard, mem_defer_list and mem_get D#N.
  //   files — JSON.stringify(array); pre-scrubbed element-wise at insertDeferred via
  //           `scrubFilePaths`. It needed to be: `mem_defer` and `defer add --files` both
  //           take agent-supplied paths, and this line prescribed the remedy for four
  //           releases while the call site stored them raw.
  //   project / status — identifiers and an enum.
  deferred_work: ['title', 'detail', 'drop_reason'],
};

/**
 * Scrub one filesystem path — for PERSISTENCE and for KEY DERIVATION, which is
 * why this is a named export and not an inline `scrubSecrets(f)` at each site.
 *
 * `observation_files.filename` is both a stored value and the recall key
 * (lib/file-edge-match.mjs binds it four ways). If the write side scrubs and the
 * read side does not, the two derive different keys from the same path and a
 * lesson becomes unreachable through the very file it is about. Both sides call
 * THIS, so they cannot drift apart — the same rule this repo already enforces
 * for `fileMatchClause`'s two consumers.
 *
 * Total by construction: it never throws, because one caller is a hook on the
 * PreToolUse path. Nullish becomes '' (`p ?? ''`); anything else becomes its
 * String() form, so 42 yields '42', not ''.
 */
export function scrubFilePath(p) {
  // SEGMENT-WISE, and that is the whole point rather than a micro-optimisation.
  // Many SECRET_PATTERNS carry a value class that does not exclude `/`. This is the one place
  // that number is stated, with its population, because it is GRID-DEPENDENT and five copies of
  // a bare "eight" is how it went wrong: measured here, 11 of the 40 patterns match text
  // spanning `/` on a 15-shape credential grid; the two v6.10.1 pre-ship lenses measured 12
  // (1130 path probes) and 15 (26-shape grid), and 21 on a structural reading of the value
  // classes. "Eight", carried since v6.8.2 with the enumeration
  // secret-scrub.mjs:33/74/78/83/98/109/259/260, is an UNDER-count on every one of those
  // populations — it omits at least the `Authorization:`, `AccountKey=`, `DATABASE_URL`/
  // `SUPABASE_KEY` and db-connection-URL arms. The mechanism does not depend on the count.
  // On prose the wide value class is correct; run
  // whole-path, the match eats the separator and everything after it, so
  // `/repo/token=<secret>/notes.mjs` became `/repo/token=***` — the filename
  // destroyed at WRITE time and unrecoverable, and every file under such a
  // directory collapsing onto one recall key (measured: an untouched `gamma.mjs`
  // recalled another file's observations). Splitting first bounds every pattern to
  // the segment it matched in.
  //
  // A credential whose own syntax SPANS a separator — `scheme://user:pass@host`, the Slack
  // webhook path, a `postgres://` connection string — needs its `/` characters to match at all,
  // so segment-wise scrubbing cannot see it. That was accepted here until v6.10.1 on the stated
  // reason "these columns hold filesystem paths", and the pre-ship review measured that premise
  // FALSE: `lib/save-observation.mjs` filters `params.files` on `typeof f === 'string'` and
  // nothing else, and `extractFilePaths` returns a URL verbatim from a `{path}` / `{filePath}`
  // tool input under a `PostToolUse: *` matcher. A URL reaches these columns. Measured: four URL
  // shapes v6.10.0 redacted were being stored verbatim.
  //
  // So the value decides, not the column: when it carries `://` it is scrubbed whole-string, the
  // only way those patterns match. NAMED COST, pinned in tests/secret-scrub-coverage.test.mjs: a
  // URL whose credential sits in a path SEGMENT now loses its filename to the greedy value class,
  // which is the thing segment-wise scrubbing exists to prevent, traded back on this one shape.
  // Redacting a live credential wins over preserving a filename that is not a recall key. The
  // guard is `scrubSecrets`-decided, not scheme-decided — a credential-free URL comes back
  // byte-identical, so ordinary `https://` / `s3://` / `file://` values are untouched.
  const s = String(p ?? '');
  if (s.includes('://')) return scrubSecrets(s);
  // The capture group keeps the separators in the split output, so join()
  // reconstructs the original byte-for-byte when nothing matches.
  return s
    .split(/([/\\])/)
    .map((part) => (part === '/' || part === '\\' ? part : scrubSecrets(part)))
    .join('');
}

/**
 * Element-wise scrub for a path ARRAY, to be called upstream of the
 * `JSON.stringify` / junction INSERT this module's header points at.
 *
 * A non-array flows through UNTOUCHED, mirroring scrubRecord's own contract for
 * non-string fields. That is load-bearing rather than defensive: call sites pass
 * `undefined` on purpose (`JSON.stringify(undefined)` is `undefined`, which is
 * how a column stays NULL), and coercing it to `[]` here would quietly rewrite
 * NULL to '[]' in columns other code tests with `IS NULL` / `NOT IN (NULL,'[]')`.
 */
export function scrubFilePaths(paths) {
  return Array.isArray(paths) ? paths.map(scrubFilePath) : paths;
}

/**
 * Scrub the text fields of a record before INSERT.
 * Returns a shallow copy with string text-fields scrubbed; the input object
 * is left untouched. Non-string values (numbers, null, JSON blobs the caller
 * has already stringified) flow through unchanged.
 */
export function scrubRecord(table, row) {
  if (!row || typeof row !== 'object') return row;
  const fields = TEXT_FIELDS_BY_TABLE[table];
  const out = { ...row };
  if (fields) {
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = scrubSecrets(out[f]);
    }
  } else {
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string') out[k] = scrubSecrets(out[k]);
    }
  }
  return out;
}
