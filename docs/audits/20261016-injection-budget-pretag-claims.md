# Pre-ship claims review — feat/injection-budget (main 92fdfad6 .. 1ca93d69)

Reviewer lens: CLAIMS. Worktree: detached at 1ca93d69. Corpus: frozen root
`benchmark/results/injection-corpus-20261016` (MANIFEST re-hashed: 212/212 files match, listing
sha256 b3a01b6687180025… recomputes). All numbers below re-derived 2026-10-16 ~02:00Z from that
root unless stated; independent counts are my own Python walks (scratchpad/rc/*.py), not the ruler.

## Verdict

Ship-able after text fixes. No P1. The headline numbers hold: 18.57 -> 12.66 KB/session,
25.02 -> 19.11, 1,923-block identity check, identical citation-live-replay output on both roots,
340 / 426 / 27.6%, Recent 2/498, 8 of 52 echoes, CLAUDE.md 20,479 -> 20,466 B, every README
default, and the hooks-doc quote. Four published numbers are WRONG (P2) — two of them are value
proxies the ruler itself computes wrongly, so the ruler needs a fix as well as the prose. All four
errors leave each change's decision standing (three of them make the case stronger).

## Severity table

| ID | Sev | Claim (where) | Finding | Decided by |
|---|---|---|---|---|
| P2-1 | P2 | "`activity` was run in 4 of the 52 sessions" (commit 25b14389; lib/startup-dashboard.mjs:109; baseline doc:103 "52 个会话里 4 个跑过 activity（7.7%）") | WRONG: **0 of 52**. All 4 ruler hits are commands that only NAME the word: python patches touching `lib/activity.mjs`, a grep over `cli/activity.mjs`, test text `runCli(['activity', …])` being written. A regex for an actual CLI call (`(cli.mjs|claude-mem-lite|$C) activity`) finds 0 invocations. Ruler bug: benchmark/injection-budget.mjs:744 tests `/\bactivity\b/` and `/claude-mem-lite|cli\.mjs/` anywhere in the command. | own walk over Bash tool_use inputs, main thread |
| P2-2 | P2 | "`💡 mem events` sat in 56 of 60 SessionStart blocks" (commit 25b14389; lib/startup-dashboard.mjs:108) | WRONG: **60 of 60** blocks carry it (one text variant, `💡 mem events: N entries (\`claude-mem-lite activity recent\`)`). The ruler agrees with 60: its after-arm drops dashboard lines 193 -> 130 = 60 event lines + 3 emptied headings (blank 256 -> 253). | own walk; ruler `--project` output |
| P2-3 | P2 | "The framing header was the same 95 bytes on all 1,546 PreToolUse blocks" (commit c28c32f4); "Both lines are the same text on every PreToolUse / PostToolUse recall block" (lib/recall-shown.mjs:4) | WRONG: **220 distinct header strings**. 1,033 are the 82-B legacy line; 513 are the factual-arm line that names the file (`… notes recorded by claude-mem-lite about CHANGELOG.md; the tool call proceeds as planned:`, 110–119+ B). 95 B is the MEAN (144.67 KB / 1,546). PostToolUse recall carries a header only in the `bind` arm (scripts/post-tool-recall.js:51,101) and this lib does not govern it. The 2.78 KB/session figure is right. | own walk; lib/recall-framing.mjs:73-77 |
| P2-4 | P2 | "92.3% of its 1,102 lines rode a call that was already a partial read" (commit 0c840368; scripts/pre-tool-recall.js:203; baseline doc:91-92) | OVERSTATED: **90.1–90.7%**. 17 of the 975 `bash_partial` lines rode a command whose every mention of the named file is a full unpiped `cat` (e.g. `cat tests/doctor-update-pending.test.mjs; echo; sed -n 740,830p tests/hook-update.test.mjs`); 24 if a call that both `wc`s and `cat`s the file counts. Ruler `triggerKind` applies PARTIAL_BASH_RE to the whole command, so any `sed -n`/grep/head/wc elsewhere marks it partial. The 39.7% (25/63) vs 69.0% (673/975) comparison inherits the same class. Conclusion unchanged. | own segment-level classification of each triggering command |
| P3-1 | P3 | "1 an earlier prompt of the same session" (commit 68c70950; baseline doc:105) | UNVERIFIABLE as attributed: the one row is `P#1003 继续`, matched by exact equality (<12 chars) to an earlier `继续`; `继续` is also a typed prompt in 2 other corpus sessions (a8de9cbe, c7347a85), so the text cannot say whose prompt P#1003 is. The 8 current-prompt echoes CONFIRMED: none of the 8 texts occurs in any other session. | ruler's `isEcho` imported + cross-session scan |
| P3-2 | P3 | "Was the whole pick (about 12 rows)" (README.md:1144); "about 12 rows on this machine" (commit d84e0efe) | IMPRECISE: Recent rows per SessionStart block 7–13, mean **9.4** (565/60); per project 11.3 (claude-mem-lite), 10.8, 8.1, 7.6. Cap 5 keeps 300 of 565 (matches the ruler's 745 -> 480 lines). | own walk |
| P3-3 | P3 | "同一会话内重复注入同一教训（压缩后重新计）：pretool 12.7%（111/876），error_recall 29%（137/468），fyi 8%，约 0.8 KB/会话" (baseline doc:109) | CONFIRMED only on an unstated caliber: a repeat counts when the id was injected earlier by ANY of the three faces. Per-face repeats are 78/876 (8.9%), 89/468 (19.0%), 7/100, 0.55 KB/session. Say "across faces". | own walk, 4 caliber variants |
| P3-4 | P3 | "18.57 KB/session (74.2% of all hook context)" / "全部 hook 25.02" (commit 185801bb; baseline doc:42) | Population omits `hook_blocking_error` attachments (Stop feedback, model-visible): 33 blocks, 0.28 KB/session, all another plugin's. Counted: 25.30 KB/session, share 73.4%. Plugin's own figure unaffected. | own walk |
| P3-5 | P3 | README.md:1158 FILE_INTEL "on the first `Read` of a large file" | The line also rides Bash views (cat/sed -n/head): 997 of the corpus's 1,102 lines did. | ruler trigger split + own classification |
| P3-6 | P3 | CHANGELOG draft (after doc:78) "Later recall blocks … carry a short directive" | Only blocks that carry a directive (Edit with lessons, Read→Edit nudge) carry the short form; Read blocks carry none. | scripts/pre-tool-recall.js emitRecallBlock |
| P3-7 | P3 | commit 68c70950 "or a prefix covering >=80% of it" | Code is symmetric: either text a prefix of the other, >=80% of the LONGER (prompt-search-utils.mjs isPromptEcho; its docblock says this correctly). | code read |
| P3-8 | P3 | "hook_scan.py 把 systemMessage 也算进去了" (baseline doc; rulers.md) | CONFIRMED (hook_scan.py:38) and incomplete: it also adds `reason`, and for non-JSON `hook_error` it counts stderr. | file read |

## Claims table (CONFIRMED unless marked)

| Claim | Site | Verdict | Evidence |
|---|---|---|---|
| 52 sessions, 4 projects, 212 files, frozenAt 2026-10-16T00:58:58Z, window [09-30, 10-16) | baseline doc, MANIFEST | CONFIRMED | MANIFEST read + 212 sha256 recomputed, listing hash recomputes |
| 18.57 KB/session plugin, 25.02 all, 6.45 others, 74.2% | commits, both docs, rulers.md | CONFIRMED (see P3-4) | ruler run + independent Python recount: 18.57 / 6.45 / 25.02 / 74.2% |
| per-face table (pretool 9.96/1,546; SS 3.09/60; ups_context 2.24/41; ups_search 1.53/87; posttool 1.24/138; failure 0.52/51) and every class row | baseline doc | CONFIRMED | ruler + independent recount of face totals and fires |
| handoff split 1.16 / 0.54 / 0.39 | baseline doc | CONFIRMED | own section walk (sum 2.09) |
| 1,546 blocks: 779 lessons / 340 nudge-only / 426 file-info-only / 1 reread; 767 without lessons (49.6%), 27.6% | commit 185801bb, docs, rulers.md | CONFIRMED | own block-mix walk |
| header 2.78 KB/s on all 1,546 blocks | commit c28c32f4, lib comment | CONFIRMED (count); "same 95 bytes" WRONG (P2-3) | own header census |
| Read→Edit nudge repeated the full ACK directive on 340 blocks (2.03 KB/s) | commit c28c32f4 | CONFIRMED | 413 directive lines (340 nudge + 73 edit), 413/413 contain ACK_DIRECTIVE byte-exact |
| ACK_DIRECTIVE moved byte for byte | commit c28c32f4, lib comment | CONFIRMED | main's literal === lib export (node compare) |
| 1,102 file-info lines; trigger 975 / 42 / 63 / 22 | docs | CONFIRMED as the ruler's classes; "92.3% partial" P2-4 | ruler + own classification |
| 39.7% (25/63) vs 69.0% (673/975) | commit 0c840368, code comment, baseline | CONFIRMED (numbers; class caveat P2-4) | own later-slice walk reproduces 25/63, 673/975, 31/42, 12/22 |
| 0/1,102 size named | same | CONFIRMED | a looser detector (fname + any "N tok" same turn) finds 4 hits, all false (a Chinese "300 token" sentence) |
| PreToolUse additionalContext delivered "next to the tool result" (hooks reference, "Add context for Claude") | commit 0c840368, code comment, ruler docblock, baseline | CONFIRMED | code.claude.com/docs/en/hooks fetched 2026-10-16: placement list "PreToolUse, PostToolUse, PostToolUseFailure, and PostToolBatch: next to the tool result"; "Claude reads the reminder on the next model request" |
| official doc advises factual wording | baseline doc | CONFIRMED | same page: "Write the text as factual statements rather than imperative system instructions" |
| plain stdout of SessionStart/UserPromptSubmit is context; systemMessage is user-facing | ruler docblock, rulers.md | CONFIRMED | same page ("Exit code 0"; universal fields table) |
| Recent ids cited 2/498 (0.4%) | commit d84e0efe, hook-context.mjs comment, baseline | CONFIRMED | own walk with own `#NN` extractor: 498 pairs, cited {184, 210} |
| Deferred D# named 51/190 | baseline | CONFIRMED | own walk |
| activity run 4/52 | commit 25b14389, dashboard comment, baseline | WRONG (P2-1) | — |
| mem-events line in 56/60 SS blocks | commit 25b14389, dashboard comment | WRONG (P2-2) | — |
| past questions 52 rows, P# named 0/52, 8 echo the triggering prompt | commit 68c70950, prompt-search-utils docblock, baseline | CONFIRMED | ruler isEcho + cross-session check (none of the 8 texts elsewhere) |
| "1 an earlier prompt of the same session" | same | UNVERIFIABLE (P3-1) | — |
| mechanism: hook.mjs user-prompt writes the current prompt (with cc_session_id) into user_prompts while UPS search runs | commit 68c70950, UPS comment | CONFIRMED | hook.mjs:3443 INSERT … cc_session_id; hooks doc "All matching hooks run in parallel" |
| SQL excludes current session, NULL legacy rows stay; echo filter runs before OR relaxation | commit 68c70950, comments | CONFIRMED | scripts/user-prompt-search.js:594, 611-619 |
| 1780253d: old tests let `return false` in the prefix branch survive; new tests kill it and the dropped 80% bound | commit 1780253d | CONFIRMED | mutation runs: M1 vs 68c70950 test file 4/4 pass (survives); M1 vs HEAD tests 1 failed/8; M2 (drop bound) 1 failed/8; mutations applied (git diff --stat 1 file) and reverted |
| handoff in 33 sessions, 33/33 also had Last Session/Working State, 39.47 KB | baseline | CONFIRMED (ruler) | ruler --value |
| D#104 A/B legacy 6/162 vs factual 2/158, p = 0.21 | baseline | CONFIRMED | docs/measurement/rulers.md citation entry |
| 2026-10-15 re-check: original measurement at 21:35:24Z (session eea2ca87) | baseline | CONFIRMED | first hook_scan tool_use in eea2ca87 stamped 2026-10-15T21:35:24.001Z |
| hook_scan copy 48 / 25.6 / 18.56; ruler 49 / 25.10 / 18.31; header 2.77, lessons 2.58, file-info 1.54, nudge+directive 2.35 | baseline | CONFIRMED | re-ran ruler on the live store with --until 2026-10-15T21:35:24Z (49 / 25.10 / 18.31; 1.99+0.36); re-ran a hook_scan copy (SELF excluded, records cut) -> 48 / 25.56 / 18.56 |
| hook_scan.py counted systemMessage as model-visible | baseline, rulers.md | CONFIRMED (P3-8) | hook_scan.py:38 |
| cite table pretool 3/332, error_recall 1/366, fyi 1/93, ups 1/14 with CIs; 6 cites total | commits, docs, rulers.md | CONFIRMED | citation-live-replay --json on the frozen root |
| citation-live-replay reads identical pairs and hits per face on both roots | commit c8d7f645, after doc, rulers.md | CONFIRMED | the two --json outputs are byte-identical (diff exit 0) |
| after-arm 18.57 -> 12.66; 25.02 -> 19.11; pretool 9.96 -> 4.60; header 1,546 -> 52 lines; blocks 1,546 -> 1,120; Recent 1.02 -> 0.57 (745 -> 480); dashboard 0.20 -> 0.13; past q 0.20 -> 0.16 | after doc, commits, rulers.md | CONFIRMED | ruler --project; INDEPENDENT re-projection of C1/C2/C3 in Python gives 1,120 blocks, 52 headers (45 sessions with pretool + compaction resets), 49 full + 364 short directives, pretool 4.60 KB/s |
| projected root measures 12.66 directly | after doc | CONFIRMED | ruler on -projected root: 12.66 / 19.11; regenerating --write-projected from HEAD gives a tree identical to the stored one (diff -rq clean) |
| identity self-check passed on 1,923 blocks; both checks reachable from main() and driven to fail in tests | commit c8d7f645, after doc | CONFIRMED | ruler output; 1,923 = 1546+60+41+87+138+51 non-empty plugin blocks; tests/injection-budget.test.mjs:290-309 THROW cases; main() calls both |
| 4.66 KB gap to 8 KB; remaining big items (2.66, 2.09, 1.65, 1.01, 1.45); dropping Recent saves ~0.57 more | after doc | CONFIRMED arithmetic | ruler rows |
| marker keyed like the cooldown (threadKey); cleared on SessionStart(compact); reaped by the 24h GC | commit c28c32f4, lib, after doc | CONFIRMED | pre-tool-recall.js:556-557 + recallShownPath; hook.mjs:3111; hook.mjs PRE_RECALL_COOLDOWN_STALE_MS = 24h + RECALL_SHOWN_PREFIX in the GC |
| all three emit sites go through emitRecallBlock; verdict/bind/bridge keep full text | commit c28c32f4, README | CONFIRMED | diff of scripts/pre-tool-recall.js |
| HEADER_ONCE=0 / DIRECTIVE_ONCE=0 restore every-block text | commit, README | CONFIRMED | lines are pushed only under the old showFraming conditions (file-intel, lessons, PRETOOL_NUDGE), so header-on-every-block equals the old output |
| post-tool-recall.js header only in the bind arm | after doc | CONFIRMED | scripts/post-tool-recall.js:51,101 |
| README defaults: FILE_INTEL off (1/on/true/yes), HEADER_ONCE on, DIRECTIVE_ONCE on (0/off/false/no disable), STARTUP_RECENT_ROWS 5 (int >= 0, 0 hides) | README | CONFIRMED | lib/file-intel.mjs fileIntelEnabled; lib/recall-shown.mjs isOn; hook-context.mjs recentTableRowCap (envNumber default 5, min 0, integer) |
| README FILE_INTEL row corrected from "past observations about the file" | commit 0c840368 | CONFIRMED | main README row |
| CLI `context` shares the builder and the cap | commit d84e0efe | CONFIRMED | mem-cli.mjs:1828 (hook-precompact.mjs:28 shares it too, unmentioned) |
| Recent cut does not touch injected-id markers | (implicit in "knapsack/token budget unchanged") | CONFIRMED | collector records Key Context ids only (hook-context.mjs:747-759) |
| `activity recent` still documented | dashboard comment | CONFIRMED | README.md:127 |
| C2 "two metrics tests now opt in"; C6 "two tests now assert the 🔄 Continuation pointer" | commits | CONFIRMED | test diffs |
| CLAUDE.md 20,479 -> 20,466 B, under the 20 KB cap | commit 1ca93d69 | CONFIRMED | wc -c on main / HEAD; cap 20,480 by the house convention (prior audits); no test enforces it |
| rulers.md entry: caliber, population, freeze, after-arm, self-checks, readings, two corrected premises | rulers.md | CONFIRMED | each item checked above |

## Out-of-lens observation (not a claim, flagged for the defect reviewer)

- tests/hook-context.test.mjs:1319-1324 ("0 hides the table") fails with `MEM_NO_AUTO_ADOPT=1`
  (1 failed / 66 skipped): received `### Recent Activity\n- row2 title…`, the existing fallback
  section (no summary, not quiet) matching `/### Recent/`. It passes in the default env because the
  repo cwd counts as adopted (steering injected -> effectiveQuiet). Same shape as CLAUDE.md's
  effectiveQuiet invariant. The house rule forbids a global MEM_NO_AUTO_ADOPT suite run, so CI is
  not red; the assertion still depends on adoption state. Uncertain because a run with
  `MEM_QUIET_HOOKS=1` added also failed, which I did not explain.
- Six branch test files run together under a sandboxed HOME + MEM_NO_AUTO_ADOPT=1: 215 passed,
  1 failed (the hook-context case above); injection-budget, recall-shown, ups-past-question-echo,
  startup-dashboard and pre-tool-recall all green. The hook-context case passes in the default env.

## NOT CHECKED

- "提交后的版本在冻结根上重跑，计数与冻结时的输出逐行相同": no freeze-time output is stored. UNVERIFIABLE.
- Whether a `sed -n a,bp` call actually covered the whole file (P2-4 counts command form only).
- Savings estimates for cuts not made (~0.6 KB repeat-as-id, 0.1–1.0 error recall, 0.5–1.0 handoff).
- Behaviour claims: the header's #7758 purpose, "a thread needs each once", and model behaviour
  under shorter context; a projection cannot show them (the docs say so).
- Subagent-thread injections: the ruler reads the main thread only (sidechain skipped, subagent
  files not walked for bytes). KB/session is main-context only; subagent cost after C1 not measured.
- No live hook run of the marker write/clear path; only unit tests.
- Full suite not run.
- Interaction with the recall-framing A/B: after C1 a factual-arm session sees the file-naming
  header once per thread instead of on every block; `pretoolFramingOf` still labels the session
  from its first block. Whether an open readout depends on the old per-block dose was not checked.
