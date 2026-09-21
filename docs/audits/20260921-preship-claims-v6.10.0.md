# CLAIMS audit — converge/20260921-handoff-payload (0e31b3d..3d31dcf, 9 commits)

Anchor: `git -C /home/ai/dev/claude-mem-lite rev-parse HEAD` → `3d31dcfe1ff28073a6bda98d29b2241aae9b93f6` ✓

Method notes:
- Live DB opened `{readonly:true}` only. No writes to `/home/ai/dev/claude-mem-lite` (verified
  `git status --porcelain` = 0 lines before and after every run).
- Test/mutation runs were done in **my own** trees, not the lead's extraction: the lead's
  `/tmp/preship-q9Wa3x` is being mutated concurrently (during this audit `probe-isvalid.mjs`,
  `probe-paused2.mjs` and a `dbcopy/` dir appeared at its repo root and
  `tests/zzprobe-defect.test.mjs` disappeared). **Two untracked `.mjs` at the repo root inflate
  the suite headline there** — `tests/obs-id-caliber-sync.test.mjs` emits one case per root
  `.mjs`/`.js`. Any full-suite count measured in that tree is +2 cases.
- Suite headlines were taken from pristine `git archive <sha> | tar -x` trees with
  `node_modules` symlinked.

Tally: **28 claims checked · 7 FALSE · 21 VERIFIED** (2 of the 7 are wrong *mechanisms* behind
true observations; 2 more are stale/mis-cited text rather than measurement error).

---

## 1. Observation namespace split — VERIFIED (with stamped drift)

Claim: "101 of 105 observations sit in the `manual-` namespace (all 101 at importance >= 2);
4 sit in `hook-`, spread over 3 ids."

```
$ node <readonly better-sqlite3 script>
--- total observations --- 107
{"ns":"manual-","c":103,"ids":8,"imp_ge2":103}
{"ns":"hook-","c":4,"ids":3,"imp_ge2":2}
hook-dev--claude-mem-lite-0a67644b  1
hook-dev--code-graph-mcp-e3f18223   2
hook-dev--daagu-e9d2e6a9            1
```

Now 103 of 107 (all 103 at importance >= 2); `hook-` is still **4 rows over exactly 3 ids**.
The corpus grew by 2 `manual-` rows since the 2026-09-21 stamp — expected (doctrine rule 2).
Structure and the load-bearing "disjoint prefixes" conclusion hold.

## 2. All stored handoff rows carry empty completed / key_decisions — VERIFIED (row count moved)

Claim: "all 17 stored handoff rows carry completed = 0 bytes and key_decisions = 0 bytes;
8 of 17 carry key_files = []".

```
{"n":16,"completed0":16,"kd0":16,"kf_empty":7,"kf0":0}
handoff rows span 2026-09-13T20:28Z .. 2026-09-21T19:16Z
```

