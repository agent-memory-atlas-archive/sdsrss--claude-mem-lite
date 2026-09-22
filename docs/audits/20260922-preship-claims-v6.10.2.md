# CLAIMS LENS — pre-ship review of `cb5ddd3`

Target `cb5ddd3` (parent `aebb14c`), HEAD confirmed at `cb5ddd3` before and after.
All work done in two extraction trees under the session scratchpad; the real repo was
read only (`git archive`, `git show`, one read-only `cp -r` of `.git`). Nothing written
to `/home/ai/dev/claude-mem-lite` or `~/.claude`.

Population: every falsifiable statement in the commit-message body of `cb5ddd3` plus the
new/modified code comments and test docblocks in its diff (`format-utils.mjs`,
`hook-context.mjs`, `hook-handoff.mjs`, `hook.mjs`, and the three test files).

**31 claims checked. 8 FALSE, 4 MISLEADING-BUT-TECHNICALLY-TRUE, 2 UNVERIFIABLE, 17 TRUE.**

---

## Harness

```
target : scratchpad/xtree-cb5ddd3   (git archive cb5ddd3 + node_modules symlink;
                                     later + a read-only copy of the real .git →
                                     `git status --porcelain` empty = working-tree-equivalent)
control: scratchpad/ctrl-aebb14c    (git archive aebb14c, no .git — the author's own control shape)
```

---

## 1. The cut-point sweep (item 1 of the commit, and the same numbers in
##    `hook-handoff.mjs:104-112` and `tests/handoff-working-on-scrub-order.test.mjs:1-16`)

### 1.1 "a 244-cut-point sweep across five credential families" — **MISLEADING-BUT-TECHNICALLY-TRUE**

Rebuilt the sweep two ways: as a pure `scrubSecrets`/`truncate` simulation, and end-to-end
through `buildAndSaveHandoff` on the control tree (one `:memory:` DB per cut point).
`truncate(s,200)` keeps `slice(0,199)`, so the cut lands at 199; the prompt is padded so
exactly `headLen` characters of the token stay on the kept side, `headLen = 1 … len-1`.

244 is **exactly** reproducible — but only with a 55-char Slack token
(`'xoxb-' + 12 + '-' + 12 + '-' + 24`, the bearer that is actually in the new test file):

```
ghp_+36      len 40 →  39 cuts
AKIA+16      len 20 →  19
xoxb-        len 55 →  54     ← 50 entropy chars, not 48
password=32  len 41 →  40
sk-ant+80    len 93 →  92
                      ---
                      244
```

The commit's own table labels that family **`xoxb- + 48`**, i.e. a 53-char token, which
gives 52 cuts and a total of **242**. The denominator and the table row therefore describe
two different fixtures; they cannot both be right. Corrected statement: *a 244-cut-point
sweep whose Slack arm is `xoxb-` + 50 entropy characters*.

### 1.2 "33 cut points leak >=12 characters under truncate-then-scrub" — **FALSE**

Measured end-to-end through `buildAndSaveHandoff` on the control tree, at the same 244
cut points:

```
TOTAL CUT POINTS: 244 | leak>=12: 38 | leak>=13: 33
ghp_+36     : cuts=39 leak>=12:22 leak>=13:21
AKIA+16     : cuts=19 leak>=12: 8 leak>=13: 7
xoxb-       : cuts=54 leak>=12: 3 leak>=13: 2
password=32 : cuts=40 leak>=12: 2 leak>=13: 1
sk-ant+80   : cuts=92 leak>=12: 3 leak>=13: 2
```

33 is the count under a **strictly-greater-than-12** threshold. Under the stated `>=12`
the answer is **38** — one extra cut point per family, exactly five more.

Corrected statement: *38 cut points leak ≥12 characters (33 leak ≥13)*.
The error direction understates the leak.

### 1.3 The per-family entropy table — **FALSE, every row, each by exactly one**

Same run, `maxHead` = the longest retained head the old order still stores, minus the
prefix length:

