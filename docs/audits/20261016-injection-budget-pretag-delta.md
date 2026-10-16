# Pre-ship DELTA review — `feat/injection-budget` repair commits 1ca93d69..b19b2c1a (3715e464, b19b2c1a)

Reviewer did not write the change. Detached worktrees: `~/.cache/ib-review-delta` (b19b2c1a), `-old` (1ca93d69),
`-main` (92fdfad6), all removed at the end. Every hook/CLI/ruler run used a sandbox HOME + CLAUDE_MEM_DIR under
`~/.cache/ib-delta-sbx`, MEM_NO_AUTO_ADOPT=1, CLAUDE_CONFIG_DIR unset (sandbox deleted). Frozen corpus read-only.
Node v26.8.1, 2026-10-16.

## Verdict

**No P1, no P2. Ship-able; 7 P3s (text and ruler robustness, none changes a published number or a behaviour).**

Every repair fixes its finding, and each one is verified behaviourally against the pre-repair tree:
- The C4 cut now keeps the project's own rows: 0 → 2 own rows on the thin fixture, and 0/10 → 10/10 on the 5 corpus tables.
  The fix covers the hook, the CLI `context` command and PreCompact.
- The two switches restore main's output exactly, apart from the documented current-session exclusion.
- SessionStart clears the marker on every source except `resume`.
- The widened id check says NO on every face when that face is emptied.
- The ruler no longer creates a runtime dir (checked as an A/B against the pre-repair tree).

Nothing the earlier reviews confirmed has regressed:
- The identity check passes on 1,923 blocks.
- The headline still reads 18.57 → 12.66 KB/session.
- citation-live-replay `--json` is byte-identical on the frozen root, the stored projected root and a freshly regenerated
  one.
- The full suite passes: **496 files / 8,614 tests**, exit 0.

## Severity table

| ID | Sev | Finding | Where |
|----|-----|---------|-------|
| P3-1 | P3 | The retraction sweep is incomplete. Prose still states the corrected or superseded claims: the after doc says the marker is cleared only on `source: compact`; lib comments say "SessionStart(compact) clears"; the test header comments repeat the claims-review P2-3 wording ("same text on every recall block") and its P3-1 wording ("1 an earlier prompt of the same session"); the C4 test header says "newest 5 rows / keeps the newest picks"; and the withFallbackTopUp docblock still says "At the uncapped table site this only adds" next to the appended "has been capped" sentence. | `docs/audits/20261016-injection-budget-after.md:18`; `lib/recall-shown.mjs:16-17,39`; `tests/recall-shown.test.mjs:3,6,101`; `tests/ups-past-question-echo.test.mjs:5`; `tests/hook-context.test.mjs:1276,1280`; `hook-context.mjs:537` |
| P3-2 | P3 | "7–13 rows per session, mean 9.4" counts per SessionStart TABLE (565 rows / 60 tables), not per session. Per session the range is 7–34 and the mean 10.87 (565/52). | `README.md:1144`, `lib/recent-table.mjs:4`, commit 3715e464 |
| P3-3 | P3 | Two ruler branches added by the repairs are pinned by no test. Mutation R7 (drop the `hook_blocking_error` branch, so 25.24 reads 25.02 again) and R8 (`projectSessionStart` cuts newest-first again, reproducing the P2-1 eviction in the after-arm) both leave `tests/injection-budget.test.mjs` at 22/22 green. The new "past questions do not count" assertion does not depend on the exclusion set: with `NOT_MEMORY_ROWS` emptied (R6) it stays green, because `P#9` never matches `MEMORY_ID_RE`. | `benchmark/injection-budget.mjs:474`, `:854`, `:938`; `tests/injection-budget.test.mjs` (new id-check case) |
| P3-4 | P3 | `isActivityCall` misses `node $C activity …`, `node "$C" activity …` and a flag before the verb (`cli.mjs --json activity`). The `node $C <verb>` shape is used in this corpus (main thread of 79f51186: `C=…/cli.mjs; node $C defer drop D#241`). It also fires on `grep "claude-mem-lite activity" README.md`. The 0/52 reading still holds (see Q1e). | `benchmark/injection-budget.mjs:662` |
| P3-5 | P3 | The after-arm reads a row's project from `FOREIGN_ROW_RE = /\(([\w.-]*--[\w.-]+)\) \|$/`. That pattern is ASCII-only and needs `--`, but `projectNameFromDir` keeps any `\p{L}` and returns a bare basename for a root-level dir. On another corpus such foreign rows would rank as own. This corpus never reaches it: 4 ASCII `dev--*` projects. | `benchmark/injection-budget.mjs:844`; `project-utils.mjs:70,81` |
| P3-6 | P3 | The `hook_blocking_error` caliber is not stated. The ruler counts only the payload (`blockingError.blockingError`, 11,748 B → 0.22 KB/session → 25.24 / 73.6%). The archived claims report says 0.28 / 25.30 / 73.4%, which matches counting the rendered command and wrapper too. Both readings sit side by side in docs/audits with nothing reconciling them. | `benchmark/injection-budget.mjs:474-481`; baseline doc:42-43; `docs/measurement/rulers.md:85` |
| P3-7 | P3 | Commit 3715e464 names 0c840368, c28c32f4, 25b14389 and 68c70950 as the commits whose messages keep uncorrected figures. d84e0efe ("about 12 rows on this machine") and 185801bb ("74.2% of all hook context") also keep them. | commit messages |

