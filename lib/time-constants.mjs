// lib/time-constants.mjs — millisecond time units, defined once.
//
// Four modules each carried their own `const DAY_MS` (deferred-work, metrics,
// err-sampler, hook-telemetry) with ~60 more bare 86400000 literals scattered
// across the runtime. The value cannot drift — that is not the problem. The
// problem is that a reader auditing a window ("is this 30 days or 30 hours?")
// had to re-derive the magic number at every site, and a grep for the policy
// returned a number rather than a name.
//
// Zero imports on purpose: lib/metrics.mjs and lib/err-sampler.mjs are sinks
// that must never crash or slow their callers, so anything they import has to
// stay a leaf.

// Kept internal rather than exported: only DAY_MS has runtime consumers today,
// and an export born with zero importers is how the knip baseline drifted
// 46→47 during v3.50–3.53 (DEFER_STALE_DAYS). Promote one when a caller needs it.
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export const DAY_MS = 24 * HOUR_MS;

/**
 * How long an `ep-flush-*` / `pending-*` runtime file must sit untouched before any
 * sweeper may treat it as an orphan rather than as work in flight.
 *
 * handleLLMEpisode's worst-case round-trip is ~60s (delay + LLM call + DB write), so 1h
 * is a wide safety margin. Anything older is a crashed worker or a pre-shutdown buffer
 * that no live caller will pick up.
 *
 * It lives HERE, in the zero-import leaf, because it now has two consumers that cannot
 * share a module: the automatic sweep in `hook-shared.mjs` (which re-exports it, so its
 * own importers are unchanged) and `install.mjs`'s manual `cleanup`, which may only
 * import from `lib/`. That split is exactly how the two drifted: `cleanup` deleted every
 * `ep-flush-*` with NO age gate at all, discarding a seconds-old in-flight episode while
 * printing "✓ Removed" — and `doctor` recommends running `cleanup`.
 */
export const ORPHAN_EPISODE_AGE_MS = HOUR_MS;

/**
 * PreToolUse recall's hard age cut: observations and events created longer ago than this
 * are never surfaced by file, whatever their later use. Set without a measurement, and it
 * first bites on 2026-11-04 on the maintainer DB (oldest live row 2026-09-05). Shared with
 * benchmark/cutoff-reach-probe.mjs, which counts the rows it removes, so the probe reads the
 * shipped window rather than a copy of it.
 */
export const PRETOOL_LOOKBACK_MS = 60 * DAY_MS;

/**
 * How long a connection waits for another writer before SQLITE_BUSY. ensureDb and the MCP
 * server set it on open; the two scoped overrides (search telemetry's rating wait and
 * refreshPlannerStats) put it back to this when the prior value cannot be read.
 */
export const DB_BUSY_TIMEOUT_MS = 5000;

/**
 * The same wait for the hook processes the host kills at a 5 s hooks.json timeout (user-prompt,
 * stop, post-tool-use, post-tool-failure, pre-compact). DB_BUSY_TIMEOUT_MS equalled that timeout,
 * so under a write lock held past 5 s (a long maintain / fts-check rebuild / import / restore)
 * the wait never failed inside the hook: the host killed it first, and UserPromptSubmit lost the
 * prompt and every line of context (E2E 2026-10-16 F9). 1.5 s leaves room for node startup and
 * a second blocked open (Stop's episode flush, then its own writes) inside the 5 s. Background
 * workers and the CLI keep DB_BUSY_TIMEOUT_MS: nothing kills them at 5 s.
 */
export const HOOK_DB_BUSY_TIMEOUT_MS = 1500;

/**
 * The same wait for scripts/user-prompt-search.js, whose hooks.json timeout is 2 s. Its only
 * writes are best-effort injection_count bumps, one statement per injected row, after its
 * output is written; each waited DB_BUSY_TIMEOUT_MS, so a held lock got it killed and its
 * injection discarded (F9). It stops bumping at the first lock wait that runs out.
 */
export const UPS_DB_BUSY_TIMEOUT_MS = 500;
