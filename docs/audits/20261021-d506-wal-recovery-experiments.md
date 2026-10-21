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

## Appendix: the Q1 scripts as run

Run from the scripts directory with the child environment `common.mjs` builds: `build-pristine.mjs`, then `node q1.mjs 20 <arms>`; `check.mjs` reads the outcome.

### common.mjs
```js
// Shared helpers for the D#506 mechanism experiments. Never imports schema.mjs (callers that need it
// set CLAUDE_MEM_DIR first and import it themselves, because DB_PATH is frozen at import time).
import { readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

export const REPO = '/home/ai/dev/claude-mem-lite';
export const BSQ = `${REPO}/node_modules/better-sqlite3/lib/index.js`;
export const SCHEMA = `${REPO}/schema.mjs`;
export const D = '/tmp/claude-1000/-home-ai-dev-claude-mem-lite/c9e45eae-6456-4573-9010-9065054431eb/scratchpad/d506';
export const S = `${D}/scripts`;
export const FX = `${D}/fx`;
export const DB_NAME = 'claude-mem-lite.db';
export const PRISTINE = `${FX}/pristine/${DB_NAME}`;

/** Environment for every child: sandboxed HOME/TMPDIR, no LLM keys, a fixture CLAUDE_MEM_DIR. */
export function childEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/API_KEY|TOKEN|OPENROUTER|ANTHROPIC/i.test(k)) delete env[k];
  delete env.CLAUDE_MEM_DEBUG;
  return { ...env, HOME: `${D}/home`, TMPDIR: `${D}/tmp`, CLAUDE_MEM_DIR: dir ?? `${D}/nowhere`, ...extra };
}

export function node(script, args = [], { dir, env = {}, timeout = 60000, input } = {}) {
  const out = execFileSync(process.execPath, [script, ...args.map(String)], {
    env: childEnv(dir, env),
    encoding: 'utf8',
    timeout,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const last = out.trim().split('\n').pop();
  try {
    return JSON.parse(last);
  } catch {
    return { raw: out };
  }
}

export const sha = (p) => (existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12) : null);
export const size = (p) => (existsSync(p) ? statSync(p).size : -1);
export function fileState(dbPath) {
  return {
    main: sha(dbPath),
    wal: size(`${dbPath}-wal`),
    walSha: sha(`${dbPath}-wal`),
    shm: size(`${dbPath}-shm`),
  };
}

// ─── WAL arithmetic (SQLite fileformat2 §4.1), copied from tests/wal-recovery.test.mjs ──────────
export function walChecksum(buf, s0, s1, bigEndian) {
  for (let i = 0; i + 7 < buf.length; i += 8) {
    const a = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const b = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + a + s1) >>> 0;
    s1 = (s1 + b + s0) >>> 0;
  }
  return [s0, s1];
}

export function walFrames(wal) {
  const pageSize = wal.readUInt32BE(8);
  const frames = [];
  for (let off = 32, i = 0; off + 24 + pageSize <= wal.length; off += 24 + pageSize, i++) {
    frames.push({ i, off, pgno: wal.readUInt32BE(off), commit: wal.readUInt32BE(off + 4) });
  }
  return { pageSize, frames, bigEndian: wal.readUInt32BE(0) === 0x377f0683 };
}

/** Re-sign every frame of `bad` (a damaged copy of a valid WAL) so the checksum chain verifies. */
export function resign(bad) {
  const { pageSize, frames, bigEndian } = walFrames(bad);
  let [s0, s1] = walChecksum(bad.subarray(0, 24), 0, 0, bigEndian);
  for (const f of frames) {
    [s0, s1] = walChecksum(bad.subarray(f.off, f.off + 8), s0, s1, bigEndian);
    [s0, s1] = walChecksum(bad.subarray(f.off + 24, f.off + 24 + pageSize), s0, s1, bigEndian);
    bad.writeUInt32BE(s0, f.off + 16);
    bad.writeUInt32BE(s1, f.off + 20);
  }
  return bad;
}

/** quick_check on a copy of the MAIN FILE ALONE (no -wal/-shm), in a private temp dir. */
export function mainOnlyQuickCheck(dbPath, Database) {
  const t = mkdtempSync(`${D}/tmp/qc-`);
  try {
    copyFileSync(dbPath, join(t, DB_NAME));
    const db = new Database(join(t, DB_NAME));
    let r;
    try {
      r = db.pragma('quick_check', { simple: true });
    } catch (e) {
      r = `${e.code}: ${e.message}`;
    }
    db.close();
    return r;
  } catch (e) {
    return `${e.code}: ${e.message}`;
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

export function tally(list) {
  const t = {};
  for (const x of list) t[x] = (t[x] ?? 0) + 1;
  return t;
}

export { readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync, statSync, spawn, join };
```

