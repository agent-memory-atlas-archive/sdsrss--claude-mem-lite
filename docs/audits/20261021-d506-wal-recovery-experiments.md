# D#506 mechanism experiments — corrupt-WAL recovery (2026-10-21)

Tree: claude-mem-lite v6.30.1 @ 5443e879 (schema v49), better-sqlite3 13.0.3, SQLite 3.53.4,
Node v26.8.1, Linux 7.0.0-38, every fixture on tmpfs under `<d506>/fx` (deleted at the end).
`<d506>` = `/tmp/claude-1000/-home-ai-dev-claude-mem-lite/c9e45eae-6456-4573-9010-9065054431eb/scratchpad/d506`.
Every open of a fixture ran in its own fresh node process; every outcome was checked in another
fresh process. Children ran with HOME=`<d506>/home`, TMPDIR=`<d506>/tmp`, CLAUDE_MEM_DIR=<fixture>,
LLM keys stripped (`scripts/common.mjs` childEnv). Host load average 12-18 on 12 cores during the
runs (another session's suite), so the timings in Q3 are noisy.

## Fixtures

- **pristine**: `ensureDb()` on an empty dir, `wal_checkpoint(TRUNCATE)`: 64 pages, 262,144 B.
- **(a)** the test fixture `plantCorruptWal` (tests/wal-recovery.test.mjs): pristine main file +
  the WAL of `CREATE TABLE _wal_probe_marker` (3 frames: pages 1, 54, 65); page-1 frame bytes
  100..300 = 0xff; every frame re-signed; a 32 KB zero `-shm`.
- **(b)** pristine main + WAL of 400 inserts into `observations` (FTS triggers fire; 156 frames;
  77 observations-table pages). The NEWEST frame of one seeded observations page is damaged:
  `b-header` bytes 0..200 = 0xff (page header + cell pointers); `b-rand` 1-8 bytes xor'd at a
  seeded offset. Re-signed.
- **(c)** fixture-a WAL with 1-8 xor'd bytes at a seeded offset in a seeded sqlite_schema frame
  (page 1 = interior, page 54 = leaf). Re-signed. Search over seeds 1..300 (fresh RO probe
  process + fresh ensureDb process per seed): 98 "malformed database schema", 8 "database disk
  image is malformed", 194 opened (page 1: 147 opened / 2 malformed; page 54: 98 schema / 6
  malformed / 47 opened). The RO probe's verdict equalled ensureDb's on 300/300 seeds. D#512
  reported 162/300; I did not have its damage distribution, and in mine half the seeds land in
  page 1's mostly empty interior page. Cell (c) below = the first 20 "malformed database schema" seeds.
- **healthy**: the pristine main file alone.

## Q1 Guard connection

Population: fixture (a), 20 trials per arm. On (a) the RW handle fails at
`PRAGMA journal_mode = WAL` (SQLITE_CORRUPT), the statement outside ensureDb's try (D#438).
Outcome: quick_check on a copy of the main file alone; then (fresh process) rm -wal/-shm + ensureDb.

| arm | main file corrupt | main byte-identical to pristine | WAL left | ensureDb after delete |
|---|---|---|---|---|
| plain-close (RW fails, `rw.close()`) | 20/20 | 0/20 | 0/20 | fails 20/20 |
| guarded-close, guard runs `count(*) sqlite_master` (it throws CORRUPT) | 0/20 | 20/20 | 20/20 (12,392 B, the original) | ok 20/20 |
| guarded-close, guard runs `PRAGMA schema_version` (succeeds) | 0/20 | 20/20 | 20/20 | ok 20/20 |
| guarded-close, guard opened, NO statement | 20/20 | 0/20 | 0/20 | fails 20/20 |
| leak (no close, natural exit) | 20/20 | 0/20 | 0/20 | fails 20/20 |
| leak + guard (count stmt) open at natural exit | 1/20 | 19/20 | 19/20 | ok 19/20 |
| leak + guard (schema_version) open at natural exit | 0/20 | 20/20 | 20/20 | ok 20/20 |
| leak + guard (no stmt) at natural exit | 20/20 | 0/20 | 0/20 | fails 20/20 |
| leak, `process.exit(0)` | 0/20 | 20/20 | 20/20 | ok 20/20 |
| leak + guard, `process.exit(0)` | 0/20 | 20/20 | 20/20 | ok 20/20 |
| shipped `ensureDbWithWalRecovery` | 20/20 | 0/20 | 0/20 | fails 20/20 |