| family | commit says | measured | why |
|---|---|---|---|
| `ghp_`+36 | retained **28** of 36 | **29** of 36 | `ghp_…{30,}` — 29 entropy chars is the largest non-match |
| `AKIA`+16 | **14** of 16 | **15** of 16 | `AKIA[A-Z0-9]{16}` — 15 is the largest non-match |
| `xoxb-`+48 | **8** of 48 | **9** (of 50) | `xox[bpasr]-[A-Za-z0-9-]{10,}` |
| `password=` 32 | **3** of 32 | **4** of 32 | the appended `…` counts toward the `{6,}` value class, which is why it is 4 and not 5 |
| `sk-ant-api03-`+80 | **0** of 80 | **1** of 80 | the `ant` alternation lets `api03-AA` satisfy `{8,}`, so the last leaking head is `sk-ant-api03-A` |

The systematic one-character offset is consistent with a sweep fixture whose token landed
one position later than its arithmetic said. It matters most on the last row: `sk-ant-api03-`
is the commit's *contrast* case ("variable-length retained 0"), and it retains 1.

This table ships twice — in the commit body and verbatim in `hook-handoff.mjs:110-113`
("`ghp_`+36 retained 28 of its 36 entropy characters and `AKIA`+16 retained 14 of 16,
while variable-length `sk-ant-api03-` retained 0").

### 1.4 "0 under scrub-then-truncate" — **TRUE**

Same 244 cut points against the fixed tree: `leak>=12: 0`. Max retained head is 0 for four
families and 9 for `password=` — that 9 is the literal `password=` prefix with the value
already `***`, no entropy at all.

### 1.5 "the three call sites that sit twenty lines above it" — **FALSE**

Pre-change (`aebb14c`) positions in `hook-handoff.mjs`:

```
106  const t = truncate(p.prompt_text, 200);                     ← dedup key
111  let workingOn = uniquePrompts.map(... truncate ...)          ← join
126  workingOn = `(carry-forward subject) ${truncate(fallback.title, 180)}`
453  // ... scrub at the persistence boundary regardless of source.
454  // Order matters: scrub raw values BEFORE truncation, ...
```

The rule sits **327–348 lines** below the call sites, not twenty. The shipped test docblock
carries the same error in the other direction of phrasing: "the rule sat two dozen lines
below the code that broke it" (`tests/handoff-working-on-scrub-order.test.mjs:6`).
The in-code comment is the only one of the three that gets it right — it says merely
"the three call sites that sit above it".

### 1.6 "`EXPORT_COLUMNS` is observations-only and `session_handoffs` has zero occurrences in server.mjs/cli" — **TRUE** (re-measured, not inherited)

```
grep -c session_handoffs server.mjs  → 0
grep -c session_handoffs cli.mjs     → 0
grep -c session_handoffs mem-cli.mjs → 0
grep -r session_handoffs cli/        → 0
```
`lib/export-columns.mjs` `EXPORT_COLUMNS` is 26 entries, all observations columns, consumed
as `SELECT … FROM observations` in both `server.mjs:1753` and `mem-cli.mjs`. Claim stands
on its own evidence, not on the v6.10.1 lenses'.

### 1.7 "`working_on` is now scrubbed TWICE" vs the code comment's "a third time" — **MISLEADING**

Commit body: "`working_on` is now scrubbed TWICE (here, and at the persistence boundary
via scrubRecord)". Shipped comment, `hook-handoff.mjs:447`: "So `workingOn` passes
scrubSecrets twice on this derivation and a third time through scrubRecord."

Measured chain depths:
- `match_keywords` path: prompt arm (1) → `allText` map at `:457` (2) = **2**
- `working_on` column path: prompt arm (1) → `scrubRecord` at `:490` (2) = **2**

No value receives three sequential passes; the two shipped statements disagree on the
number for the same fact. "Twice" (the commit body) is the correct one.

### 1.8 "`completed` / `unfinished` … reach that call from STORED ROWS rather than from prompts" — **FALSE for `unfinished`**

