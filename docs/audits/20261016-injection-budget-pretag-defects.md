# Pre-ship defect review — `feat/injection-budget` (main 92fdfad6 .. head 1ca93d69)

Lens: behaviour / correctness. Reviewer did not write the change. Work done in detached worktrees
(`~/.cache/ib-review-defects` = head, `~/.cache/ib-review-main` = main), sandboxed HOME / CLAUDE_MEM_DIR
under `~/.cache`, `MEM_NO_AUTO_ADOPT=1`, `CLAUDE_CONFIG_DIR` unset. Node v26.8.1. Date 2026-10-16.

## Verdict

**No P1. Two P2s to fix (or explicitly accept) before tagging.** The PreToolUse half (C1/C3) behaves as specified on every
path exercised. The ruler's after-arm matches what the shipped hook emits: 0 differences over 271 replayed blocks. The
P2s are:

- C4's 5-row cut runs after the cross-project top-up, so on a thin project it drops the project's own rows and shows
  other projects' rows. It does this in 5 of the 60 SessionStart Recent tables in the frozen corpus.
- C5 (in part) and C6 have no env switch that restores the old behaviour, which the contract asks of every changed face.

Baseline health: the 11 changed test files pass 264/264. The full suite passes **496 files / 8605 tests**, exit 0
(Node 26 only). Knip output is identical on main and head (20 lines each).

## Severity table

| ID | Sev | Finding | Where |
|----|-----|---------|-------|
| P2-1 | P2 | On a thin project, C4's newest-5 cut evicts the project's own Recent rows in favour of the cross-project top-up. This breaks the stated "own rows first" ranking. Seen in 5/60 corpus tables (10 local rows cut). The after-arm reproduces the cut, so the ruler cannot flag it. | `hook-context.mjs:941-943`; stale contract text `hook-context.mjs:553`, `README.md:1144`, after-doc CHANGELOG draft |
| P2-2 | P2 | No restore switch for C6 (the dashboard events line), nor for C5's cross-session echo arm. The contract asks for one on every changed face; the after doc lists "无" for both. | `lib/startup-dashboard.mjs:107`, `scripts/user-prompt-search.js:611`, `docs/audits/20261016-injection-budget-after.md:14-15` |
| P3-1 | P3 | The C5 echo filter also drops an identical question asked in an EARLIER session, which is not in the context. The CHANGELOG draft says only "the prompt you just typed or another prompt of the same session". | `scripts/user-prompt-search.js:611`, `tests/ups-past-question-echo.test.mjs:94` |
| P3-2 | P3 | Importing the ruler is not side-effect-free. Through `hook-context.mjs` → `hook-shared.mjs:387-391` it creates and chmods `<data>/runtime`. This contradicts the ruler's own comment. | `benchmark/injection-budget.mjs:72`, `:1116` |
| P3-3 | P3 | `assertNoLessonRowLost` checks the pretool face only. A projector that empties every `ups_search` block (FYI `#NN` rows, the face C5 edits) or every SessionStart block passes it. | `benchmark/injection-budget.mjs:901` |
| P3-4 | P3 | The marker records THAT a header or directive was shown, not WHICH text. If the session is resumed with a different `CLAUDE_MEM_SALIENCE` or framing arm, the default arm's first ACK can be the short form. | `lib/recall-shown.mjs:53-62` |
| P3-5 | P3 | A subagent or teammate marker is never cleared by that thread's own compaction, only by the 24 h GC. `/rewind` also leaves every marker set (same class as the cooldown). Not observed so far: 0/160 corpus and 0/204 live subagent transcripts are compacted. | `hook.mjs:3111` (main key only) |
| P3-6 | P3 | The thread key is cut at 64 chars. An agent name of 25 chars or more leaves no hex suffix, so two agents with the same name in one session share the cooldown and now also the header/directive marker. Pre-existing D15 class. | `lib/cooldown-path.mjs:32` |
| P3-7 | P3 | SessionStart(`startup`) keeps the marker, and a test pins that. Startup always means a fresh context, so clearing there too (and on `clear`) would be free and errs in the safe direction. It only matters for a reused session id. | `hook.mjs:3111`, `tests/recall-shown.test.mjs:146` |
| P3-8 | P3 | Pre-existing (by reading, not reproduced): `cjkPrecisionOk` still filters AFTER the OR-relaxation decision. That is the same LIMIT-upstream-of-a-JS-filter shape the new C5 comment fixes for echoes. | `scripts/user-prompt-search.js:627` vs `:607-610` |

---

## Q1 — PreToolUse: header on every block, or none on a first block?