- Guarded arms: /proc/locks showed the process holding the db SHARED range (1073741826-1073742335)
  and the -shm DMS byte (128) both before and after `rw.close()`, 20/20.
- Leaked handles are closed by better-sqlite3's exit hook (`src/addon.cpp:8`, a
  `std::set<Database*>` ordered by pointer, `database.hpp` CompareDatabase) on a natural exit, not
  on `process.exit()` (0/20 vs 20/20). Which leaked handle closes last is the addon's pointer order.
- Shipped arm trace (`q1-shipped-trace.mjs`, 3 runs): h1 and h2 throw SQLITE_CORRUPT at
  `journal_mode`, h3 (after the delete) throws SQLITE_IOERR_SHORT_READ at `journal_mode`; JS
  closes none of the three. This harness reads 20/20 main-corrupt where the 2026-10-20 note reads
  11/20; uncertain why — the exit-hook close order is the candidate, not verified.
- **Answer: no.** With a read-only guard that has run a statement, the RW close did not checkpoint
  the bad frame (0/20 vs 20/20 unguarded); a guard that is only opened does nothing (20/20).

## Q2 Probe reach

Population: 20 trials per cell; RO = one readonly connection running `count(*) FROM
sqlite_master` then `PRAGMA quick_check`; ensureDb = plain open+close on a re-made fixture.

| cell | RO probe throws | RO quick_check | plain ensureDb | main file after ensureDb's process exits |
|---|---|---|---|---|
| (a) page-1 frame | 20/20 SQLITE_CORRUPT "disk image is malformed" | throws, 20/20 | throws 20/20 | corrupt 20/20 |
| (b-header) observations leaf | 0/20 | returns a row "Tree N page N: btreeInitPage() returns error code 11", 20/20 | opens 20/20 (no throw) | quick_check shows the same row 20/20 |
| (b-rand) 1-8 bytes in that leaf | 0/20 | "ok" 20/20 | opens 20/20 | quick_check ok 20/20 |
| (c) "malformed database schema" | 20/20 (same message) | throws, 20/20 | throws 20/20 | corrupt 20/20 |

- RO probe/quick_check side effects on main and -wal: none, 80/80.
- `PRAGMA schema_version` on the RO connection succeeded 80/80 (page-1 header bytes intact).
- b-rand data check (`q2-brand-data.mjs`, 20 seeds, after a plain ensureDb): 10/20 trials have
  at least one observation whose text/title differs from what was inserted; integrity_check
  flagged 1/20 ("row N missing from index idx_obs_project_live").
- **Answer:** the RO probe sees (a) 20/20 and (c) 20/20 and (b) 0/40; quick_check adds b-header
  20/20 but not b-rand 0/20; plain ensureDb does not throw on (b) at all (0/40) and its close
  writes the damaged page into the main file.

## Q3 Fast-path cost

Population: synthetic store, 50,000 observations through the real table (+1,250 sdk_sessions),
26,967 pages = 105.3 MB, tmpfs. 30 reps per op, alternating order. ms, best / median.

| | probe (RO open+count+close) | ensureDb (open+close) | RO quick_check (5 reps) |
|---|---|---|---|
| in-process, no holder | 0.526 / 0.577 | 1.209 / 1.387 | 459 / 469 |
| in-process, holder open | 0.266 / 0.301 | 0.512 / 0.569 | 348 / 353 |
| fresh process, no holder | 2.328 / 2.811 | 3.793 / 4.170 | - |
| fresh process, holder open | 2.255 / 2.328 | 3.331 / 3.758 | - |

A fresh-process probe alone pays SQLite's first-use cost, which the opener pays once either way,
so the pair was also timed in one fresh process (`q3-pair.mjs`, 30 each, alternating):

| | ensureDb alone | probe then ensureDb | of which probe / ensureDb |
|---|---|---|---|
| no holder | 3.391 / 3.872 | 3.948 / 4.265 | 2.261 / 2.399 + 1.537 / 1.790 |
| holder open | 3.332 / 3.904 | 3.952 / 4.128 | 2.243 / 2.340 + 1.619 / 1.754 |

