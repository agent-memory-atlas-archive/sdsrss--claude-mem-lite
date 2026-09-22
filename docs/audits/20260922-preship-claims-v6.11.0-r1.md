> **Added when this report was committed (v6.11.0 release), not part of the review.** It ran
> against the FIRST draft of this series (`05121eb` `0867145` `f3cd4a5` `a3fe871`), before its own
> findings were repaired and before a second review round (the `-r2` reports). None of those
> SHAs exist on `main`; the shipped equivalents are `4d8393c` `d409c8c` `91493ad` `9c41144`.

# Pre-ship CLAIMS review — claude-mem-lite, 4a4e422..a3fe871

Lens: are the author's own numbers, mechanisms and claims TRUE? (Defects are the other
reviewer's job.)

## Anchor

```
$ git rev-parse HEAD
a3fe871db6669457a6f9921dc01aaa417c3281fb            ✓ as briefed
$ git log --oneline 4a4e422..HEAD
a3fe871 fix(doctor): stop calling in-flight episode files stale, …
f3cd4a5 refactor(doctor): move the hook-interpreter check into lib/, …
0867145 change(re-enrich): return the main scope's unusable budget …
05121eb fix(scrub): the second labelled secret on a line shipped in plaintext
```
Exactly 4 commits ✓. Primary repo left read-only throughout; `git status --porcelain`
is empty and HEAD is unchanged at the end of this review.

## Tally

| | count |
|---|---|
| Claims checked | 41 |
| **FALSE** | **4** (3 are one recurring arithmetic fault) |
| True but misleading in scope | 5 |
| Unverifiable | 2 |
| TRUE | 30 |

## Working tree and its two caveats

`git archive HEAD` extraction at
`…/scratchpad/tree-claims-hKyt`, `node_modules` symlinked.

Two suite failures appeared that are artifacts of the extraction, **not** regressions —
both also fail at the 4a4e422 baseline, so every delta below is clean:

* `tests/pre-commit-hook-sync.test.mjs` — needs a real `.git` (`git ls-files`).
* `tests/suite-touches-no-repo-files.test.mjs` — install.mjs's dogfood branch detects this
  repo **by its git remote**, and an archive has none.

I fixed the environment rather than working around it: `git init` + a committed baseline +
`git remote add origin https://github.com/sdsrss/claude-mem-lite`. After that the suite is
**422 files / 6520 passed, 0 failed, 0 skipped** — which is also what makes the headline
number below trustworthy.

---

# FALSE

## F1 — the suite total is wrong in 3 of 4 commit bodies; the final one understates by 10

Measured by extracting each commit with `git archive` into its own tree and running
`npx vitest run` in each (identical environment, back-to-back):

| commit | claimed total | **measured** | per-commit delta | verdict |
|---|---|---|---|---|
| 4a4e422 (baseline) | "6492" | **6492** (420 files) | — | ✓ |
| 05121eb | "420 files / 6500 (6492 + 8 new, residual 0)" | **6500** (420) | +8 | ✓ TRUE |
| 0867145 | "420 files / 6494 (6492 + 2 new, residual 0)" | **6502** (420) | +2 | **FALSE, −8** |
| f3cd4a5 | "421 files / 6500 (6492 + 7 new + 1 generated)" | **6510** (421) | +8 | **FALSE, −10** |
| a3fe871 | "422 files / 6510 = 6500 + 9 new + 1 generated" | **6520** (422) | +10 | **FALSE, −10** |

Every **file count** is right (420/420/421/422) and every **increment** is right
(8 / 2 / 7+1 / 9+1). What is wrong is the absolute: from 0867145 onward each body adds its
own new cases to a baseline of **6492**, which by then already excluded the author's own
earlier commits in the same series. f3cd4a5 reported 6500, and a3fe871 then chained
`6500 + 9 + 1 = 6510` off that reported figure, so the error propagates.

`6492 + 8 + 2 + 8 + 10 = 6520` — the chained arithmetic reproduces my measurement exactly,
which is the strongest evidence that the increments were measured and the totals were not.

