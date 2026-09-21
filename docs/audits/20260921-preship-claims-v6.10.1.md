# Pre-ship CLAIMS review — claude-mem-lite v6.10.1

Lens: are the author's own statements true? Not a defect hunt.
Tree: `/tmp/claude-1000/preship-claims-7Glt` (`git archive HEAD` of `e03fadfe6d3ca851746c6aea201121ec5e2ae3ab`, no `.git`, node_modules symlinked).
Scope: `d96b102..e03fadf` — two commits — plus the comments in `hook-handoff.mjs` / `lib/scrub-record.mjs`
and the docblocks of `tests/handoff-key-files.test.mjs`, `tests/handoff-match-keywords-scrub.test.mjs`,
`tests/secret-scrub-coverage.test.mjs`.

**Self-anchor passed**: `hook-handoff.mjs:461` contains `const safeKeyFiles = JSON.stringify(safeFiles.slice(0, 20));`
and `tests/handoff-match-keywords-scrub.test.mjs` exists (5581 bytes).

Probe scripts live in `/tmp/claude-1000/preship-claims-scratch/` — **nothing was left at the tree root**
(44 root `.mjs`/`.js`, unchanged; the one probe test file added under `tests/` was deleted).
Two revert probes were run from a file copy (`hook-handoff.ORIG.mjs`); the tree was restored each time and
the restore verified by sha256 (`f91b063b…c401237`, byte-identical to the extraction).
The live DB at `/home/ai/.claude-mem-lite/` was **not opened at all** — nothing here needed it.

**Tally: 24 claims checked · 4 FALSE · 3 UNVERIFIABLE · 17 VERIFIED.**

---

## FALSE

### F1 — "key_files was the sixth and last path column still handing a filesystem path to `scrubSecrets`"
(commit 2c277b3 body; `hook-handoff.mjs:449`; `tests/handoff-key-files.test.mjs:107`)

**"last" is VERIFIED. "sixth" is FALSE — it is the SEVENTH, and the repo already assigns "the SIXTH" to a different column.**

Full enumeration of every sink in this codebase that stores a filesystem path:

| # | sink | writer | function used |
|---|------|--------|---------------|
| 1 | `observations.files_modified` | `hook-llm.mjs:363,380` · `lib/save-observation.mjs:181` · `lib/import-jsonl.mjs:163` | `scrubFilePaths` |
| 2 | `observations.files_read` | `hook-llm.mjs:364,379` | `scrubFilePaths` |
| 3 | `observation_files.filename` | `lib/observation-write.mjs:122-124` (via `hook-llm.mjs:394`) | `scrubFilePaths` upstream |
| 4 | `events.file_paths` | `lib/activity.mjs:74` | `scrubFilePaths` |
| 5 | `deferred_work.files` | `lib/deferred-work.mjs:57` | `scrubFilePaths` |
| 6 | `session_handoffs.next_steps` (`.file`) | `hook-handoff.mjs:380` | `scrubFilePath` |
| 7 | `session_handoffs.key_files` | `hook-handoff.mjs:407,461` | `scrubFilePaths` (this commit) |

Also present in the schema but never holding a path: `session_summaries.files_read` / `.files_edited`
(`schema.mjs:261-262`). The only writer hardcodes `'[]', '[]'` (`hook-llm.mjs:1560-1561`), which
`tests/fast-summary.test.mjs:107` pins. Correctly excluded from the count.

The ordinal is wrong because the repo's OWN convention counts `observations.files_modified` and
`.files_read` separately, and three shipped sites say so:

- `CHANGELOG.md:245-249` (v6.8.2): *"Five columns held paths … then pre-ship review found a sixth column
  nobody had counted (`deferred_work.files` …). All six scrub now."*
- `lib/deferred-work.mjs:52`: *"**The SIXTH path column.** `files` is agent-writable on two live faces …"*
- `tests/secret-scrub-coverage.test.mjs:373` / `:379`: *"The SIXTH path column, found by the claims lens:
  `deferred_work.files` …"* / `describe('deferred_work.files — the sixth path column', …)`

`next_steps.file` was added at the v6.10.0 pre-ship round (`lib/scrub-record.mjs:70-72` says so), making
seven. So after this commit **two shipped source files each claim "the SIXTH path column" for a different
column** — `lib/deferred-work.mjs:52` vs `tests/handoff-key-files.test.mjs:107` + `hook-handoff.mjs:449`.
Both cannot hold.

