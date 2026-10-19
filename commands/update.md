---
name: update
description: "Use when: search results seem noisy or for periodic memory maintenance"
---

# Memory Maintenance

Run intelligent maintenance on the memory database.

## Usage

- `/claude-mem-lite:update` — Run full maintenance cycle

## Instructions

When the user invokes `/claude-mem-lite:update`, perform the following maintenance cycle:

### Phase 1: Memory Maintenance

Run each command below via Bash. The maintenance tools are not in your tool list; the CLI is how you reach them.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain scan` to analyze maintenance candidates
2. Report scan results to the user (duplicates, stale items, broken items, boostable items, **pending purge** items)
3. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute` to apply safe automatic changes — with no `--ops` it runs the default set: cleanup, decay, boost, then demote_pinned
4. If duplicates were found in scan, review them and run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute --ops dedup --merge-ids keepId:removeId,...` — keep the more important/recent observation in each pair. Groups are comma-separated and the first id in each is kept (`10:11,20:21:22`); the scan prints ready-made groups for the pairs it can merge on its own
5. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" compress --execute` for old low-value observations (without `--execute` it only previews)
6. **If pending purge items > 0**: Report the count to the user and ask for confirmation. If confirmed, run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute --ops purge_stale --confirm`. **`--confirm` is required:** without it the command prints a dry-run preview and deletes nothing while still succeeding, so you would report a purge that never happened. User may optionally add `--retain-days N` (default 30, allowed range 7–365) to control how many days of data to keep; the CLI rejects a value outside that range, so tell the user instead of substituting the default. Do NOT purge without explicit user confirmation.

### Phase 2: Summary

Summarize all maintenance actions taken in zh-CN:
- Memory: observations cleaned, decayed, boosted, demoted, deduplicated, compressed
- Overall health assessment
