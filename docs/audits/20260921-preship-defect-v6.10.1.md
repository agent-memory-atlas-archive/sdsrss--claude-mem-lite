# Pre-ship DEFECT review — claude-mem-lite v6.10.1

Tree: `/tmp/claude-1000/preship-defect-mIw6` (`git archive` of e03fadfe6d3ca851746c6aea201121ec5e2ae3ab).
Self-anchor passed: `hook-handoff.mjs:461` carries `const safeKeyFiles = JSON.stringify(safeFiles.slice(0, 20));`
and `tests/handoff-match-keywords-scrub.test.mjs` exists.

Scope: `2c277b3` + `e03fadf`. The executable change is FOUR lines (`git diff d96b102..e03fadf`
with comment/blank lines filtered): the `scrubFilePaths` import, `const safeFiles = …`,
`extractMatchKeywords(scrubSecrets(allText), safeFiles)`, and `JSON.stringify(safeFiles.slice(0,20))`.
`lib/scrub-record.mjs` has NO executable change in this range — comments only. Everything else in
the 283 insertions is comment text and tests.

Baseline evidence, fresh in this tree:
- `npx eslint` on all five changed files → exit 0.
- `npx prettier --check` on all five → "All matched files use Prettier code style".
- Blast-radius suite (19 files that import `hook-handoff` / `scrub-record` / touch `match_keywords`)
  → **19 files / 426 tests passed, 0 failed**, `MEM_NO_AUTO_ADOPT=1`.

Counts: **0 P1 · 2 P2 · 8 P3.**

---

## P2-1 — `key_files` no longer redacts a credential whose syntax spans a separator, and the reachable input channel contradicts the docblock's reason for accepting that

`lib/scrub-record.mjs:132-137` states the trade and then justifies accepting it:

> "a credential whose own syntax spans a separator is no longer caught here — the Slack webhook
> path and the `scheme://user:pass@host` arms both need their `/` characters. Those are URL shapes,
> **and these columns hold filesystem paths**"

Measured, old vs new on the same bytes, back-to-back (`scrubSecrets` = the v6.10.0 function,
`scrubFilePath` = `lib/scrub-record.mjs:135`):

| input | v6.10.0 stored | v6.10.1 stored |
|---|---|---|
| `https://deploy:hunter2secret@internal.example.com/api/keys.json` | `https://***:***@internal.example.com/api/keys.json` | **unchanged — password verbatim** |
| `ftp://svc:S3cretValue1@files.example.com/drop/report.csv` | `ftp://***:***@files.example.com/drop/report.csv` | **unchanged** |
| `postgres://admin:pw123456@db.example.com/dump.sql` | `postgres://***` | **unchanged** |
| `https://hooks.slack.com/services/T00.../B00.../XXXX/payload.json` | `https://hooks.slack.com/services/***.json` | **unchanged** |

4/4 survive. Reproduced end-to-end through the SHIPPING writer, not a replica — seeded
`observations.files_modified` with case 1, called `buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null)`:

```
E2E key_files : ["https://deploy:hunter2secret@internal.example.com/api/keys.json"]
E2E password in stored column? true
E2E rendered  : "## Key Files\nkeys.json"
```

The premise "these columns hold filesystem paths" is false on the reachable channel:
- `lib/save-observation.mjs:181-182` filters `params.files` on `typeof f === 'string' && f.length > 0`
  and nothing else. `mem_save(files=[…])` performs **no path validation**.
- `hook-handoff.mjs:291-297` (`isValidFile`) admits the URL: `basename` is `keys.json`, which
  matches `FILE_BASENAME_RE`, and it is not under `/dev/`, `/proc/`, `/tmp/`.
- The hook arm also admits it: `extractFilePaths` (`bash-utils.mjs:446`) returns the URL verbatim
  from `{path: <url>}` and `{filePath: <url>}` (measured), and `hooks/hooks.json` matches
  `PostToolUse` on `*`, so every tool's input — including third-party MCP tools with a `path`
  parameter — reaches it. Only the `input.command` branch is safe: its regex requires
  `(?:^|\s)/`, and a URL's `//` is preceded by `:`, measured `[]` on
  `curl https://deploy:hunter2secret@…`.

**Why P2 and not P1:** the same bytes are already at rest elsewhere. `observations.files_modified`
has routed through this same segment-wise function since D#44 (`hook-llm.mjs:363`,
`lib/save-observation.mjs:181`), and the episode buffer JSON in the runtime dir holds the raw value
regardless. So this removes the last *copy-level* redaction of that shape rather than exposing data
that was previously protected everywhere. If `key_files` had been the only copy it would be P1.