"residual 0" is therefore asserted against a stale baseline in three bodies. This is
`feedback-baseline-read-after-own-edits` recurring, on its second axis (the carried cell).

Final green run, for the record:
```
 Test Files  422 passed (422)
      Tests  6520 passed (6520)
```

## F2 — "`***` is 3 characters and every value class requires at least 6, so a replacement can never become a new match"

(secret-scrub.mjs docblock + 05121eb body.) **False of at least 6 of the 40 patterns.**
The termination *conclusion* is fine; the *reason* given is not.

```
$ node c1-patterns.mjs
TOTAL PATTERNS: 40
--- does any pattern match a *** replacement output? ---
  MATCH idx=19 probe="-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----"
        -> "***PEM_KEY***"
  MATCH idx=28 probe="postgres://***:***@h" -> "postgres://***"
```
Six patterns have no 6-character floor at all — their value class is `+` or `*`:

```
idx 17: ["]+"]    (https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]+
idx 19: ["]*",…]  -----BEGIN … PRIVATE KEY-----[\s\S]*?-----END …
idx 22: ["]+"]    (Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s,;'"}\]]+
idx 26: ["]+"]    (\b(?:SUPABASE_KEY|…|DATABASE_URL|REDIS_URL)\s*[…
idx 27: ["]+","]+"]  (https?|ftps?):\/\/[^@/\s:]+:[^@/\s]+@
idx 28: ["]+","]+"]  \b(postgres(?:ql)?|mysql|…)(\+[\w-]…
```
and two of them **demonstrably re-match their own output**. Termination still holds (each
sweep strictly shrinks what is left), but it holds for a different reason than the one
written down, and that reason is the only thing standing between this loop and an
unbounded one. Per this repo's own rule 10 ("correct the premise before quoting it") and
the fourth axis of `feedback-retraction-must-sweep-all-copies` — the replacement reason
written down during a fix is itself an unverified new assertion — this one needed
measuring and was not.

## F3 — "three hand-kept twins … `stalePatterns` at two sites and the `pending-`/`ep-flush-` test at two more"

(a3fe871 body.) The enumeration does not add to three under either reading. Measured on
install.mjs at 0867145 (pre-change):

```
2662:    const stalePatterns = ['.update-staging-', '.update-backup-'];
2665:        if (stalePatterns.some((p) => f.startsWith(p))) staleCount++;
2670:        if (f.startsWith('pending-') || f.startsWith('ep-flush-')) staleCount++;
3073:  const stalePatterns = ['.update-staging-', '.update-backup-'];
3079:      if (stalePatterns.some((p) => f.startsWith(p))) {
3114:      if (f.startsWith('pending-') || f.startsWith('ep-flush-')) {
```
That is **two duplicated rules across four sites** (or three duplicated *fragments* across
six sites, if `stalePatterns.some(...)` is counted separately — but then "at two sites /
at two more" is wrong). Minor, and the load-bearing half is TRUE: post-change, install.mjs
contains **zero** occurrences of any of them.

## F4 — "There is no input on which a fill pass takes a slot the main scope could have spent"

(hook-optimize.mjs docblock + 0867145 body.) False as an absolute statement about the
code; true under the comparative reading the paragraph intends. Brute-forced over 129,654
inputs (R = 1..14 × pools 0..20³):

```
D  literal  mainBudget >= min(R, mainPool)  : 98713 FAILURES
```
Counter-example straight from the boundary table: `R=6, mainPool=4` → `half=3`,
`fillCap=3`, `mainBudget=3`. Main could have spent 4 and gets 3. The fill passes took a
slot main could have spent. This is **pre-existing** (old arithmetic gives 3 too), which is
why the intended reading — "this change introduces no such input" — is sound; but the
sentence as written is an unqualified claim about the code and is false of it.

---

# True but misleading in scope

## S1 — "0 of 452 live corpus values across text/subtitle/concepts/facts/search_aliases are modified by scrubSecrets at all"

The **0 is TRUE** and reproduces. The **452 is a NOT-NULL count that includes empty
strings**, which cannot be modified by anything, so ~39% of the denominator is
unfalsifiable by construction.

```
$ node c3-livecorpus.mjs         # readonly handle, premise asserted first
PREMISE ok — handle refuses writes: SQLITE_READONLY
  text: 117 non-empty values, 0 modified
  subtitle: 5 …, 0 modified          concepts: 24 …, 0 modified
  facts: 24 …, 0 modified            search_aliases: 117 …, 0 modified
TOTAL non-empty values across the 5 columns: 287
TOTAL modified by scrubSecrets: 0

$ node c4-denominator.mjs
SUM NOT NULL       = 473        SUM non-empty      = 287        SUM all rows x 5   = 585
```
473 today vs 452 at the author's reading is pure corpus growth (this session wrote to the
DB): at 112 observations with 4 non-null subtitles the NOT-NULL sum is exactly 452. So the
figure is honest and reproducible — but "which rows" is the required field doctrine rule 3
asks for, and "live corpus values" does not say that a third of them are `''`. The
meaningful denominator is 287.