This sentence is load-bearing: it is the stated reason `scrubRecord` "stays as-is" for those
two columns, i.e. the boundary that separates them from `working_on`. It appears in three
shipped places (commit body, `hook-handoff.mjs:117-118`, and the new test docblock).

- `completed` — `hook-handoff.mjs:218`, `db.prepare(…)`. Stored rows ✓
- `unfinished` — `hook-handoff.mjs:233-262`: it is `episodeSnapshot.entries[].desc`
  (the in-memory episode buffer) or, when that is empty, `readProjectTasks()` reading
  `~/.claude/tasks/<list>/*.json`. **Neither is a stored row.**

Corrected statement: *`completed` arrives from stored rows; `unfinished` arrives from the
in-memory episode snapshot or the on-disk task list.*

### 1.9 "measured 14/14 families a fixpoint on their own output … pinned in the new test" — **FALSE**

`tests/handoff-working-on-scrub-order.test.mjs` pins **eleven** bearers
(`sk-ant-api03-`, `ghp_`, `github_pat_`, `xoxb-`, `AKIA`, `password=`, `api_key:`,
`Authorization: Bearer`, `postgres://`, `AccountKey=`, `AIza`) — 11 `it.each` cases plus
one compound case, 12 tests. There is no 14-family measurement anywhere in the tree, and
`SECRET_PATTERNS` has 40 entries, so 14 is not a denominator that appears either.
Corrected statement: *11/11 families*.

### 1.10 "three passes stable on the compound string" — **TRUE**
The compound case runs `p1 = scrub(all)`, asserts `p1 !== all`, then `p2 === p1` and
`scrub(p2) === p2`. Green.

### 1.11 "D#46 stays open on idempotence by CONTRACT" / "D#49 still has three bare credential-shaped values" — **TRUE**
`defer list`: D#46 open, P2, "scrubSecrets is not idempotent-by-contract…".
D#49 open, P3, "events.file_paths 里 3 个凭据形值仍是裸的（写入端已修）" — three bare
credential-shaped values in a sibling path column. ("Titles are scrubbed on write TODAY"
also checks out: `lib/save-observation.mjs:192-196`.)

---

## 2. The second render surface (item 2)

### 2.1 "NARROWER than it reads: … a `<claude-mem-context>`-bearing fixture goes green against the unfixed tree and only a `## `-bearing one discriminates" — **TRUE**

Measured on the **control** tree, driving `buildSessionContextLines` end to end:

```
WorkingState rendered                : true
Key files line rendered              : true
LIVE <claude-mem-context> in output  : false   ← already covered by the whole-return pass
LIVE '## Recent' via working_on      : true    ← the actual gap
```

### 2.2 "eleven free-text interpolations reach that return and none stripped ATX markers" — **FALSE (the count)**

`buildSessionContextLines` returns
`neutralizeContextDelimiters([...summaryLines, ...handoffLines, ...deferredLines, ...obsLines].join('\n'))`,
so every one of those four arrays reaches it. The commit's eleven = 3 fixed + 8 named
(`:717/:736` + `:870-:883`). Behavioural probe, unadopted `CLAUDE_PROJECT_DIR`, marker
`zz ## ForgedSection` on the **fixed** tree:

```
LIVE  :: observations.lesson_learned  → ### File Lessons      (hook-context.mjs:650 pre-change)
LIVE  :: observations.title           → ### Key Context       (:660)
LIVE  :: deferred_work.title          → ### Deferred Work     (:818)
LIVE  :: observations.title           → ### Recent table      (:845, via mdCell)
LIVE  :: session_summaries.request    → ### Last Session      (:870)  [named]
strip :: session_handoffs 3 columns   → ### Working State              [fixed]
```

Four source families that carry a live forged section into the same return are **not** in
the enumerated population. `mdCell` (`hook-context.mjs:56-60`) escapes `|` and collapses
CR/LF/TAB only — no `#` handling — so `:845` is confirmed by reading as well as by probe.