### mkfx.mjs
```js
// Fixture maker. One fresh process per fixture; the live handle used to produce the WAL is closed
// (its close checkpoints), then the main file is restored to the pristine bytes, as in
// tests/wal-recovery.test.mjs plantCorruptWal.
//   node mkfx.mjs a <dir>                 page-1 frame, bytes 100..300 = 0xff (the test fixture)
//   node mkfx.mjs b <dir> <seed> header   WAL of 400 observation inserts; the LATEST frame of one
//                                         observations-table page (seeded pick) gets bytes 0..200 = 0xff
//   node mkfx.mjs b <dir> <seed> rand     same WAL, 1-8 bytes xor'd at a seeded offset in that frame
//   node mkfx.mjs c <dir> <seed>          fixture-a WAL; 1-8 bytes xor'd at a seeded offset inside one
//                                         seeded frame among those holding sqlite_master pages
//   node mkfx.mjs healthy <dir>           pristine main file only
// Prints one JSON line describing what was damaged.
import { BSQ, PRISTINE, DB_NAME, readFileSync, writeFileSync, rmSync, mkdirSync, walFrames, resign } from './common.mjs';
const Database = (await import(BSQ)).default;
const [kind, dir, seedArg, mode] = process.argv.slice(2);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/${DB_NAME}`;
const pristine = readFileSync(PRISTINE);
writeFileSync(dbPath, pristine);
if (kind === 'healthy') {
  console.log(JSON.stringify({ kind, dbPath }));
  process.exit(0);
}
let seed = Number(seedArg ?? 1) >>> 0 || 1;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
seed = Math.imul(seed, 2654435761) >>> 0; // spread small seeds
for (let k = 0; k < 4; k++) rnd();

const live = new Database(dbPath);
live.pragma('journal_mode = WAL');
live.pragma('wal_autocheckpoint = 0');
live.pragma('foreign_keys = OFF'); // ensureDb runs with FKs off too
live.pragma('wal_checkpoint(TRUNCATE)');
let pageOwner = new Map();
if (kind === 'a' || kind === 'c') {
  live.exec('CREATE TABLE _wal_probe_marker(x TEXT)');
} else if (kind === 'b') {
  const ins = live.prepare(
    `INSERT INTO observations(memory_session_id, project, text, type, title, narrative, created_at, created_at_epoch)
     VALUES (?, 'proj', ?, 'discovery', ?, ?, '2026-10-21T00:00:00Z', ?)`,
  );
  live.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: 60 }, (_, k) => `w${(i * 31 + k * 7) % 997}`).join(' ');
      ins.run(`s${i % 7}`, words, `title ${i}`, `narrative ${words}`, 1_760_000_000 + i);
    }
  })();
}
for (const r of live.prepare('SELECT pageno, name, pagetype FROM dbstat').all()) pageOwner.set(r.pageno, r);
const wal = readFileSync(dbPath + '-wal');
live.close();
writeFileSync(dbPath, pristine);
rmSync(dbPath + '-shm', { force: true });

