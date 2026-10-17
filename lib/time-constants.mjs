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
 * How long after its process started a hook the host kills at a 5 s hooks.json timeout
 * (user-prompt, stop, post-tool-use, post-tool-failure, pre-compact) may still wait for another
 * writer. Every statement on a connection the hook opens, ensureDb's own included, waits at most
 * the time left until this deadline (setHookDbDeadline, schema.mjs setBusyDeadline), so several
 * blocked opens (Stop's per-session episode flushes, then its own writes) share one budget instead
 * of each taking its own. DB_BUSY_TIMEOUT_MS equalled the host timeout, so under a lock held past
 * 5 s (a long maintain / fts-check rebuild / import / restore) the wait never failed inside the
 * hook and the host killed it with its output (E2E 2026-10-16 F9); a fixed 1.5 s per statement
 * then lost the writes a lock of 1.5–4.5 s had only delayed (pre-tag review 2026-10-16). 3.5 s
 * leaves 1.5 s for what runs after the wait. The price is a lock that ends between 3.5 s and the
 * host's kill: v6.27.0 waited it out and wrote late, this drops the write and exits (round-2
 * review: under a 4.0 / 4.5 s lock v6.27.0 stored the prompt row at 4117 / 4620 ms, this does
 * not); a lock v6.27.0 could not wait out got it killed with its output.
 * Background workers and the CLI keep DB_BUSY_TIMEOUT_MS: nothing kills them.
 */
export const HOOK_DB_DEADLINE_MS = 3500;

/**
 * How long the MCP server keeps retrying a startup open that another writer's lock made fail
 * (an attempt's migration waits up to DB_BUSY_TIMEOUT_MS for the lock), instead of exiting 1 for
 * the session. The last attempt starts before this has passed, so its migration's wait ends by
 * 20 s, inside Claude Code's 30 s MCP startup timeout (MCP_TIMEOUT,
 * code.claude.com/docs/en/env-vars, read 2026-10-17); a pending one-shot cleanup may wait as long
 * again, and the open's own work comes on top. Only an open that has to write waits for the lock
 * (the events backfill takes it per batch but never waits), chiefly the first one after an update:
 * round-3 pre-tag review, another process migrating the same store got the server "FATAL:
 * Database cannot be opened: database is locked" after 5.1 s.
 */
export const SERVER_OPEN_BUSY_RETRY_MS = 15000;

/** The same deadline for SessionStart, whose hooks.json timeout is 15 s. */
export const SESSION_START_DB_DEADLINE_MS = 11000;

/**
 * The same wait for scripts/user-prompt-search.js, whose hooks.json timeout is 2 s. Its only
 * writes are best-effort injection_count bumps, one statement per injected row, after its
 * output is written; each waited DB_BUSY_TIMEOUT_MS, so a held lock got it killed and its
 * injection discarded (F9). It stops bumping at the first lock wait that runs out.
 */
export const UPS_DB_BUSY_TIMEOUT_MS = 500;

/**
 * HOOK_DB_DEADLINE_MS for scripts/user-prompt-search.js (2 s in hooks.json): every statement it
 * runs, ensureDb's first-open migration included, waits at most the time left until 1.5 s after
 * the process started. Without it that migration waited DB_BUSY_TIMEOUT_MS under another
 * writer's lock and the host killed the prompt search at 2 s (D#394 follow-up).
 */
export const UPS_DB_DEADLINE_MS = 1500;
