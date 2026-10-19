---
name: mem
description: "Use when: querying past work, managing memories, or checking project history"
---

# Memory

Search and browse your project memory efficiently.

## Quick Commands

- `/mem search <query>` — Search all memories (FTS5 full-text search)
- `/mem recent [n]` — Show recent N observations (default 5)
- `/mem recall <file>` — History for a file before editing
- `/mem timeline <id>` — Browse timeline around an observation
- `/mem save <text>` — Save a manual memory/note
- `/mem stats` — Show memory statistics
- `/mem cleanup` — Scan and interactively purge stale data
- `/mem cleanup [N]d` — Purge stale data older than N days (e.g. `cleanup 60d`)
- `/mem cleanup keep [N]d` — Purge stale data but retain last N days (e.g. `cleanup keep 14d`)

## Instructions

When the user invokes `/mem`, parse their intent:

- `/mem search <query>` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" search <query>` via Bash
- `/mem recent` or `/mem recent 20` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" recent [N]` via Bash
- `/mem recall <file>` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" recall <file>` via Bash
- `/mem timeline <id>` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" timeline --anchor <id>` via Bash
- `/mem save <text>` → call `mem_save` MCP tool with the text as content
- `/mem stats` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" stats` via Bash
- `/mem get <ids>` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" get <ids>` via Bash
- `/mem cleanup` → run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain scan` via Bash and report the pending purge and stale counts to the user. Then run the purge command below without `--confirm` first: it prints how many rows it would delete and deletes nothing. If that count is 0, tell the user nothing is old enough to purge yet and stop. Otherwise report that count, not the scan's pending count, which includes rows too recent to purge. Ask for confirmation, and if confirmed run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" maintain execute --ops purge_stale --confirm` via Bash. **`--confirm` is required and is not optional politeness:** without it the command prints a dry-run PREVIEW and deletes nothing, while still succeeding — so you would report a cleanup that never happened.
- `/mem cleanup Nd` (e.g. `60d`) → same as above but add `--retain-days N` to both purge runs to only purge items older than N days. **`--retain-days` must be between 7 and 365**; the CLI rejects anything outside that range, so `/mem cleanup 3d` cannot be honoured — say so rather than silently substituting the default.
- `/mem cleanup keep Nd` (e.g. `keep 14d`) → same as above with `--retain-days N`, same 7–365 range.
- `/mem <query>` (no subcommand) → treat as search, run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" search <query>` via Bash

Use Bash commands first. For detailed data, use `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" get <id>` via Bash.