const { pageSize, frames } = walFrames(wal);
const latest = new Map();
for (const f of frames) latest.set(f.pgno, f); // a reader uses the newest frame of each page
const bad = Buffer.from(wal);
let target;
let what;
if (kind === 'a') {
  target = frames.find((f) => f.pgno === 1);
  bad.fill(0xff, target.off + 24 + 100, target.off + 24 + 300);
  what = 'bytes 100..300 = 0xff';
} else if (kind === 'b') {
  const cands = [...latest.values()].filter((f) => pageOwner.get(f.pgno)?.name === 'observations');
  target = cands[Math.floor(rnd() * cands.length)];
  if (mode === 'rand') {
    const off = Math.floor(rnd() * pageSize);
    const n = 1 + Math.floor(rnd() * 8);
    for (let k = 0; k < n && off + k < pageSize; k++) bad[target.off + 24 + off + k] ^= 1 + Math.floor(rnd() * 255);
    what = `xor ${n} bytes at ${off}`;
  } else {
    bad.fill(0xff, target.off + 24, target.off + 24 + 200);
    what = 'bytes 0..200 = 0xff';
  }
  what += ` (candidates ${cands.length})`;
} else if (kind === 'c') {
  const cands = [...latest.values()].filter((f) => f.pgno === 1 || pageOwner.get(f.pgno)?.name === 'sqlite_schema' || pageOwner.get(f.pgno)?.name === 'sqlite_master');
  target = cands[Math.floor(rnd() * cands.length)];
  const off = Math.floor(rnd() * pageSize);
  const n = 1 + Math.floor(rnd() * 8);
  for (let k = 0; k < n && off + k < pageSize; k++) bad[target.off + 24 + off + k] ^= 1 + Math.floor(rnd() * 255);
  what = `xor ${n} bytes at ${off} (candidates ${cands.length})`;
} else throw new Error(`unknown kind ${kind}`);
resign(bad);
writeFileSync(dbPath + '-wal', bad);
writeFileSync(dbPath + '-shm', Buffer.alloc(32768)); // a crash leaves one behind too
console.log(
  JSON.stringify({
    kind,
    dbPath,
    frames: frames.length,
    walPages: [...latest.keys()].map((p) => `${p}:${pageOwner.get(p)?.name ?? '?'}`).slice(0, 12),
    target: { frame: target.i, pgno: target.pgno, owner: pageOwner.get(target.pgno)?.name, type: pageOwner.get(target.pgno)?.pagetype },
    what,
  }),
);
```

### build-pristine.mjs
```js
// Build the pristine, fully checkpointed, schema-current store once: fx/pristine/claude-mem-lite.db.
// Same recipe as tests/wal-recovery.test.mjs beforeAll. Run with CLAUDE_MEM_DIR=<FX>/pristine.
import { FX, SCHEMA } from './common.mjs';
if (process.env.CLAUDE_MEM_DIR !== `${FX}/pristine`) throw new Error('set CLAUDE_MEM_DIR to fx/pristine');
const { ensureDb, DB_PATH, CURRENT_SCHEMA_VERSION } = await import(SCHEMA);
const db = ensureDb();
db.pragma('wal_checkpoint(TRUNCATE)');
const cols = db.prepare('PRAGMA table_info(observations)').all();
const pages = db.pragma('page_count', { simple: true });
const ps = db.pragma('page_size', { simple: true });
db.close();
console.log(JSON.stringify({ DB_PATH, CURRENT_SCHEMA_VERSION, pages, ps, obsCols: cols.map((c) => `${c.name}${c.notnull ? '!' : ''}${c.dflt_value !== null ? '=' + c.dflt_value : ''}`) }));
```

### q1.mjs
```js
// Q1 (and Q5 recovery arms) orchestrator. Each trial: fresh fixture process (mkfx a), one arm
// process, then fresh check processes: state, mainqc, ensure-after-delete.
// argv: n arm[,arm...] [guardStmt]
import { S, FX, D, node, tally, writeFileSync, rmSync } from './common.mjs';
const [n, arms, guardStmt = 'count'] = process.argv.slice(2);
const summary = {};
for (const arm of arms.split(',')) {
  const trials = [];
  for (let i = 0; i < Number(n); i++) {
    const dir = `${FX}/q1/${arm}`;
    node(`${S}/mkfx.mjs`, ['a', dir]);
    const run = node(`${S}/q1-arm.mjs`, [dir, arm, guardStmt], { dir });
    const st = node(`${S}/check.mjs`, [dir, 'state'], { dir });
    const qc = node(`${S}/check.mjs`, [dir, 'mainqc'], { dir });
    const en = node(`${S}/check.mjs`, [dir, 'ensure-after-delete'], { dir });
    trials.push({ run, st, mainqc: qc.mainqc, ensureAfterDelete: en.ensureAfterDelete });
    rmSync(dir, { recursive: true, force: true });
  }
  // pid and inode vary per trial; keep the lock type and byte range (128 = -shm DMS byte,
  // 1073741826..1073742335 = the db file's SHARED range)
  const lk = (a) => (a ?? []).map((l) => l.replace(/^(POSIX ADVISORY \w+) \d+ \S+ /, '$1 ')).join(' / ') || '-';
  const short = (s) => (s === 'ok' ? 'ok' : s.split('\n').slice(0, 2).join(' | ').slice(0, 90));
  summary[arm] = {
    n: trials.length,
    mainqc: tally(trials.map((t) => short(t.mainqc))),
    mainIsPristine: tally(trials.map((t) => String(t.st.mainIsPristine))),
    walLeftBytes: tally(trials.map((t) => String(t.st.wal))),
    corruptFiles: tally(trials.map((t) => t.st.corrupt.join(',') || '-')),
    ensureAfterDelete: tally(trials.map((t) => t.ensureAfterDelete)),
    steps: tally(trials.map((t) => t.run.steps?.join(' ; ') ?? JSON.stringify(t.run).slice(0, 120))),
    locksBeforeClose: tally(trials.map((t) => lk(t.run.locksBeforeClose))),
    locksWithGuard: tally(trials.map((t) => lk(t.run.locksWithGuard))),
    locksAfterRwClose: tally(trials.map((t) => lk(t.run.locksAfterRwClose))),
  };
  writeFileSync(`${D}/logs/q1-${arm}${guardStmt === 'count' ? '' : '-' + guardStmt}.json`, JSON.stringify(trials, null, 1));
}
console.log(JSON.stringify(summary, null, 1));
```

### q1-arm.mjs
```js
// One open of a corrupt-WAL fixture in a FRESH process. argv: dir arm
//   plain-close    RW open; journal_mode=WAL throws; rw.close()
//   guarded-close  RW open; journal_mode=WAL throws; RO guard opened and a statement run on it
//                  (count(*) sqlite_master — throws too, see `guardStmt`); rw.close(); guard.close()
//   leak           RW open; journal_mode=WAL throws; nothing closed; natural exit
//   leak-guard     as leak, plus a RO guard (statement run) left open; natural exit
//   leak-exit      as leak, process.exit(0)
//   leak-guard-exit as leak-guard, process.exit(0)
//   shipped        schema.ensureDbWithWalRecovery()
//   probe-delete   RO probe (count(*) sqlite_master); corruption -> rm -wal,-shm; ensureDb()
//   probe-rename   RO probe; corruption -> rename -wal to -wal.corrupt-<ts>, rm -shm; ensureDb()
// Prints one JSON line.
import { BSQ, SCHEMA, DB_NAME, readFileSync } from './common.mjs';
import { rmSync, renameSync } from 'node:fs';
const Database = (await import(BSQ)).default;
const [dir, arm, guardStmt = 'count'] = process.argv.slice(2);
process.env.CLAUDE_MEM_DIR = dir;
const p = `${dir}/${DB_NAME}`;
const r = { arm, steps: [] };
const note = (k, e) => r.steps.push(e ? `${k}: ${e.code} ${e.message.slice(0, 60)}` : `${k}: ok`);
const myLocks = () =>
  readFileSync('/proc/locks', 'utf8')
    .split('\n')
    .filter((l) => l.split(/\s+/)[4] === String(process.pid))
    .map((l) => l.split(/\s+/).slice(1).join(' '));