Whole fresh process wall (node start + imports + op): probe 27.7-28.2 best / 30.8-36.9 median;
ensureDb 34.6-39.5 best / 41.9-56.9 median.
- **Answer:** probe-first adds 0.56-0.62 ms best-of (0.22-0.39 ms median) per fresh-process open
  on this store, against a 28-57 ms process; quick_check costs 348-469 ms per open. Noisy host;
  the deltas are differences of two best-of figures.
- Side effect: a RO probe on a clean store (no -wal) leaves a 0-byte -wal and a 32 KB -shm behind
  (20/20 in Q4 none-clean; it cannot delete them at close).

## Q4 Other-connection detection

Population: 20 trials per cell, fresh fixture (+ fresh holder) per trial and candidate.
Scenarios: none-clean (pristine, no -wal/-shm), none-crash (holder wrote 100 rows then SIGKILLed
itself: -wal/-shm left, nobody live), none-corrupt (fixture a), sleep (holder RW WAL connection,
100 rows, idle), write (as sleep + 1 row per 100 ms). Before each candidate the -wal atime was set
to 2020 (tmpfs updates atime on read, checked), and /proc/self/fd was read after the statement.

| candidate | FN (sleep+write, 40) | FP (3 no-holder scenarios, 60) | reads WAL before refusing | side effects |
|---|---|---|---|---|
| (i) `excl`: RW, timeout 0, `locking_mode=EXCLUSIVE`, `PRAGMA schema_version` | 0 (SQLITE_BUSY 40/40) | 0 (ok 60/60) | no: -wal not opened 40/40, atime unchanged 40/40 | holder: none (commits continued 20/20, rows persisted 20/20). Alone: opens the WAL 60/60 (reads it where one existed) and its close checkpoints: none-crash main changed 20/20, **none-corrupt main corrupt 20/20** |
| (i') `excl-ro` (same, readonly) | 40 (SQLITE_IOERR_LOCK 100/100) | 0 | no | none — but no signal |
| (i'') `excl-chmod`: (i) with the -wal chmod 000 for the duration | 0 (BUSY 40/40) | 0 (CANTOPEN 40/40 when a WAL exists; ok 20/20 on none-clean) | no: not opened, atime unchanged, 80/80 where a WAL existed (none-clean: creates an empty one) | none: main unchanged 60/60 without holder, main quick_check ok 100/100 |
| (ii) `ro` probe | 40 (no error, nothing in the API) | 0 | it opens the WAL 100/100 (none-clean: creates an empty one) | none on main/-wal; on none-clean leaves empty -wal + -shm |
| (iii) /proc/locks (Linux only) | 0 (db SHARED range + -shm byte 128 seen 40/40) | 0 | n/a | none |

- (ii) side channel: -shm ctime changed 40/40 in none-crash/none-corrupt (the first opener
  truncates -shm) and 0/40 with a live holder. Measured on tmpfs only; it rests on SQLite's
  first-opener truncate and the filesystem's timestamp behaviour, not on any interface.
- (iii) best 3.5-7.5 ms (it scans every lock on the host); blind to holders in another pid
  namespace or on another NFS client; a holder can open right after the read.
- Follow-up `q4-hold-run.mjs` (20 trials per scenario): with no holder, `excl-chmod` gets
  SQLITE_CANTOPEN 20/20 while holding a POSIX WRITE lock on the db SHARED range (= EXCLUSIVE)
  20/20; meanwhile another process's RW open and RO probe both get SQLITE_BUSY 20/20; removing
  -wal/-shm under that lock and then closing left main quick_check ok 20/20 and a fresh ensureDb
  ok 20/20. With a sleeping or writing holder: BUSY 40/40, nothing touched, holder errors 0,
  holder rows persisted 20/20.
- **Answer:** yes. (i) detects a live connection 40/40 with 0/60 false positives and does not
  touch the WAL when refused, but when it gets the lock its close checkpoints the bad frame
  (20/20 corrupt); the chmod 000 variant keeps the detection (40/40, 0/60) without reading or
  checkpointing, and holds the lock through the delete. /proc/locks also detects 40/40, 0/60
  (Linux only, race window). The read-only API gives no signal.

## Q5 Move aside instead of delete

Recovery outcome on (a), 20 trials each (`q1.mjs` arms probe-delete / probe-rename: RO probe,
corruption -> delete or rename -wal to `-wal.corrupt-<ts>` + rm -shm, then ensureDb): main file
corrupt 0/20 vs 0/20; ensureDb opened 20/20 vs 20/20; rename left a 12,392-byte side file 20/20.

Live writer, 20 trials per cell (`q5.mjs`): healthy store; holder baseline 100 rows checkpointed
into the main file, then 1 row per 100 ms; after >= 10 timed rows a fresh process moves the WAL,
drops -shm, ensureDb, inserts 5 rows into `_recov`, closes; the holder writes ~1.5 s more, then
exits cleanly or is SIGKILLed; a fresh read-only process counts. Commit times vs the move: 0
ambiguous. The recovery process saw only the 100 checkpointed rows (20/20 per cell).

| | holder rows committed pre / post move | in the store: pre / post | `_recov` rows in store | side file replayed onto final main: pre / post | files left |
|---|---|---|---|---|---|
| delete, holder exits cleanly | 200 / 300 | 200 / 300 | 0 of 100 (20/20 trials lose all 5) | - | main only |
| rename, holder exits cleanly | 200 / 300 | 200 / 300 | 0 of 100 | 200 / 300 (integrity ok 20/20) | main + side file |
| delete, holder SIGKILLed | 201 / 301 | 0 / 0 | 100 of 100 | - | main + recovery's -wal (32,992 B) + -shm |
| rename, holder SIGKILLed | 201 / 300 | 0 / 0 | 100 of 100 | 201 / 300 (integrity ok 20/20) | as delete + side file |

- Mechanism seen: after the move the two processes write separate WALs. The recovery's close
  cannot checkpoint while the holder holds its SHARED lock (its WAL is left: 32,992 B). On a
  clean exit the holder is last: it checkpoints its own WAL from its open fd (moved or unlinked)
  and then deletes the files at the `-wal`/`-shm` PATHS, which are the recovery's, so the
  recovery's rows go (walBytesLeft -1 in 40/40).
- integrity_check of the store ok 80/80; main-only quick_check ok 80/80.
- **Answer:** same outcome as delete on (a) (20/20 each). With a live writer the store loses the
  same rows in both arms (clean exit: the recovery's 5/5 rows per trial; SIGKILL: every holder
  row committed after the last checkpoint, 502 and 501). Rename loses nothing extra; it keeps every
  holder row in the side file (SIGKILL: 501/501 of the rows the store lost; clean exit: 500/500,
  a redundant copy), where delete keeps none. Replaying the side file onto the main file restores
  the holder's rows only by discarding the recovery's own WAL.

## Design implications

**When to probe.** (1) Only after a failure, behind a guard: zero fast-path cost, and Q1 shows
the guard alone keeps the bad frame out (0/20 vs 20/20), provided the failed RW handle is closed
inside ensureDb's try (D#438; a leaked handle is closed by the exit hook on a natural exit, 20/20
corrupt) and the guard has run a statement (an idle guard: 20/20 corrupt). The guard's statement
can be the probe itself (`count(*) sqlite_master` threw on (a) 20/20). Every RW close while the
bad WAL is on disk needs the guard, including the shipped "retry with WAL kept". (2) Probe on
every open: +0.56-0.62 ms best-of per fresh-process open on 105 MB, leaves empty -wal/-shm on a
clean store, and detects exactly what ensureDb's own open detects (300/300 seeds agree; (b) 0/40
for both). It buys no measured outcome over (1). quick_check per open (348-469 ms) is out.