**Behaviour verified end to end.** Harness: `scratchpad/harness-pretool.mjs`. It runs 15 steps three ways, each in a
fresh sandbox: main, head with the switches restored, and head with defaults. The steps cover Read, Read→Edit nudge,
Edit, the re-read warning, a file-intel-only Read, compaction, the Bash leg (`sed -n` read, `sed -i` write),
NotebookEdit, a subagent (`agent_id`), and no `session_id`.
- (a) main vs head with `CLAUDE_MEM_RECALL_HEADER_ONCE=0 CLAUDE_MEM_DIRECTIVE_ONCE=0 CLAUDE_MEM_FILE_INTEL=1`: **0/14
  hook steps differ**. The switches restore old behaviour on all three PreToolUse emit sites and the Bash leg.
- Head defaults:
  - The header appears on step 1 only, and again on the first block after compaction (step 8).
  - The re-read warning (step 5) and the Read→Edit nudge (step 2) carry no header.
  - The subagent's first block (step 12) has header + full directive; its second (step 13) is short.
  - Both no-session steps (14, 15) have header + full directive every time, as before.
- Replays of RECORDED sessions (`scratchpad/replay-session.mjs`). Each replays the main-thread tool calls and
  compactions through both hooks, with one lesson seeded per touched file. Headers dropped to 1 + compactions per
  session in every case:

  | Session | Calls | Compactions | Headers main → head | Short directives |
  |---|---|---|---|---|
  | 63e6b16a | 346 | 1 | 50 → 2 | 18 |
  | 4a85d5d0 | 931 | 3 | 161 → 4 | 68 |
  | bccae402 | 391 | 1 | 60 → 2 | 21 |

- **Parallel calls** (`scratchpad/race-probe.mjs`, 20 rounds × 5 concurrent calls on one fresh thread):
  - Headers per round: `{1:11, 2:6, 3:3}`. The overlap is real: 9/20 rounds had duplicate headers.
  - **0 rounds had no header.**
  - **0 final markers claim a line no block showed.**
  - A writer only ever sets what it read or showed itself, so a lost update can only re-show, never suppress.
- Corrupt marker (`'{not json'`, `null`, wrong types): `readRecallShown` returns empty, so the header is re-shown and the
  marker rewritten (`lib/recall-shown.mjs:76-84`). An unwritable marker means a header on every block, i.e. the old
  behaviour.
- The only paths where a thread's first block lacks the header are P3-4, P3-5 and P3-6. A hook killed by the 3 s timeout
  after `flushHookStdout` but before exit would also do it (marker written at `scripts/pre-tool-recall.js:585`, then
  output discarded). That last case is NOT CHECKED, and the cooldown shares it.
- Opt-in `CLAUDE_MEM_PRETOOL_NUDGE=1`: same `emitRecallBlock` path (`scripts/pre-tool-recall.js:963-977`), header once.
  Checked by reading.

## Q2 — compaction / resume / clear / GC

- Main thread: cleared exactly at SessionStart(`compact`) (`hook.mjs:3111`).
  - The test drives the real entry point (`tests/recall-shown.test.mjs:146`).
  - Harness step 7 → 8 shows the header and full directive back.
  - The replays show one header per compaction.
- `/clear` rotates the session id, so the old marker is orphaned and reaped by the GC. `resume` is not in the
  SessionStart matcher (`startup|clear|compact`); the marker persists and the transcript is restored. Whether Claude
  Code re-sends hook attachments on resume is NOT CHECKED.
- Subagent marker: never reset by the main thread's compaction, which is correct (test above; `clearRecallShown` keys on
  `ccSessionId` only). It is also never reset by its own compaction (P3-5).