---

## Q1 — does each repair fix its finding?

### (a) Recent-table cut (`lib/recent-table.mjs:45-48`, `hook-context.mjs:926-931`)

The probe (`delta/c4-probe.mjs`) loads main, old and head in one process against the same in-memory DB. For each code
home it calls `buildSessionContextLines(db,'test',now)`.

| Scenario | main (uncapped) | old (1ca93d69) | head |
|---|---|---|---|
| 2 own (19–20 h old) + 5 foreign (1–5 h old) | 7 rows | 5 foreign, **0 own** | 3 foreign + **2 own** |
| 1 own + 5 foreign | 6 | 5 foreign, 0 own | 4 foreign + own |
| 0 own + 5 foreign | 5 | 5 | 5 |
| 7 own + 5 newer foreign | 7 own (no top-up, since ≥3 own) | newest 5 own | newest 5 own |
| 4 own + 5 foreign | 4 own | 4 own | 4 own |

- **Caps:**
  - cap 1 → the newest own row; cap 2 → both own rows; cap 3 → 1 foreign + 2 own.
  - cap 0 → no `### Recent (` heading and no rows. `### Recent Activity` still appears on the 0-own project, as it
    does on main: it is the separate fallback section.
  - cap 100 and cap 1,000,000 → **the whole builder output equals main's** in all 6 scenarios.
- **Rows without `project`:**
  - The knapsack rows carry no `project` column (`hook-context.mjs:213`), so they count as own, which is correct.
  - A foreign row with `project=''` counts as own and renders without a suffix. That is consistent with how it
    displays. NOT NULL blocks a NULL project.
- **withFallbackTopUp:** it still runs only below 3 own rows, and dedups by id. Own rows that reach the union through
  the unscoped fallback query rank as own.
- **`### Recent Activity`:** `hook-context.mjs:754` keeps its own `.slice(0, MIN_LOCAL_OBS)`, untouched.
- **CLI `context`** (`delta/seed-thin.mjs` builds a file DB; then
  `node <tree>/cli.mjs context --project sbx--thin | grep '^| #'`):
  - main 7 rows, old 5 foreign, head 3 foreign + `own 0`, `own 1`.
  - PreCompact (`hook-precompact.mjs:28`) shares the builder.
- **End-to-end `hook.mjs session-start`** on the same thin DB, `source: startup`:
  - head with every restore switch set (`HEADER_ONCE=0 DIRECTIVE_ONCE=0 FILE_INTEL=1 STARTUP_RECENT_ROWS=100000
    DASHBOARD_EVENTS=1 UPS_PROMPT_ECHO=0`) gives stdout **byte-identical to main** (812 B each).
  - head defaults: 714 B, with 3 foreign + 2 own rows.
- **The tests can say NO:**
  - M1 (newest-cut) fails "the 5-row table keeps both own rows…".
  - M8 (`Math.max(1, cap)`) fails the cap-0 case.
  - The cap-0 case now passes with the default env, with `MEM_NO_AUTO_ADOPT=1`, and with `MEM_NO_AUTO_ADOPT=1
    MEM_QUIET_HOOKS=1` (69/69 each). The claims review's out-of-lens failure is resolved.

### (b) The two switches

**`CLAUDE_MEM_DASHBOARD_EVENTS`** (`lib/startup-dashboard.mjs:113-124`):
- The code is main's query, text and position, moved under the gate (diffed against main).
- `delta/dash-ab.mjs` compares `buildDashboard` main vs head over 3 DB shapes (events=5, events=0, db=null) × 2 stub
  sets.
  - Values `1` / `ON` / `yes`: **identical to main in 12/12**.
  - Unset / `0` / `false`: the line is gone, and only the events=5 cases differ.
