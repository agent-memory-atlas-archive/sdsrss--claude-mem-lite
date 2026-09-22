> **Added when this report was committed (v6.11.0 release), not part of the review.** It ran
> against the FIRST draft of this series (`05121eb` `0867145` `f3cd4a5` `a3fe871`), before its own
> findings were repaired and before a second review round (the `-r2` reports). None of those
> SHAs exist on `main`; the shipped equivalents are `4d8393c` `d409c8c` `91493ad` `9c41144`.

# Pre-ship DEFECT review — claude-mem-lite @ a3fe871

Anchor verified. `git rev-parse HEAD` = `a3fe871db6669457a6f9921dc01aaa417c3281fb`;
`git log --oneline 4a4e422..HEAD` = exactly a3fe871 / f3cd4a5 / 0867145 / 05121eb.

Working tree: `/tmp/claude-1000/-home-ai-dev-claude-mem-lite/cac51b05-093a-4203-b43f-62c5755d6589/scratchpad/tree-defect-dc5E`,
verified byte-for-byte equal to `git archive HEAD` (file-set diff empty) at the end of the
round. All mutations reverted from file copies; the four touched sources hash back to their
pre-mutation values:

```
d2d1a3b5…  secret-scrub.mjs
02378ef4…  hook-optimize.mjs
8b7c70f5…  lib/doctor-hook-interpreter.mjs
29fa9e53…  lib/doctor-stale-temp.mjs
fcc0d852…  install.mjs
```

## Grade counts

| Grade | Count |
|-------|-------|
| **P1 (blocks the tag)** | **0 — I found none.** |
| P2 | 1 |
| P3 | 5 |

Nothing I measured changes a user-visible behaviour in a wrong direction, leaks a secret that
the parent tree did not leak, or starves a pool that the parent tree did not starve.

## Suite baseline in this tree

```
$ npx vitest run
 Test Files  2 failed | 420 passed (422)
      Tests  2 failed | 6517 passed | 1 skipped (6520)
```

Both failures are **artifacts of a `git archive` tree, not regressions**. I proved it by
extracting the parent commit and running the same file:

- `tests/pre-commit-hook-sync.test.mjs > the tracked shim is recorded EXECUTABLE in the index`
  — `git ls-files -s .githooks/pre-commit` returns `''` because the archive has no `.git`.
- `tests/suite-touches-no-repo-files.test.mjs > adopts the sandbox project when nothing opts
  out — the premise` — fails identically at `4a4e422`:
  ```
  $ cd tree-base-4a4e422 && npx vitest run tests/suite-touches-no-repo-files.test.mjs
   Test Files  1 failed (1)
        Tests  1 failed | 3 passed (4)
  ```
The 1 skip is the documented "skips without git hooks" case.

`npx eslint .` → `ESLINT_EXIT=0`. `npm run format:check` → `All matched files use Prettier
code style!`. Both new `lib/` modules are registered in **both** `source-files.mjs:75-76` and
`package.json:77-78`. No import left dangling in `install.mjs` (readdirSync 6 uses, statSync 5,
execFileSync 18, existsSync 58, readFileSync 17).

---

# P2-1 — `mainPool`'s `scope` argument is load-bearing and completely unguarded

**File:** `hook-optimize.mjs:1762-1766`

```js
const mainPool = findReenrichCandidates(db, budget.reenrich, {
  scope: reenrichScope,        // <- this argument
  project,
}).length;
const fillCap = Math.max(half, budget.reenrich - mainPool);
```

