> **Added when this report was committed (v6.11.0 release), not part of the review.** It ran
> against a series that was rebuilt afterwards to apply its findings, so the SHAs below do not
> exist on `main`. Old -> shipped: `1d85e4e` -> `e12564b` (now FIRST), `8bbe7b6` -> `4d8393c`,
> `44cc832` -> `d409c8c`, `c86d795` -> `91493ad`, `773dedb` -> `9c41144`; `b2e3575` was the
> unreleased release commit. Line numbers refer to those trees.

# Pre-tag DEFECT review (reviewer B): claude-mem-lite v6.11.0 @ b2e3575

## Anchor
```
$ git -C /home/ai/dev/claude-mem-lite rev-parse HEAD
b2e3575d45fe3c5435bf76ace2ce32a6404247d5
$ git -C /home/ai/dev/claude-mem-lite log --oneline 4a4e422..HEAD
b2e3575 release  | 773dedb | c86d795 | 44cc832 | 1d85e4e | 8bbe7b6      (exactly 6)
```
Working tree: `scratchpad/tree-defect-SvHe`. I checked it against `git archive b2e3575`: the file sets match
(diff empty) and the concatenated content hashes match (`2d576156…a59a6`). I checked this before the probes and
again after them. Every mutation was reverted from a file copy and I confirmed each revert by its sha. My one
temporary test file (`tests/zz-reviewb-probe.test.mjs`) was deleted, and a copy is kept at
`review-b/probe-daily-scope.test.mjs`. In the main repo I used only `git log/show/diff`.

## Counts
| Grade | Count |
|---|---|
| P1 | 0 |
| P2 | 1 |
| P3 | 6 |

Suite in this tree (full run, 2026-09-22 ~17:25, load average 18, so it was contended):
```
$ npx vitest run
 Test Files  2 failed | 420 passed (422)
      Tests  2 failed | 6524 passed | 1 skipped (6527)
```
The 2 failures are the same `git archive` artifacts the prior review proved fail at 4a4e422 too
(`pre-commit-hook-sync` needs `.git`; `suite-touches-no-repo-files` needs the git remote). 6527 total
matches CLAUDE.md's new Baselines row. `npx eslint <11 touched files>` → exit 0; `prettier --check` → clean.

---

## P2-1 — The "per project" re-enrich cost in README, CHANGELOG and the code comment is wrong: the daily pass is ONE unscoped, machine-wide run