- Mutations M4 (gate dead) and M5 (gate always on) each fail one test.

**`CLAUDE_MEM_UPS_PROMPT_ECHO`** (`scripts/user-prompt-search.js:613-616`):
- `delta/ups-ab.mjs` spawns the real script with a fresh data dir per run.
  - An earlier session's identical prompt, a 90% near-duplicate, and a legacy NULL `cc_session_id` row: head ECHO=0
    **== main**, while head default hides them.
  - The current session's identical prompt with `session_id` on stdin: head ECHO=0 still shows no past questions,
    while main shows `P#1`. **The current-session exclusion stays in place.**
- Caveat: with NO `session_id` on stdin, head ECHO=0 returns the just-typed prompt, as main does. The SQL exclusion has
  no session to exclude, and the switch turns off the JS filter that otherwise drops it. Claude Code always sends
  `session_id`, so this is the negligible case the defects review already described. README.md says "stay excluded
  either way" without that condition.
- Methodological note: run three arms on ONE data dir and the later arms are suppressed by the per-session shown-marker.
  The new test avoids this by using `sess-now-2`, and my first A/B was confounded by it until I used a fresh dir per
  arm.
- Mutations M6 (switch ignored) and M7 (switch=0 also drops the SQL session exclusion) each fail one test.

### (c) Marker clearing (`hook.mjs:3112`)

`delta/ss-source.mjs` plants a main-thread marker and runs the real `hook.mjs session-start` once per `source` value.

| source | head | old |
|---|---|---|
| startup / clear / compact | cleared / cleared / cleared | kept / kept / cleared |
| resume | kept | kept |
| missing / `null` / `''` / `fork` / `Resume` | cleared | kept |
| non-JSON stdin | kept (no session id known) | kept |

- No value leaves a fresh context holding a marker. Every unknown or empty value clears, which errs safe (one more
  header).
- `resume` is not in the SessionStart matcher (`hooks/hooks.json:6`, `install.mjs:1079`: `startup|clear|compact`), so
  the `!== 'resume'` arm is not reached from the host.
- The new comment says resume "restores the transcript, copies included". That is an unverified host claim; see NOT
  CHECKED.
- Mutations M2 (compact only) and M3 (resume clears too) both fail the rewritten test.

### (d) Widened `assertNoLessonRowLost` (`benchmark/injection-budget.mjs:938-962`)

`projectSessionEvents` sets `before` on every non-blank hook block of every face, so all faces are compared.
`delta/idcheck-mut.mjs` runs mutated projectors over the frozen corpus:

| Projector | old check | head check |
|---|---|---|
| shipped | pass | pass |
| empty every ups_search block | **pass** | NO `[#391,#394,#62] → []` |
| empty every ups_context block | **pass** | NO `[#33,#33,#39,#40,#41,#41] → []` |
| empty every session_start block | **pass** | NO `[#33,#33,#39,#40,#41] → []` |
| empty every posttool / posttool_failure block | **pass** | NO |
| empty pretool / drop lesson_row lines | NO | NO |
| drop FYI rows but keep the heading | **pass** | NO |
| drop error_recall rows but keep the heading | **pass** | NO |
| drop every non-Recent session_start line holding an id | **pass** | NO |
| drop the whole Recent table | pass | pass (by design) |

Is the exclusion list too broad? I counted the ids in the recorded blocks by (face, class):
- The ids sit in error_recall (322 + 154), lesson_row (877), read_edit_nudge (340), fyi (102), memory_context (23),
  ctx:last_session (8), handoff (8) and deferred_ref (6).
- Ids inside excluded classes: **file_info 7**, all file text (`… issue #35`), and **ctx:recent 577**, by design.
- header, lessons_for, reread_warn and past_questions hold **0** ids.

So on this corpus the list hides no memory id. The structural residue: a pretool continuation line that fails the
`lesson_row` regex inherits `lessons_for` and is excluded. That was observed 0 times.

### (e) `bashReadsPartially` (`:570`) and `isActivityCall` (`:662`)

**bashReadsPartially:**
- `delta/trigger-moved.mjs` finds 26 lines that moved from bash_partial to bash_full. I read all 26 and each is correct:
  - a whole `cat` of the named file next to an unrelated `sed -n`/`grep`/`wc`;
  - `wc` + `cat` of the same file;
  - `cat f | python3 -c json.load`.
