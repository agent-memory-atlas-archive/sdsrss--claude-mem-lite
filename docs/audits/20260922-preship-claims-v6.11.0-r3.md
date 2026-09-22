> **Added when this report was committed (v6.11.0 release), not part of the review.** It ran
> against the SECOND build of this series (head `4324be9`), whose prose it audited; that build was
> then rebuilt once more to apply these findings, so its SHAs do not exist on `main`. Old ->
> shipped: `b7c45cd` -> `e12564b`, `842b629` -> `4d8393c`, `fbd6bf0` -> `d409c8c`, `481cee7` ->
> `91493ad`, `7179a88` -> `9c41144`; `4324be9` was the unreleased release commit.

# Pre-tag CLAIMS review, round 3: claude-mem-lite v6.11.0 repair (b2e3575 -> 4324be9)

Lens: is what the rewritten prose SAYS true? Everything was re-measured; nothing was accepted
because the author's reasoning read well. Scope: every sentence that differs between b2e3575 and
4324be9 in `*.mjs`, CHANGELOG.md, both READMEs, baselines.md and CLAUDE.md; all six commit
bodies compared with their b2e3575-series counterparts; the SHA mapping notes prepended to
docs/audits; and a by-entity sweep of round 2's F1-F12 / M1-M7.

## Anchor
```
$ git rev-parse HEAD              -> 4324be9b6733834f9560d675552372dc8002e32e
$ git log --oneline 4a4e422..HEAD -> 4324be9 7179a88 481cee7 fbd6bf0 842b629 b7c45cd (6)
```
The main repo was read-only throughout. I ran probes in tree-r3-jNcY. Before starting I checked
it with `diff -rq` against a fresh `git archive 4324be9`: identical. Every mutation was reverted
from a file copy and its sha256 checked against the pristine archive. The final `diff -rq`
against that archive is clean (TREE-CLEAN). The suite had left two EMPTY directories
(`tmp/` and `tests/.tmp-prompt-search-dir/`); I removed both. That residue is out of lens; see
the end of this report.

The full suite ran once (`vitest run --coverage`): 422 files / 6528 cases. It has 2 failures,
both caused by the tree having no `.git`: `pre-commit-hook-sync` and
`suite-touches-no-repo-files`, the same pair round 2 documented. There was 1 skip. Because of
those 2 failures the coverage report was not emitted, and I did not re-run the full suite. All
other runs used targeted files, each with a no-op control.

## Tally
| verdict | count |
|---|---|
| FALSE | 4 (1 is a round-2 FALSE surviving in an unswept copy) |
| TRUE-BUT-MISLEADING | 4 (1 is a round-2 UNVERIFIABLE item surviving in an unswept copy) |
| UNVERIFIABLE-HERE | 6 |
| TRUE | 42 |
| **total** | **56** |

---------------------------------------------------------------------------------------------
# FALSE

## F1. "at least about 460 bytes" is not the minimum. 428 bytes overruns the cap.
Where: CHANGELOG.md v6.11.0: "a single line carrying more than 32 of these adjacent labelled
values — at least about 460 bytes, deliberately constructed — still stores the ones past the
32nd."
The `:\s*` separator does not require the space. review-c/cap.mjs on the shipped scrubber:
```
token: AAAAAA sp   n 32 bytes 447 unscrubbed 0 idempotent true
token: AAAAAA sp   n 33 bytes 461 unscrubbed 1 idempotent false
token:AAAAAA nosp  n 32 bytes 415 unscrubbed 0 idempotent true
token:AAAAAA nosp  n 33 bytes 428 unscrubbed 1 idempotent false
```
So 428 bytes leaves one value unscrubbed. "At least ~460" states a floor that is 7% too high. Round 2
had already printed 428 ("461 bytes (428 without the space after the colon)"), and the prose
took the other number. The secret-scrub.mjs comment "~447-byte chain" for REACHING the cap is
also the spaced form (415 without spaces). It uses "~" rather than "at least", so I did not
grade it FALSE.

