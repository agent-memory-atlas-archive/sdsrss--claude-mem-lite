---
name: verify
description: "Use when: the user explicitly asks to verify, audit or correct their stored memories against the current code (e.g. \"check my memories for stale ones\", /mem:verify). You check each memory with read-only repo tools and propose corrections; nothing is written until the user approves. Not for routine recall or saving."
---

# /mem:verify — check memories against the code, then correct the stale ones

Memories go stale: a bug recorded as open gets fixed, a measurement gets retracted, a
mechanism is replaced. Measured on 118 live memories across 7 repos, ~10% were STALE and
~14% PARTIAL, and most went stale within a day of being saved. No automatic pass catches
this — cheap single-shot models misjudged it (precision 0.36) and model-written corrections
were false 40% of the time. What works is YOU reading the code: you propose, the user
approves, and `verify-apply` is the only thing that writes.

## Arguments

- `--from <YYYY-MM-DD>`: only memories saved on or after this date (default: all live).
- `--ids 12,34`: only these memories.
- `--project <name>`: a project other than the current one.

## Step 1 — Select

```bash
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs export --project <project> [--from <date>] > <scratch>/memories.json
```

Every row carries `id`, `type`, `title`, `narrative`, `facts`, `lesson_learned`,
`files_modified`, `created_at`. With `--ids`, filter that file to those ids. Tell the user
how many memories you are about to check.

## Step 2 — Verify (read-only)

For EACH memory, answer: *if this memory were shown to an agent working in this repo today,
would anything it asserts mislead that agent?*

1. List its concrete, checkable claims: identifiers, file paths, `file:line` references,
   constants, counts, behaviours, "X is still broken", "Y was measured at Z".
2. Check each against the current tree (Grep, Read) and, where useful, the history since
   `created_at` (`git log --since=<created_at> -- <files>`, `git log -S<token>`, `git show`).
3. Pick one verdict:
   - **VALID** — every checkable claim still holds.
   - **STALE** — at least one specific claim is contradicted by the tree or history: a
     renamed/removed symbol, a changed value or default, a changed behaviour, a bug presented
     as open that has since been fixed, a count that moved, a measurement later retracted.
   - **PARTIAL** — the main point holds; a secondary detail (a line number, a count, a minor
     mechanism) is out of date.
   - **UNVERIFIABLE** / **NO_CODE_CLAIM** — leave these alone.

Rules that the measurement showed matter:
- A file having changed is NOT a contradiction. You need a line, a diff hunk or a commit that
  contradicts a specific claim.
- A record of what happened (what was measured then, what a review found) stays true as
  history. It is stale only if it would mislead about the PRESENT.
- A note that already records its own fix is not stale because the fix commit landed later.
- Do not write, stash, check out or run tests while verifying.

More than ~25 memories: split them into batches and give each batch to a read-only subagent
with the rubric above; have each subagent write its results to a file with a bash heredoc and
reply with only the path. Treat a subagent's verdict as a lead: before proposing anything,
re-open every cited `file:line` and commit yourself.

## Step 3 — Draft proposals (STALE and PARTIAL only)

Write `<scratch>/proposals.json` — a JSON array, one entry per memory to change:

```json
[
  { "id": 52, "action": "replace", "verdict": "STALE",
    "title": "...", "narrative": "...", "lesson_learned": "...",
    "evidence": "7bc8ba9; hook-optimize.mjs:1371-1383" },
  { "id": 64, "action": "edit", "verdict": "PARTIAL",
    "set": { "narrative": "..." }, "evidence": "hook-llm.mjs:1359-1361" },
  { "id": 201, "action": "retire", "verdict": "STALE", "evidence": "600c744" }
]
```

- **edit** — the stale part is one detail. `set` may hold `title`, `narrative`,
  `lesson_learned`, `importance`, `concepts`; copy the original text and change only the
  stale words.
- **replace** — the memory's claim is wrong but its lesson is still worth keeping. Write the
  corrected memory; omitted fields are copied from the original, which stays as history.
- **retire** — nothing in it is worth keeping (e.g. a mid-debug note about a failure fixed
  minutes later).
- `evidence` is required: the commit or `file:line` that shows the memory is out of date.
- `lesson_learned` is at most 500 characters. Keep the memory's language.

## Step 4 — Show the plan

```bash
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs verify-apply <scratch>/proposals.json
```

This is a dry run: it validates every entry against the database and writes nothing. Show the
user one line per proposal (id, verdict, what changes, evidence) and the counts of
VALID / STALE / PARTIAL you found. Ask for approval. If the dry run refuses an entry, fix the
proposal — never work around it with `update`, `save` or `delete`.

## Step 5 — Apply, only after the user approves

```bash
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs verify-apply <scratch>/proposals.json --apply
```

It backs up every target row, applies all entries in one transaction (all or nothing), reads
each row back and prints `ok` or `MISMATCH`, then prints the undo command
(`verify-apply --undo <backup>`). Report the read-back result and the undo command to the
user verbatim. A non-zero exit means something did not land — say so; do not retry blindly.
