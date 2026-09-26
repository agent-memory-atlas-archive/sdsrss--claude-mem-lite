// Error-triggered recall — the SUPPRESSION half: firings that are real failures of nothing
// the memory corpus could explain (session-history analysis r2, finding N2).
//
// The trigger (detectBashSignificance / the host's is_error) judges "did it fail" and was
// right; what it injected was still mostly irrelevant, because two populations are not
// failures a memory can help with:
//
//   tdd-red     the agent has just written the test and runs it to WATCH it fail.
//   data-print  an exit-0 inline script or `gh … --log-failed` whose OUTPUT is somebody
//               else's error text (a transcript line, a CI log, the script's own assert).
//
// Reach, measured before this shipped (2026-09-26, tree fa66e5d, 196 session transcripts,
// pre-DB firings through the shipped trigger): tdd-red 229 of 858 PostToolUse firings and
// 1 of 243 PostToolUseFailure firings; data-print 41 of the 858.
//
// Pure: the hook hands in the episode entries it already keeps, so the decision is
// testable without spawning a hook, and coverage reaches it (hook.mjs is outside it).

import { detectBashSignificance, isDataPrintingCommand } from '../bash-utils.mjs';
import { EDIT_TOOLS } from '../utils.mjs';

// Test-file names as runners print them: `tests/x.test.mjs`, `src/a.spec.ts`,
// `test_x.py`, `x_test.go`. Path-qualified when the output qualifies them.
const TEST_FILE_RE =
  /(?:[\w.@-]+\/)*(?:[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?|test_\w+\.py|\w+_test\.(?:py|go))(?![\w.])/g;

/** Test files named in a command line or its output, `./` stripped, deduped. */
function namedTestFiles(...texts) {
  const out = new Set();
  for (const t of texts)
    for (const m of String(t || '').matchAll(TEST_FILE_RE)) out.add(m[0].replace(/^(?:\.\/)+/, ''));
  return [...out];
}

/**
 * Same file, written two ways: the episode keeps what extractFilePaths captured (absolute
 * for a tool edit, possibly relative for a Bash write) while runners print cwd-relative
 * paths. Matched on a PATH-SEGMENT boundary, so `tests/bred.test.mjs` is not `red.test.mjs`.
 */
function samePath(a, b) {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

// A test runner was invoked. detectBashSignificance's isTest plus `node --test`, which it
// does not know and which the claudemd project runs its whole suite through.
function runsTests(cmd) {
  return detectBashSignificance({ command: cmd }, '').isTest || /\bnode\b[^\n|;&]*\s--test\b/.test(cmd);
}

/**
 * An episode entry that EDITED files: an edit tool, or a Bash call whose capture-time
 * `writes` flag (bashCommandWrites) is set. A Bash READ of the test is deliberately not an
 * edit — measured, 106 of 1101 firings name a test a prior Bash call only read, and
 * reading a test before running it is how a real failure is investigated.
 */
function isEditEntry(e) {
  return EDIT_TOOLS.has(e?.tool) || (e?.tool === 'Bash' && e.writes === true);
}

/**
 * tdd-red: a test runner ran, the output (or the command) names test files, and EVERY one
 * of them was edited in this episode by this session. "Every", not "any": a full-suite run
 * that also fails in an unedited file is a real failure and keeps firing.
 */
function isDeliberateRed({ cmd, response, entries, ccSession }) {
  if (!Array.isArray(entries) || entries.length === 0 || !runsTests(cmd)) return false;
  const tests = namedTestFiles(response, cmd);
  if (tests.length === 0) return false;
  const edited = entries.filter(
    (e) =>
      isEditEntry(e) && Array.isArray(e.files) && (!ccSession || !e.ccSession || e.ccSession === ccSession),
  );
  return tests.every((t) => edited.some((e) => e.files.some((f) => typeof f === 'string' && samePath(f, t))));
}

// A stack frame: V8's `at fn (path:L:C)` / `at path:L:C` (file:// URL or bare path), and
// CPython's `File "path", line N`. Only ABSOLUTE paths are read — V8 always prints them,
// CPython does for imported modules — and `[eval]`/`<stdin>` pseudo-files never qualify.
const FRAME_RE =
  /^[ \t]*(?:at\s+(?:[^\n(]*\()?(?:file:\/\/)?(\/[^\s():]+):\d+(?::\d+)?\)?[ \t]*\{?$|File "(\/[^"]+)", line \d+)/gm;

/**
 * The failure is in THIS repo's source: a stack frame whose file sits under the project
 * directory and outside node_modules. Frame-shaped, not "a repo path:line anywhere": a
 * printed review note quoting `scripts/lib/x.js:45` is prose, and the measured population
 * had exactly that case.
 */
function hasRepoSourceFrame(response, projectDir) {
  if (!projectDir) return false;
  const root = projectDir.endsWith('/') ? projectDir : projectDir + '/';
  for (const m of String(response || '').matchAll(FRAME_RE)) {
    const p = m[1] || m[2];
    if (p.startsWith(root) && !p.includes('/node_modules/') && !p.includes('[eval')) return true;
  }
  return false;
}

/**
 * Should this error-recall firing stay silent?
 *
 * @param {{cmd: string, response: string, entries?: object[], ccSession?: string|null,
 *          exitZero: boolean, projectDir?: string}} opts
 *   `entries` are the current episode buffer's entries (they carry `tool`, `files`,
 *   `ccSession` and, for Bash, `writes`); `exitZero` is true on the PostToolUse path, where
 *   the host has routed every non-zero exit elsewhere.
 * @returns {{reason: 'tdd-red'|'data-print'}|null} null ⇒ fire as before.
 */
export function errorRecallSuppression({ cmd, response, entries, ccSession, exitZero, projectDir }) {
  const command = typeof cmd === 'string' ? cmd : '';
  if (!command) return null;
  if (isDeliberateRed({ cmd: command, response, entries, ccSession })) return { reason: 'tdd-red' };
  // Exit 0 only: an inline script that exits non-zero is a program that failed, and the
  // failure path (PostToolUseFailure) keeps it.
  if (exitZero && isDataPrintingCommand(command) && !hasRepoSourceFrame(response, projectDir))
    return { reason: 'data-print' };
  return null;
}
