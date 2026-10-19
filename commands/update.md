---
name: update
description: "Use when: search results seem noisy or for periodic memory maintenance"
disable-model-invocation: true
---

# Memory Maintenance

Run intelligent maintenance on the memory database.

## Usage

- `/claude-mem-lite:update` — Run full maintenance cycle

## Instructions

When the user invokes `/claude-mem-lite:update`, perform the following maintenance cycle:

### Phase 1: Memory Maintenance

Run each command below via Bash; the CLI reaches the maintenance operations whether or not their MCP tools are in your tool list.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain scan` to analyze maintenance candidates
2. Report scan results to the user (duplicates, stale items, broken items, boostable items, **pending purge** items)
3. **If pending purge items > 0**: first run the purge command below without `--confirm`: it prints how many rows it would delete and deletes nothing. Report that count to the user and ask for confirmation. If confirmed, run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute --ops purge_stale --confirm`. **`--confirm` is required:** without it the command prints a dry-run preview and deletes nothing while still succeeding, so you would report a purge that never happened. User may optionally add `--retain-days N` (default 30, allowed range 7–365) to both runs to control how many days of data to keep; the CLI rejects a value outside that range, so tell the user instead of substituting the default. Do NOT purge without explicit user confirmation. The purge comes before the next step on purpose: decay there queues more rows for purge, and those wait for a later run, so what gets deleted is what the user approved.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute` to apply safe automatic changes — with no `--ops` it runs the default set: cleanup, decay, boost, then demote_pinned (left out when `CLAUDE_MEM_SKIP_DEMOTE_PINNED=1`)
5. If duplicates were found in scan: for pairs similar enough to merge without review the scan prints a ready-to-run command after `Ready-to-use:`; run it as printed. A **Needs review** pair is shown only as ids and titles cut to 40 characters, which two different memories can share, so first read both with `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" get <idA>,<idB>`. Merge a pair only when both record the same thing, keeping the more important or more recent one, with `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute --ops dedup --merge-ids keepId:removeId,...` — groups are comma-separated and the first id in each is kept (`10:11,20:21:22`). Leave a pair that differs
6. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" compress --execute` for old low-value observations (without `--execute` it only previews)

### Phase 2: Summary

Summarize all maintenance actions taken in the user's language:
- Memory: observations cleaned, decayed, boosted, demoted, deduplicated, compressed
- Overall health assessment