Counting interpolations the way the commit appears to count them (one per free-text `${}`),
the population is **17**, of which 3 are fixed and **14** remain, not 11 and 8.
The identical claim is in the shipped test docblock:
`tests/handoff-context-defang.test.mjs:20-25`, "POPULATION, measured 2026-09-21: … ELEVEN".

The second half — "none stripped ATX markers" — is **TRUE** for the named sites
(`renderInjectableEvent` applies `neutralizeContextDelimiters` only; the `Last Session`
lines apply nothing).

### 2.3 "The other EIGHT … observations.title at :717/:736" — **FALSE (attribution)**

`:736` is `summaryLines.push(\`- ${renderInjectableEvent(e)}\`)`, fed by
`recentInjectableEvents`, whose SQL is `SELECT id, event_type, title, body, importance,
created_at_epoch FROM events`. It is `events.title`, not `observations.title` — a different
table and a different writer. Only `:717` is `observations.title`.

### 2.4 "the three session_handoffs lines (776/780/785 pre-change)" — **TRUE**
Control tree: 776 `- Working on:`, 780 `- Recent activity:`, 785 `- Key files:`. ✓

### 2.5 Stale line citations in the shipped test docblock — **MISLEADING**

`tests/handoff-context-defang.test.mjs` cites `hook-context.mjs:854` for the whole-return
defang and `hook-handoff.mjs:853` for "the free-text fields ONLY". Both are the **parent's**
positions. In the tree this file ships in they are `hook-context.mjs:872` and
`hook-handoff.mjs:843`; `:854` is `if (obsToShow.length > 0) {` and `:853` is a comment about
git tree state. Same for `:717/:736` (now 718/737) and `:870-:883` (now 888-901). Only the
`776/780/785` trio is labelled "pre-change".

### 2.6 The `stripAtxToFixpoint` docblock (`format-utils.mjs`) — **TRUE, all of it**

```
single pass on "x ## ## Key Decisions" → "x ## Key Decisions"   ← a live marker, as claimed
safeText(...)                          → "x Key Decisions"
"issue #42 filed" → unchanged ; "C# notes" → unchanged ; "D#216 open" → unchanged
"# heading" → "heading" ; "###### deep" → "deep" ; "#not-a-heading" → unchanged
```
Termination argument holds by inspection (every match carries ≥1 `#` and the replacement
drops all of them). "until 2026-09-21 only the first one called it" ✓ — `safeText` was
private to `hook-handoff.mjs` in `aebb14c` and `hook-context.mjs` never imported it.
"Both callers structure themselves with ATX headers" ✓ (`## Working On` / `### Working State`).

---

## 3. Item 3 — the dead columns

### "hook.mjs selected `working_on, unfinished, key_files` and read only `unfinished`" — **TRUE**

`aebb14c` `hook.mjs`: `prevClearHandoff` appears exactly four times — declaration `:2095`,
assignment `:2120`, and the two reads `:2148`/`:2149`, both `.unfinished`. Nothing else in
the file touches `working_on` or `key_files` from that row, and the value is never passed
out. The companion statement — the `### Working State` block is built by `hook-context`
from its own query — is also true (`hook-context.mjs:756/766`).

---

## 4. "NOT taken, and it is not a defect"

### 4.1 "it measures 3.46 ms at 200 paths" — **UNVERIFIABLE (unstamped), reading differs**

`scrubFilePaths` over 200 synthetic paths, 11 warm runs on this machine:
**median 4.304 ms** (min 4.280, max 4.332); at 20 paths, median 0.448 ms.
Same magnitude, ~24% above the quoted figure. The commit carries no machine/date stamp for
it, so under this repo's own doctrine rule 1 the number cannot be superseded or defended.

### 4.2 "the real N is bounded by EPISODE_BUFFER_SIZE=10 and a LIMIT 10" — **FALSE**