**Keeping the bad frame out of the main file.** In order: never let a RW connection be the last
closer while the bad WAL exists (guard with a statement); remove the WAL only while holding
EXCLUSIVE taken with the WAL unopenable (excl-chmod: no WAL read 80/80, main unchanged 60/60,
other openers BUSY 20/20); do not rely on `process.exit()` skipping the exit hook (0/20 vs 20/20,
exit-path dependent). Plain `locking_mode=EXCLUSIVE` without the chmod is unsafe (20/20 corrupt
when alone). Damage of kind (b) is out of reach of every open-time check measured: the probe sees
0/40, quick_check sees header damage (20/20) but not payload damage (0/20), integrity_check 1/20,
and any clean close copies it into the main file.

**A safe no-other-connection check exists**: excl-chmod (FN 0/40, FP 0/60, no WAL read, no
checkpoint, holds the lock through the removal). Its costs: it needs to chmod the -wal (owner
only); while a holder is live, a third process opening during the ~2 ms window would get
SQLITE_CANTOPEN (not measured); measured on Linux tmpfs only, Windows not measured. /proc/locks is
the Linux-only, read-only alternative (FN 0/40, FP 0/60) with a race between the read and the
removal. The read-only API gives no signal (FN 40/40). Rename over delete: same store outcome in
every cell measured; the side file makes the SIGKILL-case loss recoverable by hand.