**Action:** either accept explicitly and correct `lib/scrub-record.mjs:132-137` to say the columns
hold *caller-supplied strings that are not validated as paths*, or re-run `scrubSecrets`
whole-string as a second pass when the value contains `://` (the split/join is byte-preserving, so
a `://` guard costs nothing on real paths — 718/718 measured identity, see the non-findings below).

## P2-2 — "it does leave the machine through `export`" is false; `export` never reads `session_handoffs`

`hook-handoff.mjs:399-400` and `tests/handoff-match-keywords-scrub.test.mjs:16-17` both state that
`match_keywords` exposure matters because the column leaves the machine through `export`. That is
the sentence carrying the fix's severity, and the previous justification at this exact site was
itself retracted for being a no-op — so it is the one sentence that had to be measured.

Measured:
- `lib/export-columns.mjs:31-58` (`EXPORT_COLUMNS`) is an **observations-only** column list.
- Both export faces select `FROM observations`: `server.mjs:1753`
  (`SELECT ${EXPORT_COLUMNS_SQL} FROM observations …`, reached by `runExport` at `server.mjs:1701`),
  and the CLI `cmdExport` shares the same list by construction (the file's own header).
- `grep -rn "session_handoffs" server.mjs cli/` → **zero hits**. Outside tests, the only readers of
  the table are `hook-handoff.mjs`, `hook-context.mjs`, `hook.mjs` and `schema.mjs`.

So the residual exposure is local-DB-at-rest only, and there is no egress path. The fix is still
correct — a credential in a stored column is worth removing — but the recorded reason is a second
unverified justification landing at the site of a retracted first one, which is the recurrence shape
this repo has already paid for four times. (The claims lens may hold this too; I am reporting it
because it is a factual error in shipped source, not only in prose.)

---

## P3-1 — `allText` is scrubbed as a CONCATENATION, so the join destroys terms that no column loses

`hook-handoff.mjs:408-409`:
```js
const allText = [workingOn, ...completed.map((c) => c.title).filter(Boolean), unfinished].join(' ');
const keywords = extractMatchKeywords(scrubSecrets(allText), safeFiles);
```
The scrub runs AFTER the join, so a credential-noun at the end of one element and a `:`/`=` at the
start of the next form a match that exists in neither element. This is the same class the sibling
comment at `hook-handoff.mjs:435-438` already legislates against for truncation ("scrub raw values
BEFORE …"), and it is the opposite of what `next_steps` (`:376-383`) and `key_files` do — both
scrub per element and join afterwards.

Reproduced through `buildAndSaveHandoff`, prompt `"we still need to set the api_key"` +
observation title `": zebrafish is manual"`:
```
working_on     : "we still need to set the api_key"        <- term intact
completed      : "[change] : zebrafish is manual"          <- term intact
match_keywords : "need api_key manual"                     <- "zebrafish" GONE
```
Both columns keep `zebrafish`; only the derived keyword set loses it. Reachability is low (needs a
`[=:]` at an element boundary) but the fix is one line: scrub each element, then join.

## P3-2 — "scrubSecrets is identity on ordinary prose" is false, and one lost term can flip the matcher

`hook-handoff.mjs:401-403` claims a clean session's term set is "byte-identical to before; it moves
only where a credential was about to be stored". Two populations, measured:

- **2295 prose lines** from this repo's own `README.md` / `CONTRIBUTING.md` / `SECURITY.md` /
  `CLAUDE.md` / `docs/measurement/findings.md`, each truncated to 200 chars like a handoff prompt:
  term set moved on **0 / 2295 (0.00%)**. The claim holds on that population.
- **Directed grid of 12 ordinary developer prompts** carrying structured credential keys (which have
  no prose lookbehind by design): **12 / 12 lose exactly one term.** Examples —
  `"fix the api_key: handling in scrub-record…"` loses `handling`;
  `"the access_token: refresh flow needs retry backoff"` loses `refresh`;
  `"document how client_secret: rotation works…"` loses `rotation`;
  `"set DATABASE_URL=postgres in the compose file…"` loses `postgres`;
  `"run the server with --token placeholder…"` loses `placeholder`.

This is not cosmetic: `hook-handoff.mjs:664-671` scores `isSpecificTerm` tokens at **2** against
`HANDOFF_MATCH_THRESHOLD = 3` (`lib/handoff-constants.mjs:16`), so losing one specific term can
move a Stage-2 score from 4 to 2 — below threshold. Stage 0 / Stage -1 use a boolean `hasOverlap`,
which a singleton overlap set flips outright.

Mitigating, and it should be the stated reason instead of "identity": in the single-element case the
`working_on` / `completed` / `unfinished` COLUMNS lose the same word (they go through the same
`scrubRecord`), so the keyword set now agrees with what the resuming session is shown. That is a
defensible trade; "byte-identical" is not a defensible description of it.

## P3-3 — "Eight SECRET_PATTERNS" is a measured under-count, repeated at five shipped sites

The figure appears at `hook-handoff.mjs:375`, `hook-handoff.mjs:451`, `lib/scrub-record.mjs:123`,
`tests/handoff-key-files.test.mjs:113` and `tests/secret-scrub-coverage.test.mjs:298`, cited as
`secret-scrub.mjs:33/74/78/83/98/109/259/260`.

Measured mechanically — ran each of the `SECRET_PATTERNS` entries against a 26-case grid of
credential strings containing `/`, and counted patterns whose MATCHED TEXT spans a separator:
**15 patterns**, not 8. Beyond the eight cited (indices 0-5, 38, 39) the grid also reddens indices
17 (Slack webhook), 22 (`Authorization:` header), 24 (`AccountKey=`), 25 (`?sig=`),
26 (`SUPABASE_KEY`/`DATABASE_URL`), 27 (URL basic-auth) and 28 (DB connection string). On the
comment's own strict wording — "a value class that does not exclude `/`" — indices 22, 24, 25, 26
and 28 all qualify, so the count is **≥13** even excluding the two that carry `/` literally.

The fix direction is unaffected (an under-count understates the defect it was fixing). What the
under-count hides is the *other* side: it is the same set that defines what segment-wise scrubbing
stops catching, which is P2-1.

## P3-4 — truncate-before-scrub at `hook-handoff.mjs:111` lets a bare prefix-anchored token survive

`workingOn` is built from `truncate(p.prompt_text, 200)` (`:111`) and only scrubbed afterwards —
both for the column (`:434` `scrubRecord`) and now for the keywords (`:409`). The comment at
`:435-438` asserts the opposite order is maintained. A prefix-anchored pattern (`ghp_`, `sk-`,
`AKIA`, `npm_`, `glpat-`) whose length floor falls past the cut therefore fails to match.

Reproduced: a 241-char prompt with `ghp_zzz…`(40) starting at index 191 →
`working_on` and `match_keywords` both store `ghp_zzzz…` (the 8-char surviving prefix + ellipsis).
Control with the same token inside 200 chars → `working_on: "rotate *** now"`, keywords clean.

Severity is low because only a *prefix* leaks (the KV arms still catch `token=`/`password=` shapes,
whose `{6,}` floor survives truncation), and because the defect is PRE-EXISTING on the column — this
change inherits it into the keyword arm and into the new test's "does not store credentials" claim.

## P3-5 — the `### Working State` renderer defangs nothing, unlike the sibling the new test pins

`hook-context.mjs:782-787` renders `files.map((f) => basename(f)).join(', ')` raw, while the
sibling renderer `hook-handoff.mjs:923` wraps the identical expression in `safeText(...)` —
which strips context delimiters and ATX headings (`hook-handoff.mjs:802-804`). `working_on` and the
pending summary in that same block (`:769-779`) are equally undefended. `safeText` is a module-local
function in `hook-handoff.mjs` with no counterpart in `hook-context.mjs`.

Pre-existing, not introduced here. I am reporting it because
`tests/handoff-key-files.test.mjs:181-195` newly pins that exact renderer and asserts only the happy
case — the comment there says the sibling would otherwise be "green by inheritance rather than by
measurement", and its defanging still is.

## P3-6 — `hook.mjs:2122` selects `key_files` and never reads it

`SELECT working_on, unfinished, key_files FROM session_handoffs …` at `hook.mjs:2120-2123`; the only
uses of `prevClearHandoff` afterwards are `:2148-2149`, both `.unfinished`. Dead column in the
query, invisible to knip. Pre-existing; noted because the parent listed this site as a consumer to
check — it is not a consumer.

## P3-7 — `tests/handoff-match-keywords-scrub.test.mjs:91-94` omits the premise assertion its two siblings carry

The first two cases each assert `expect(kw, 'premise: no keywords were derived at all').toBeTruthy()`
before the negative. The third ("a credential in an observation title") asserts only
`not.toContain(...)`, which would pass identically if the observation title never reached the
keyword derivation at all.

I measured the premise directly rather than inferring it from a green mutation: seeding the title
`"rotated the zebrafish after api_key=ghp_…leaked"` yields
`match_keywords = "work ranker rotated zebrafish api_key leaked"` — the title's own terms are
present, so the case **is** discriminating today. This is a discipline gap, not a live vacuity; the
reading I measured is "the fixture does reach the branch".

For the record on the mutation question: all 11 new cases (7 in `handoff-key-files`, 4 in
`handoff-match-keywords-scrub`) are the complete set of new cases, so the parent's probes covered
every arm; I found no unprobed arm to mutate. `tests/handoff-key-files.test.mjs:178-183`
("leaves an ordinary path byte-identical") passes under both the old and the new function and is a
control, not a discriminator — same as the self-labelled `CRED_BASENAME` case. Neither is vacuous;
both are non-discriminating by design.

## P3-8 — the scrub now runs over the FULL file set instead of 20 paths

`hook-handoff.mjs:407` scrubs every member of `fileSet`; the pre-change line scrubbed only
`.slice(0, 20)`. Measured on 718 real repo paths: old shape (20 paths, whole-string) **0.084 ms**;
new shape **3.46 ms at 200 paths**, **8.38 ms at 500**. Bounded in practice —
`EPISODE_BUFFER_SIZE = 10` (`hook-shared.mjs:60`) and the observation query is `LIMIT 10` — so a
realistic `fileSet` is well under 100 paths (~1.7 ms) on the synchronous Stop/SessionStart path.
Not a blocker; recorded because `mem_save(files=[…])` has no length cap either
(`lib/save-observation.mjs:181-182`), so 10 rows × a large agent-supplied array is the only shape
that would make it visible.

---

## Measured non-findings (so they are not re-derived)

- **`fileSet` is not mutated between derivation and use.** Last write is `hook-handoff.mjs:314`;
  `safeFiles` is derived at `:407` and consumed at `:461`. Nothing in between touches it.
- **`map`-then-`slice` ≡ `slice`-then-`map` here**, and the keyword arm still reads the FULL set.
  Verified against `git show d96b102:hook-handoff.mjs` — the pre-change line was
  `extractMatchKeywords(allText, [...fileSet])`, i.e. also the full set. No change for sessions
  with >20 files.
- **No value is scrubbed twice inside `buildAndSaveHandoff`** (D#46 does not bite here).
  `match_keywords` is genuinely absent from `TEXT_FIELDS_BY_TABLE.session_handoffs`
  (`lib/scrub-record.mjs:58-89`), so `scrubRecord` passes `keywords` through untouched — pinned by
  `tests/secret-scrub-coverage.test.mjs:147`. `safeFiles` is scrubbed once; `allText` once.
  Separately, `scrubSecrets` measured **idempotent on its own outputs, 13/13 shapes** (`password=***`,
  `postgres://***`, `https://***:***@`, `Authorization: Bearer ***`, `SUPABASE_KEY=***`, …), so the
  one genuine double-scrub that does occur — `files_modified` read back from the DB was already
  `scrubFilePaths`'d at write — is a no-op.
- **`scrubFilePath` is identity on 718 / 718 real paths** from this tree, tested in both absolute
  and repo-relative form. "Identity on ordinary paths" holds as stated.
- **Legacy rows: no read path behaves worse.** Neither renderer changed; both still call
  `basename()`. There is no migration, so rows written before v6.10.1 keep destroyed filenames in
  `key_files` and un-scrubbed credentials in `match_keywords` — but per P2-2 that column has no
  egress path, and the UPSERT (`hook-handoff.mjs:471-490`) rewrites a row whenever the same
  `(project, type, session_id)` hands off again.
- **No guard was removed.** The only deleted lines across the two commits in `tests/` are two
  comment lines and one `import` line (`git diff d96b102..e03fadf -- tests/ | grep '^-'`).
- **`***` in `match_keywords` is inert at match time.** The file arm can store a literal `***` term
  (measured: `match_keywords = "*** work ranker touched files"` for a credential-basename file), but
  both matchers re-tokenize with `tokenizeHandoff`, which drops it — `tokenizeHandoff('a *** b')`
  returns `[]`. `isSpecificTerm('***')` is also false (length 3 < 4).
- **The `hook-llm.mjs` shape the new comment cites is real.** `hook-llm.mjs:358-396` derives
  `safeFiles` / `safeFilesRead` once and feeds `files_modified` plus `insertObservationFiles`.