function failRw() {
  const rw = new Database(p);
  try {
    rw.pragma('journal_mode = WAL');
    note('rw journal_mode');
  } catch (e) {
    note('rw journal_mode', e);
  }
  return rw;
}
function openGuard() {
  const g = new Database(p, { readonly: true });
  try {
    if (guardStmt === 'count') g.prepare('SELECT count(*) FROM sqlite_master').get();
    else if (guardStmt === 'schema_version') g.pragma('schema_version');
    // guardStmt 'none': the guard is opened and nothing is run on it
    note(`guard ${guardStmt}`);
  } catch (e) {
    note(`guard ${guardStmt}`, e);
  }
  r.locksWithGuard = myLocks();
  return g;
}

if (arm === 'plain-close') {
  const rw = failRw();
  r.locksBeforeClose = myLocks();
  rw.close();
} else if (arm === 'guarded-close') {
  const rw = failRw();
  const g = openGuard();
  rw.close();
  r.locksAfterRwClose = myLocks();
  g.close();
} else if (arm === 'leak' || arm === 'leak-exit') {
  globalThis.keep = [failRw()];
} else if (arm === 'leak-guard' || arm === 'leak-guard-exit') {
  globalThis.keep = [failRw(), openGuard()];
} else if (arm === 'shipped') {
  const m = await import(SCHEMA);
  try {
    m.ensureDbWithWalRecovery({ warn: (x) => r.steps.push(`warn ${x.slice(0, 70)}`) }).close();
    note('shipped');
  } catch (e) {
    note('shipped', e);
  }
} else if (arm === 'probe-delete' || arm === 'probe-rename') {
  const m = await import(SCHEMA);
  let bad = false;
  const ro = new Database(p, { readonly: true });
  try {
    ro.prepare('SELECT count(*) FROM sqlite_master').get();
    note('probe');
  } catch (e) {
    bad = m.isDbCorruptionError(e);
    note('probe', e);
  }
  ro.close();
  if (bad) {
    if (arm === 'probe-delete') rmSync(`${p}-wal`, { force: true });
    else renameSync(`${p}-wal`, `${p}-wal.corrupt-${Date.now()}`);
    rmSync(`${p}-shm`, { force: true });
  }
  try {
    m.ensureDb().close();
    note('ensureDb');
  } catch (e) {
    note('ensureDb', e);
  }
} else throw new Error(`unknown arm ${arm}`);
console.log(JSON.stringify(r));
if (arm.endsWith('-exit')) process.exit(0);
```

### check.mjs
```js
// Outcome checks, each in its own fresh process. argv: dir what
//   mainqc       quick_check on a copy of the main file alone (no -wal/-shm)
//   ensure-after-delete  rm -wal/-shm, then schema.ensureDb() and quick_check on it
//   state        file state (sha of main, sizes) + any -wal.corrupt-* files
import { BSQ, SCHEMA, DB_NAME, PRISTINE, mainOnlyQuickCheck, fileState, sha, size } from './common.mjs';
import { rmSync, readdirSync } from 'node:fs';
const [dir, what] = process.argv.slice(2);
process.env.CLAUDE_MEM_DIR = dir;
const p = `${dir}/${DB_NAME}`;
const Database = (await import(BSQ)).default;
if (what === 'mainqc') {
  console.log(JSON.stringify({ mainqc: mainOnlyQuickCheck(p, Database) }));
} else if (what === 'state') {
  const corrupt = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  console.log(
    JSON.stringify({
      ...fileState(p),
      mainIsPristine: sha(p) === sha(PRISTINE),
      corrupt: corrupt.map((f) => `${f.replace(/\d+$/, 'TS')}:${size(`${dir}/${f}`)}`),
    }),
  );
} else if (what === 'ensure-after-delete') {
  rmSync(`${p}-wal`, { force: true });
  rmSync(`${p}-shm`, { force: true });
  const m = await import(SCHEMA);
  let out;
  try {
    const db = m.ensureDb();
    const qc = db.pragma('quick_check', { simple: true });
    db.close();
    out = qc === 'ok' ? 'ok' : `opened, quick_check: ${String(qc).split('\n')[1] ?? qc}`;
  } catch (e) {
    out = `${e.code}: ${e.message.slice(0, 60)}`;
  }
  console.log(JSON.stringify({ ensureAfterDelete: out }));
}
```