## S2 — "N space-adjacent secrets converge in exactly N+1 sweeps (N = 1, 2, 3, 5, 10, 25, 50)"

TRUE only when each value **ends with an ASCII letter**. Counted with the same single-sweep
twin the test file uses:

```
shape A: `token: <24 letters>` repeated       shape C: `token: hunter2correct000N`
  N=1 : 2   claim 2   ✓                         N=1 : 2   claim 2   ✓
  N=2 : 3   claim 3   ✓                         N=2 : 2   claim 3   ✗
  N=10: 11  claim 11  ✓                         N=10: 2   claim 11  ✗
  N=50: 51  claim 51  ✓                         N=50: 2   claim 51  ✗
```
Mechanism: the prose lookbehind is `(?<![A-Za-z][ \t])`. A value ending in a **digit** does
not re-arm it, so every secret on the line falls in one sweep. The claim is written as a
property and is a property of one value shape.

This does **not** make the cap case vacuous — `tests/secret-scrub-coverage.test.mjs`
re-derives the sweep count in-test as a premise (`expect(sweeps).toBeGreaterThan(32)`), and
I confirmed N=40 of the letter-terminated shape reads 41. The direction the cap argument
needs (N+1 is the *maximum*) is the true one.

## S3 — "install.mjs measures 11.67% statements / 10.22% lines when temporarily added (vitest.config.mjs records that measurement)"

Literally TRUE as a citation — `vitest.config.mjs:105` says exactly that. But the reading is
**stamped 2026-09-03** and the commit presents it as current. CLAUDE.md names three caliber
breaks, and that number predates **all three**: the 2026-09-05 reformat (`36f8c0f`), the
vitest 5.0.0 upgrade (which CLAUDE.md says *did* re-calibrate coverage), and the 2026-09-07
`include` inversion. This is the load-bearing justification for the whole refactor
("the reason is coverage, not length") resting on a carried cell.

## S4 — "doctor() is 1025 of install.mjs's 3596 lines"

The 1025 is exact. The denominator mixes counting conventions:
```
$ awk … install.mjs @ 0867145       doctor() lines 1759-2783 = 1025
$ wc -l < install.mjs               3595
$ node -e "…split('\n').length"     3596      (counts the empty slot after the final \n)
```
1025 is derived with `wc -l` semantics; 3596 is not. Trivial, but the two halves of one
sentence use different rulers.

## S5 — "measured verbatim on a fixture of three episode files … Same fixture after this change"

Every quoted string and number is right; "same fixture" is not — the before-fixture has 3
files and the after-fixture has 4. I rebuilt both and ran both faces on the PRE (0867145)
and POST (HEAD) trees:

```
=== tree-0867145 === FIXTURE A: 3 fresh episode files
doctor :   ⚠ Stale temp files: 3 found (run: node install.mjs cleanup)
cleanup:     Kept 3 episode file(s) newer than 1h — possibly in flight, …
           No stale files found.
=== HEAD === FIXTURE B: 3 fresh + 1 aged past the gate
doctor :   ⚠ Stale temp files: 1 found (run: node install.mjs cleanup)
cleanup:   ✓ Removed: runtime/ep-flush-stale-0.json
             Kept 3 episode file(s) newer than 1h — possibly in flight, …
           1 stale file(s) removed.
```
The contradiction is real and reproduces verbatim; the fix behaves exactly as described.

