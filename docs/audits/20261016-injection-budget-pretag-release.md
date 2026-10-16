# Pre-tag review: v6.27.0 release candidate `f12e673a` (branch feat/injection-budget)

Reviewed 2026-10-16. Tree: `f12e673a` checked out in the primary working tree (clean before and after;
`git status --short` empty at the end). Review only, nothing edited.

Counts: **P1 0 · P2 1 · P3 6**.

## Evidence base

- Ruler, read-only, frozen root: `CLAUDE_MEM_TRANSCRIPT_ROOT=benchmark/results/injection-corpus-20261016 node benchmark/injection-budget.mjs --project` (and `--value`). Output matches the after-arm audit table line for line (18.57 → 12.66, header 2.78 → 0.09, nudge 2.03 → 1.14, file_info 1.57 → 0, edit_directive 0.38 → 0.18, recent 1.02 → 0.57, identity self-check on 1,923 blocks, no id lost).
- Unrounded figures from the ruler's exported `sessionEvents` / `accountBytes` / `projectSessionEvents` over the same 52 main transcripts: total 18.5733 → 12.6612; header 2.7821 → 0.0924; read_edit_nudge 2.0276 → 1.1351; edit_directive 0.3770 → 0.1757; file_info 1.5725; ctx:recent 1.0169 → 0.5736.
- `citation-live-replay.mjs` on the frozen root (0.9 s): pretool 3/332, error_recall 1/366, fyi 1/93, ups 1/14; plus `--dump` to read per-session hits.
- End-to-end sandbox probe (HOME + data dir under `$HOME/.cache/tmp`, `MEM_NO_AUTO_ADOPT=1`, deleted afterwards): real `scripts/pre-tool-recall.js` and `hook.mjs session-start`.
- Single test files: `tests/recall-shown.test.mjs tests/ups-past-question-echo.test.mjs tests/injection-budget.test.mjs tests/startup-dashboard.test.mjs` → 4 files, 59 passed (TMPDIR=$HOME/.cache/tmp).

## Findings

### P2-1 — "6 citations in all" is 4 citations; one citation is counted on three faces
`CHANGELOG.md` v6.27.0, "Not measured" bullet: "the 52 sessions hold 6 citations in all".
6 = 3 + 1 + 1 + 1, the sum of per-FACE cited (session, id) pairs. In session `2b427c71` (claudemd) the
assistant names `#210` once ("按 #210 的教训…"); #210 had been injected by PreToolUse, PostToolUse,
UserPromptSubmit and SessionStart, so the replay scores that one mention as a hit on `pretool`,
`error_recall` AND `fyi`. Distinct cited (session, id) pairs of injected ids: **4**
(2b427c71 #210, dbd5076b #395, 4a85d5d0 #154, f6804bad #184).
Repro:
```
CLAUDE_MEM_TRANSCRIPT_ROOT=benchmark/results/injection-corpus-20261016 node benchmark/citation-live-replay.mjs --dump /tmp/c.json
node -e 'for (const r of require("/tmp/c.json").records) { const h = Object.fromEntries(Object.entries(r.faces).map(([k,f])=>[k,f.hit])); if (Object.values(h).some(a=>a.length)) console.log(r.session.slice(0,8), JSON.stringify(h)); }'
# 2b427c71 {"pretool":[210],"error_recall":[210],"fyi":[210]}   dbd5076b {"pretool":[395],...}
# 4a85d5d0 {...,"ups":[154],...}   f6804bad {"pretool":[184],...}
```
Impact: the sentence's conclusion (too few to show a change) holds and gets stronger at 4; the number
itself is false as worded. Same copy in `docs/audits/20261016-injection-budget-after.md`
(line 56, "52 个会话里一共只有 6 次引用"), `docs/audits/20261016-injection-budget-baseline.md`
(lines 89 and 124, "4 个面合计只有 6 次引用", "上面 6 次") and `docs/measurement/rulers.md:85` ("6 cites in all").
Fix shape: "4 cited lessons (6 face hits)" or "6 cited (face, session, id) pairs".

### P3-1 — Headline per-session figure is main-thread only; the population is unstated
`CHANGELOG.md` upgrade note: "the 52 sessions … receive 12.66 KB per session from the plugin instead of 18.57".
`benchmark/injection-budget.mjs:432-442` `sessionEvents` counts the main transcript only (skips
`isSidechain`; main transcripts hold 0 sidechain entries, 80,648 records). The 160 frozen subagent
transcripts carry 2,350 more plugin attachments = **642.50 KB = 12.36 KB/session** that neither arm
counts: pretool 1,979 blocks / 449.13 KB (header 1,979 lines 172.79 KB, file_info 1,928 lines 116.36 KB,
lesson_row 123.27 KB, lessons_for 29.62 KB), posttool 101.49 KB, posttool_failure 91.88 KB.
Measured by feeding the subagent files (isSidechain stripped) through the ruler's own `sessionEvents`
+ `accountBytes`. The change also cuts subagent text (header once per subagent thread, file-intel off),
so the omission understates rather than overstates, but "per session from the plugin" reads as all of
it. Fix shape: "into the main conversation's context".

### P3-2 — "2.41 → 1.32" are sums of rounded parts
CHANGELOG "Read→Edit reminders and pre-edit directives 2.41 → 1.32". 2.03 + 0.38 and 1.14 + 0.18;
unrounded (105.43 + 19.60 KB)/52 = **2.40** before, **1.31** after (2.4046 → 1.3108).

### P3-3 — C4's restore value is not stated
CHANGELOG "(`CLAUDE_MEM_STARTUP_RECENT_ROWS`, 0 hides it)" under "Every change below except the bug fix
has a setting that brings the old behaviour back". The old table comes back with any value at least the
budget's pick (`lib/env-number.mjs` has no max; the ruler's `RESTORE_ENV` uses 1000000, and with
cap ≥ rows `capRecentRows` returns the same newest-first order as the old sort). Neither the CHANGELOG
nor README says which value restores it. Fix shape: "a large value, e.g. 100, shows the whole pick again".