`EPISODE_BUFFER_SIZE = 10` (`hook-shared.mjs:60`) ✓ and the observation query does carry
`LIMIT 10` (`hook-handoff.mjs:328`) ✓ — but those bound **entries and rows**, not paths.
Each of the 10 rows carries an uncapped `files_modified` JSON array, and the snapshot is
`[...new Set(entries.flatMap(e => e.files || []))]` (`hook-episode.mjs:205`), also uncapped.

Measured by spying on `scrubFilePaths` with 10 rows × 50 files + a 40-file snapshot:

```
scrubFilePaths call sizes: [540]    stored key_files length: 20
```

N reached **540**, past the 200 the timing was taken at. The conclusion ("not a defect") may
well stand on its other two reasons — the slice-after-map is deliberate and documented, and
the keyword arm genuinely reads the full set (`:459` vs `:512`) — but the stated bound does
not hold, which is the "right for the wrong reason" shape this repo keeps shipping.

---

## 5. Evidence block

### 5.1 "Suite 420 files / 6481 tests, 0 failed" — **TRUE, reproduced exactly**

Extraction tree + a read-only copy of the real `.git` (`git status --porcelain` empty, so
byte-identical to the working tree at `cb5ddd3`):

```
Test Files  420 passed (420)
      Tests  6481 passed (6481)
```

### 5.2 "Control … 418 / 6453" — **TRUE, reproduced exactly**

```
scratchpad/ctrl-aebb14c (git archive aebb14c, no .git)
Test Files  2 failed | 416 passed (418)
      Tests  2 failed | 6450 passed | 1 skipped (6453)
```

### 5.3 "The 3 red + 1 skipped there are environmental (no `.git`)" — **UNVERIFIABLE as to "3"; the attribution is TRUE**

I measure **2 red + 1 skipped** in the author's own control shape, not 3. Both reds are
`.git`-environmental, proven rather than asserted: `tests/pre-commit-hook-sync.test.mjs`
goes green the moment a git index exists, and `tests/suite-touches-no-repo-files.test.mjs`
goes green in the working-tree-equivalent run above. A third red did not appear on this
machine; whether it appeared on the author's is not recoverable from the tree.

### 5.4 "Delta +2 files / +28 cases, exactly the 19 + 9 added" — **TRUE**
420 − 418 = 2; 6481 − 6453 = 28. `handoff-working-on-scrub-order.test.mjs` = 19 cases
(7 + 12), `handoff-context-defang.test.mjs` = 9 (7 + 2). Both files run green, 28 passed.

### 5.5 "eslint exit 0, format:check exit 0" — **TRUE**
Run without a pipe, exit status read directly: `eslint exit=0`, `format:check exit=0`
("All matched files use Prettier code style!").

### 5.6 "knip 32 unused exports / 0 unused files / 3 unlisted binaries, name set unchanged; `safeText` is not in it" — **TRUE**

Target tree: `Unused exports (32)`, `Unlisted binaries (3)` (`du`, `claude-mem-lite`,
`pgrep`), no unused-files section → 0. Name sets sorted and diffed between control and
target: **identical**. `safeText` is absent from both.

### 5.7 The six mutations — **five exact, m6 understated**

Each applied by anchor-count-asserted patch with sha compared before/after, `node --check`
green, **full suite** run, then `git checkout --` with a dirty-count of 0 confirmed after
every revert (the tree is committed, so the revert baseline is sound).

| # | mutation | commit says | measured (full suite) |
|---|---|---|---|
| m1 | prompt arm, scrub removed | 2 red | **2** — both straddling cases ✓ |
| m2 | fallback arm, scrub removed | 1 red | **1** — carry-forward case ✓ |
| m3 | `- Working on:` safeText removed | 1 + 1 collateral | **2** — Working-on case + the nested case ✓ |
| m4 | `- Recent activity:` removed | 1 red | **1** ✓ |
| m5 | `- Key files:` removed | 1 red | **1** ✓ |
| m6 | `stripAtxToFixpoint` single-pass | 1 red | **3** — nested case (new file) **plus** "strips adjacent markers that a single pass would re-form" and "strips a deeply repeated run", both in `tests/handoff-preship-repairs.test.mjs` |