**Where:** `README.md:245-247` ("The ceiling is unchanged at 6 LLM calls per project per cycle … a project whose
main pool is empty now reaches it, where it previously stopped at 3"). `CHANGELOG.md` v6.11.0 upgrade note ("up to
**6** LLM calls for that project per cycle where it made **3**") and D#51 paragraph ("8 projects … 26 slots a day
went unused"). `README.zh-CN.md` has the same claim. `hook-optimize.mjs:1745-1748` and `tests/hook-optimize.test.mjs:583`
("26 slots a day"). The 44cc832 body says "the daily path fans out one scoped pass per project".

**What the code does** (read):
- `hook.mjs:1764` gates auto-maintain on ONE file, `join(RUNTIME_DIR,'last-auto-maintain.json')`, which is
  24h and machine-wide. At `hook.mjs:2004` it `spawnBackground('llm-optimize')`.
- `hook-optimize.mjs:1874`: `handleLLMOptimize` → `optimizeRun(db, { reenrichScope: 'wide' })`, which passes **no
  `project`**. `findReenrichCandidates` adds `AND project = ?` only when `project` is set (`hook-optimize.mjs:89`).
  So `mainPool`, `fillCap` and every fill pool are UNION counts over all projects. Per-project fan-out exists for
  normalize only.

**Behavioural probe** (verified). A temporary test used the daily path's exact arguments and mocked the LLM the way
`tests/hook-optimize.test.mjs` does. Source: `review-b/probe-daily-scope.test.mjs`.
```
$ npx vitest run tests/zz-reviewb-probe.test.mjs --silent=false --reporter=verbose
[PROBE B-only (A empty)]                 byScope={"wide":0,"aliases":0,"concepts":6,"scopes":0} llmCalls=8
[PROBE A has 6 wide, B has 8 concepts]   byScope={"wide":3,"aliases":0,"concepts":3,"scopes":0} llmCalls=9  optimizedPerProject=[{"project":"projA","n":3}]
[PROBE same, scope NULL (scopes pool)]   byScope={"wide":3,"aliases":0,"concepts":3,"scopes":6} llmCalls=15
```
- Row 2: project B's own main pool is empty, but B gets 3 concepts slots, not 6. Project A's wide rows fill the
  shared main pool. So "a project whose main pool is empty now reaches [6]" is false. The budget depends on the
  union across projects.
- Row 3: the re-enrich family makes 3+3+6 = **12** calls in one cycle, because the `scopes` side-pass is budgeted
  separately, up to `budget.reenrich` again (`hook-optimize.mjs:1782-1785`). This predates the release and those
  calls are cheap (maxTokens 60). Still, "the ceiling is unchanged at 6 LLM calls" leaves them out. The whole
  daily cycle made 15 model calls in that fixture.
- "26 slots a day" adds up per-project shares for 8 cycles that do not exist. There is one cycle per day. With
  the union main pool at 0, the idle share was **3 slots a day** and becomes 6 concepts calls a day.

**Why P2 and not P1:** the code is correct and the direction of the release is as described: idle budget goes to
the backfills, and the cost goes up by at most 3 calls a day. What is wrong is the unit and size of the
user-facing cost note. That note is the stated reason for the MINOR bump, and both READMEs ship to npm. A user
with 8 projects reads a ceiling of up to 48 re-enrich calls a day. The real figure is 6, plus up to 6 scope
classifications. The "26 slots" figure is about 8.7× the real idle figure. Suggested fix: say "per machine per
day (one unscoped daily pass)", name the separately budgeted scopes pass, and correct 26 → 3 in
CHANGELOG, README ×2, the hook-optimize.mjs comment and the test comment.

---

## P3-1 — `classifyEpisodeFile` lost its JSDoc to `EPISODE_AGE_LABEL`
`lib/doctor-stale-temp.mjs:38-56`. 773dedb put the new `/** How the age gate is SPOKEN … */` block and
`EPISODE_AGE_LABEL` between the classifier's docblock (with `@returns {'stale'|'in-flight'}`) and
`export function classifyEpisodeFile`. JSDoc attaches to the nearest following declaration. The classifier's
contract ("the single definition of the age gate", fail-safe on an unreadable mtime) now sits above a string
constant, and the function has no doc. Found by reading; not run (typescript is not installed in node_modules).
Fix: move the label above line 38.

## P3-2 — A test comment claims to kill `MAX_SCRUB_PASSES = 1`, and that case stays green under it
`tests/secret-scrub-coverage.test.mjs:1008-1014`: "Kills `MAX_SCRUB_PASSES = 1`: that mutation stops after one
sweep, so the second space-adjacent secret survives". The input
(`password=SUPERSECRETVALUE123 and the token: alicewashere`) has no second adjacent secret.
```
[A2-cap1] APPLIED secret-scrub.mjs sha 39165a16206d -> a2958c405a92
  × property > is idempotent, on the four shapes that used to prove it was not
  × D#52 > scrubs the SECOND space-adjacent labelled secret, not just the first
  × D#52 > scrubs a run of three, not just the head
  × D#52 > is idempotent: a second scrub changes nothing (D#46)
  × cap > a chain that FITS inside the cap is still fully scrubbed
  × cap > the overrun case scrubs what it reached — a residual, not a no-op
[A2-cap1] REVERTED sha 39165a16206d
```
The mutant is killed by six other cases. The case named in the comment is not among them (verified). Once the
fallback is removed, the case is only a prose negative with one secret in the string. The comment should say
that.

## P3-3 — Comments still describe the removed fallback and the retracted denominator
- `tests/secret-scrub-coverage.test.mjs:941-945` still says "The MAX_SCRUB_PASSES fallback is the one branch
  nothing else reaches … the claim in its comment ('hitting the cap is not a silent partial scrub')". The
  fallback was removed in this range, and the source now says the opposite (`secret-scrub.mjs:315-327`).
- `tests/secret-scrub-coverage.test.mjs:881` still says "0 of 452 live values". The source retracted that
  denominator at `secret-scrub.mjs:296-300` (287 non-empty).
Found with an entity grep over the tree (`grep -rnaI` with no file-type filter).

## P3-4 — Chains longer than the cap still leak, and scrubbing is no longer idempotent there; the user notes don't say so
This is deliberate and documented in `secret-scrub.mjs:315-327`, and it is a strict improvement on v6.10.3 at
every length. The CHANGELOG ("capped at 32 sweeps") and READMEs ("This release fixes the write path") do not
say that a single line with more than 32 letter-terminated labelled values still stores the tail. Measured
(verified):
```
$ node review-b/cap.mjs <HEAD secret-scrub.mjs> <4a4e422 secret-scrub.mjs>
chain n=32 bytes=1023 leaked: v6.10.3=31 v6.11.0=0  idempotent@6.11.0=true
chain n=33 bytes=1055 leaked: v6.10.3=32 v6.11.0=1  idempotent@6.11.0=false
chain n=40 bytes=1279 leaked: v6.10.3=39 v6.11.0=8  idempotent@6.11.0=false
chain n=100 bytes=3199 leaked: v6.10.3=99 v6.11.0=68 idempotent@6.11.0=false
```
The idempotence the D#46 comment gives as cmdRestore's requirement (`secret-scrub.mjs:~291`) holds only below the
cap. Past the cap, a restore re-scrub redacts more, which is the safe direction. The reach is low: this needs a
crafted adjacent chain of more than 1 KB.

## P3-5 — `EPISODE_AGE_LABEL` can only express whole hours
`lib/doctor-stale-temp.mjs:56`: `` `${Math.round(ORPHAN_EPISODE_AGE_MS / 3600000)}h` ``. A gate of 20 min would
print "0h" and one of 45 min would print "1h". So the "derived from the gate itself" guarantee holds only for
whole-hour gates. It cannot happen today (the gate is `HOUR_MS`), and no test pins the label to the gate.
Found by reading and arithmetic.

## P3-6 — "the number doctor prints is the number cleanup removes" (CHANGELOG) is not true of cleanup's total
`install.mjs` cleanup also reaps test-fixture sandboxes in `os.tmpdir()` and `~/.claude/tmp` (the
`sweepStaleTestFixtures` block after the episode loop) and adds them to `removed`. Doctor's scanner does not count
them. On a machine with leaked fixtures, doctor prints N and cleanup reports N+K removed. This predates the release
and cleanup lists each one, so it is benign. The sentence holds for temp residue only. Found by reading; not run.

---

## Checked and CLEAN

1. **`>`→`>=` in `classifyEpisodeFile` (priority 1). The direction is correct and nothing else disagrees.**
   - `hook-shared.mjs:205` deletes only `statSync(full).mtimeMs < fileCutoff`, which keeps `>= cutoff`.
   - `hook-llm.mjs:1350` treats `mtimeMs >= cutoff` as live.
   - The classifier now returns in-flight for `mtimeMs >= now - episodeAgeMs`.
   - All three put the exact-gate tie on the KEEP side. `install.mjs:3027` rmSyncs only what is not in-flight,
     so the change removes one deletion case and adds none.
   - v6.10.3's cleanup did use `mtimeMs > epCutoff` (`git show 4a4e422:install.mjs` line 3124), so the test
     comment's history is accurate.
   - Every reader of the classifier, `scanStaleTempFiles` and `ORPHAN_EPISODE_AGE_MS` (grep of `.mjs/.js/.sh`,
     node_modules excluded): `install.mjs` doctor (2569) and cleanup (3027), `hook-shared.mjs` (153 default),
     `hook-llm.mjs` (1345), and tests. Nothing relied on the strict `>`.
   - `--dry-run` goes through the same classifier.
   - `scanStaleTempFiles` passes `episodeAgeMs: undefined` when it is omitted, and the destructuring default in
     `classifyEpisodeFile` still applies.
2. **Prior findings are now closed. Each re-run in this tree, reverted, and sha-confirmed:**
   - D4 (`>=`→`>`): `Tests 1 failed | 10 passed (11)`. Killed by "a file exactly at the gate is in flight…".
   - D6 (drop `episodeAgeMs` on the way to the classifier): `1 failed | 10 passed`. Killed by "honours an
     injected episodeAgeMs…".
   - P2-1/B3 (`scope: reenrichScope` → `'aliases'`): `1 failed | 70 passed (71)`. Killed by "measures the main
     pool with the scope it is about to RUN".
   - C5 per site. Manifest side: `1 failed | 8 passed (9)`. Settings side: `1 failed | 8 passed (9)`. Each is
     killed by its own case.
   - P3-1 (whole-string unguarded fallback): I put the removed block back as a mutant, and
     `1 failed | 93 passed (94)` went red on "does not corrupt prose elsewhere in the string when the cap is
     overrun". The loop is now `if (result === before || pass >= MAX_SCRUB_PASSES) break;`, and no fallback
     code is left in `secret-scrub.mjs`.
   - P3-4: `EPISODE_AGE_LABEL` is used at both faces (`install.mjs:2586`, `:3047`), and there is no `1h`
     literal left in either print. The over-claiming comment was restated with the lock caveat.
3. **1d85e4e budgets are applied.** Both cases are synchronous (`execFileSync`). vitest 5.0.0 still enforces the
   third-argument timeout after the fact:
   ```
   [T1] 60000 -> 1000 in doctor-survives-bad-settings:  Error: Test timed out in 1000ms.  Tests 1 failed | 1 passed (2)
   [T2] 60000 -> 1000 in install-lifecycle (-t project-scoped .mcp.json):  × … 24921ms, 1 failed | 24 skipped
   ```
   Neither child `execFileSync` has its own `timeout` that could undercut the 60 s. The lifecycle comment's
   claim that this is the only full-`install` case in that file holds: the other `runInstall` calls are
   status / cleanup-hooks / uninstall / doctor. The timing numbers in the comments are the author's
   measurements and I did not re-measure them (this box read load average 18 during my run).
4. **Five version surfaces are consistent:** package.json, plugin.json, marketplace.json, package-lock.json
   (`version` and `packages[""]`) all read 6.11.0, and CLAUDE.md reads `**Version**: 6.11.0`. No stray 6.10.3
   in shipped code.
5. **Re-enrich arithmetic.** The comparative claim ("this change introduces no input on which a fill pass takes
   a slot main could have spent") matches the code and the prior review's brute-force check. The only problem is
   the unit in P2-1.
6. **Secret-scrub fixed point versus v6.10.3:** leaked-value count ≤ the v6.10.3 count at every chain length
   tested (10/31/32/33/40/100). Full scrub up to n=32.
7. **c86d795 / lib/doctor-hook-interpreter.mjs** changed only its docblock in the post-review diff. No code
   change.