- GC: the prefix match at `hook.mjs:1876` reaps markers (test `tests/recall-shown.test.mjs` "reaps a marker older than a
  day"). Age is the mtime of the last STATE CHANGE, usually the thread's first block. A thread active for more than
  24 h is reaped mid-life and shows the header and full directive once more. That errs in the safe direction; noted only.

## Q3 — salience arms

`scratchpad/arms-probe.mjs`: Read → Read→Edit nudge → Edit → Edit in one thread, per arm.
- `bind`, `bridge` (with `CLAUDE_MEM_BRIDGE_FAKE=n/a`) and `verdict` carry their full text on blocks 2–4.
- Default: full on its first directive (the nudge), short on blocks 3–4. `legacy`: no directive.
- The shortening is gated on `ACTIVE_DIRECTIVE === ACK_DIRECTIVE` (`scripts/pre-tool-recall.js:575`).
- The default never got the short form on a thread's first directive, except via P3-4.
- All arms lose the header after the first block. The header is not directive text, so this is within the contract.

## Q4 — C5 past-question fallback

- SQL predicate truth table (`scripts/user-prompt-search.js:594`): session=null keeps NULL/'s'/'t' rows; session='s'
  keeps NULL and 't' rows. NULL-`cc_session_id` legacy rows stay eligible. Correct.
- OR relaxation: the echo filter runs on each pool before the `rows.length === 0` decision (`:611-621`). Correct.
- CJK: `isPromptEcho` folds whitespace (`\s` covers U+3000) and case. For an older question that a prompt is a prefix
  of, coverage ≥80% counts as an echo and below 80% does not (pinned by tests).
- **Drops a legitimate past question**: an identical question asked in another, earlier session.
  `scratchpad/c5-echo.mjs` seeds the prompt 3 days ago under `sess-three-days-ago` and asks again from `sess-now`:
  - main: `[mem] FYI — Past similar questions … P#1 💬 why does the retry loop in fetcher.mjs ignore the timeout`
  - head: nothing.
  This is intentional (pinned at `tests/ups-past-question-echo.test.mjs:94`). But the stated fix ("8/52 rows were the
  triggering prompt", which the SQL session exclusion alone fixes) does not need it, the CHANGELOG draft does not
  mention it, and it has no switch (P3-1, P2-2). Earlier prompts of the same session stay excluded after compaction,
  when they are only in the summary; that is by design.
- Still returns the current prompt: only with no `session_id` AND stored text that differs from the raw prompt (secret
  scrub, or a prompt over 12.5k chars). Negligible.

## Q5 — C4 Recent cap

- **P2-1.** `obsToShow = withFallbackTopUp(...).sort(newest).slice(0, 5)` (`hook-context.mjs:941-943`). Under
  `MIN_LOCAL_OBS` (3) local picks, the union holds up to 5 cross-project fallback rows, and the newest-5 cut can remove
  every local row.
  - `scratchpad/c4-topup.mjs` (2 local rows 19–20 h old, 5 other-project rows 1–5 h old): **main 7 rows / 2 local; head
    5 rows / 0 local.**
  - Frozen corpus (`scratchpad/c4-corpus.py`): 60 SessionStart blocks have a Recent table; 5 have cross-project rows;
    **in 5/5 the cut keeps the cross-project rows and drops the local ones (10 rows)**. Example: daagu session
    `26c39a2b`, where the 5 kept rows are `(dev--code-graph-mcp)` / `(dev--claude-mem-lite)` and the 2 cut rows are
    daagu's own.
  - The docstring at `:553` ("At the uncapped table site this only adds … Preferring the project's own rows … is the
    intended order") is now false at this site. `README.md:1144` ("the newest of the rows the token budget picks") is
    wrong for thin projects.
  - Fix shape: cap the local selection first, then top up, or rank local before cross-project before the slice.
- `### Recent Activity` (`hook-context.mjs:768-777`): its own `slice(0, MIN_LOCAL_OBS)`, unaffected.
- CLI `context` (`mem-cli.mjs:1828`) and PreCompact (`hook-precompact.mjs:28`) share the builder and the cap. The claim
  holds; the CLI has no flag to see more rows.
- Other sets: Recent rows are booked nowhere. `recordKeyContextInjection` books `keyContextLines` only
  (`hook.mjs:3293`), and nothing bumps `injection_count` for Recent rows. The keyctx marker, exclude sets and dedup
  markers are unchanged.

## Q6 — C6 events count

Nothing else reads it. Grep finds only the ruler, `tests/startup-dashboard.test.mjs:211,227` and
`tests/feature-sweep-hooks.test.mjs:515` (negative assertions, restated not weakened), plus docs.
`buildDashboard`'s `db` is still used for the handoff line. The comment "`activity recent` is still documented where the
tools are" holds only via `claude-mem-lite help` (`mem-cli.mjs:3368`). The adopted detail doc lists only `activity save`
(`adopt-content.mjs:191`).

## Q7 — ruler after-arm fidelity and self-checks

- **Faithful on everything replayed:**
  - Harness (b): 10/10 main-thread steps, projection of main's output == head's output.
  - Three recorded-session replays: **0 differences over 271 blocks**, and 0 calls whose lesson-row ids differ between
    main and head.
  - Directive census: **413/413** recorded directive lines carry today's `ACK_DIRECTIVE` byte for byte, so the
    projector's `replace` never silently no-ops.
- `--project` reproduces the published reading: **18.57 → 12.66 KB/session**, identity on 1,923 blocks, header lines
  1,546 → 52.
- Can the self-checks say NO? (`scratchpad/selfcheck-mut.mjs`, frozen corpus)

  | Projector variant | Identity check | No-lesson-lost check |
  |---|---|---|
  | Shipped projector | pass | pass |
  | Ignores the restore env | **NO** | — |
  | Drops the last line of each pretool block | **NO** | — |
  | Drops `E#` rows | — | **NO** (`[E#5151] → []`) |
  | Empties every session_start block | — | **pass** (P3-3) |
  | Empties every ups_search block | — | **pass** (P3-3) |

  Both checks guard the PROJECTOR. Neither runs a shipped hook, so neither can catch a defect in
  `scripts/pre-tool-recall.js` itself; my replays are what cover that. Both also faithfully reproduce P2-1, so the
  after-arm cannot see it.
- Import side effects (P3-2), each module imported in a fresh HOME:
  - The ruler and `hook-context.mjs` create `<HOME>/.claude-mem-lite/runtime`.
  - `lib/recall-shown.mjs`, `schema.mjs` and `project-utils.mjs` create nothing.
  - The ruler imports `hook-context.mjs` only for `recentTableRowCap`.

## Q8 — hot-path cost

Marker I/O happens only on EMITTING calls (`emitRecallBlock`); silent calls do none.

| Measurement | main | head |
|---|---|---|
| Emitting Edit, n=40 interleaved (`scratchpad/latency-pretool.mjs`), p50 | 40.2 ms | first block (marker write) 40.6 / later block (marker read) 40.0 ms |
| Same, min | 34.8 ms | 36.5 / 36.0 ms |
| Silent Read, n=60 interleaved, p50 | 38.8 ms | 39.1 ms |
| Silent Read, min | 33.7 ms | 35.8 ms |
| `benchmark/hook-latency.mjs -n 15`, run twice alternating, `pre-tool-recall.js` min | 23.8 / 23.9 ms | 25.6 / 26.9 ms |
| Same, p50 | 31.5 / 28.9 ms | 33.5 / 29.8 ms |

No p50 movement beyond +0.4 ms on the interleaved runs. Min is +1.2 to +3.0 ms across rulers, at n=15–60. That is not
separable from noise here and is not a ship issue.

## Q9 — other

P3-4, P3-6, P3-7 and P3-8 in the table.
- The registration constraint holds: `lib/recall-shown.mjs` is in `source-files.mjs` and `package.json#files`.
- The README rows for the two new switches match the code.

## Claims to falsify

| Claim | Holds? | Evidence |
|---|---|---|
| Lesson rows untouched, (session,id) pairs do not move | **Yes** for every face the Stop-side extractor reads | 0 lesson-id mismatches over 271 replayed blocks and the harness. C4/C5 remove only Recent `\| #NN \|` and `P#N` rows, which no `SURFACE_MATCHERS` face counts (`lib/citation-tracker.mjs:754`) |
| Marker cleared on SessionStart(compact), reaped by 24 h GC | **Yes for the main thread**; a subagent marker is cleared by GC only (P3-5); GC age is the first write, not last use | `hook.mjs:3111`, `:1876`; tests and harness |
| verdict/bind/bridge keep their full text | **Yes** | arms probe |
| CLI `context` shares the builder and the cap | **Yes**, and it inherits P2-1 | `mem-cli.mjs:1828` |
| post-tool-recall.js header only under bind | **Yes** | `scripts/post-tool-recall.js:51` returns unless `SALIENCE_BIND` |

## NOT CHECKED

- **Node 22** (lowest CI Node): there is no Node 22 binary on this machine. Every run here was Node v26.8.1.
- Whether Claude Code delivers a PreToolUse block whose process is killed by the 3 s timeout after flushing.
- Whether Claude Code re-sends hook attachments on `resume`.
- Whether SessionStart fires (and with which ids) when a subagent or teammate compacts.
- Whether microcompaction or tool-result clearing drops hook attachments, which would remove the header with no
  SessionStart.
- **Behavioural effect** of dropping the header from later blocks (the #7758 early turn-end it was added for). A
  projection or replay cannot show this; it needs a live A/B.
- Replays used a synthetic DB (one lesson per touched file), not the DB as it was at recording time.
- Windows-shaped paths. CI run state of the branch. `npm run test:ci-env`, `format:check`, `eslint`.

Reproduction scripts (scratchpad):
- `harness-pretool.mjs`
- `replay-session.mjs`
- `race-probe.mjs`
- `arms-probe.mjs`
- `latency-pretool.mjs`, `latency-silent.mjs`
- `c4-topup.mjs`, `c4-corpus.py`
- `c5-echo.mjs`
- `selfcheck-mut.mjs`
- `dir-census.mjs`

Run them with `env -u CLAUDE_CONFIG_DIR HOME=<sandbox> CLAUDE_MEM_DIR=<sandbox>/data MEM_NO_AUTO_ADOPT=1`. They expect
the two worktrees at `~/.cache/ib-review-{defects,main}`, which this review removed; recreate them with
`git worktree add --detach`.