### P3-4 — "the full pre-edit directive … once per thread" is default-arm only
CHANGELOG first Change bullet. `scripts/pre-tool-recall.js` emitRecallBlock substitutes the short form
only when `ACTIVE_DIRECTIVE === ACK_DIRECTIVE`; `CLAUDE_MEM_SALIENCE=verdict|bind|bridge` keep their
full text on every block (README's `CLAUDE_MEM_DIRECTIVE_ONCE` row says so; the CHANGELOG does not).

### P3-5 — The Recent cap also changes `claude-mem-lite context`
`mem-cli.mjs:1828` renders `buildSessionContextLines`, which now cuts to `recentTableRowCap()`
(`hook-context.mjs:926`; `lib/recent-table.mjs` comment: "Read per call so the CLI `context` command …
see the current env"). The CHANGELOG names only the SessionStart table.

### P3-6 — Stale docstring on `clearRecallShown`
`lib/recall-shown.mjs:104` `/** SessionStart(compact): the main thread's earlier copies are gone … */` — the
caller (`hook.mjs` handleSessionStart) clears on every source but `resume` (startup, clear, compact), as
the file's own header comment and the 1799c9ee comment say.

## Claims to falsify — results

| Claim | Verdict | Evidence |
|---|---|---|
| Lesson rows (`#NN`/`E#NN` before an edit, after an error, on a prompt) unchanged | Holds | Diff touches no lesson-row emitter: pretool rows built as before (`scripts/pre-tool-recall.js` lesson loop unchanged, only header/directive slots move into `emitRecallBlock`); error recall (hook.mjs PostToolUse/Failure) untouched; UPS change is confined to `searchByUserPrompts` (the `P#` fallback, reached only when `rows.length === 0`). Ruler `assertNoLessonRowLost` passes on all faces; replay pairs identical. Probe: second block still carries `lesson for b file handling`. |
| A thread's first block asking to tag still asks in full | Holds | Probe (real hook, sandbox): session S Edit a → header + full ACK; Edit b → no header, `tag rule as before`, lesson intact; subagent `agent_id` first block → header + full. `planRecallBlock` sets `next.directive` only after a `full`. Corpus: 0 of 49 first-directive blocks and 0 of 52 first-header blocks sat on an errored tool result. ACK text moved byte-identical (`cmp` of main vs f12e673a). |
| Every change except the bug fix has a setting | Holds (C4 value unstated, P3-3) | Probe: `HEADER_ONCE=0` + `DIRECTIVE_ONCE=0` → second block has header + full ACK; `CLAUDE_MEM_FILE_INTEL=1` → `[mem] 📄 big.mjs ~6.5k tok` on Read and on Bash `cat`, default → no output; `CLAUDE_MEM_DASHBOARD_EVENTS` gates the same query + line at the same position (`lib/startup-dashboard.mjs`); `CLAUDE_MEM_UPS_PROMPT_ECHO=0` covered by `tests/ups-past-question-echo.test.mjs` (passed). Ruler identity check: 1,923 blocks byte-identical with every switch restored. |
| Both come back after `/compact` | Holds | Probe: after `hook.mjs session-start` with `source: compact` the next Edit has header + full ACK, the one after has neither. hooks.json and install.mjs both match `startup|clear|compact`; no early return precedes the clear in handleSessionStart (lines 2968–3114). Same key both sides: `threadKey(sid, null) === sid` → `cooldownSessionKey`. |
| 89.9% rode a read that already took a slice | Holds | `--value`: bash_partial 949 + read_partial 42 = 991/1,102 = 89.93%. Of the 949: `sed -n` 835, head 46, grep 34 (piped/paged), wc 18, tail 11, awk 2, cut 2, jq 1. |
| No session ran the `activity` command it points to | Holds | `--value`: 0/52 sessions (main thread, `isActivityCall`). Note: subagents of 2 sessions ran `activity show`, bare `activity` and `activity delete` against review sandboxes; none ran `activity recent`, and the hint is shown to the main thread only. |
| The prompt is stored while the search runs | Holds | hooks.json UserPromptSubmit runs `user-prompt-search.js` and `hook.mjs user-prompt` as two hooks of one matcher (host runs them in parallel); `hook.mjs` `recordUserPromptRow` inserts `prompt_text` + `cc_session_id`; the new SQL predicate `(? IS NULL OR up.cc_session_id IS NULL OR up.cc_session_id != ?)` excludes it. Baseline value proxy: 8/52 rows echoed the triggering prompt. |
| 7–13 rows per table; 1.02 → 0.57 | Holds | 60 tables: min 7, max 13, mean 9.42 (histogram 7:14, 8:12, 9:7, 10:10, 11:2, 12:9, 13:6); after: 60 × 5. KB 1.0169 → 0.5736. |
| framing 2.78 → 0.09; nudges+directives 2.41 → 1.32 | First holds; second off by 0.01 (P3-2) | 2.7821 → 0.0924; 2.4046 → 1.3108. |
| 12.66 vs 18.57; 52 sessions; 6 citations | 12.66/18.57 and 52 hold (main thread, P3-1); 6 is false (P2-1) | 18.5733 → 12.6612; MANIFEST 52 sessions, window [2026-09-30, 2026-10-16), listing sha `b3a01b6687180025`. |

Other numbers in the entry: file-intel 1.57 KB/session (1.5725) holds; corpus dates "2026-09-30 to 2026-10-15" match the MANIFEST window.

## Released-artifact checklist
- SemVer: 6.26.1 → 6.27.0, minor. OK.
- Upgrade note at top: present ("the plugin's hooks put less text …; there is nothing to do"). OK.
- Opt-out per default change: C1, C2, C3, C5-echo, C6 named with values; C4 named without the restore value (P3-3).
- Discoverability: the CHANGELOG callout. Note, not a finding: CHANGELOG.md is not in `package.json#files`, `publish.yml:202-204` creates the GitHub release with `generate_release_notes: true` (not the CHANGELOG body), and the update banner (`hook-update.mjs:195`) names only the version. Same as earlier releases.

## Version sites
`git grep 6.27.0 f12e673a`: package.json:3, package-lock.json:3 and :9, .claude-plugin/plugin.json:3,
.claude-plugin/marketplace.json:12, CLAUDE.md:5 (`**Version**: 6.27.0 — …`, line format unchanged).
`git diff f12e673a~1 f12e673a -- package-lock.json` changes exactly the two top-level version lines.
No `6.26.1` left outside CHANGELOG/docs. OK.

## hook.mjs comment (1799c9ee)
Comment-only diff. Each statement checked against the code beside it: clears on every source but
`resume` (`if (ccSessionId && startSource !== 'resume')`); `/clear` rotates the id; the resume
assumption is labelled unverified; "hooks/hooks.json does not even match `resume`" is true, and so does
install.mjs's settings.json twin (`install.mjs:1079` `matcher: 'startup|clear|compact'`), so "only from
a direct call" holds for both install shapes. No finding.

## NOT CHECKED
- Whether Claude Code delivers a PreToolUse `additionalContext` when the tool call is then denied (by the user or another hook). The marker records "shown" at hook time; if such a block is dropped, later blocks get the short directive without the full one. Corpus shows no first block on an errored result, but delivery on denial was not tested.
- Whether `--resume` keeps the session id and restores hook attachments into context (the comment already marks this unverified).
- Model behaviour on the shorter text (turn-end after a header-less block) — disclosed in the entry.
- Production C5 vs the ruler's approximation (the projector removes echo rows only; production also drops every same-session row in SQL and may refill from the OR pool). Not in the CHANGELOG's numbers.
- Full suite, coverage, knip, benchmark gates, `test:ci-env`, lowest-CI-Node run (excluded by the brief or out of scope).
- Non-Linux platforms.