**The row count HAS moved: 17 → 16, and 8 → 7.** Both halves moved by exactly one, consistent
with a single `key_files = []` row aging out of the GC window (rows only survive ~8 days).
The proportions are unchanged: 16/16 empty `completed`, 16/16 empty `key_decisions`, 7/16 `[]`
`key_files`. Claim stands as stamped; the code comment at `hook-handoff.mjs:262` ("8 of the 17
live handoff rows") is now a stale figure by one.

Scope worth naming: "all 17 rows" is an 8-day window, not the whole history — expired rows are
GC'd. It is not evidence that the sections were *always* empty, only that they are now.

## 3a. files_modified population — VERIFIED

Claim: "218 non-null files_modified entries; 59 (27%) are repo-root filenames".

```
rows with non-null files_modified: 107
TOTAL entries: 220
entries with NO separator (repo-root filenames): 59 (26.8%)
distinct no-separator values (25): Cargo.toml | mem-cli.mjs | server.mjs | hook-optimize.mjs |
  tfidf.mjs | CHANGELOG.md | package.json | CLAUDE.md | deep-search.mjs | hook-llm.mjs |
  hook.mjs | search-engine.mjs | cli.mjs | install.mjs | hook-context.mjs | schema.mjs |
  bash-utils.mjs | claudemd.mjs | adopt-cli.mjs | search-scoring.mjs | RELEASING.md |
  install.js | uninstall.js | cli.js | README.md
```

218 → 220 entries (the 2 new observations), 59 unchanged, 26.8% ≈ the stated 27%. All 25
distinct values are genuine repo-root source filenames. This half of the measurement is sound.

## 3b. "3 are extensionless slash-bearing values, i.e. project directories … visible in a real injection as `Key Files: claude-mem-lite`" — **FALSE (mechanism)**

The three values are real, but they are not what the commit says they are, and they are **not**
the source of the artifact the commit attributes to them.

```
all distinct slash-bearing entries whose basename has no dot:
["claude-plugin/bin/code-graph-mcp","/var/tmp/pr44-split","/var/tmp/review49"]

does any files_modified entry equal /home/ai/dev/<project>?
[]                                    <-- ZERO, across all 107 rows
```

Three separate problems:

1. **"i.e. project directories" is wrong for at least one of the three.**
   `claude-plugin/bin/code-graph-mcp` is an extensionless **executable file**, not a directory.
   It is in fact an instance of the *named cost* the same commit accepts ("an extensionless FILE
   (Makefile, LICENSE) no longer reaches key_files") — counted here as evidence for the defect it
   is actually a cost of. The other two are `/var/tmp` scratch dirs, not project directories.

2. **The quoted real artifact cannot have come from this population.** No entry in
   `observations.files_modified` equals a project directory. But the live handoff rows do carry
   them:
   ```
   2026-09-21T19:16:19Z dev--claude-mem-lite/exit: ["/home/ai/dev/claude-mem-lite"]
   2026-09-21T19:16:57Z dev--loop-testing/exit:    ["/home/ai/dev/loop-testing"]
   2026-09-14T21:33:21Z dev--code-graph-mcp/exit:  ["/home/ai/dev/code-graph-mcp"]
   ```

3. **The real source is the other input, which the measurement never covered.** `key_files` is
   built from TWO sources (`hook-handoff.mjs:260` and `:263`): `episodeSnapshot.files` — read from
   the on-disk episode buffer by `readEpisodeRaw()`, not from the DB — and `observations.files_modified`.
   The buffer is where the directories live:
   ```
   $ node -e "read /home/ai/.claude-mem-lite/runtime/ep-dev--loop-testing.json"
   ep-dev--loop-testing.json files=1 projectDirEntries=["/home/ai/dev/loop-testing"]
   ```
   which is byte-for-byte the `key_files` of the `dev--loop-testing/exit` row above.

The FIX is unaffected — `isValidFile` gates both sources, so the new basename-extension predicate
covers the episode arm too. What is false is the stated population and the causal bridge: the
directory half of the defect is evidenced by nothing in the 218/220-entry measurement, and the
commit's population line ("population = all 218 non-null files_modified entries") reads as if it
covers both halves when it covers one.

## 4. 35 of 35 Key Decisions lines byte-identical to a Completed line, 8 projects, 100% — VERIFIED exactly

Re-derived with the real predicates (`liveObsFilterSql('')` from `lib/inject-search-core.mjs`,
`LOW_SIGNAL_TITLE` from `utils.mjs`, the real LIMIT 15 / LIMIT 10 / `.slice(0,5)` and the real
`[type] title` storage format), not an approximation:

```
liveObsFilterSql("") = COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
projects with observations: 8
 dev--claude-mem-lite:  completed=15 decisions=5 byteIdenticalDup=5 keptAfterDedup=10
 dev--code-graph-mcp:   completed=15 decisions=5 byteIdenticalDup=5 keptAfterDedup=10
 dev--gsd-lite:         completed=14 decisions=5 byteIdenticalDup=5 keptAfterDedup=9
 dev--loop_eng:         completed=12 decisions=5 byteIdenticalDup=5 keptAfterDedup=7
 dev--claudemd:         completed=8  decisions=5 byteIdenticalDup=5 keptAfterDedup=3
 dev--loop-testing:     completed=7  decisions=5 byteIdenticalDup=5 keptAfterDedup=2
 dev--daagu:            completed=4  decisions=4 byteIdenticalDup=4 keptAfterDedup=0
 scratchpad--loop-smoke:completed=1  decisions=1 byteIdenticalDup=1 keptAfterDedup=0
TOTAL: decision lines=35, byte-identical=35 (100.0%)
```

35 of 35, 8 projects, 100%. Exact reproduction.

## 4b. "three of the eight measured projects have a session whose whole history is its decisions" — **FALSE**

Same run, last column:

```
projects where Completed would render EMPTY after dedup: 2 of 8
   (dev--daagu, scratchpad--loop-smoke)
```

Reconstructed at the 105-observation state the commit was stamped against, it is still 2:

```
obs=107 projects=8 decisionLines=35 dup=35 projectsWithEmptyCompletedAfterDedup=2
obs=105 projects=8 decisionLines=34 dup=34 projectsWithEmptyCompletedAfterDedup=2
```

Measured **2 of 8**, not three, at both corpus sizes. The next-closest project keeps 2 lines
(`dev--loop-testing`), so no rounding or definitional slack gets to three. This number appears
twice — commit body of `4e07134` and the code comment at `hook-handoff.mjs:770-771` — and is the
stated justification for omitting the `## Completed` header entirely. The BEHAVIOUR is still
warranted (2 projects do hit it, and `handoff-section-overlap.test.mjs` covers it); only the count
is wrong.

## 5. session_summaries.next_steps non-empty in 11 of 310 rows (3.5%) — VERIFIED exactly

```
when total=287: nonempty=11 (3.8%)
when total=305: nonempty=11 (3.6%)
when total=310: nonempty=11 (3.5%)     <-- exact match, at 2026-09-21T18:20Z
when total=311: nonempty=12 (3.9%)
final total=315 nonempty=15 (4.8%)
```

At the moment the table held 310 rows the reading was exactly 11 / 3.5%. Denominator and
numerator coexisted; the figure is not a cross-time diff.

Caveat worth carrying, because the number is used as a *justification* ("that route has already
been measured and does not work"): **the rate is moving.** All four rows added after the
measurement (`dev--daagu`, 18:23–18:47 today) carry non-empty `next_steps`. The lifetime rate is
3.5%; the rate over the last seven summaries is 4/7. The conclusion may still hold, but "already
measured and does not work" now rests on a lifetime average that the current regime contradicts.

## 6a. "18 paused files across 9 projects on this machine" — **FALSE**

```
$ find /home/ai -maxdepth 6 -name '*-paused.md' -not -path '/home/ai/.claude/*' \
      -not -path '*/node_modules/*' -not -path '/home/ai/.cache/*' | sed 's#/tasks/.*##' | sort | uniq -c
     15 /home/ai/dev/claude-mem-lite
      4 /home/ai/dev/daagu
      2 /home/ai/dev/moa-skill
      2 /home/ai/dev/code-graph-mcp
      2 /home/ai/dev/claudemd
      1 /home/ai/dev/loop_eng
      1 /home/ai/dev/loop-testing
=== total === 27
```

**27 files across 7 projects**, not 18 across 9. Neither half reproduces, and drift cannot
explain it: the newest paused note on the machine is `2026-09-21 16:44`, while the earliest
commit in this branch is `2026-09-21 18:27:36`. Every one of the 27 already existed when the
measurement was taken. Running the shipped reader over each project root confirms the population:

```
/home/ai/dev/claude-mem-lite: 15 file(s) -> note items=1 file=tasks/session-end-b3c0c20d-paused.md
/home/ai/dev/claudemd:         2 file(s) -> note items=1
/home/ai/dev/code-graph-mcp:   2 file(s) -> note items=1
/home/ai/dev/daagu:            4 file(s) -> note items=1
/home/ai/dev/loop-testing:     1 file(s) -> note items=1
/home/ai/dev/loop_eng:         1 file(s) -> note items=1
/home/ai/dev/moa-skill:        2 file(s) -> note items=1
TOTAL paused files=27, projects with >=1 file=7, projects yielding a parsed note=7
```

I could not construct any reading (per-project newest only = 7; notes that parse = 7; last 10
days = 12 files / 6 projects) that yields 18/9. The number appears in both the `aa0f0b3` commit
body and the `lib/paused-reader.mjs` header comment.

The claim understates the case it is making, so the argument survives — but it is an unreproducible
number in a shipped file.

## 6b. "zero readers" — VERIFIED

```
$ git grep -i "paused" 0e31b3d -- '*.mjs'
0e31b3d:eslint.config.mjs:75:    // `tasks/**` is gitignored scratch (specs, plans, paused-task notes) …
$ git grep -l -- "-paused.md" 0e31b3d        # all tracked files, every extension
(no output)
```

One comment in an eslint config; no reader anywhere in the tree. I also checked the two adjacent
readers that could plausibly have surfaced them already: `lib/plan-reader.mjs` globs
`~/.claude/plans/`, and `lib/task-reader.mjs` reads `~/.claude/tasks/` — neither touches the
project's `tasks/` dir. "Nothing delivers the paused note" holds within this system.

## 7a. "12 open deferred_work rows" — VERIFIED

```
dev--claude-mem-lite: 10 open
dev--code-graph-mcp:   2 open
total open = 12
```

## 7b. "…and the dashboard lists them" — **FALSE (mechanism, and materially)**

```
$ grep -n "deferred_work\|deferred" lib/startup-dashboard.mjs
(no output)
```

`lib/startup-dashboard.mjs` — the module that *is* the dashboard, and whose sections are
`📊 Git`, `📋 Active tasks`, `📝 Recent plans`, the continuation pointer, `💡 mem events` and the
adopt hint — contains no reference to `deferred_work` at all. The delivery is in a different
surface: `hook-context.mjs:798-820`, the `### Deferred Work` block inside `<claude-mem-context>`.

That surface is also **not** "lists them":

```sql
-- hook-context.mjs:798
FROM deferred_work WHERE project = ? AND status = 'open'
ORDER BY priority DESC, created_at_epoch ASC
LIMIT 5
```

Project-scoped, capped at 5. For `dev--claude-mem-lite` — the project this branch is being written
in — **10 rows are open and 5 are rendered**. So 5 of the measured 12 are delivered by nothing.

This matters because the sentence is load-bearing: it is the stated reason `deferred_work` was
*excluded* as a `next_steps` source ("adding them here would double-inject"). For the half that
falls past the LIMIT there is no double-injection to avoid. The decision may still be right on
other grounds — the paused note is hand-written and deferred rows are a queue — but the reason
given is not true as written.

## 8a. UNCONSUMED_HANDOFF_SQL matrix, "8 of 12 killed, then 12 of 12" — VERIFIED exactly

Re-ran the whole matrix myself in a private copy: replace ONE interpolation site with `1=1`,
assert the file changed by sha, run `tests/handoff-consume.test.mjs` under vitest (the final
harness, not a standalone probe), restore, re-compare sha.

At HEAD (16 cases):
```
sites found: 12
#0 hook-handoff.mjs:462 -> RED(killed) failed=1 restore=byte-identical
#1 hook-handoff.mjs:471 -> RED(killed) failed=1 restore=byte-identical
#2 hook-handoff.mjs:497 -> RED(killed) failed=2 restore=byte-identical
#3 hook-handoff.mjs:506 -> RED(killed) failed=1 restore=byte-identical
#4 hook-handoff.mjs:547 -> RED(killed) failed=1 restore=byte-identical
#5 hook-handoff.mjs:556 -> RED(killed) failed=1 restore=byte-identical
#6 hook-handoff.mjs:611 -> RED(killed) failed=1 restore=byte-identical
#7 hook-handoff.mjs:620 -> RED(killed) failed=1 restore=byte-identical
#8 hook-handoff.mjs:657 -> RED(killed) failed=1 restore=byte-identical
#9 hook-context.mjs:756 -> RED(killed) failed=1 restore=byte-identical
#10 hook-context.mjs:766 -> RED(killed) failed=1 restore=byte-identical
#11 lib/startup-dashboard.mjs:35 -> RED(killed) failed=1 restore=byte-identical
MATRIX: 12 of 12 killed; surviving: none
```

With `tests/handoff-consume.test.mjs` swapped back to its `eac4fb0` content (12 cases, baselined
green at 12/12 first):
```
#0 hook-handoff.mjs:462 -> GREEN(survived)
#3 hook-handoff.mjs:506 -> GREEN(survived)
#4 hook-handoff.mjs:547 -> GREEN(survived)
#8 hook-handoff.mjs:657 -> GREEN(survived)
MATRIX: 8 of 12 killed; surviving: hook-handoff.mjs:462, :506, :547, :657
```

Not just the counts — **the same four indices**, and the labels check out against the source:
`:462` is the Stage -1 **scoped** arm, `:506` the Stage 0 **unscoped** arm, `:547` the Stage 2
**scoped** arm, `:657` `consumeHandoff`'s own UPDATE race guard. Exactly the four named in the
commit. The site inventory also matches the prose: 9 in `hook-handoff.mjs`
(pickHandoffToInject ×2, Stage -1 ×2, Stage 0 ×2, Stage 2 ×2, consumeHandoff ×1), 2 in
`hook-context.mjs`, 1 in `lib/startup-dashboard.mjs` = 12, i.e. "eleven read sites" + the UPDATE.

## 8b. Dedup matrix, "4 of 4 killed" — VERIFIED exactly

Four arms against `tests/handoff-section-overlap.test.mjs`:
```
ARM "drop the dedup filter":              RED(4 failed / 2 passed) restore=byte-identical
ARM "drop the stored type prefix":        RED(1 failed / 5 passed) restore=byte-identical
ARM "always emit the Completed header":   RED(1 failed / 5 passed) restore=byte-identical
ARM "titleOf made identity":              RED(1 failed / 5 passed) restore=byte-identical
DEDUP MATRIX: 4 of 4 killed
```
Per-arm failure counts match the commit's RED(4)/RED(1)/RED(1)/RED(1) exactly.

## 9. key_decisions readers — VERIFIED (both halves)

"The only production reader of `session_handoffs.key_decisions` is this file's own renderer":
sweeping non-test `.mjs` for `key_decisions` and for `FROM session_handoffs` leaves exactly one
reader — `hook-handoff.mjs:755` in `renderHandoffFromRow`. Everything else is DDL/migration
(`schema.mjs`), the writer (`hook-handoff.mjs:380`), or a scrub-field allowlist
(`lib/scrub-record.mjs:48,64`). The only other module that reads a column of that name,
`hook-context.mjs:880`, reads it from `session_summaries` (`hook-context.mjs:609`).

"session_summaries.key_decisions is a different column, a JSON array from Haiku": confirmed —
`hook-llm.mjs:1425` asks Haiku for `"key_decisions":["important design choices made and WHY"]`
and `:1481` persists `JSON.stringify(llmParsed.key_decisions)`.

## 10. Test counts — VERIFIED (per-file and full-suite)

Per-file at HEAD:
```
handoff-payload-reach     -> 7 passed (7)
handoff-consume           -> 16 passed (16)
handoff-tree-state        -> 8 passed (8)
handoff-key-files         -> 5 passed (5)
paused-reader             -> 11 passed (11)
handoff-next-steps        -> 4 passed (4)
handoff-heading-collision -> 3 passed (3)
handoff-section-overlap   -> 6 passed (6)
```
Every per-commit figure lands: `0633227` 7/7; `eac4fb0` 12/12 (verified by running that commit's
own test file: `Tests 12 passed (12)`) then `5d231ff` 16/16; `91b1df8` 8/8; `1feb8a6` 5/5;
`aa0f0b3` 10/10 + 4/4 then `3d31dcf` 11/11 (+1 case, confirmed in the diff) and 11+4 = 15/15.

I checked specifically for the "count quoted before a later edit changed it" failure: `aa0f0b3`
touched `tests/handoff-payload-reach.test.mjs` (+1 line) after `0633227` quoted 7/7 — it is still
7/7 at HEAD. All eight files are green at HEAD.

Full suite, on pristine `git archive` trees:
```
0e31b3d (branch base): Test Files 407   Tests 6362
91b1df8 (mid-branch):  Test Files 410   Tests 6393
3d31dcf (HEAD):        Test Files 415   Tests 6423
```

**"410 → 415 files / 6393 → 6423 tests" reproduces exactly** — but note it is a *mid-branch* to
HEAD delta (the 410/6393 endpoint is `91b1df8`, after four of the nine commits), not what the
branch adds. Branch-wide the delta is 407 → 415 files (+8) and 6362 → 6423 tests (+61). If the
figure is ever restated as "what this branch adds", it understates by 3 files / 30 tests.

Each archive run shows the same 2 failures, and both are artifacts of extracting without a
`.git` dir — `tests/pre-commit-hook-sync.test.mjs` (`git ls-files` returns `''`) and
`tests/suite-touches-no-repo-files.test.mjs` (install's dogfood auto-adopt branch). Both pass in
the primary working tree:
```
$ npx vitest run tests/pre-commit-hook-sync.test.mjs tests/suite-touches-no-repo-files.test.mjs
 Test Files  2 passed (2)    Tests  7 passed (7)
$ git -C /home/ai/dev/claude-mem-lite status --porcelain | wc -l
0
```

## 11. "knip unchanged at 32 unused exports, and the new import edge is not flagged" — VERIFIED

```
HEAD (3d31dcf):  Unused exports (32)
base (0e31b3d):  Unused exports (32) · Unlisted binaries (3)
```
Grepping the HEAD report for `paused-reader`, `format-utils` and `truncate` returns nothing — the
new `lib/paused-reader.mjs → format-utils.mjs` edge is not flagged. Caveat per CLAUDE.md: knip is
specified to be measured from the primary working tree; I measured from archive extractions with
symlinked `node_modules`, and both read 32, matching the CLAUDE.md baseline.

## 12. `85ce15c` pre-fix reading — VERIFIED exactly

Reconstructed the author's reading faithfully: `hook-handoff.mjs` @ `aa0f0b3` (the parent) +
`tests/handoff-heading-collision.test.mjs` @ `85ce15c`:
```
× strips markdown heading markers carried inside working_on
× strips them from completed, key_decisions and next_steps too
AssertionError: expected [ '\n## ', '\n# ', ' ## ' ] to have a length of 1 but got 3
AssertionError: expected [ '\n## ', '\n## ', ' ## ', …(5) ] to have a length of 4 but got 8
 Tests  2 failed | 1 passed (3)
```
"Pre-fix 2 failed / 1 passed, counting 3 markers where 1 was written and 8 where 4 were" — exact,
including which case passes both ways. Tree restored byte-identical (`diff -q` clean).

## 13. The quoted real injection in `85ce15c` — VERIFIED

The commit quotes a real `working_on` that carries `#` and `##` inline. It is in the live DB:
```
--- dev--code-graph-mcp/exit ---
# 自主端到端测试与修复循环  ## 角色与授权 你是本项目的 QA 工程师兼开发者：…  → 提交推送发版
rows whose working_on carries a markdown heading marker: 2 of 16
```
(The commit renders the tail as `→ 提交 推送 发版`; the stored text is `→ 提交推送发版`. Cosmetic.)

## 14-17. Supporting claims — VERIFIED

- **"every free-text field in the renderer goes through safeText (12 call sites)"** — 13 matches
  for `safeText(` in `hook-handoff.mjs`, one of which is the declaration at `:685`. 12 call sites.
- **paused-reader keeps its leaf property** — `format-utils.mjs` has exactly one import,
  `./lib/time-constants.mjs`, which has none. Verified, not assumed.
- **"Registered in BOTH source-files.mjs and package.json#files"** — `source-files.mjs:69` and
  `package.json:72`.
- **"An older build opening this DB keeps working"** — `CURRENT_SCHEMA_VERSION` is `49` at both
  `0e31b3d` and `3d31dcf` (the diff touches only comments around it), and all four new columns are
  `... DEFAULT NULL` additive. Nothing locks an older code home out.
- **"An unstubbed probe confirmed the leak by coming back with tasks/session-end-b3c0c20d-paused.md"**
  — running the shipped reader against `/home/ai/dev/claude-mem-lite` returns exactly
  `tasks/session-end-b3c0c20d-paused.md`.
- **"Dedup matches on the TITLE … rows written before the prefix shipped still dedup"** —
  `TYPE_PREFIX_RE = /^\[[^\]]{1,20}\]\s*/`, so a bare legacy title and a `[type] title` line
  normalise to the same key. Killed by the `titleOf made identity` mutation arm above.

## 18. "the overlap only became visible once the payload fix landed … before that both sections were empty" — VERIFIED for the measured population, with a scope caveat

All 16 live rows carry 0-byte `completed` and `key_decisions`, so the sections were empty on every
row that exists. Note it was not *structurally* impossible pre-fix — 4 observations do sit in the
`hook-` namespace that the old `memory_session_id = ?` join could reach — merely 4 of 107. And the
population is only the ~8-day GC window. As a statement about what anyone could have seen, it holds.

---

## FALSE claims not covered above

## 19. `lib/paused-reader.mjs` header: "the maintainer's real repo, which carries five `tasks/*-paused.md` files of its own" — **FALSE**

It carries **15**:
```
15 /home/ai/dev/claude-mem-lite
```
Shipped file, shipped comment. Same file as claim 6a, a second unreproducible count.

## 20. "project names have been renormalized in the past — schema.mjs:1127" — **FALSE (citation)**

```
$ sed -n '1122,1132p' schema.mjs
          } catch {
            // One unparseable row must not cost every row after it its edges …
            continue;
          }
          if (!Array.isArray(files)) continue;        <-- :1127
          for (const f of files) {
            if (typeof f === 'string' && f.length > 0) insertFile.run(row.id, f);
```
Line 1127 is inside the **observation_files backfill** migration. The project-renormalisation
migration is a different one:
```
1139:    name: 'normalize-project-names',
1182:          db.prepare(`UPDATE OR IGNORE ${table} SET project = ? WHERE project = ?`).run(
```
The underlying fact (project names were renormalised, so the `OR project = ?` arm needs the id side
kept) is TRUE and the migration exists. Only the pointer is wrong — it lands in the previous
migration. Appears in the `0633227` commit body and in the code comment at `hook-handoff.mjs:174-175`.

## 21. `hook.mjs:1978` comment — **FALSE (stale, falsified by this branch)**

```
// GC expired session_handoffs: the consume-DELETE (handleSessionStart) only removes
// the single handoff a continuation reads back; an 'exit'/'compact' that is never
// resumed (and every superseded 'clear') lingers forever …
```
`eac4fb0` is the commit that removed the consume-DELETE — it replaced
`db.prepare('DELETE FROM session_handoffs WHERE project = ? AND type = ? AND session_id = ?')`
with `consumeHandoff(db, picked)`, which stamps `consumed_at`. There is no consume-DELETE any more;
this comment describes the behaviour the branch withdrew, 900 lines from the call site that
changed. (It was also already imprecise about the caller: the consume happens in
`injectHandoffIfEarly`, the UserPromptSubmit path, not `handleSessionStart`.)

This is the repo's own recurring defect class — a retraction that swept the call site and left a
copy behind, in a comment that now explains the GC by a mechanism that no longer exists.

## 22. `hook-shared.mjs:387` — nit, not a finding

The `hook-<project>-<uuid8>` literal is at `:388`; `:387` is `const project = inferProject();`.
Off by one, inside the right function. Cited correctly elsewhere: `lib/save-observation.mjs:200`
(exact), `bash-utils.mjs:463` and `:472` (exact), `mem-cli.mjs:199` (exact).

---

## Housekeeping observed, not a claim

- `/tmp/preship-q9Wa3x` has untracked `probe-isvalid.mjs` and `probe-paused2.mjs` at its repo root
  and a `dbcopy/` dir. Repo-root `.mjs` files are counted by `tests/obs-id-caliber-sync.test.mjs`,
  so a full-suite headline taken there reads 2 cases high. `tests/zzprobe-defect.test.mjs` was
  present in that tree at 19:22 and gone by 19:26 — something is editing it concurrently.
  Nothing of mine is in `/home/ai/dev/claude-mem-lite` (`git status --porcelain` = 0 throughout).
- Residue under `~/.claude` after my full-suite runs: `backups/` and `.claudemd-state/` mtimes
  moved (this session's own plugin hooks). `~/.claude/settings.json` unchanged — same size 4874,
  same mtime `2026-09-21 13:06:16`.