---

# Unverifiable

## U1 — "a directed grid (2940 inputs, 80.3% reach)"

The grid script is not in the tree (correct per §8.V4 sandbox-artifact disposal), and the
numbers appear exactly once, in `tests/secret-scrub-coverage.test.mjs:880`. The specific
2940 / 80.3% cannot be reproduced.

The **substance** corroborates strongly. My own independent directed grid
(5 labels × 5 labels × 4 separators × 7 value shapes × 5 joiners × 4 prefixes):
```
grid inputs              : 14000
reach (scrubber modifies): 13568 (96.9%)
still leaks after ONE sweep (the pre-fix code) : 3870 (27.6%)
still leaks after the FIXED POINT (shipped)    : 3150 (22.5%)
```
720 inputs leak under one sweep and not under the fixed point. Sample:
```
in    "token: AAAAAAAAAAAAAAAAAAAA token: AAAAAAAAAAAAAAAAAAAA"
1x    "token: *** token: AAAAAAAAAAAAAAAAAAAA"   <- second value in PLAINTEXT
fixed "token: *** token: ***"
```
And the 22.5% residual is **entirely** the prose-protected set, not a surviving leak —
which independently confirms "does not buy the fix with the #8283 prose protection":
```
prefix ""                         n=3500  still-contains-value=0 (0.0%)
prefix "the "                     n=3500  still-contains-value=1575 (45.0%)
prefix "error from upstream: "    n=3500  still-contains-value=0 (0.0%)
prefix "deploy --flag "           n=3500  still-contains-value=1575 (45.0%)
```
Config position: 0 of 7000. Prose position: unchanged, as designed.

## U2 — "8 counter-examples" and "exactly 3 of 40 patterns carry the prose lookbehind; only 2 of 40 are not a fixed point in one pass"

The second half of that pair and the "8 counter-examples" figure **do not appear in any
audited artifact** — not in the four commit bodies, not in `secret-scrub.mjs`, not in the
test headers. `grep` for `2 of 40`, `8 counter`, `counter-examples` returns nothing in
either file. I have not graded phrases I cannot locate; flagging so they are not taken as
reviewed.

Worth noting: the nearest measurable reading of "only 2 of 40 are not a fixed point in one
pass" gives **exactly 2** — patterns 19 and 28 — which is the same pair that falsifies F2.

---

# TRUE (verified, with the command)

**Pattern table (05121eb)**
1. "40 patterns" — `TOTAL PATTERNS: 40` ✓
2. "exactly 3 of 40 carry the prose lookbehind" — ✓ exactly 3: idx 1, 3, 8 ✓
3. The leak mechanism (a /g match consumes its value; the next keyword is preceded by
   letter+space; `\n` is not `[ \t]` so newline-separated input never leaked) — reproduced
   in the grid above; the newline arm shows 0 leaks under one sweep ✓

**Budget arithmetic (0867145)** — brute-forced over 129,654 inputs modelling the code verbatim:
```
A  identity  R-fillCap === min(R-half, mainPool)   : HOLDS
B  bound     mainBudget >= R-fillCap               : HOLDS
   mainBudget never negative                       : HOLDS
C  "at/below old floor -> receives ALL of it" + "larger -> byte-for-byte": HOLDS
```
4. `mainBudget >= budget.reenrich - fillCap = min(budget.reenrich - half, mainPool)` — the
   identity is exact (`R - max(a,b) = min(R-a, R-b)`) and holds at R = 1, 2, 3 and every
   boundary ✓
5. "when main's pool is at or below its old floor it now receives ALL of it; when larger,
   byte-for-byte what it was" ✓
6. "up to 6 LLM calls per cycle where it made 3" ✓ (R=6, mainPool=0: old total 3, new 6)