- No lines moved the other way, which follows from the rule.
- The whole-command fallback fired for **0 of 997** Bash lines.
- The 3 `read_full` later-slice flips (25 → 22) are each a later `cat "$S/<file>"`, a full read, so they are correct.
- Residue I could construct but did not see change a verdict: the `includes(fname)` substring match (`adopt.md` inside
  `unadopt.md`, harmless there), and prose words `more`/`less` inside a heredoc.
- Mutations R1 (whole-command) and R2 (partial wins over full) each fail the new test.

**isActivityCall:**
- `delta/activity-scan.mjs` covers all 38 Bash commands naming `activity`, main thread AND sidechains.
  - Shipped regex: 0 calls.
  - A looser regex that also accepts `$VAR activity`: 0 calls.
  - So **0/52 holds**. The robustness gaps are P3-4.
- R3 (the loose form) fails the new test.

## Q2 — new defects or regressions?

No new P1/P2.

| Earlier-confirmed property | Re-run result |
|---|---|
| Identity self-check | passes on **1,923** blocks |
| `--project` headline | **18.57 → 12.66 KB/session**: 12.660 (old) vs 12.661 (head), because 65 B moved in ctx:recent (30,478 → 30,543 B) when own rows replaced foreign ones |
| Stored projected root vs fresh `--write-projected` at head | `diff -rq` clean |
| Stored projected root vs a `--write-projected` from 1ca93d69 | differs in exactly the 5 daagu sessions (so the diff can say NO) |
| `citation-live-replay --json` on frozen / fresh-projected / old-projected | byte-identical (1,668 B each): pretool 3/332, error_recall 1/366, fyi 1/93, ups 1/14 |
| Ruler run directly on the fresh projected root | 19.33 / 12.66 KB/session |

- **Every changed ruler number, old vs head** (full `--value --project --json` diff): trigger 22/975 → 48/949; laterSlice
  bash_full 12→25, bash_partial 673→656, read_full 25→22; laterSliceSameTurn 741→734; bigLaterSlice 290→289;
  activity 4→0; the Stop|reply-language-check.sh row added (33 fires, 11,748 B); after ctx:recent +65 B. Nothing else
  moved. 741 / 67.2% and 290/362 are quoted in none of the docs.
- **Knip:** identical old vs head (43 lines each). `lib/recent-table.mjs` is registered in `source-files.mjs` and
  `package.json#files`.
- **eslint and prettier** on the changed `.mjs`/`.js`: clean. `prettier --check README.md` fails on main, old and head
  alike, and README is outside `format:check` (`**/*.{mjs,js}`).
- **Import side effect (P3-2 of the defects review):** fresh HOME, CLAUDE_MEM_DIR unset, then
  `await import('<tree>/benchmark/injection-budget.mjs')`.
  - old creates `home/.claude-mem-lite/runtime`; head creates nothing.
  - A full `--value --project` run with CLAUDE_MEM_DIR set: old creates `data/runtime`, head nothing.

## Q3 — are the new numbers true?

Each figure was re-derived on the frozen root with my own walks (the ruler supplied only the event walk).