**The shipped code is correct.** The defect is that nothing can say NO about it: the entire
safety argument in the commit body ("`mainBudget >= budget.reenrich - fillCap =
min(budget.reenrich - half, mainPool)`") depends on `mainPool` being the **main** scope's pool,
and replacing `reenrichScope` with a hard-coded `'aliases'` passes the **whole suite**.

### Reproduction

Mutation (applied from a file copy, sha `02378ef4f626` → `0a99f496e4e5`):
`scope: reenrichScope` → `scope: 'aliases'`.

Against the two new D#51 cases and then the full suite:

```
=== B3: mainPool measured with the WRONG scope ===
APPLIED hook-optimize.mjs: sha 02378ef4f626 -> 0a99f496e4e5
  [B3]       Tests  70 passed (70)

$ npx vitest run            # full suite, B3 applied
 Test Files  2 failed | 420 passed (422)
      Tests  2 failed | 6517 passed | 1 skipped (6520)
```

Identical to the unmutated baseline — the same 2 archive artifacts, nothing else. **The mutant
survives 6517 passing cases.**

### Why the two new cases are blind to it

I instrumented the block and read the real allocations in both shipped cases:

```
[PROBE] B=6 half=3 mainPool=0 fillCap=6 aliasBudget=0 conceptsBudget=5 mainBudget=1   <- "drains the fill pool…"
[PROBE] B=6 half=3 mainPool=1 fillCap=5 aliasBudget=1 conceptsBudget=4 mainBudget=1   <- "does not take the main scope below…"
```

In **both** fixtures the aliases pool happens to hold exactly as many rows as the main pool
(0 and 0; 1 and 1), so substituting one for the other changes no arithmetic. That is a
coincidence of the fixtures, not a property.

It is also structurally unreachable with `reenrichScope = 'narrow'`: narrow's predicate
requires `search_aliases IS NULL`, so every narrow candidate is necessarily an aliases
candidate, i.e. `aliasesPool >= narrowPool` always, and the mutant can only ever be *more*
conservative. The discriminating shape needs `wide` — **which is the scope the daily unattended
path passes explicitly** (`hook-optimize.mjs:1706-1707` records that).

### The consequence, measured

I mapped pool membership per seed shape:

```
[bare              ] {"narrow":1,"wide":1,"aliases":1,"concepts":1,"scopes":0}
[aliasesSet        ] {"narrow":0,"wide":1,"aliases":0,"concepts":1,"scopes":0}
[lessonSet         ] {"narrow":0,"wide":0,"aliases":1,"concepts":1,"scopes":0}
[aliasesAndLesson  ] {"narrow":0,"wide":0,"aliases":0,"concepts":1,"scopes":0}
```

`aliasesSet` gives a deep **wide** pool with an **empty aliases** pool. Seeding 6 of those plus
8 concepts-only rows and running the daily path (`reenrichScope: 'wide'`, `maxItems: 6`):

```
# SHIPPED code
[POOLS] {"narrow":0,"wide":6,"aliases":0,"concepts":14,"scopes":0}
[RESULT] wide.processed= 3  concepts.processed= 3
 ✓ main (wide) scope keeps its floor of 3

# with B3 applied
[POOLS] {"narrow":0,"wide":6,"aliases":0,"concepts":14,"scopes":0}
[RESULT] wide.processed= 0  concepts.processed= 6
 × main (wide) scope keeps its floor of 3
   → main scope starved by the fill pass: expected +0 to be 3
```

Main gets **0 of 6 waiting rows** while the fill pass takes all six slots — precisely the
starvation `hook-optimize.mjs:1782-1792` says is forbidden, and the fill pass writes `concepts`,
which is narrow's own predicate column (memory #48: every re-enrich pool keys on a column some
other pass writes).

### Suggested guard

One case with `reenrichScope: 'wide'`, an **empty** aliases pool, a main pool deeper than
`budget.reenrich - half`, and a fill pool deeper than `budget.reenrich`, asserting
`byScope.wide.processed === 3`. The premise assertions must include `aliases === 0`, because
that is the axis the two existing fixtures accidentally pinned to the main pool's size.

### What I verified is fine

The arithmetic claim itself holds. `aliasBudget + conceptsBudget <= fillCap` by construction,
so `mainBudget = B - aliasBudget - conceptsBudget >= B - fillCap = min(B - half, mainPool)`.
`fillCap <= B` (since `half <= B` for `B >= 1` and `B - mainPool <= B`), so `mainBudget >= 0`.
`fillCap` only widens when `mainPool < B - half` (i.e. `mainPool <= 2` at `B = 6`), and the old
`fillCap = half = 3` already exceeded that, so **no main candidate becomes newly reachable by a
fill pass** — the eviction set is unchanged. Behavioural confirmation of both directions:

```
=== B1: fillCap = half (the old arithmetic) ===
  [B1]  Tests  1 failed | 69 passed (70)
     RED: × drains the fill pool at the whole budget when the main pool is empty
=== B2: fillCap = budget.reenrich (ignore mainPool) ===
  [B2]  Tests  1 failed | 69 passed (70)
     RED: × does not take the main scope below what its own pool can use
=== B5: Math.max -> Math.min in fillCap ===
  [B5]  Tests  1 failed | 69 passed (70)
     RED: × drains the fill pool at the whole budget when the main pool is empty
=== B4: fill passes run BEFORE main (the load-bearing order) ===
  [B4]  Tests  2 failed | 68 passed (70)
     RED: × gives a row sitting in all three pools to the generic pass, not to the backfills
     RED: × does not take the main scope below what its own pool can use
```

The ordering guard is still live after the change — B4 is killed, so "the execution order below
it is untouched" is verified behaviourally, not just by reading the diff.

---

# P3-1 — the `MAX_SCRUB_PASSES` fallback drops the prose guard over the WHOLE input

**File:** `secret-scrub.mjs:328-333`

```js
if (pass >= MAX_SCRUB_PASSES) {
  for (const [pattern, replacement] of PROSE_UNGUARDED_PATTERNS) {
    result = result.replace(pattern, replacement);   // <- applied to the entire string
  }
  break;
}
```

The commit body defends this as "an input still carrying labelled secrets after 32 sweeps is
not prose under any reading". That is true of the **un-converged region**. The fallback is
applied to the whole document, so prose *elsewhere in the same string* is collateral — and the
un-guarded copy of the `password:` pattern has no credential-shaped value class at all
(`secret-scrub.mjs:74` with the lookbehind stripped), so it scrubs plain English.

### Reproduction

```
$ node probe11.mjs
--- chain n=31 (cap not reached) --- prose section after scrub:
Reset the password: instructions are in the onboarding doc.
Ask Bob, the token: alice is the reviewer.

--- chain n=33 (cap OVERRUN) --- prose section after scrub:
Reset the password: *** are in the onboarding doc.
Ask Bob, the token: alice is the reviewer.
```

`Reset the password: instructions are in the onboarding doc` is the exact v3.61.0 regression
`secret-scrub.mjs:44-50` records as "caught by independent pre-tag review" and deliberately
undone. It is irreversible — scrubbing runs on the write path.

### Why this is P3 and not P1: reachability is low, and I measured it

The only route to the cap is one long **space-adjacent** chain; independent slow spots converge
in parallel. Over 40 000 fuzz inputs built from 13 secret fragments the maximum was **7 passes**:

```
max passes over 40000 short fuzz inputs = 7
  input (len 144): "secret:bbbbbb  --token gggggg  https://u:pp@h ?sig=https://a:b@h  AccountKey=https://a:b@h bearer:cccccc\tsecret:bbbbbb token:aaaaaa token:aaaaaa"
best passes-per-byte: 3 passes in 18 bytes
```

The cap needs a deliberately constructed chain, minimum ~447 bytes:

```
  adjacent-chain n=31 bytes=433 passes=32
  adjacent-chain n=32 bytes=447 passes=33
  adjacent-chain n=36 bytes=503 passes=37
```

A newline breaks the chain (the lookbehind needs `[ \t]`), and the `=` / JSON / quoted-key
patterns carry no prose guard at all, so a pasted `.env`, a header dump and a one-line JSON blob
all converge in ≤3 passes. **Not raising this to P1**, but the fallback could be scoped to the
region that failed to converge, or the cap raised well above any constructible chain.

### The fallback itself is not a silent partial scrub — verified

```
n=40 passes=32 capped=true
SHIPPED scrubSecrets output:
token: *** token: *** … token: ***
residual plaintext values: []
```

I also swept 16 cap-overrun configurations (chain lengths 30-45 × 6 trailing shapes) re-running
every pattern with the guard stripped over the output, looking for anything a further pass would
still catch:

```
max uncapped pass count seen = 35; leaking configurations = 0
```

---

# P3-2 — the fixed point widens the over-scrub class (bounded, adjacency-only)

**File:** `secret-scrub.mjs:322-334`

The commit says the extra sweeps "only ever scrub MORE, never less, which is the safe direction
and is bounded by the prose negatives". The first half is right and I confirmed the mechanism:
every replacement ends in `*`, `"` or `'`, never `[A-Za-z]`, so a replacement can only ever
*remove* the prose guard from a following keyword, never add one. The second half — "bounded by
the prose negatives" — was not measured. I measured it.

### Grid (1008 rows: 8 left-hand shapes × 9 separators × 14 right-hand strings)

```
grid rows=1008  identical=958  differ=50
  of which the fixed point additionally scrubbed the RIGHT-hand text: 50
  other differences: 0
```

Every one of the 50 has the same shape — a replaced span, then a **single space or tab**, then a
labelled keyword with **no intervening word**:

```
in: "api_key: abcdefgh secret: onboarding"
1x: "api_key: *** secret: onboarding"
fp: "api_key: *** secret: ***"

in: "AKIAIOSFODNN7EXAMPLE token: rotation"
1x: "*** token: rotation"
fp: "*** token: ***"
```

Zero rows fired across `\n`, `, `, `. `, `; `, ` - `, or with any article in between. The pinned
negatives (`the token: alice`, `Reset the password: instructions are in the onboarding doc`,
`token_count: 123456`, `session: r.content_session_id`, `per session: ${x}`) survived in all
1008 rows. A control confirms half this class already existed before the change: when the
preceding value ends in a **digit** the single sweep already over-scrubbed
(`api_key: abcdefg1 secret: instructions` → both arms give `secret: ***`).

### The population arm: 214 681 lines of this repo's own tracked text, both arms back-to-back

```
files=725 lines=214681
unchanged-by-both=214016 changed-by-both=665 changed-only-by-fixedpoint=0 changed-only-by-single=0
```

**Zero** lines that the single sweep left alone are touched by the fixed point. This population
is not blind — 665 lines do reach the substitution path — which is what memory #189 says the
452-value live-corpus arm was not. Of the 665, 16 differ between arms; all are the adjacency
shape above or the `AccountKey=` grower-vs-consumer case already documented in
`tests/property.test.mjs`. The fixed point consumes slightly more of the surrounding token
there (a trailing backtick in `lib/import-jsonl.mjs`'s docblock), bounded by whitespace.

### Idempotence and cost — both claims hold

60 000 fuzz inputs from 20 secret fragments, 100 % reaching the substitution path:

```
fuzz inputs=60000 reached-substitution=60000 (100.0%) non-idempotent=0
```

Multi-line shapes the fuzz did not cover (PEM block, inline PEM, `<private>` block, JWT, Slack
webhook, Azure, CRLF, tab-separated) — all idempotent, none slow.

Cost:

```
clean prose 200KB (no secret, 1 sweep)         len= 204800      8.4 ms
prose+secrets 200KB (converges)                len= 204800      4.9 ms
60-chain alone (cap overrun)                   len=   1019      1.8 ms
60-chain + 200KB prose (cap overrun, big)      len= 205820     95.1 ms
200KB of adjacent chain                        len= 204800    159.9 ms
```

Bounded at 32 passes; the hot path (no secret) pays one sweep plus one string comparison, as
claimed. No catastrophic-backtracking input found.

### The three mutations in the commit body reproduce exactly

```
=== A1: single sweep (revert the fixed point) ===
  [A1]  Tests  6 failed | 93 passed (99)
     RED: × a scrubbed title still deduplicates across runs
     RED: × is idempotent, on the four shapes that used to prove it was not
     RED: × scrubs the SECOND space-adjacent labelled secret, not just the first
     RED: × scrubs a run of three, not just the head
     RED: × is idempotent: a second scrub changes nothing (D#46)
     RED: × clears every labelled secret even when the cap is overrun
=== A2: MAX_SCRUB_PASSES = 1 ===
  [A2]  Tests  2 failed | 97 passed (99)
=== A3: vacuous fallback (empty unguarded set) ===
  [A3]  Tests  1 failed | 98 passed (99)
```

Three more I added, all killed:

```
=== A4: PROSE_LOOKBEHIND typo -> derivation silently finds 0 patterns ===
  [A4]  Tests  1 failed | 98 passed (99)
=== A5: remove the early-exit (always burn all 32 passes) ===
  [A5]  Tests  8 failed | 91 passed (99)
     RED: × does NOT corrupt ordinary prose (the v3.61.0 regression)   … +7 more
=== A6: fallback runs but result is NOT assigned ===
  [A6]  Tests  1 failed | 98 passed (99)
```

A5 is the interesting one: it is the same failure mode as P3-1, and the guard set catches it in
8 places — so the prose protection **is** pinned; what P3-1 exploits is that the cap branch is
reachable without removing the early exit.

The `PROSE_GUARDED_PATTERNS` derivation reads correctly at runtime:

```
total patterns: 40
prose-guarded count: 3
```

---

# P3-3 — the test-count absolutes in three of four commit bodies are understated

Measured on a tree that matches `git archive HEAD` exactly (file-set diff empty, so the
generated `obs-id-caliber-sync` population is the clean tracked one):

```
 Test Files  2 failed | 420 passed (422)
      Tests  2 failed | 6517 passed | 1 skipped (6520)
```

**Total case count at HEAD is 6520.** `a3fe871` reports "Suite 422 files / 6510 passed = 6500 +
9 new cases + 1 generated". The per-commit **deltas are all correct** and sum to 28
(8 + 2 + 8 + 10), and `6492 + 28 = 6520` — exactly what I measure. The absolutes drift because
each commit after the first added its delta to the v6.10.2 baseline of 6492 rather than to its
own parent:

| commit | delta claimed | total claimed | total implied by its parent |
|--------|---------------|---------------|------------------------------|
| 05121eb | +8 | 6500 | 6500 ✓ |
| 0867145 | +2 | 6494 | 6502 |
| f3cd4a5 | +7 +1 generated | 6500 | 6510 |
| a3fe871 | +9 +1 generated | 6510 | **6520** |

This is the `baseline-read-after-own-edits` shape: a column carried from a stale base while the
deltas stayed honest. It matters because `CLAUDE.md`'s Baselines row is updated from these
numbers at release time, and 6510 would go into a tracked baseline 10 short.

I did **not** corroborate this by running the parent tree's full suite — that arm was polluted
(58 failed files / 270 failed cases) because the base tree shares a symlinked `node_modules`
with the defect tree, so I am not quoting it. The HEAD-tree measurement stands on its own and
reproduced identically across three separate runs.

---

# P3-4 — `install.mjs`'s new comment over-claims: the two faces still disagree under `install.lock`

**File:** `install.mjs:2556-2560`

> "Counting is all that differs here; the classification is shared, so *what doctor calls stale*
> and *what cleanup removes* can no longer disagree."

They still can. `cleanup()` skips update residue entirely while `install.lock` is held
(`install.mjs:2977-2980`); `scanStaleTempFiles` has no such gate, so doctor counts it. Measured
on one fixture (1 update-residue + 1 aged episode + 3 fresh episodes):

```
########## A) normal: doctor then cleanup, same fixture ##########
  ⚠ Stale temp files: 2 found (run: node install.mjs cleanup)
    3 episode file(s) newer than 1h are in flight, not stale — cleanup keeps these.
--- cleanup ---
  ✓ Removed: .update-staging-xyz
  ✓ Removed: runtime/ep-flush-old-d.json
    Kept 3 episode file(s) newer than 1h — possibly in flight, they sweep automatically once stale.
  2 stale file(s) removed.

########## B) install.lock HELD (self-update in progress) ##########
  ⚠ Stale temp files: 2 found (run: node install.mjs cleanup)
    3 episode file(s) newer than 1h are in flight, not stale — cleanup keeps these.
--- cleanup (lock held) ---
  ⚠ Update residue skipped: install in progress (install.lock held)
  ✓ Removed: runtime/ep-flush-old-d.json
    Kept 3 episode file(s) newer than 1h — possibly in flight, they sweep automatically once stale.
  1 stale file(s) removed.
```

Case A is **exact agreement** — the D#53 fix works end to end. Case B is the same defect class
on a third axis (first the directory, then the age gate, now the lock), and the commit body does
acknowledge the lock asymmetry — but the sentence in the code says the faces *cannot* disagree,
and they can. It is materially milder than D#53 because cleanup **says why** rather than
answering "No stale files found", which is why this is P3 and not higher. It also predates this
commit.

Related, same file: the gate's value is hand-copied as the literal `1h` into **both** faces
(`install.mjs:2580` and `install.mjs:3040`) while the rule lives in `ORPHAN_EPISODE_AGE_MS`
(`lib/time-constants.mjs:38`, `= HOUR_MS`). They agree today. It is a fourth hand-kept twin of
the gate in a commit whose headline is "the rule now has one home".

---

# P3-5 — surviving mutants on the new guards (per-site, as requested)

Everything below was applied from a file copy with the landing asserted (occurrence count = 1
**and** sha changed), run against the full 23-file / 160-case doctor+cleanup set, then reverted.

| # | Site | Mutation | Result |
|---|------|----------|--------|
| C1 | `lib/doctor-hook-interpreter.mjs:129` | skip the `count === null` branch | **killed** (2 red) |
| C2 | `:151` | drop `bashScripts.join(', ')` | **killed** (1 red) |
| C3 | `:157` | swallow the outer catch | **killed** (1 red) |
| C4 | `:72` | return `{count: 0, source:'settings'}` instead of `null` | **killed** (4 red) |
| C5 | `:73` | `c.startsWith('bash ')` → `c.includes('bash')` | **SURVIVES** |
| C6 | `:121` | `bashPresent = probeBash` → `() => true` | **killed** (1 red) |
| C7 | `:71` | drop the `installDir` filter on settings commands | **killed** (2 red) |
| D1 | `lib/doctor-stale-temp.mjs:60` | remove the age gate (the D#53 shape) | **killed** (4 red) |
| D2 | `:78-80` | skip the data-dir scan | **killed** (2 red) |
| D3 | `:57-59` | flip the unreadable-mtime fail-safe to `stale` | **killed** (1 red) |
| D4 | `:60` | `>` → `>=` on the age comparison | **SURVIVES** |
| D5 | `:85-86` | count in-flight as stale in the scanner only | **killed** (4 red) |
| D6 | `:85` | drop the `episodeAgeMs` argument | **SURVIVES** |
| D7 | `:32` | drop `ep-flush-` from the prefixes | **killed** (5 red) |
| D8 | `:29` | drop `.update-backup-` from the prefixes | **killed** (36 red) |

Verbatim for the three survivors:

```
C5: sha 8b7c70f5c25d->eb6adb07350c | Tests  160 passed (160)
D4: sha 29fa9e531d12->50035198a085 | Tests  160 passed (160)
D6: sha 29fa9e531d12->9135810a91ba | Tests  160 passed (160)
```

**C5** — `includes('bash')` would count a `node` command whose path merely contains the string.
It is benign on the shipped registration today, which I checked rather than assumed:

```
total hook commands in hooks/hooks.json: 11
startsWith("bash ") = 3 ["bash \"${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh\"", …]
includes("bash")    = 3
DIFFERENCE (counted only by includes): []
```
Worth noting only because this repo ships a root module literally named `bash-utils.mjs`; a
future hook command naming it would be miscounted, and nothing would go red.

**D4** is a one-millisecond boundary — not worth a case. **D6** means a caller passing
`episodeAgeMs` to `scanStaleTempFiles` would be silently ignored; the injected-clock case pins
`now` but not `episodeAgeMs`. Both are cheap to close and neither is reachable in shipped code.

---

# Verified clean (the lead's explicit questions)

**"Did the doctor extractions change any user-facing string or severity?"** No. I ran the real
`install.mjs doctor` against the parent tree and the HEAD tree over an identical sandbox fixture
(3 fresh episode files, 1 aged, 1 update residue), normalising the two tree paths, and diffed:

```
=== DIFF: parent 4a4e422 (-) vs HEAD a3fe871 (+) ===
@@ -21,7 +21,8 @@
   ✓ LLM provider: openrouter key set, openrouter.ai reachable …
   ⚠ Hook scripts: <SBX>/home/.claude-mem-lite/scripts is absent — all 6 hook commands …
   ✓ Hook interpreter: bash present (3 hook command(s) need it)
-  ⚠ Stale temp files: 5 found (run: node install.mjs cleanup)
+  ⚠ Stale temp files: 2 found (run: node install.mjs cleanup)
+    3 episode file(s) newer than 1h are in flight, not stale — cleanup keeps these.

   3 issue(s) found. (+6 warnings)
```

That is the **entire** diff across doctor's whole output — the intended D#53 change and nothing
else. The `Hook interpreter:` line, every other check, the severity counts and the summary line
are byte-identical across the `f3cd4a5` extraction. The new in-flight line is wired into the
`--json` face too:

```
"message": "Stale temp files: 1 found (run: node install.mjs cleanup)",
  "2 episode file(s) newer than 1h are in flight, not stale — cleanup keeps these."
```

**Runtime/data dir overlap** in `scanStaleTempFiles` (`lib/doctor-stale-temp.mjs:78-88`): if
`CLAUDE_MEM_RUNTIME_DIR` were pointed at the data dir the two loops would read the same
directory, but the prefix families are disjoint so nothing double-counts — and there is a case
pinning exactly that ("the two prefix families do not overlap, so nothing is counted twice",
killed by D7). Not a finding.

**Not verified:** `npm run dead-code` (knip). CLAUDE.md requires measuring it from the primary
working tree, and my brief limits me to read-only git there, so I did not run it. The commits'
knip claim (32 unused exports / 0 unused files / 3 unlisted binaries) is unchecked by me —
`probeBash` is correctly left unexported in `lib/doctor-hook-interpreter.mjs:85`, which is the
one thing in this round that would have moved that number.