**Live DB (0867145)** — readonly handle, premise asserted before any number:
7. "All 8 projects read narrow 0 / wide 0 / aliases 0 / scopes 0" — ✓ **exactly**, all 8:
```
  dev--claude-mem-lite   narrow=0 wide=0 aliases=0 concepts=6 scopes=0
  … (8 projects, all four pools 0)
```
8. concepts backlog "20/16/11/11/6/6/3/1" — now reads **23/16/11/11/7/6/3/1**. The two that
   moved are this repo and `dev--claudemd`, both written to during this session; shape and
   tail identical. TRUE as of measurement (doctrine rule 2 applies — corpora grow).
9. **"26 idle slots a day" — ✓ exact, and it still reproduces on the drifted backlogs**:
   `3+3+3+3+3+3+3+5 = 26` (R=6, half=3, main spends 0, concepts capped at 3).
10. "the backlog draining at 3 per cycle" ✓

**Coverage (f3cd4a5, a3fe871)**
11. "New module: 88.88% stmts / 78.26% branch / 87.5% funcs / 87.09% lines; the uncovered
    span (86-91) is the real `probeBash` body" — **byte-exact**, from the v8 text reporter:
```
  ...terpreter.mjs |   88.88 |    78.26 |    87.5 |   87.09 | 86-91
```
12. "New module 100% statements / 100% branches / 100% functions, read from
    coverage-final.json because the text table omits fully-covered files" ✓ —
    `doctor-stale-temp.mjs 100.00 / 100.00 / 100.00`, and it is indeed absent from the table.
13. "the gate (81/75/87/83) holds" ✓
14. Global coverage: **does not reproduce to the stated precision**, but the *delta* claim
    does. Same-environment back-to-back arms:
```
baseline 4a4e422 : 85.79 / 80.06 / 91.10 / 86.98   (420 files, 6492)
HEAD     a3fe871 : 85.85 / 80.09 / 91.13 / 87.02   (422 files, 6520)
```
    Claimed 85.81 / 80.07 / 91.05 / 87 (a3fe871) and 85.78 / 80.03 / 91.01 / 86.98 (f3cd4a5).
    All within ~0.1 of mine; every axis moved **up**, so "unmoved" / "gate holds" is TRUE.
    Absolute coverage figures are environment-sensitive at the second decimal — quote deltas.

**knip**
15. "32 unused exports / 0 unused files / 3 unlisted binaries" ✓ exact at HEAD, name set
    matches; neither `probeBash` nor the two un-exported prefix arrays appear.
16. "exporting `probeBash` would have moved knip's baseline from 32 to 33" — ✓ **tested**:
```
=== knip WITH probeBash exported ===   Unused exports (33)
    probeBash  function  lib/doctor-hook-interpreter.mjs:85:17
=== knip at HEAD (control) ===         Unused exports (32)
```

**Mutations — all 11 claimed kills verified, each against a back-to-back green control.**
Applied as literal string replacements with the removed/inserted text printed (a changed
sha only proves *something* changed — my first attempt at M7 via `perl` silently
interpolated `${bashScripts…}` and produced a false GREEN), then restored from a file copy
with the sha asserted back.

17. 05121eb "single sweep → 6 red (both leak cases, both idempotence cases, the dedup
    restatement, the cap case)" — ✓ **exactly 6, exactly that set**, full suite 6520:
```
  - import-jsonl-dedup-scrub > a scrubbed title still deduplicates across runs
  - property > is idempotent, on the four shapes that used to prove it was not
  - secret-scrub-coverage > scrubs the SECOND space-adjacent labelled secret
  - secret-scrub-coverage > scrubs a run of three, not just the head
  - secret-scrub-coverage > is idempotent: a second scrub changes nothing (D#46)
  - secret-scrub-coverage > clears every labelled secret even when the cap is overrun
```
18. "MAX_SCRUB_PASSES=1 → 2 red" ✓ exactly 2
19. "vacuous fallback → 1 red" ✓ exactly 1
20. 0867145 "fillCap = half kills the drain case" ✓ 1 red of 274 — *drains the fill pool at
    the whole budget when the main pool is empty*
