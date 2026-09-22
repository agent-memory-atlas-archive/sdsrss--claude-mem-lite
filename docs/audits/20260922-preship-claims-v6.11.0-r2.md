> **Added when this report was committed (v6.11.0 release), not part of the review.** It ran
> against a series that was rebuilt afterwards to apply its findings, so the SHAs below do not
> exist on `main`. Old -> shipped: `1d85e4e` -> `e12564b` (now FIRST), `8bbe7b6` -> `4d8393c`,
> `44cc832` -> `d409c8c`, `c86d795` -> `91493ad`, `773dedb` -> `9c41144`; `b2e3575` was the
> unreleased release commit. Line numbers refer to those trees.

# Pre-tag CLAIMS review, claude-mem-lite v6.11.0 (4a4e422..b2e3575)

Lens: is what the prose SAYS true? Re-measured, not re-read. Code defects are the other reviewer's job.

## Anchor
```
$ git rev-parse HEAD                -> b2e3575d45fe3c5435bf76ace2ce32a6404247d5
$ git log --oneline 4a4e422..HEAD   -> b2e3575 773dedb c86d795 44cc832 1d85e4e 8bbe7b6 (6)
```
Main repo was read-only throughout. Probes and mutations ran in tree-claims-VoQx. Every mutated
file was restored from a file copy, and its sha was checked equal to `git show b2e3575:<f>`
(secret-scrub 39165a16, hook-optimize c41d7246, doctor-hook-interpreter 201abaee,
doctor-stale-temp 5d2a430a, the two test files a5214aa7 / 9f26b133). The .mjs/.js set at the
tree root and under lib/, scripts/ and benchmark/ matches `git ls-tree b2e3575` exactly: no
stray files. My per-commit trees were deleted when I finished.

## Tally
| verdict | count |
|---|---|
| FALSE | 12 (4 of them are earlier FALSE/misleading findings that were not corrected in every copy) |
| TRUE-BUT-MISLEADING | 7 |
| UNVERIFIABLE-HERE | 8 |
| TRUE | 41 |
| **total** | **68** |

Environment note. The tree comes from `git archive`, so it has no .git. Two cases fail in it
for that reason alone: `pre-commit-hook-sync` (needs `git ls-files`) and
`suite-touches-no-repo-files` (needs the origin remote). A no-op control run fails exactly
those 2 (M00). The mutation counts below have those 2 removed. For the per-commit suites I
ran `git init` plus a remote in each tree; the one remaining skip there is "no git hooks",
as CLAUDE.md says. The box was contended (load 10-14), and timing claims are graded with
that in mind.

---------------------------------------------------------------------------------------------
# FALSE