## Scripts and commands

All under `<d506>/scripts`; run from that directory. Orchestrators pass the child env above.

- `common.mjs` helpers (childEnv, WAL checksum/re-sign copied from the test, main-only quick_check)
- `build-pristine.mjs`: `env HOME=<d506>/home TMPDIR=<d506>/tmp CLAUDE_MEM_DIR=<d506>/fx/pristine node build-pristine.mjs`
- `mkfx.mjs` fixture maker (a | b <seed> header|rand | c <seed> | healthy); `explore.mjs` one-shot openers; `check.mjs` outcome checks
- `search-c.mjs`: `node search-c.mjs 1 20` (trial, logs/smoke), `node search-c.mjs 1 300`
- `q1-arm.mjs` + `q1.mjs`: `node q1.mjs 20 plain-close,guarded-close,leak,leak-guard,leak-exit,leak-guard-exit,shipped,probe-delete,probe-rename`; `node q1.mjs 20 guarded-close,leak-guard schema_version`; `node q1.mjs 20 guarded-close,leak-guard none` (smoke first: `node q1.mjs 2 plain-close,guarded-close`)
- `q1-shipped-trace.mjs`: 3x `node mkfx.mjs a <d506>/fx/trace; CLAUDE_MEM_DIR=<d506>/fx/trace node q1-shipped-trace.mjs <d506>/fx/trace; CLAUDE_MEM_DIR=... node check.mjs <d506>/fx/trace mainqc`
- `q2.mjs`: `node q2.mjs a 20`, `node q2.mjs b-header 20`, `node q2.mjs b-rand 20`, `node q2.mjs c 20` (run twice: the first run mislabelled a successful ensureDb as "rows: undefined"; the numbers above are from the rerun after the fix)
- `q2-brand-data.mjs` (writes `q2-brand-verify.mjs`): `node q2-brand-data.mjs 20`
- `q3-build.mjs`: `env HOME=<d506>/home TMPDIR=<d506>/tmp CLAUDE_MEM_DIR=<d506>/fx/q3store node q3-build.mjs 50000`
- `q3-op.mjs`, `q3-time.mjs`, `q3-pair.mjs`: `node q3-time.mjs 30 0`, `node q3-time.mjs 30 1`, `node q3-pair.mjs 30 0`, `node q3-pair.mjs 30 1`
- `holder.mjs` (sleep | write | write-ckpt | crash), `q4-cand.mjs`, `q4.mjs`: `node q4.mjs 20 none-clean,none-crash,none-corrupt proclocks,ro,excl,excl-ro,excl-chmod`, then `... sleep ...`, `... write ...` (smoke: n=2, logs/smoke)
- `q4-hold.mjs` + `q4-hold-run.mjs`: `node q4-hold-run.mjs 20 none-corrupt,sleep,write`
- `q5-recover.mjs` + `q5.mjs`: `node q5.mjs 20 delete,rename clean,kill` (smoke n=1 first, log overwritten)

Logs: `<d506>/logs/` (per-trial JSON and `*summary*.json` per question; `logs/smoke/` holds the
smoke runs).

## Cleanup and residue

- Deleted `<d506>/fx` (all fixture dirs, 107 MB) and the empty `<d506>/home`, `<d506>/tmp`; kept
  `scripts/`, `logs/`, this file. No experiment process left (pgrep).
- Outside the scratchpad: `git status --porcelain` in the repo is empty (HEAD moved to 20b55ee7,
  the other agent's commit); no `claude-mem-lite.db*` file in the repo (maxdepth 2). The /tmp
  top-level entries newer than the start marker are `.tmpPDQDgr`, `gh-cli-cache`, `code-graph-mcp`,
  `cc-socks`, `claude-1000` — other tools' directories, none with a name these scripts write.
  `~/.claude-mem-lite` was never named by any script and every child had HOME and CLAUDE_MEM_DIR
  pointed inside `<d506>`; its mtimes were not used as evidence because live sessions write there.