"All six kill their designed case" — **TRUE**. m6's "1 red" holds only if "the final harness"
meant the two new test files; against the suite it is 3. Since the m3 row explicitly counts
collateral, the reader will take these as suite-wide counts, and for m6 that is wrong.
The direction is harmless (the guard is stronger than claimed) but the reading is not the
one stated.

### 5.8 "m6's FIRST draft capped ATX_MAX_PASSES at 1 and read GREEN … exiting the loop falls through to the fail-closed `replace(/#/g,'')`" — **TRUE**
Mechanism confirmed by reading: with the cap at 1 the loop exits after one changing pass
and hits `return text.replace(/#/g, '')`, which over-strips rather than under-strips.

### 5.9 "The premise cases caught my own first fixture: the pad ran straight into the token … SECRET_PATTERNS matched it at NO length" — **TRUE**
Every prefix family in `SECRET_PATTERNS` is `\b`-anchored (`\b(?:ghp_|…)`, `\bAKIA…`,
`\bsk-…`, `\b(?:xox[bpasr]|…)`), so `ppppppghp_aaa…` matches nothing at any truncation.
The premise case in the shipped test encodes exactly that and is non-vacuous.

### 5.10 "the v6.10.1 release push was rejected (GH013) over exactly that" — **UNVERIFIABLE here, consistent with the record**
Matches the project's own stored lesson (a credential literal in the scrub-fixture file
caused GitHub push protection to reject the release push). No independent check available
from the tree.

---

## Summary of the FALSE claims

1. **"33 cut points leak >=12 characters"** — it is 38 at ≥12; 33 is the ≥13 count. Understates.
2. **The five-row entropy table** (commit body *and* `hook-handoff.mjs:110-113`) — every row one low: 29/15/9/4/1, not 28/14/8/3/0. The `sk-ant-api03-` contrast case is 1, not 0.
3. **"the three call sites that sit twenty lines above it"** (and the test docblock's "two dozen lines below") — the distance is 327–348 lines.
4. **"`completed`/`unfinished` … arrive from STORED ROWS"** — `unfinished` comes from the in-memory episode snapshot or `~/.claude/tasks/*.json`. This is the stated reason `scrubRecord` stays as-is for that column.
5. **"measured 14/14 families a fixpoint"** — the cited artifact pins 11.
6. **"eleven free-text interpolations reach that return"** (commit body *and* the new test docblock) — 17 by the same counting rule; four more source families carry a live `## ` end to end.
7. **"observations.title at :717/:736"** — `:736` renders `events` rows via `renderInjectableEvent`.
8. **"the real N is bounded by EPISODE_BUFFER_SIZE=10 and a LIMIT 10"** — measured N = 540; those constants bound rows and entries, not paths.

## MISLEADING-BUT-TECHNICALLY-TRUE

- **"244-cut-point sweep"** reproduces only with a 55-char `xoxb-` token, which the same table calls `xoxb- + 48`.
- **"scrubbed twice" (body) vs "a third time through scrubRecord" (`hook-handoff.mjs:447`)** — max chain depth is 2; the two shipped statements disagree.
- **m6 "1 red"** — 3 red against the suite; true only for a two-file harness.
- **`hook-context.mjs:854` / `hook-handoff.mjs:853`** in the shipped test docblock — parent-tree line numbers; in the shipped tree they are `:872` and `:843` and point at unrelated code.

## What held up

The three defect adjudications themselves are sound and better evidenced than the prose
around them: the ordering bug is real and the fix drives the leak to 0 at all 244 cut
points; the "narrower/wider" re-reading of the second surface is correct and measured;
the two dead columns in `hook.mjs` are genuinely dead. Suite totals, delta, lint, format,
knip (counts **and** name set) and five of the six mutations all reproduce exactly.