## F2. "90 s is a budget eight other cases in this repo already carry": the count is 7 cases.
Where: tests/install-lifecycle.test.mjs:501-502 ("90 s is a budget eight other cases in this
repo already carry") and the b7c45cd body ("90000 is a value eight other cases in this repo
already carry").
```
$ git grep -nE "\},\s*90[_]?000\)" 4a4e422 -- tests
audit-fixes-20260816.test.mjs:445 / :747 / :793
audit-silent-20260814.test.mjs:864 / :878
binding-error-diagnosis.test.mjs:160
fts-corruption-query-time-remedy.test.mjs:235
tests/sandbox/phaseB-npm.mjs:652        <- `setTimeout(() => l.kill('SIGTERM'), 90_000)`
```
I walked back from each hit to its enclosing callback. The first 7 all close an `it(`. The
eighth hit is a kill timer inside the sandbox harness. That file is not a vitest file and the
line is not a test budget. `tests/doctor-install-shape-e2e.test.mjs:115` `timeout: 90000` is an
execFileSync option, also not a case budget. So 7 other cases carry 90000, and the eighth is a
grep hit that nobody opened. The 34% arithmetic (90000/67327 = 1.337) is TRUE.

## F3. "only an injected probe that throws can drive it" is too wide.
Where: lib/doctor-hook-interpreter.mjs, `probeBash` docblock (new in this rewrite): "The
dispatch's outer catch is unreachable through this function altogether … so only an injected
probe that throws can drive it."
The first half is TRUE: `probeBash` catches everything. The "only" is false. The try block
also calls `resolveBashHookCount(...)` and the injected `ok`/`dwarn`, and both can throw:
```
settingsCommands:['bash "/d/a.sh"', null]      -> W Hook interpreter: check failed — Cannot read properties of null (reading 'includes')
ok: () => { throw new Error('EPIPE') }         -> W Hook interpreter: check failed — EPIPE
```
In production the risk is low: `settingsHookCommands` (plugin-cache-guard.mjs:129) pushes only
`typeof command === 'string'`. The comment's scope word still covers two other drivers that
exist. The 481cee7 body scopes it correctly ("cannot be reached through the real probe at
all").

## F4. Round-2 F11 survives in one copy: "two of its four outcomes need a machine without bash"
Where: tests/doctor-hook-interpreter-dispatch.test.mjs:8: "so two of its four outcomes need a
machine without bash."
The 481cee7 body and the lib docblock were both corrected to "one of its four", and the body
calls the old wording a draft error ("A draft said two of the four needed a bash-less machine;
only one does"). The code shows one: only the `count>0 && !bashPresent()` branch needs bash to
be absent (lib/doctor-hook-interpreter.mjs:156-169). The retraction reached 2 of 3 copies.
Command: `grep -rnaI "two of its four" . --exclude-dir=node_modules --exclude-dir=audits`.

---------------------------------------------------------------------------------------------
# TRUE-BUT-MISLEADING

## M1. The password-family leak examples give a condition that is necessary but not sufficient.
Where: CHANGELOG.md ("for example `token: <v> secret: <v>`, or `password: <v> passwd: <v>`,
when the first value ends in a letter — the first value was scrubbed and the second stored as
written"). The 842b629 body ("It crosses patterns too — `token: <v> password: <v>` leaked the
password").
Grid on v6.10.3's scrubber (4a4e422 secret-scrub.mjs) against the shipped one,
review-c/scrub-grid.mjs. The grid is 6 labels x 6 labels x 3 first-value shapes x 4
second-value shapes = 432 inputs:
```
old leaks second (first scrubbed): 108   new leaks: 0
by first ending  { letter: 54, alphaOnly: 54 }             <- digit-terminated first: 0 (claim TRUE)
by second shape  { alnumLetter: 18, alnumDigit: 18, alphaOnly: 54, longAlpha: 18 }
token/secret/bearer -> token/secret/bearer         : leaks for EVERY second shape
anything -> password/passwd/passphrase             : leaks ONLY for alphaOnly (10 letters)
password-family -> token-family                    : never
```
The password family has a second, unguarded pattern (1b, secret-scrub.mjs:78). It scrubs any
value that is not 1-15 ASCII letters, even in "prose" position. So `password: <v> passwd: <v>`,
and token followed by password, leaked only when the SECOND value was letters-only and at most
15 characters long. Alphanumeric passwords were caught. The token-family example is accurate
under its stated condition. The passwd example is accurate only under an unstated second
condition. The author's correction of round 2 is TRUE: the leak does cross patterns, as the
4324be9 body says. But the example chosen to show it has the narrowest reach of the shapes.

## M2. CHANGELOG D#53: "the stale temp files `doctor` counts are the ones `cleanup` removes" names one exception and omits the other.
The CHANGELOG adds the sandbox exception ("cleanup also reaps leftover test sandboxes … its total
can be higher"). That exception is TRUE: `sweepStaleTestFixtures` adds to `removed`,
install.mjs:3050-3060. The other exception runs in the opposite direction. While install.lock is
held, cleanup skips update residue (install.mjs:2984-2986). The scanner has no such gate, so
doctor counts files that cleanup declines to remove. The 7179a88 body and install.mjs:2564-2567
both disclose this. The shipped-to-users note does not, so "the ones cleanup removes" is wrong
mid-self-update.

## M3. The "76 files / 14 budgeted" counting rule does not reproduce as literally stated, and the tree is ambiguous.
Where: b7c45cd body ("numbered 76, and 14 of them give any case a `}, <ms>);` budget") and
tests/install-lifecycle.test.mjs:506-509 ("numbered 76 on this tree, and 14 of them").
```
rule execFileSync\(process\.execPath|spawnSync\(process\.execPath|INSTALL_PATH   (tests/, recursive)
 4a4e422 files=75   b7c45cd files=75   4324be9 files=76 (+ doctor-stale-temp-agreement, from 7179a88)
budget `\}, *[0-9_]+\);`          b7c45cd 13   4324be9 13
budget `\}, *[A-Z_0-9]+\);`       4324be9 14   (a named constant counted as <ms>)
```
On b7c45cd's own tree the rule gives 75, not 76; 76 holds for the release tree only. The
literal `<ms>` gives 13. 14 needs an identifier to count as a budget. The conclusion ("most
such files run on the global 20 s") holds under every variant.

## M4. Round-2 U6 was fixed in the CHANGELOG and the body, but one copy survives: install.mjs:2578-2579
"An episode file younger than the gate is work in progress — it exists for ~60s after every
Stop hook". The CHANGELOG now reads "After a session turn that hands an episode to the
summarizer … for up to about a minute", and the 7179a88 body reads "up to about a minute after a
Stop that hands one to the summarizer". Both are right: lib/time-constants.mjs:27 calls ~60s
the WORST-CASE round trip, and a flush happens only when a turn hands off an episode. This copy
still says every Stop, for ~60s. Found with
`grep -rnaI "every Stop" . --exclude-dir=node_modules --exclude-dir=audits`.

---------------------------------------------------------------------------------------------
# UNVERIFIABLE-HERE
U1. Timings: .mcp.json case 4970/5122/5154 idle and 23958/29385/40908 contended;
    bad-settings 5748/5758 at "load 5-7", 20172 at 6.91, 37952 at 9.96; 67327 ms and "timed out
    at 60 s once in about 20 full-suite runs" (quoted from round 2, which reported exactly that);
    "failed every pre-commit attempt"; "beat it within the hour"; "417 ms". This is a shared box.
    My one full run took 40 s wall at load 2-9 and did not break out these cases.
U2. Live-DB readings: union concepts 74; per-project 20/16/11/11/6/6/3/1 (the sum is 74,
    consistent); 287 non-empty / 0 modified. The later re-read of 78 matches round 2's printed
    output verbatim. "452 … ~39% of it empty strings": 39% is round 1's figure at NOT NULL = 473
    (186/473). At 452 the share is unknown. If non-empty were still 287, it would be 36.5%.
U3. Global coverage "85.82 / 80.07 / 91.05 / 87.01, read on 7179a88": no report was emitted in
    my single full run (see above). Round 2 read 85.84/80.09/91.11/87.01 on 773dedb. Between
    773dedb and 7179a88 the code changes are comments and one moved JSDoc block, plus one test
    case, so an unchanged reading is plausible but was not re-measured here.
U4. "the 28 test files that import the module or drive doctor or cleanup (709 cases)": the
    selection rule is not recorded. I re-ran the mutations on the two decisive files instead
    (see TRUE 6-8).
U5. "The ledger's entry read the UNION (concepts 73)": no D#51 or "concepts 73" string is found
    in .converge/*.md today. v6.10.3's CHANGELOG:44 carries the same union reading
    ("concepts 73 of 111 live rows … three of six slots per cycle"), so the substance holds.
U6. "RED first — the drain case read 3 against a 5-row backlog": consistent with the
    arithmetic (old fillCap = half = 3). Not replayed on a pre-change tree.

---------------------------------------------------------------------------------------------
# Round 2 F1-F12 / M1-M7: sweep status (entity grep, `grep -rnaI`, no type filter, node_modules + docs/audits excluded)
| item | entity grepped | status |
|---|---|---|
| F1 26 slots / per-project fan-out | `26 slots`, `fans out one scoped`, `per project it is worse` | FIXED. Only retraction notes remain (hook-optimize.mjs:1755, tests/hook-optimize.test.mjs:584). |
| F2 per project / ceiling 6 | `per project per cycle`, `each project.s budget`, `a project whose main pool` | FIXED. README x2, CHANGELOG and the fbd6bf0 body now say per machine per day and name the scopes pass (verified at hook-optimize.mjs:1792-1795: `Math.min(budget.reenrich, …)`). |
| F3 "only the daily pass" | `only for the daily background`, `只影响每日` | FIXED for re-enrich. Both READMEs name manual `optimize --run` / `mem_optimize` (both reach optimizeRun: mem-cli.mjs:3584, server.mjs:1619). The hits at README.md:294 / zh:242 are the v6.8.0 normalize section, a different claim, and were not re-graded. |
| F4 6 red / 2 red | body text | FIXED: now 7 and the same 7. Reproduced (TRUE 4). |
| F5 kills 6 | body text | FIXED: now 7 (6 + audit-r10). Reproduced (TRUE 6). |
| F6 narrow unreachable | `structurally unreachable`, `aliasesPool >= narrowPool` | FIXED. Only the correction text remains (test:667). |
| F7 three twins | `three hand-kept`, `hand-kept twin` | FIXED: "two rules … at four sites" (verified at 4a4e422: install.mjs 2662/3073 + 2670/3114; 0 at HEAD). |
| F8 452 | `\b452\b` | FIXED: every live copy is now a retraction note. |
| F9 "not a silent partial" | `silent partial` | FIXED. property.test.mjs:134 ("a cap being hit is a silent partial scrub") agrees with the current source. |
| F10 `token: alice` | `token: alice([^bw]\|$)` | FIXED in prose (all copies now say alicebob). tests/audit-r10-secret-gaps.test.mjs:132 still asserts `'the token: alice'` is unchanged. That assertion is true, but it cannot see the guard. It is a test, not prose, and was not graded. |
| F11 two of four | `two of its four` | **NOT FIXED in 1 of 3 copies**: tests/doctor-hook-interpreter-dispatch.test.mjs:8 (F4 above). |
| F12 same fixture | body text | FIXED: "it takes the fourth, aged file". |
| M1 leak condition | CHANGELOG / READMEs | PARTLY FIXED. The letter condition is stated and EN/zh agree. The password-family example needs an extra unstated condition (M1 above). |
| M2 allowlist | `allowlist` | FIXED: "excluded … by name" in the docblock, the 481cee7 body and the CHANGELOG (vitest.config.mjs:154 include `'*.mjs'`, :175 exclude `'install.mjs'`). |
| M3 N+1 | `N+1 sweeps` | FIXED: both remaining copies are letter-qualified (secret-scrub.mjs:315, tests/secret-scrub-coverage.test.mjs:952). |
| M4 both faces carried "1h" | `both faces used to`, `fourth hand-kept` | FIXED. |
| M5 five readings | `five readings` | FIXED: six, and 6 values listed. |
| M6 214,681 / changed-only | `214,?681`, `changed-only-by` | FIXED: the body now gives 216,070 / 663 / 16 (reproduced, TRUE 9). |
| M7 47% headroom | `47%` | FIXED: the budget is now 90 s, with the history recorded. |
| (U6) ~60s after every Stop | `every Stop` | CHANGELOG and body fixed; install.mjs:2579 survives (M4 above). |

---------------------------------------------------------------------------------------------
# TRUE (command -> observation)
1. Anchor as briefed. Audit notes: the r1 map 05121eb/0867145/f3cd4a5/a3fe871 -> 842b629/
   fbd6bf0/481cee7/7179a88 and the r2 map 1d85e4e->b7c45cd, 8bbe7b6->842b629, 44cc832->fbd6bf0,
   c86d795->481cee7, 773dedb->7179a88 pair commits with identical subjects. `merge-base
   --is-ancestor`: none of the 10 old SHAs is on main ("None of those SHAs exist on `main`").
2. Suite: 422 files / 6528 cases, 1 skipped (+2 no-.git failures) -> the CLAUDE.md row and the
   CHANGELOG "422 / 6528".
3. Per-commit deltas, static `it(`/`test(` count per changed test file plus new lib/ .mjs:
   b7c45cd 0; 842b629 +10 (property +1, coverage +9); fbd6bf0 +3; 481cee7 +9 +1 generated;
   7179a88 +12 +1 generated. Sum +36 = 6528 - 6492. 4324be9 touches no .mjs/.js (`git show
   --name-only`), so "adds no case" holds.
4. 842b629 mutations (targeted: secret-scrub-coverage, property, import-jsonl-dedup-scrub;
   control 101/101): `MAX_SCRUB_PASSES = 1` -> 7 red; loop collapsed to `break;` -> the SAME 7:
   both D#52 leak cases, the D#46 idempotence case, both cap cases, the property restatement
   and the dedup restatement, exactly as named. The prose case "a real secret in the string
   leaves the prose-position keyword alone" stays green, as its rewritten comment says.
5. The rewritten test header says the prose-alongside-overrun case is "what would catch [the
   guard-stripping fallback] coming back". I mutated the scrubber to re-run all patterns with
   the lookbehind stripped once the cap is hit: 1 red of 101, exactly "does not corrupt prose
   elsewhere in the string when the cap is overrun".
6. 7179a88 "removing the age gate … 7 red: 6 in the agreement file … and audit-r10's 'keeps a
   FRESH ep-flush/pending file'": `return 'stale'` -> 7 red, exactly that split (control 30/30).
7. "dividing the label by minutes … kills the new label case, and the in-flight detail case":
   `/ 60000` -> 2 red, exactly those two.
8. The boundary RED message: `>=` -> `>` kills the boundary case alone, with "expected 'stale' to
   be 'in-flight'".
9. The tracked-text scan: `git grep -I -h '' 4a4e422` gives 216,070 lines that are `!== ''`
   (216,063 if whitespace-only lines are excluded). Single sweep 663 changed, fixed point 663,
   onlyNew 0, output differs on 16. All 16 are this repo's own fixtures and notes: CHANGELOG 1,
   v6.8.0 audits 8, lib/import-jsonl.mjs 1, import-jsonl-dedup test 1, property test 5. The
   shapes are nested AccountKey / DSN, `?sig=`, and the D#52 `--token … secret:` line.
10. Grid (M1): the fixed point leaks 0 of 432. A digit-terminated first value never leaked in
    v6.10.3 (0 of 144). This confirms "Values ending in a digit … were not affected".
11. `the token: alicebob` -> unchanged; `token: alicebob` -> `token: ***`. With the three
    lookbehinds stripped (copy of the scrubber), `the token: alicebob` -> `the token: ***`
    ("stays readable only because of it"). `alice` is never scrubbed in either position (5 < 6).
    The source holds 3 guarded patterns (lines 74, 83, 123) and `SECRET_PATTERNS.length` is 40.
12. Cap: 33-deep leaves 1 unscrubbed, 32-deep leaves 0. Past the cap `scrub(scrub(x)) !==
    scrub(x)` ("no longer idempotent … a second call scrubs further").
13. D#51 brute force, R 1..14 x pools 0..20^3 = 129,654 inputs: identity R - fillCap =
    min(R - half, mainPool) 0 failures; negative budgets 0; ab+cb > fillCap 0; main served less
    than under the old arithmetic 0 ("the identity, the bound and the non-negativity all hold";
    "introduces no input on which a backfill takes a slot").
14. The daily path is one unscoped run: hook.mjs:1764 is a single machine-wide gate file,
    hook.mjs:2004 `spawnBackground('llm-optimize')`, hook-optimize.mjs:1881 `optimizeRun(db,
    { reenrichScope: 'wide' })` with no project. The only per-project loop in hook-optimize.mjs
    is normalize's (:987) ("only normalize fans out").
15. Budget: `distributeBudget(15).reenrich` = floor(15 x 0.4) = 6; scopes pass = `Math.min(
    budget.reenrich, pool)`, so "up to 6 more short calls" holds.
16. `optimize --run` is the real flag (mem-cli.mjs:3452), and it and `mem_optimize` both call
    `optimizeRun` and enter the same narrow/wide branch ("behaves the same way").
17. README EN and zh-CN "Upgrading to 6.11.0" match sentence for sentence: per-run half,
    once per machine per day over all projects, 6 vs 3, the scopes pass +6, manual paths, the
    revert pin, and the letter-terminated leak condition.
18. install.mjs coverage population: vitest.config.mjs:154 include `'*.mjs'`, :175 exclude
    `'install.mjs'`, so "excluded … by name".
19. "one of its four outcomes needs a machine where bash is absent" (docblock, 481cee7 body):
    TRUE per the four branches at lib/doctor-hook-interpreter.mjs:143/152/154/156.
20. Lib coverage (targeted run, json-summary): doctor-hook-interpreter 88.88 / 78.26 / 87.5 /
    87.09, uncovered 100-105, which is the `probeBash` body (lines 99-107). doctor-stale-temp
    100/100/100/100 and absent from the text table.
21. "All 21 doctor test files (151 cases)": `tests/*doctor*` minus the later agreement file is
    21 files, 151 passed.
22. The hook-interpreter lib imports only `node:fs` and `node:child_process`.
23. knip name sets: 4a4e422 and 4324be9 both give exports 32, files 0, binaries 3, with
    identical names on both sides ("identical … to the reading taken before the series").
24. EPISODE_AGE_LABEL is consumed at install.mjs:2586 and :3047. Math.round(20/60) = 0 gives
    "0h" as stated. The parse-back case exists and is killed (TRUE 7). The JSDoc now sits
    directly on `classifyEpisodeFile` (round-2 defect P3-1 is fixed).
25. "the two hook-side readers … still spell the gate themselves": ORPHAN_EPISODE_AGE_MS outside
    tests is read only in hook-shared.mjs (:153) and hook-llm.mjs (:1345), besides the lib.
26. install.mjs's own comment (2560-2567) now discloses the install.lock asymmetry, as the
    7179a88 body says.
27. Arithmetic: 20 s / 5.0-5.8 s = 3.5-4.0x; 67327/5748 = 11.7 (about 12x); 90000/5122 = 17.6
    (about 18x); 60000/40908 = 1.47; 90000/67327 = 1.34. The .mcp.json case lists six readings.
28. 4324be9 review tallies match the reports: r1 claims 4 FALSE of 41; r1 defect 0/1/5; r2
    defect 0/1/6; r2 claims 12 FALSE / 7 misleading of 68. The P2 was the "per project" note.
29. The superseded Baselines row in baselines.md:43-45 matches 4a4e422 CLAUDE.md:108-110
    byte for byte ("moved verbatim").
30. The 4a4e422 row "read directly … 420 / 6492" matches round 2's measured reading.
31. The 842b629 body's quotations of reviewer data match the audit reports: 14,000 inputs /
    96.9% reach / 720 / 22.5% / config position 0 of 7000 (r1 claims:252-271); 40,000 inputs
    max 7 sweeps (r1 defect:231); round 2's broader rule 96 / 19.
32. The fbd6bf0 body's "re-read … union main 0, concepts 78, old 3 -> new 6" matches round 2's
    printed probe output.
33. hook-optimize.test comment: narrow (default pool) has no `LENGTH(narrative) > 100` and no
    `notLowSignalTitleClause`, while aliases has both (hook-optimize.mjs:119-135 vs the default
    block), so "three short-narrative rows read narrow 3 / aliases 0" follows from the predicates.
34. "Five commits since v6.10.3", then the list: the 5 SHAs and subjects match `git log`, and
    b7c45cd's parent is 4a4e422 ("now FIRST").
35. Both readers of the stale rule at 4a4e422 kept 2 `stalePatterns` + 2 pending/ep-flush tests.
    HEAD has 0 of either in install.mjs ("now keeps none").
36. CHANGELOG "cleanup also reaps leftover test sandboxes, which doctor does not count" is TRUE
    (install.mjs:3050-3060 adds `swept.removed` to `removed`; the scanner has no such arm).
37. Update residue is not age-gated, and a case pins it: tests/doctor-stale-temp-agreement.test.mjs:123
    "update residue counts on both faces, and is NOT age-gated".
38. "`scrubSecrets` ran its 40 patterns" is TRUE on both 4a4e422 and HEAD (40 / 40).
39. The CHANGELOG security paragraph ("one sweep still catches exactly what it caught before,
    and the extra sweeps only ever redact more") matches TRUE 9: onlyOld = 0, onlyNew = 0, and
    the 16 differing lines are all additional redaction.
40. The CHANGELOG / README "Values on separate lines were never affected" is consistent with
    the mechanism: the lookbehind needs `[ \t]`. Round 2 measured newline input not leaking.
41. The CHANGELOG "read up to 67 s" for the two re-budgeted cases matches 67327 (U1 for the
    value itself). "about 5 s of real work" matches the 4970-5758 readings.
42. The 481cee7 body "`probeBash` is deliberately NOT exported": `grep -n "export function
    probeBash"` returns nothing, and no test names it.

---------------------------------------------------------------------------------------------
# Out of lens, for the defect reviewer
- A full `vitest run` in an archive tree leaves two empty directories: `tmp/` at the root and
  `tests/.tmp-prompt-search-dir/`. It also left a `/tmp/mem-scenario-a94ecdeb` directory
  timestamped inside my full run's window. The box is shared, so I cannot attribute that one
  with certainty, and I did not delete it. Thirteen 21-character vite `/tmp/<id>` directories
  are newer than my start; they are probably mine, but the box is shared and I left them. /tmp
  is at 15%.
- `tests/audit-r10-secret-gaps.test.mjs:132` pins `'the token: alice'` unchanged. That input
  cannot distinguish a working guard from a missing one: it is 5 characters, so the case passes
  with the lookbehind deleted.

Artifacts: review-c/{scrub-grid,cap,alice,tracked,tr16,knipnames}.mjs, mut.sh, M*/D0 logs,
cov-full.txt, cov-lib/, knip-*.json, spawn-*.txt. Pristine/reference trees deleted.