21. "fillCap = budget.reenrich kills the floor case" ✓ 1 red of 274 — *does not take the main
    scope below what its own pool can use*. Neither guard is vacuous in the other's direction ✓
22. f3cd4a5 "`ok` instead of `dwarn` on the unreadable-registration branch kills the ⚠ case"
    ✓ (kills 2: the named dispatch case *and* the doctor-wiring case)
23. "dropping `bashScripts.join` kills the naming case" ✓ exactly 1
24. "swallowing the outer catch kills the throwing-probe case" ✓ exactly 1
25. a3fe871 "removing the age gate kills 4 cases including both agreement cases" ✓ **exactly
    4, and both agreement cases are among them**
26. "skipping the data-dir scan kills 2" ✓ exactly 2
27. "flipping the unreadable-mtime fail-safe from in-flight to stale kills 1" ✓ exactly 1

**Doctor refactor (f3cd4a5)**
28. "All 21 doctor test files (149 cases) stay green" ✓ exact at f3cd4a5:
    `Test Files 21 passed (21) / Tests 149 passed (149)`
29. "every user-facing string is byte-identical" ✓ — full `doctor` output diffed between the
    PRE and POST trees on one fixture: the **only** difference is the tree's own path inside
    a `Fix: node <path>/install.mjs install` line, i.e. `__dirname`, not a string change.
30. "`probeBash` is deliberately NOT exported: no test uses it" ✓ (grep: only importers are
    the two test files, neither names `probeBash`)

**History (a3fe871)**
31. "the scanner's own comment records v3.93.0 moving the deleter to MEM_RUNTIME_DIR and
    leaving the scanner on join(MEM_DATA_DIR,'runtime')" ✓ — the comment is at
    install.mjs:2655-2659 pre-change, and CHANGELOG.md:3061 independently confirms the event:
    *"v3.93.0 moved the deleter (`cleanup()`) to the override-aware directory and left the
    scanner eight hundred lines earlier reading the data dir. `doctor` reported `✓ Stale temp
    files: none` while the command it recommends removed two files."*
32. "This is the second divergence between these two faces, not the first" ✓
33. "install.mjs … now has none" ✓ zero occurrences post-change (see F3)
34. "It is still said out loud, as a detail line rather than a warning" ✓ — human face:
```
  ✓ Stale temp files: none
    3 episode file(s) newer than 1h are in flight, not stale — cleanup keeps these.
```
35. "update residue is guarded in cleanup by install.lock rather than by age, so there is no
    age gate there to mirror" ✓ (M10 kills the case that pins it)

**Gates (all four commits)**
36. "eslint exit 0" ✓ — `npx eslint .` → `exit=0` (exit code read directly, not through a pipe)
37. "format:check clean" ✓ — `exit=0`, *All matched files use Prettier code style!*

---

# Method notes worth carrying

* **The box is contended.** A concurrent `vitest` (the other reviewer) wipes the shared vite
  `/tmp` transform cache mid-run, producing hundreds of `ENOENT … /ssr/<hash>` "failures" in
  files the mutation cannot touch — a false red indistinguishable from a real one. My first
  mutation batch read 1178 / 1088 / 1254 / 1192 failures for M4–M7 and every one was noise.
  Fix: accept a run only when the population loaded intact (case total == control), and take
  a control back-to-back with each mutation. This is `feedback-rulers-must-not-run-concurrently`
  on a fifth axis — the contending ruler was not mine.
* **A disk QUOTA (not free space) killed three harness processes** with SIGABRT / `pwd: write
  error: Disk quota exceeded` while `df` still read 80% / 2.4G free. Freeing my own archive
  trees restored it.
* **`perl -0pi -e 's/\Q…\E/…/'` does not suppress interpolation.** `${bashScripts.join(', ')}`
  inside the pattern was interpolated to empty, so the mutation "landed" (sha changed) but was
  not the intended one, and read GREEN — the exact `feedback-mutation-must-assert-applied`
  shape, one level deeper: assert *what* changed, not just *that* it changed.