Second, smaller error in the same sentence: `tests/handoff-key-files.test.mjs:107-110` writes
*"The other **five** (`observations.files_modified/files_read`, `observation_files.filename`,
`events.file_paths`, `deferred_work.files`, `session_handoffs.next_steps.file`)"* — the parenthetical
**enumerates six columns**. `next_steps.file` was appended to the list without moving the count.

**"last" VERIFIED**: after this commit no non-test call site hands a path to `scrubSecrets`. The only
`scrubSecrets(` left in `hook-handoff.mjs` is `:409`, on `allText` (prose). Swept with
`grep -rn 'scrubSecrets(' --include=*.mjs` over the whole tree minus `tests/` and `secret-scrub.mjs`.

---

### F2 — "Eight SECRET_PATTERNS carry a value class that does not exclude `/`"
(commit 2c277b3 body; `lib/scrub-record.mjs:123`; `hook-handoff.mjs:376-377` and `:451`;
`tests/handoff-key-files.test.mjs:113`; `tests/secret-scrub-coverage.test.mjs:298`; `CHANGELOG.md:251`)

**FALSE, measured two ways, and both disagree with 8.**

`SECRET_PATTERNS.length` = **40** (measured, `secret-scrub.mjs:8`).

- **Structural reading** ("carry a value class that does not exclude `/`"): **21 of 40** patterns contain a
  negated character class that does not list `/`. The 13 the enumeration omits are the quoted-value arms
  (`[^'"]`, `[^"]`, idx 6-9, 23, 35-37) and idx 22, 24, 25, 26, 28. `[^'"]` does not exclude `/` either.