| Claim | Verdict | Evidence |
|---|---|---|
| 89.9% (991/1,102) partial; 949 / 42 / 63 / 48 | TRUE | 949+42=991; ruler, and my reimplementation with both rules reproduces old and new exactly |
| 34.9% (22/63) vs 69.1% (656/949) | TRUE | independent `delta/laterslice-delta.mjs`: old 25/63, 673/975; new 22/63, 656/949 |
| activity 0/52 (was 4/52) | TRUE | ruler; plus a scan of all 38 Bash commands naming activity, main and sidechain |
| mem-events line 60/60 | TRUE | 60 of 60 SessionStart blocks |
| 220 distinct headers; 1,033 legacy at 82 B; 513 factual | TRUE | own census; mean 95.82 B incl. newline |
| all hooks 25.24 → 19.33; plugin 73.6%; others 6.67, of which 0.22 is Stop blocking feedback | TRUE on the ruler's payload-only caliber (P3-6) | ruler on frozen and projected roots |
| Recent rows "7–13 per session, mean 9.4" | Numbers TRUE per SessionStart table (565/60); unit WRONG (P3-2) | per session 7–34, mean 10.87 |
| 5 thin tables now keep all 10 own rows | TRUE | `delta/census.mjs`: own kept 10/10 at head, 0/10 at 1ca93d69; recorded tables newest-first by id in 60/60 (the projection's premise) |
| Within-session repeats per face 78/876 (8.9%), 89/468 (19.0%), 7/100, 0.55 KB; across faces 111/876, 137/468, 8/100, 0.80 KB | TRUE | own walk `delta/repeats.mjs`, reset at compaction |
| "first fired on a file-info summary quoting issue #35" | TRUE | file_info id sample: `… the third face of issue #35` |
| After doc: 1,668 replayed calls, 271 blocks, 0/14 steps, 5/60 tables / 10 rows, 160/204 subagent transcripts | TRUE (quotes the defects report) | 346+931+391 = 1,668 |
| `claude-mem-lite help` still lists `activity recent` | TRUE | help line 206 `recent [N]  Most recent events` under `activity <action>` |
| "RED test reproduced 0 own rows kept" | TRUE | M1 fails the test; the old tree renders 0 own rows on the same fixture |

## Q4 — tests

| Run | Result |
|---|---|
| 5 touched files (`hook-context`, `injection-budget`, `recall-shown`, `startup-dashboard`, `ups-past-question-echo`) | **5 files / 126 tests passed**, exit 0 |
| Same 5 files with sandbox HOME + `MEM_NO_AUTO_ADOPT=1` | 126/126 |
| `hook-context.test.mjs` with default env / `MEM_NO_AUTO_ADOPT=1` / plus `MEM_QUIET_HOOKS=1` | 69/69 each |
| Full suite `npx vitest run` | **496 files / 8,614 tests passed**, exit 0 (41.5 s) |

The full suite gained 9 tests over the defects review's 8,605: 8 new cases plus 1 generated case for
`lib/recent-table.mjs`.

**Mutation runs** (one site each, applied as `1 file changed` per `git diff --stat`, reverted with `git checkout`):
- Killed: M1–M8 and R1–R5.
- **Survived: R6, R7, R8** (P3-3).

## Claims to falsify

| Claim | Holds? |
|---|---|
| "the 5 thin-project tables now keep all 10 own rows" | **Holds**: 10/10 at head vs 0/10 at 1ca93d69. The real builder does the same on a thin fixture (hook, CLI, SessionStart end to end). |
| "importing the ruler no longer creates a runtime dir" | **Holds**: A/B in fresh HOMEs, head creates nothing and the old tree creates `.claude-mem-lite/runtime`. |
| "CLAUDE_MEM_UPS_PROMPT_ECHO=0 keeps the current session's prompts excluded" | **Holds whenever stdin carries `session_id`**, which Claude Code always sends; verified end to end. Without `session_id`, the just-typed prompt returns, as on main. |
| "the widened id check fires on a projector that empties every UserPromptSubmit block" | **Holds** for both UPS faces: ups_search `[#391,#394,#62] → []`, ups_context `[#33,…] → []`. The old check passed both. |

## NOT CHECKED

- **Node 22** (the lowest CI Node): no Node 22 binary on this machine. `~/.cache/node-gyp/22.23.3` holds headers only.
  Every run was on Node 26.8.1.
- Whether Claude Code re-delivers hook attachments on `resume`. The new `hook.mjs:3108-3111` comment states it does.
  Also whether SessionStart fires with the lead's id for teammates or subagents.
- CI state of the branch, `npm run test:ci-env`, the coverage gate, `validate:manifests`.
- Behavioural effect on the model of any change (outside a projection's reach).
- The live DB and transcripts (`~/.claude-mem-lite`, `~/.claude`), untouched by instruction. The thin-project fix was
  verified on synthetic DBs and through the projection, not on the DB as it was at recording time.
- The ruler regex changes were checked only on this corpus (4 ASCII projects).

Reproduction scripts (scratchpad `delta/`):
- `c4-probe.mjs`, `seed-thin.mjs`, `ss-source.mjs`, `dash-ab.mjs`, `ups-ab.mjs`, `idcheck-mut.mjs`
- `trigger-moved.mjs`, `trigger-fallback.mjs`, `trigger-heredoc.mjs`, `laterslice-delta.mjs`, `activity-scan.mjs`
- `census.mjs`, `recent-order.mjs`, `repeats.mjs`, `mutate.sh`

They expect worktrees at `~/.cache/ib-review-delta{,-old,-main}` (b19b2c1a / 1ca93d69 / 92fdfad6) with a
`node_modules` symlink. Those were removed; recreate them with `git worktree add --detach`.