## F1. Re-enrich was measured per project, but the daily path makes ONE unscoped pass. "26 slots a day" is wrong.
Where: 44cc832 body ("the daily path fans out one scoped pass per project, so the split has
to be read per project, and per project it is worse"; "26 slots a day"). hook-optimize.mjs:1746-1749
("every project idled its reserved half every cycle — 26 slots a day"). The D#51 header in
tests/hook-optimize.test.mjs (same wording). CHANGELOG ("Measured on one machine's 8
projects … 26 slots a day went unused").

Code: the only daily caller is hook.mjs:2004 `spawnBackground('llm-optimize')`, which sits
behind the GLOBAL 24h gate `RUNTIME_DIR/last-auto-maintain.json` (hook.mjs:1764-1770). That
calls `handleLLMOptimize()`, which calls `optimizeRun(db, { reenrichScope: 'wide' })`
(hook-optimize.mjs:1874) with NO `project`. `findReenrichCandidates` then drops its project
clause (`project ? 'AND project = ?' : ''`, :89). The per-project fan-out is normalize's
(`normalizeOneProject`, :911), not re-enrich's.

Live DB, read-only handle (premise asserted: SQLITE_READONLY), probe-reenrich.mjs:
```
daily budget { reenrich: 6, ... }
UNION (daily path, project undefined): pools wide 0 narrow 0 aliases 0 concepts 78 scopes 0 -> old 3, new 6
per project: concepts 23/7/3/11/11/6/1/16 (all other pools 0)
```
So the daily path idles **3 slots a day** before the change, not 26. The per-project sum
(3×7 + 5 = 26) is correct arithmetic about a pass that never runs. v6.10.3's own CHANGELOG
had the right, union reading ("concepts 73 of 111 live rows … three of six slots per
cycle"). 44cc832 replaced it with the wrong one: a replacement justification written while
retracting a correct reading. The 6-where-it-made-3 headline still holds, because the union
reads 3 → 6.

## F2. "6 LLM calls per project per cycle" is wrong twice: the budget is not per project, and the ceiling is not 6.
Where: README.md and README.zh-CN.md ("reserves half of each project's budget"; "The
ceiling is unchanged at 6 LLM calls per project per cycle"; "a project whose main pool is
empty now reaches it"). CHANGELOG ("up to **6** LLM calls for that project per cycle").
44cc832 and b2e3575 bodies ("a project with an empty main pool makes up to 6").
- Per project: false on the daily path (see F1). The budget belongs to the whole database's
  daily run.
- Ceiling 6: the same branch also runs the `scopes` pass under a SEPARATE budget,
  `scopesBudget = Math.min(budget.reenrich, …)` (hook-optimize.mjs:1785-1788). That pass is
  "one cheap Haiku call per row" (:280-284) and is not carved out of the 6. So re-enrich can
  make 6 + 6 = 12 calls per cycle. The unchanged ceiling is 6 for main + aliases + concepts.

## F3. "One default changes, and only for the daily background pass" is too narrow.
Where: both READMEs ("只影响每日后台任务").
`optimizeRun` is shared. `mem-cli.mjs:3584` (manual `claude-mem-lite optimize`, default scope
narrow) and `server.mjs:1619` (MCP optimize, scope from args) both enter the same
`narrow || wide` branch, so a manual optimize also spends the fill cap now.

## F4. Mutation counts for 8bbe7b6: "single sweep -> 6 red" and "MAX_SCRUB_PASSES=1 -> 2 red"
Where: 8bbe7b6 body. The files involved are byte-identical between 8bbe7b6 and b2e3575
(`git diff --stat` shows nothing).
```
M01 `if (result === before || pass >= MAX_SCRUB_PASSES) break;` -> `break;`   7 red
M02 `MAX_SCRUB_PASSES = 32` -> `= 1`                                            7 red, the SAME 7
  import-jsonl-dedup-scrub > a scrubbed title still deduplicates across runs
  property > is idempotent, on the four shapes that used to prove it was not
  secret-scrub-coverage > scrubs the SECOND space-adjacent labelled secret
  secret-scrub-coverage > scrubs a run of three, not just the head
  secret-scrub-coverage > is idempotent: a second scrub changes nothing (D#46)
  secret-scrub-coverage > a chain that FITS inside the cap is still fully scrubbed
  secret-scrub-coverage > the overrun case scrubs what it reached — a residual, not a no-op
```
The body names "the cap case" (singular), but two cap cases go red. A cap of 1 is the
single-sweep loop by construction, so the two mutations cannot give different counts. The
"2 red" matches the earlier draft's cap block (prior review verified 2 there). The block was
restated with 2 more cases and the count was carried over.

## F5. 773dedb: "removing the age gate (the D#53 shape) kills 6 cases". I could not reproduce 6 under either construction.
```
M13  classifier: `return mtimeMs >= now - episodeAgeMs ? 'in-flight' : 'stale'` -> `return 'stale'`  -> 7 red
     (6 in doctor-stale-temp-agreement, plus audit-r10-installer-global-writes >
      "keeps a FRESH ep-flush/pending file": cleanup now deletes in-flight work)
M13b scanner only (doctor counts every episode file; cleanup untouched) -> 5 red
```
Both agreement cases are red under both constructions, which is TRUE. The author's exact
mutation text is not recorded, so this may be a third construction. But 6 is not the reading
of either natural one.

## F6. "Structurally unreachable with 'narrow' … aliasesPool >= narrowPool always"
Where: 44cc832 body, and the P2-1 comment in tests/hook-optimize.test.mjs ("the substitution
can only ever be more conservative").
The narrow predicate (hook-optimize.mjs, default pool) has NO `LENGTH(narrative) > 100` and NO
`notLowSignalTitleClause`. The aliases pool requires both. mine/narrow-probe.mjs uses the
test helpers, 3 rows, narrative "short narrative":
```
{ narrow: 3, aliases: 0 }
```
A narrow candidate is not necessarily an aliases candidate. When aliasesPool < narrowPool,
the `scope: 'aliases'` mutant UNDER-reads mainPool, which widens fillCap. That is the unsafe
direction, not the conservative one. The case that was added (the 'wide' shape) is still a
valid kill. Only the "only 'wide' can discriminate" argument is false.

## F7. "three hand-kept twins — `stalePatterns` at two sites and the `pending-`/`ep-flush-` test at two more" (prior F3, NOT corrected)
Where: 773dedb body. At 44cc832, install.mjs: `stalePatterns` at 2662 and 3073, the
pending/ep-flush test at 2670 and 3114. That is two duplicated rules over four sites. Two
pairs do not add up to "three twins". Nothing in the prose changed since the prior review
flagged it.

## F8. "0 of 452 live values" is still live in one copy (prior S1, swept 2 of 3 copies)
Where: tests/secret-scrub-coverage.test.mjs:880-881 ("0 of 452 live values across
text/subtitle/concepts/facts/search_aliases are modified"). The body and
secret-scrub.mjs:296-299 both retract 452 in favour of 287.
Re-measured read-only now: NOT NULL 473, non-empty 287, modified 0 (117 observations). The
287/0 claim reproduces exactly. The test header is the copy that did not get the retraction.

## F9. The test header quotes a source claim that no longer exists and is now contradicted
Where: tests/secret-scrub-coverage.test.mjs:941-944: "the claim in its comment ('hitting the
cap is not a silent partial scrub') would be an unverified assertion sitting in the source".
`grep "silent partial" secret-scrub.mjs` finds nothing. The shipped comment now says the
opposite: hitting the cap "leaves labelled secrets unscrubbed past the 32nd … the deliberate
choice". tests/property.test.mjs:134 says "a cap being hit is a silent partial scrub". This
header describes the earlier guard-stripping draft that review rejected.

## F10. "`the token: alice` still depends on it [the prose lookbehind]"
Where: 8bbe7b6 body and secret-scrub.mjs:283. The CHANGELOG copy is milder; see M1.
```
"the token: alice" => "the token: alice"
"token: alice"     => "token: alice"        <- config position, lookbehind irrelevant
"the token: alicebob" => unchanged ; "token: alicebob" => "token: ***"
```
The value class is `{6,}` and `alice` is 5 characters, so the phrase is never scrubbed,
with or without the guard. The dependency is real, but `alicebob` is the shape that shows it.
The old line-81 comment carries the same example; that is pre-existing and was not re-graded.

## F11. "two of its four outcomes need a machine without [bash]"
Where: c86d795 body and the lib/doctor-hook-interpreter.mjs `probeBash` docblock.
The four branches of `checkHookInterpreter` are: count null → ⚠; count 0 → ✓; count>0 with
bash present → ✓; count>0 with bash absent → ⚠. Only ONE needs bash to be absent. The
emptied-PATH E2E (tests/doctor-bash-hooks.test.mjs) reaches one outcome with two assertions
(the warning, and exit code advisory).

## F12. "Same fixture after this change: doctor says 1 found" (prior S5, NOT corrected)
Where: 773dedb body. The fixture described is three files with mtime=now. I ran both faces,
faces.sh, on sandbox HOMEs:
```
44cc832, 3 fresh:   doctor ⚠ Stale temp files: 3 found … | cleanup Kept 3 … / No stale files found.   (verbatim match)
HEAD, 3 fresh:      doctor ✓ Stale temp files: none + "3 episode file(s) newer than 1h are in flight" | cleanup same as before
HEAD, 3 fresh+1 aged: doctor ⚠ 1 found | cleanup ✓ Removed … / 1 stale file(s) removed.
```
The "1 found" reading comes from a 4-file fixture, not the same one. The fix behaves as
described.

---------------------------------------------------------------------------------------------
# TRUE-BUT-MISLEADING

M1. The READMEs and CHANGELOG say that when two labelled credentials sit on one line, "earlier
versions redacted the first and stored the second". This needs two conditions: both labels
are in the SAME prose-guarded pattern (token/bearer/secret, or password/passwd/passphrase),
and the preceding value ends in an ASCII letter. Measured on 4a4e422's scrubber:
`token: Abcdefgh1 secret: Abcdefgh2` → both scrubbed. `password: hunter2correct secret:
abcdefghij` → both scrubbed, because different patterns run in sequence.
`token: abcdefghij secret: abcdefghij` → the second leaks. The notice overstates, in the
alarming direction. The CHANGELOG's "`the token: alice` stays readable" is literally true,
but not because of the guard (F10).

M2. c86d795 body and the lib docblock say install.mjs is "outside the coverage `include`
allowlist". vitest.config.mjs:154 has `include: [..., '*.mjs']`, which covers install.mjs,
and :175 excludes it by name. The population is a DENYLIST, as CLAUDE.md says. The conclusion
(no coverage reading) is TRUE: install.mjs is absent from the v8 table.

M3. tests/secret-scrub-coverage.test.mjs:944-945 still says "N space-adjacent secrets need N+1
sweeps" without qualification (prior S2). The case comment two lines below qualifies it.
Measured: letter-terminated N=2/10/50 take 3/11/51 sweeps; digit-terminated take 2/2/2.

M4. 773dedb body and lib/doctor-stale-temp.mjs say "'1h' spelled by hand in two user-visible
strings … both faces used to carry the literal". At 44cc832 only cleanup printed "1h"
(install.mjs:3144). doctor printed no window. The second string was written in this change's
own draft.

M5. The 1d85e4e comment in tests/install-lifecycle.test.mjs gives "five readings" (idle
5122/5154). The body lists six (idle 4970/5122/5154). Different populations, same claim.

M6. 8bbe7b6 body: "Over 214,681 lines … changed-only-by-fixedpoint = 0". The metric
reproduces as 0 on 4a4e422's tracked text (216,070 non-empty lines; lines changed by the
single sweep = changed by the fixed point = 663). But the fixed point gives DIFFERENT output
on 16 lines. Examples: `deploy --token *** secret: hunter2correct` → `… secret: ***`, and
several `AccountKey=https://***:***@h` → `AccountKey=***`. The named metric cannot see extra
redaction on lines that were already touched. The fix also changes the output for nested
AccountKey/DSN shapes, which nothing in the prose mentions. It only redacts more.

M7. 1d85e4e: "60000 clears the largest observed reading by 47%". The arithmetic is TRUE
(60000/40908 = 1.47). But on this box during review, the bad-settings case took 67,327 ms and
timed out at the new 60 s once (mutation run M12, load avg 11-14). At 4a4e422 the two cases
read 37,441 and 41,763 ms. This is timing-based and not FALSE, but the headroom was exceeded
in 1 of about 20 full-suite runs here.

---------------------------------------------------------------------------------------------
# UNVERIFIABLE-HERE
U1. "7 sweeps was the max over 40,000 fuzzed inputs": the generator is not recorded.
U2. "214,681 lines of this repo's own tracked text": the population is not stated. I get
    237,723 lines, 216,070 non-empty, at 4a4e422.
U3. "directed grid (2940 inputs, 80.3% reach)" (test header): script not kept. The prior
    review's independent 14,000-input grid corroborates the mechanism, and the 8bbe7b6 body
    now quotes it.
U4. Timings 4970/5122/5154, 23958/29385/40908, 5748/5758, 20172/37952 ms, and "417 ms". My
    contended readings were in the same regime: .mcp.json case 7,567–37,441 ms, next-slowest
    case 839 ms.
U5. "76 test files spawn a node child process and only 14 give any case an explicit budget"
    (1d85e4e body, CHANGELOG). This depends on definitions: my narrowest regex gives 96 files
    spawning node, and 19 of them with an `it(…, N)` budget. Not reproducible without the
    author's rule.
U6. "~60s an episode is in flight after every Stop": ~60s is documented as the WORST-CASE
    round trip (lib/time-constants.mjs). A flush happens at Stop only when an episode buffer
    exists.
U7. "read from the json-summary reporter": the repo config writes no coverage-summary.json.
    The value (100/100/100) is TRUE from coverage-final.json.
U8. "Closes D#46, D#52, D#51, D#53": the ledger is local (.converge/).

---------------------------------------------------------------------------------------------
# TRUE (command → observation)

Per-commit suites, each on its own `git archive` tree, run back to back:
1. 4a4e422 420 files / 6492 (baselines.md's "inferred" row, now measured).
2. 8bbe7b6 420 / 6502.
3. 1d85e4e 420 / 6502 ("adds no case").
4. 44cc832 420 / 6505.
5. c86d795 421 / 6515.
6. 773dedb 422 / 6527.
7. b2e3575 422 / 6527 ("this commit adds no case").
   Every Δ in the baselines.md table holds: +10 / 0 / +3 / +10 / +12. Per-file `it(` counts
   confirm +9 (dispatch test) and +11 (agreement test). The two failures on 4a4e422 and
   8bbe7b6 were `Test timed out in 20000ms` in exactly the two cases 1d85e4e re-budgets
   (37,441 / 41,763 / 33,640 ms). That is independent confirmation of 1d85e4e's premise.
8. `git diff --stat f829e85 4a4e422 -- tests/ lib/ benchmark/ scripts/ '*.mjs' '*.js'`
   prints nothing.
9. knip 32 unused exports / 0 unused files / 3 unlisted binaries on 44cc832, c86d795 and
   HEAD. The name sets (symbol + file) are identical across all three. No doctor symbol is
   among them. knip 6.35.1, vitest 5.0.0.
10. Coverage on 773dedb: 85.84 / 80.09 / 91.11 / 87.01, against the claimed 85.82 / 80.07 /
    91.05 / 87.01. Within 0.06 (the second decimal is caliber noise, as the prior review
    found). Gate 81/75/87/83 holds. The Δ arithmetic in baselines.md (+0.05/+0.03/+0.02/+0.03)
    is correct against the claimed figures.
11. lib/doctor-hook-interpreter.mjs `88.88 | 78.26 | 87.5 | 87.09 | 96-101`, byte-exact, and
    96-101 is the `probeBash` body.
12. lib/doctor-stale-temp.mjs 100/100/100, absent from the text table because it is fully
    covered.
13. Mutations, 44cc832: fillCap=half kills only "drains the fill pool…". fillCap=budget
    kills "does not take the main scope below…" and also "measures the main pool…". max→min
    kills "drains". Fill-before-main kills the ordering guard "gives a row sitting in all
    three pools to the generic pass".
14. `scope: 'aliases'` kills 1 of 71 cases in hook-optimize.test.mjs, and only that case in
    the whole suite.
15. c86d795: ok-for-dwarn on the null branch kills the ⚠ case, plus the doctor wiring case.
    Dropping `bashScripts.join` kills the naming case. Swallowing the catch kills the
    throwing-probe case.
16. `includes('bash')` kills each site's own case alone: manifest site → the MANIFEST case,
    settings site → the "merely contains it" case.
17. 773dedb: skipping the data-dir scan kills 2. Unreadable-mtime → stale kills 1. `>=`→`>`
    kills the boundary case alone. Dropping `episodeAgeMs` kills its own case alone.
18. 1d85e4e: forcing each budget to 1 gives "Test timed out in 1ms" on exactly its case.
19. "All 21 doctor test files (151 cases)": on c86d795, `tests/*doctor*` is 21 files with
    151 passing.
20. "every user-facing string is byte-identical": `install.mjs doctor` output diffed between
    44cc832 and c86d795 on sandbox HOMEs, with bash on PATH and with PATH=/nonexistent. Both
    are identical after normalising paths.
21. `probeBash` is not exported and no test names it. `resolveBashHookCount` is gone from
    install.mjs (0 occurrences), and was exported and tested at 44cc832
    (doctor-bash-hook-shape and doctor-no-silent-catches tests).
22. Both new libs are in package.json#files and source-files.mjs. `npm pack --dry-run` ships
    README.md and README.zh-CN.md and does NOT ship CHANGELOG.md.
23. Both libs are leaves: they import only node:fs, node:path and node:child_process, plus
    ./time-constants.mjs, which imports nothing.
24. The hook-shared.mjs sweep deletes only `mtimeMs < fileCutoff`. hook-llm.mjs keeps
    `>= cutoff` as live. Both use ORPHAN_EPISODE_AGE_MS in their own comparisons ("still
    spell the gate themselves").
25. The one remaining "1h" comment sits beside the constant's name (install.mjs:3011).
    EPISODE_AGE_LABEL evaluates to "1h".
26. The D#53 pre-fix output reproduces verbatim on 44cc832 (see F12). With 3 fresh + 1 aged,
    doctor's count equals cleanup's removals (1 = 1).
27. The install.lock asymmetry is disclosed, and the case pinning it is killed by the
    data-dir mutation.
28. The leak mechanism, measured at 4a4e422: with a second label the second value leaks, a
    run of three leaks two, and newline-separated input does not leak.
29. `MAX_SCRUB_PASSES = 32`. A 33-deep chain leaves 1 unscrubbed and a 32-deep chain leaves 0
    ("unscrubbed past the 32nd").
30. "~447-byte chain": 32 × `token: AAAAAA` joined by single spaces is 447 bytes and reaches
    the cap. Leaving something unscrubbed takes 461 bytes (428 without the space after the
    colon).
31. secret-scrub.mjs:44-50 is indeed the v3.61.0 "Reset the password: instructions…"
    record.
32. cmdRestore re-scrubs five columns (mem-cli.mjs:2405-2409).
33. Grower shape: `https://u:p@` is 12 characters and `https://***:***@` is 16.
34. Live corpus, read-only: 287 non-empty values, 0 modified. NOT NULL 473, and 39% of those
    are empty.
35. Live pools: all four main/fill pools read 0 on all 8 projects. The concepts backlog is
    23/16/11/11/7/6/3/1, as the 44cc832 body re-measured. The per-project arithmetic 26 is
    correct as arithmetic (but see F1).
36. Brute force over 129,654 inputs (R 1..14 × pools 0..20³): the identity
    R - fillCap = min(R - half, mainPool) has 0 failures. newMain < oldMain has 0 cases (the
    comparative claim holds). The absolute claim fails on 98,713 inputs, including R=6
    mainPool=4 → 3, as the comment now says.
37. v6.10.3's CHANGELOG listed D#51 as known and deliberately deferred.
38. vitest.config.mjs records 14.4x and the 11.67% stamp dated 2026-09-03. doctor() is lines
    1759-2783 = 1025 of install.mjs's 3595 lines at 44cc832.
39. benchmark/baseline.json is stamped 2026-09-14T16:06:53Z, and ci.yml says red from
    2026-10-14 16:06 UTC.
40. Version bump across 5 files (package.json, package-lock, plugin.json, marketplace.json,
    CLAUDE.md). The release-guard test passes in the b2e3575 suite. No schema.mjs change in
    the range.
41. On HEAD, `eslint .` exits 0 and `format:check` exits 0. The EN and zh-CN "Upgrading to
    6.11.0" sections say the same thing, paragraph for paragraph. That includes the same F2
    and F3 errors, so fix both files.

---------------------------------------------------------------------------------------------
# Prior review's FALSE / misleading items: sweep status
- F1 (per-commit totals): corrected everywhere. All 7 trees measured.
- F2 (`***` structural termination): corrected in the body and the docblock.
- F3 ("three twins"): NOT corrected (F7 here).
- F4 (absolute starvation claim): corrected in the body, the docblock and the CHANGELOG.
- S1 (452): corrected in the body and the docblock, still present in the test header (F8).
- S2 (N+1): corrected in 3 of 4 copies. The describe header is still unqualified (M3).
- S3 (11.67%): corrected. S4 (3596): corrected to ~3595.
- S5 ("same fixture"): NOT corrected (F12).

# Out of lens, for the defect reviewer
lib/doctor-stale-temp.mjs: `classifyEpisodeFile`'s JSDoc block ("The single definition of
the age gate … @returns {'stale'|'in-flight'}") now sits ABOVE the EPISODE_AGE_LABEL block.
The docs are detached from the function they describe.

Artifacts: review-b/mine/ (mut.sh, M00-M19 logs, narrow-probe.mjs), review-b/probe-*.mjs,
review-b/faces.sh, review-b/suite-*.txt, review-b/cov-773dedb.txt, review-b/knip-*.txt.