- **Behavioural reading** (the one the sentence is used for — "so on a path the match eats the separator"):
  **12 of 40** patterns consume a `/` or `\` when run over a bare filesystem path.
  Population: 1130 path-shaped probes built from the 94 literal credential keywords the patterns
  themselves name, in `=`, `:` and `--flag` positions with three value shapes, plus a connection-URL and an
  `Authorization:` probe. Each pattern was run alone against every probe and flagged if its match text
  contained a separator.

The 8 cited (`secret-scrub.mjs:33/74/78/83/98/109/259/260` = pattern indices 0,1,2,3,4,5,38,39) all
reproduce. The four the enumeration misses, with the matched text measured:

| idx | line | eats the separator as | source |
|-----|------|----------------------|--------|
| 22 | ~`Authorization:` arm | `Authorization: Bearer abcdef123456/notes.mjs` | `(Authorization:\s*(?:Bearer\|Basic\|token)\s+)[^\s,;'"}\]]+` |
| 24 | Azure | `AccountKey=hunter2abcdef/notes.mjs` | `\b(AccountKey\|SharedAccessSignature)=[^\s;&'"]{16,}` |
| 26 | Supabase / URL env | `SUPABASE_KEY=hunter2abcdef/notes.mjs` | `(\b(?:SUPABASE_KEY\|…\|DATABASE_URL\|REDIS_URL)\s*[=:]…` |
| 28 | db connection URL | `postgres://user:passwordvalue@host/db/notes.mjs` | `\b(postgres(?:ql)?\|mysql\|…)…` |

idx 28 is the arm `scrubFilePath`'s own docblock names as a deliberate trade, so it is *known*; it is still
counted in "carry a value class that does not exclude `/`". idx 22/24/26 are not mentioned anywhere.

This does not weaken the fix — it understates its reach. But the figure is an enumeration with a cited
line list, i.e. a claimed population, and it is short by 4 behaviourally and 13 structurally.
**Six live copies**, including `CHANGELOG.md:251` in present tense.

---

### F3 — "pre-fix 3 failed / 8 passed" for `tests/handoff-key-files.test.mjs`
(commit 2c277b3 evidence line)

**FALSE — measured 4 failed / 8 passed (12).** `3 + 8 = 11`, and the file has 12 cases: that is the tell.

Revert probe, from a file copy, mutation asserted applied (sha `60e96730…` vs baseline `f91b063b…`):
`hook-handoff.mjs:461` restored to `JSON.stringify([...fileSet].slice(0, 20).map((f) => scrubSecrets(String(f))))`
plus the `scrubSecrets` import. Baseline before the probe: 12 passed (12). After:

```
Tests  4 failed | 8 passed (12)
  × keeps the filename when the credential is in a directory segment
  × renders the real basename in the ## Key Files line
  × keeps two files in one credential-bearing directory distinct
  × renders the real basename on the SECOND surface too (### Working State)
```

The uncounted fourth is the `### Working State` case — the second renderer, which the commit body
devotes a paragraph to arguing must get its own case rather than inheriting green. The evidence line
undercounts the very case the prose is about.

Restored afterwards; sha256 back to `f91b063b…`, 12/12 green.

---

### F4 — "It does leave the machine through `export`, which is what makes it a leak"
(commit e03fadf body; `hook-handoff.mjs:399-400`; `tests/handoff-match-keywords-scrub.test.mjs:15-17`)

**FALSE. `export` does not emit `match_keywords`, or any `session_handoffs` column.**

- CLI `export` — `mem-cli.mjs:2205-2212`: `SELECT ${EXPORT_COLUMNS_SQL} FROM observations WHERE …`.
- MCP `mem_export` — `server.mjs:1698` → `runExport`, same `EXPORT_COLUMNS_SQL` (`lib/export-columns.mjs:1-10`
  exists precisely so the two faces cannot drift).
- `EXPORT_COLUMNS` (`lib/export-columns.mjs:31-58`) is 26 entries, all `observations` columns. No
  `match_keywords`, no `key_files`, no `session_handoffs`.

Every non-test reader of `session_handoffs`, swept with `grep -rn 'session_handoffs'` minus `tests/`:
`hook-handoff.mjs` (writer + intent matcher), `hook-context.mjs:753-786`, `hook.mjs:1989` (GC) and
`hook.mjs:2122` (a `SELECT working_on, unfinished, key_files` whose `key_files` is never read — only
`.unfinished` is, at `:2148`), and `lib/startup-dashboard.mjs:34` (`working_on` only). None is an export.

This is the load-bearing sentence of the commit: it is what upgrades the finding from "untidiness" to
"leak". The underlying defect is real — the column did store credentials at rest, and a DB file can be
copied — but the stated egress path does not exist. Two live copies in the tree plus the commit body.

---

## UNVERIFIABLE

### U1 — "three of five probe shapes differ" (commit 2c277b3)
No probe set is recorded anywhere in the tree (`grep -rna 'probe shape'` finds only an unrelated line in
`tests/cli-broken-pipe.test.mjs`). Doctrine rule 3: the population is a required field. Measured
`scrubSecrets` vs `scrubFilePath` over the candidate sets that DO exist in the tree:

| set | differ |
|-----|--------|
| `tests/secret-scrub-coverage.test.mjs` `KV_SHAPES` (4) + the basename-credential shape | **4 of 5** |
| `tests/handoff-key-files.test.mjs` second-describe corpus (cred-dir, cred-basename, 3 ordinary) | **1 of 5** |
| the three consts `CRED_DIR_A/B`, `CRED_BASENAME` | **2 of 3** |
| one probe per credential FAMILY (KV `=`, KV `:`, `--flag`, `ghp_` prefix, hex-32) — **my construction** | **3 of 5** |

The last reproduces the figure exactly, so the claim is not contradicted. But I built that set; the author's
is not written down, and three other natural readings give 1, 2 and 4. Not gradeable either way.

### U2 — "this justification retired the question for four releases" (commit e03fadf)
I may run exactly one read-only git command against the real repo and spent it on the log, so no blame is
available, and my tree has no `.git`. `match_keywords` appears **nowhere in CHANGELOG.md**, so the tree
carries no independent date for when the `tokenizeHandoff` justification was written.

Circumstantially consistent: the D#44 round shipped in v6.8.2 (`CHANGELOG.md:220`) and four releases
followed — 6.8.3, 6.9.0, 6.9.1, 6.10.0 (`CHANGELOG.md:158/108/71/5`) — matching
`lib/scrub-record.mjs:79`'s "the reason recorded here until v6.10.0".

Flagged, not graded: the identical figure already sits 60 lines above it at `lib/scrub-record.mjs:15`
— *"that instruction sat here for four releases"* — about a **different** claim (the D#44 pre-scrub
prescription). A number that matches its neighbour exactly is the shape this repo's history records as a
carried cell. Worth one `git log -S` before the tag.

### U3 — "0 failed" on the full suite (both commits)
My tree is a `git archive` extraction with no `.git`, and I must not run in the real repo. Two cases fail
here, both traceable to the missing `.git` and neither to the change under review:

- `tests/pre-commit-hook-sync.test.mjs:47` — `git ls-files -s .githooks/pre-commit` returns `''`.
- `tests/suite-touches-no-repo-files.test.mjs:120` — the dogfood-adopt *premise* case. `dogfoodAutoAdopt`
  (`install.mjs:1198-1213`) fires only when `git -C PROJECT_DIR config --get remote.origin.url` matches
  `github.com[:/]sdsrss/claude-mem-lite`; with no repo the `execFileSync` throws into the silent-skip catch.

`1 skipped` is the documented git-hooks skip (CLAUDE.md Baselines).

---

## VERIFIED

**V1 — full-suite counts.** Measured at HEAD in my tree: **418 files / 6448 tests, 1 skipped**
(`Duration 34.08s`). Matches e03fadf's "418 files / 6448 tests" exactly.

**V2 — "plus exactly this file's 4 cases".** `npx vitest run tests/handoff-match-keywords-scrub.test.mjs`
→ **4 passed (4)**. 6448 − 4 = **6444**, matching "417/6444 before".

**V3 — "plus exactly these 7 cases".** `npx vitest run tests/handoff-key-files.test.mjs -t 'key_files scrubs per path SEGMENT'`
→ **7 passed | 5 skipped (12)**. 6444 − 7 = **6437**, matching "6437 at v6.10.0". The two intervening
commits (`3904fa1`, `d96b102`) are `docs:` only and neither adds a source file under
`benchmark/`/`lib/`/`scripts/`/root, so the generated `obs-id-caliber-sync` cases are unmoved.

**V4 — the cited before/after.** Byte-for-byte:
```
/home/ai/dev/app/password=hunter2abcdef/notes.mjs
  before (scrubSecrets)  /home/ai/dev/app/password=***           -> basename password=***
  after  (scrubFilePath) /home/ai/dev/app/password=***/notes.mjs -> basename notes.mjs
```

**V5 — "Both renderers call `basename()`" / "TWO user-visible surfaces, not one".**
`hook-handoff.mjs:920` — `lines.push('## Key Files', safeText(files.map((f) => basename(f)).join(', ')), '')`.
`hook-context.mjs:786` — `handoffLines.push(\`- Key files: ${files.map((f) => basename(f)).join(', ')}\`)`.
Two, both `basename()`. The third `SELECT … key_files` (`hook.mjs:2122`) never reads the column, so it is
not a surface — correct to leave uncounted.

**V6 — "`fileSet` is keyed on the RAW path … collapse onto the identical stored string".**
`hook-handoff.mjs:258` `new Set()`; `:298` and `:314` add raw; `:407` scrubs the materialised array.
Measured under the pre-fix revert with `CRED_DIR_A`/`CRED_DIR_B`:
`["/home/ai/dev/app/password=***","/home/ai/dev/app/password=***"]`, **distinct = 1**.

**V7 — "Asserting the array LENGTH there is vacuous — the count stays 2 either way".**
Measured: **length 2** pre-fix (1 distinct), **length 2** post-fix (2 distinct). The test asserts
`new Set(files).size` and the sorted basenames, which is the discriminating assertion.

**V8 — the retraction sweep of "key_files is the one call site that followed the prescription".**
`tests/secret-scrub-coverage.test.mjs:288-297` carries the CORRECTION directly under the original
sentence, and it reads as a correction rather than a second policy. Entity sweeps (`-a`, no
`--include`, whole tree) for `one call site` / `followed the prescription` / `exactly ONE` /
`alphanumeric tokens only` / `cannot survive the upstream tokenizer` / `prescription` / `element-wise`
found **no un-retracted live copy**. `README.md`, `README.zh-CN.md` and `llms.txt` (40 lines, the file
that escaped a sweep at v6.2.0) are clean. `CHANGELOG.md:245` and `docs/audits/20260913-v6.8.2-claims-review.md:24`
are dated release/audit prose — correctly left as history.

*The sweep's own gap:* it did not sweep the claim it was simultaneously creating. See F1 — "the SIXTH
path column" now has two live, contradicting owners.

**V9 — "the FILE arm never reaches the tokenizer".** `utils.mjs:601-611`: the `for (const f of files)` loop
does `basename(f).replace(/\.[^.]+$/, '')` and nothing else; `tokenizeHandoff` is called at `:607` on
`text` alone.

**V10 — "the tokenizer SPLITS a secret from its keyword rather than removing it".** Measured:
`tokenizeHandoff('token=ghp_a×36')` → `["token","ghp_aaaa…"]`. `utils.mjs:529` has `=` in the split class;
the second term is length ≥ 3 and not a `HANDOFF_STOP_WORDS` member, so `:609` adds it.
`extractMatchKeywords('the upstream client … token=ghp_…', [])` → `"token ghp_aaaa… live"`.

**V11 — "`/repo/ghp_<36>.mjs` was stored verbatim (lowercased)".** Measured:
`extractMatchKeywords('', ['/repo/ghp_a×36.mjs'])` → `"ghp_aaaa…"` (36 a's, lowercased). Confirmed
end-to-end by V17's revert probe.

**V12 — "nothing renders match_keywords, it is read back for a token-set intersection".**
Every non-test read — `hook-handoff.mjs:569`, `:602-603`, `:616`, `:662` — wraps it in
`new Set(tokenizeHandoff(...))` for overlap scoring. No renderer, no injection path.
(The *storage* half of "Exposure is storage, not prompt" is verified; the *egress* half is F4.)

**V13 — "No value is scrubbed twice."** Traced. `safeFiles` (`:407`) is scrubbed once and consumed by the
keyword file arm (`:409`) and by `safeKeyFiles` (`:461`) with no second scrub. `allText` (`:408`) is built
from the RAW `workingOn` / `completed` titles / `unfinished` and scrubbed once at `:409`. `scrubRecord`
(`:441-447`) then scrubs those same RAW values once each for their own columns, and skips
`match_keywords` — it is not in `lib/scrub-record.mjs:57-91`'s `session_handoffs` field list. Two
derivations from one raw source, one scrub each.

**V14 — "the keyword arm keeps reading the FULL file set; only key_files slices to 20".**
`extractMatchKeywords(scrubSecrets(allText), safeFiles)` takes the unsliced array; `:461` slices a copy.

**V15 — "slicing after a per-element map is equivalent".** Measured on a 35-element mixed array:
`scrubFilePaths(arr).slice(0,20)` === `scrubFilePaths(arr.slice(0,20))` (deep-equal true), order preserved,
and `scrubFilePath` is stateless across repeated calls (no `/g` `lastIndex` leak).

**V16 — "the shape hook-llm.mjs already uses where one array reaches two columns".**
`hook-llm.mjs:363` derives `safeFiles` once; `:380` writes it to `observations.files_modified` and `:394`
passes the same array to `insertObservationFiles` → `observation_files.filename`. One array, two sinks,
and `:360-363`'s comment gives the same reason (the junction value is also the recall key).

**V17 — "pre-fix 3 failed / 1 passed (the passer is the ordinary-terms control)".**
Revert probe (mutation asserted applied, sha `bdfafeb0…`): `:409` restored to
`extractMatchKeywords(allText, [...fileSet])`. Result **exactly** as claimed:
```
Tests  3 failed | 1 passed (4)
  × file arm: a credential that IS the basename is not stored verbatim
  × prose arm: a credential in the working objective is not stored verbatim
  × prose arm: a credential in an observation title is not stored verbatim
  ✓ leaves ordinary terms untouched, from both arms
```
Restored; sha256 back to `f91b063b…`, 16/16 green across both handoff files.

**V18 — the control that bounds the fix: "scrubSecrets is identity on ordinary prose and scrubFilePaths is
identity on ordinary paths, so a clean session's term set is byte-identical."**
This is the claim the prompt asked to test on real-looking content rather than the fixture, so I ran it
over the repo itself at the **term-set** level (`extractMatchKeywords` before vs after the scrub), which is
what the column actually stores.

| arm | population | term set moved |
|-----|-----------|----------------|
| paths | every file in the tree, 718, as absolute AND relative = 1436 probes | **0** — and the term set over all 718 at once is byte-identical |
| ordinary prose | 20 md files / **3050** non-empty lines (README ×2, CLAUDE.md, CONTRIBUTING, SECURITY, docs/ARCHITECTURE, …) | **1** (0.033%) |
| adversarial prose | 24 md files / **8165** lines of this repo's own secret-scrub audits, which quote credentials on purpose | 27 (0.331%) |

The single ordinary-prose move is `docs/ARCHITECTURE.md`'s literal `<private>...</private>`, which
`scrubSecrets` strips to `[redacted]` by design (`lib/private-strip.mjs`) — not a credential false
positive. **Claim holds**, with that one bounded exception, which is worth one clause in the comment since
`working_on` is verbatim user-prompt text and a user can type `<private>`.

---

## Two notes outside the claim list

1. `package.json` version is still **6.10.0**, matching `CLAUDE.md`'s `**Version**: 6.10.0` release guard.
   The bump to 6.10.1 has not happened in this tree — expected, but `tests/install-e2e.test.mjs` asserts the
   four-file agreement, so the bump must move all of them together (`node cli.mjs release`).
2. `benchmark/baseline.json` expiry (CLAUDE.md: red from 2026-10-14 16:06 UTC) is not yet reached at
   2026-09-21, so `--strict` should stay green through this tag. Not re-measured here.
