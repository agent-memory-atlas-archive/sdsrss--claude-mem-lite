// lib/db-unusable.mjs — the database file is not a usable database.
//
// The sibling of lib/schema-skew.mjs, and it exists for the same reason: the throw is
// correct, and everything downstream of it was missing. Measured 2026-09-08 in a sandboxed
// HOME with a corrupted header:
//
//   • CLI (`search` / `recent` / `stats` / `get` / `save` / `browse` / `fts-check`) — all exit
//     1 with the SQLite message. Correct.
//   • `status` — "⚠ Database: exists but check failed". Correct.
//   • `doctor` — names the file and prints an exact repair command. Correct.
//   • Hooks — `openDb()` returns null, `hook.mjs`'s `const db = openDb(); if (!db) return;`
//     ends SessionStart with EMPTY stdout and EMPTY stderr, and every fire wrote another
//     stack trace to runtime/hook-errors/. Nothing the user sees says memory is off.
//
// State that last figure carefully, because the first draft got it wrong twice over: it said
// "20 fires → 10 identical ~1.5 KB records", which was a MIXED fire set (only some events
// reach this path) reported as if it were 20 SessionStarts, and a size nobody measured.
// Re-measured over 20 SessionStart fires: 20 records, 859-873 bytes each — one per fire, and
// ~1.7x smaller than claimed. `recordHookError` caps the stack at 6 frames and the message at
// 500 chars, so the per-record size is bounded; the unbounded quantity is the COUNT.
//
// So the one surface the user is actually looking at during a session was the only silent
// one, on a condition that never heals by itself. That is the schema-skew shape exactly, and
// this module is deliberately its mirror image so the two cannot drift apart.
//
// It imports no native binding: the static graph is 10 modules and zero package edges (the
// only bare specifiers anywhere in it are the `node:` builtins). That is the property that
// matters — a classifier the hook path may need while the binding is the broken thing must
// not sit behind a native import. It is NOT as tight as schema-skew.mjs, which imports
// `node:` builtins and nothing else; this one reaches `db-backup → utils → …` for
// `readSnapshots`. Same guarantee, larger graph — do not restate it as "same discipline".

import { spawnSync } from 'node:child_process';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshots } from './db-backup.mjs';
import { shellWord, CLI_INVOKE } from '../cli-path.mjs';

/** Marker prefix for lib/record-once.mjs. Per project, like the skew one. */
export const DB_UNUSABLE_MARKER_PREFIX = '.db-unusable-logged-';

// SQLite's own spellings for "this file is not a usable database". Kept here as the single
// definition so install.mjs's doctor check and the hook path classify identically — they used
// to hold one copy each, which is this repo's named twin-drift class.
//
// Deliberately NOT matching "unable to open database file": that is a PERMISSIONS or
// missing-directory failure, whose remedy is nothing like the two below, and answering it
// with "move the file aside" would tell a user to destroy a healthy store.
const UNUSABLE_RE = /not a database|disk image is malformed/i;
// A row of sqlite_master SQLite cannot parse: every statement fails, so memory is as off as
// with a damaged header. One cause is a damaged row; another is SQL this SQLite's parser does
// not know (reasoned, not reproduced), where restoring a snapshot or setting the file aside is
// wrong. So this family gets the notice and the snapshot names, and no command.
const SCHEMA_UNREADABLE_RE = /malformed database schema/i;

/**
 * Whether an error is a damaged FTS5 INDEX rather than a damaged database file.
 *
 * THE MESSAGE CANNOT TELL THEM APART. SQLite reports a damaged index as
 * SQLITE_CORRUPT_VTAB with the same "database disk image is malformed" text the file-level
 * faults use, so the code is the only discriminator — and matching on message alone is what
 * conflated them before R10 P3-9. The remedy is rebuildFTS, which the FTS content lets us do
 * losslessly; treating it as file corruption would offer `cp <old snapshot> <db>` over a
 * database whose rows are all intact.
 *
 * This lives HERE rather than in schema.mjs (which re-exports it, so every existing importer
 * is unchanged) because both consumers of the distinction now need it and schema.mjs imports
 * better-sqlite3 — a classifier the hook path may need while the binding is the broken thing
 * must not be behind a native import.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isFtsCorruptionError(err) {
  return /SQLITE_CORRUPT_VTAB/i.test(`${err?.code || ''}`);
}

/**
 * What to do about a damaged FTS5 INDEX — the query-time half of isFtsCorruptionError.
 *
 * R10 P3-9 wired the classifier into `ensureDbWithWalRecovery`, which rebuilds and retries.
 * That covers OPEN time. A structure record damaged inside the index opens fine — nothing
 * reads it until the first MATCH — so the fault surfaces at QUERY time, and there the two
 * faces that carry it to a reader (the CLI catch-all, the MCP safeHandler) passed SQLite's
 * own sentence through with no next step. `recent` / `recall` / `browse` / `context` never
 * touch FTS and keep answering, which makes that dead end easy to misread as "search found
 * nothing" rather than "search is broken".
 *
 * ONE STRING FOR BOTH CHANNELS, unlike the file-level family below. The split there exists
 * because that remedy moves the database file out from under every session and must not be
 * handed ready-to-run to an agent holding Bash. This one re-derives every index from its own content table: the rows
 * are never read from the index, so a rebuild is lossless and idempotent, and `doctor`
 * already runs it unprompted. Naming "intact" is load-bearing — the reading this line
 * exists to prevent is "my memories are corrupt".
 *
 * SCOPE, measured rather than assumed: a damaged index does not always reach the caller as
 * SQLITE_CORRUPT_VTAB. `observations_fts_data` holds three rows on a one-observation store —
 * id=1 (averages), id=10 (the STRUCTURE record) and one leaf page — and which row the damage
 * lands on decides the code. Over 100 trials each:
 *
 *   UPDATE … SET block = randomblob(32) WHERE id > 1   (structure + leaf)  98 VTAB, 2 NOMEM
 *   UPDATE … SET block = randomblob(32) WHERE id > 10  (leaf only)        100 VTAB, 0 NOMEM
 *   DELETE … WHERE id > 10                             (leaf only)        100 VTAB, 0 NOMEM
 *
 * So NOMEM comes from a mangled STRUCTURE record, where SQLite reads a corrupt varint and asks
 * for an absurd allocation — not from leaf damage. (A first draft of this paragraph said
 * "leaf pages", which would send anyone re-measuring `WHERE id > 10` to 0/N and make the
 * boundary below look vacuous. Caught by the pre-ship claims audit.) That case gets no
 * remedy, on purpose:
 * isFtsCorruptionError is what isDbCorruptionError and isDbUnusableError consult, so
 * admitting SQLITE_NOMEM would answer a real out-of-memory with a full FTS rebuild, and
 * would tell a user their index is damaged when it may be their RAM. The code cannot
 * discriminate the two, so this covers the fault it can name.
 * `tests/fts-corruption-query-time-remedy.test.mjs` pins that boundary.
 */
export function ftsCorruptionRemedy(cli) {
  return (
    'The FTS5 search index is damaged; the stored observations are intact. ' +
    `Rebuild it losslessly with \`${cli} fts-check rebuild\` ` +
    `(\`${cli} doctor\` rebuilds it too, and re-checks everything else).`
  );
}

/** The CLI face's wording. Both faces name the CLI by path: the bare command exists only after
 *  an optional global npm install (D#462). */
export const FTS_CORRUPTION_REMEDY = ftsCorruptionRemedy(CLI_INVOKE);

/**
 * True when `err` means "this file exists and SQLite cannot use it as a database".
 *
 * Accepts anything thrown (Error, string, null) because recordHookError does.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDbUnusableError(err) {
  if (!err) return false;
  // FIRST, and for the same reason isDbCorruptionError does it first: a damaged index is a
  // HEALTHY FILE, and every remedy below is wrong — and destructive — for one.
  if (isFtsCorruptionError(err)) return false;
  const msg = String(err.message ?? err ?? '');
  return UNUSABLE_RE.test(msg) || SCHEMA_UNREADABLE_RE.test(msg);
}

/** The child checkSnapshot runs: lib/snapshot-probe.mjs, beside this file. */
const SNAPSHOT_PROBE = join(dirname(fileURLToPath(import.meta.url)), 'snapshot-probe.mjs');
/** checkSnapshot's private directories in the data directory: `<prefix><pid>-XXXXXX`, the pid
 *  being the process that made it. */
const CHECK_DIR_PREFIX = '.snapshot-check-';
const CHECK_DIR_RE = /^\.snapshot-check-(\d+)-[A-Za-z0-9]{6}$/;
/** The probe's run on one copy: open (migrations included), index rebuild, integrity check. The
 *  copy before it is not bounded by this. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** No check runs this long, so a private directory this old was left by a killed check even when
 *  its pid now names a live process. */
const STALE_CHECK_MS = 24 * 60 * 60 * 1000;
// SQLite codes about the check's own disk rather than about the snapshot: the copy lives in the
// data directory, so a full or failing disk there says nothing about what a restore would give.
const CHECK_DISK_CODE_RE = /^SQLITE_(FULL|IOERR)/;

function nonEmptyFile(path) {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * What restoring the snapshot at `path` would give (D#558). The snapshot is copied into a private
 * directory beside it, with its own `-wal` when it has a non-empty one (a hand-made `cp` of a live
 * store), and lib/snapshot-probe.mjs opens the copy in a child process with the opener every
 * product face uses, rebuilds its indexes as the restore command's last step (`fts-check rebuild`)
 * does, then runs SQLite's integrity check and counts observations. The directory is removed
 * before this returns.
 *
 * - `ok`: the copy opens, its indexes rebuild, it passes the integrity check, and it holds
 *   `observations` (at least one);
 * - `empty`: the same with no observation, so restoring it gives what a fresh store gives;
 * - `bad`: the product's opener throws on it (`why: 'open'`), an index does not rebuild
 *   (`why: 'rebuild'`), or the integrity check fails or throws (`why: 'integrity'`), `reason`
 *   saying how;
 * - `unchecked`: the check itself could not run (the copy, the child, a full or failing disk,
 *   whichever step met it), `reason` saying why and `where` naming the directory when making the
 *   private one failed.
 *
 * `listed`, when present, is how many observations the copy's own index listed before the rebuild,
 * more than its table holds after it. The snapshot still restores cleanly; doctor says by how
 * much it is short of its own index.
 *
 * `withLog` says whether the snapshot's own `-wal` was part of the copy, so the restore command
 * copies it too. The first attempt checked the file itself with integrity_check, which rejects a
 * snapshot whose damage an index rebuild repairs, and could not read a file over 2 GiB; this one
 * checks what a restore gives.
 *
 * @param {string} path
 * @param {{probe?: string, timeoutMs?: number}} [opts] `probe` replaces the child script (tests)
 * @returns {{verdict: 'ok'|'empty'|'bad'|'unchecked', withLog: boolean, observations?: number, listed?: number, why?: 'open'|'rebuild'|'integrity', reason?: string, where?: string}}
 */
export function checkSnapshot(path, { probe = SNAPSHOT_PROBE, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  let dir = null;
  let withLog = false;
  const unchecked = (reason) => ({ verdict: 'unchecked', withLog, reason });
  const bad = (why, reason) => ({ verdict: 'bad', withLog, why, reason: String(reason).slice(0, 200) });
  try {
    try {
      dir = mkdtempSync(join(dirname(path), `${CHECK_DIR_PREFIX}${process.pid}-`));
    } catch (e) {
      return { ...unchecked(e?.code || e?.message || 'unwritable'), where: dirname(path) };
    }
    const copy = join(dir, 'claude-mem-lite.db');
    // FICLONE: a reflink where the filesystem has them, a plain streamed copy elsewhere.
    copyFileSync(path, copy, fsConstants.COPYFILE_FICLONE);
    withLog = nonEmptyFile(`${path}-wal`);
    if (withLog) copyFileSync(`${path}-wal`, `${copy}-wal`, fsConstants.COPYFILE_FICLONE);
    const r = spawnSync(process.execPath, [probe], {
      env: { ...process.env, CLAUDE_MEM_DIR: dir },
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) {
      if (r.error.code === 'ETIMEDOUT') return unchecked(`ETIMEDOUT, over ${elapsed(timeoutMs)}`);
      return unchecked(r.error.code || r.error.message);
    }
    let out = null;
    try {
      out = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch {
      /* no result line: the probe did not run to its end */
    }
    if (r.status !== 0 || !out || typeof out !== 'object') {
      const how = r.signal ? `probe killed by ${r.signal}` : `probe exited ${r.status}`;
      // The error line, not the first one: Node prints a source location above a load failure.
      const lines = String(r.stderr)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const said = (lines.find((l) => /^\w*Error\b/.test(l)) ?? lines[0] ?? '').slice(0, 200);
      return unchecked(said ? `${how}: ${said}` : how);
    }
    const rebuildErrors = Array.isArray(out.rebuildErrors) ? out.rebuildErrors : [];
    const disk = [out.error, ...rebuildErrors].find((e) => CHECK_DISK_CODE_RE.test(e?.code ?? ''));
    if (disk) return unchecked(disk.code);
    if (out.error && !out.opened) return bad('open', out.error.code || out.error.message);
    if (rebuildErrors.length > 0) return bad('rebuild', rebuildErrors[0].message);
    if (out.error) return bad('integrity', out.error.code || out.error.message);
    if (out.integrity !== 'ok') return bad('integrity', out.integrity);
    const passed = {
      verdict: out.observations > 0 ? 'ok' : 'empty',
      withLog,
      observations: out.observations,
    };
    if (Number.isInteger(out.listed) && out.listed > out.observations) passed.listed = out.listed;
    return passed;
  } catch (e) {
    return unchecked(e?.code || e?.message || 'unreadable');
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left behind: sweepSnapshotChecks removes it once this process has exited */
      }
    }
  }
}

function elapsed(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/** Whether `pid` names a running process (EPERM: one this user may not signal, still running). */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Remove the private directories checkSnapshot leaves when it is killed mid-check (each holds a
 * full copy of a snapshot): those whose process has exited, and any older than a check can run
 * (its pid may name another process by then). A doctor checking in another terminal keeps its
 * own. Only directories named exactly as checkSnapshot names them; never a link. doctor calls
 * this before its database check, healthy store or not, so a copy left by an interrupted check
 * goes on the next doctor run even once the store is restored.
 * @param {string} dir the data directory
 * @param {{nowMs?: number}} [opts]
 */
export function sweepSnapshotChecks(dir, { nowMs = Date.now() } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = CHECK_DIR_RE.exec(n);
    if (!m) continue;
    const full = join(dir, n);
    try {
      const st = lstatSync(full);
      if (!st.isDirectory()) continue;
      if (running(Number(m[1])) && nowMs - st.mtimeMs < STALE_CHECK_MS) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* raced away, or not ours to remove */
    }
  }
}

/** doctor, run against `dbPath`'s data directory whatever the shell's CLAUDE_MEM_DIR says. */
function doctorCommand(dbPath) {
  return `CLAUDE_MEM_DIR=${shellWord(dirname(dbPath))} ${CLI_INVOKE} doctor`;
}

/**
 * What the user should actually run. Three outcomes, never two — the same rule schema-skew.mjs
 * states: "there is no backup" and "I could not look for one" must not print in the same
 * voice, because a green-sounding line ends the reader's search.
 *
 * A snapshot goes into a command only after `check` (doctor passes checkSnapshot) calls it `ok`,
 * newest first: `bad` and `empty` ones are passed over and counted; one the check could not run on
 * stops the walk with no command (kind 'unknown', or 'schema'), since an older snapshot named past
 * it could hold less. Without `check` (the SessionStart notice, which must not copy and open every
 * candidate on each session start while the store is broken) no snapshot goes into a command:
 * kind 'unknown' counts them and points at doctor, the kind every version's doctor renders as its
 * note (a killed update can leave an older install.mjs beside this file). None `ok`, or none at
 * all: the set-aside. Only regular files count as snapshots: a directory or a device named like
 * one is not a copy of anything, and copying it fails. Every doctor named in a note carries the
 * data directory, which the shell the user runs it from may not.
 *
 * Both commands keep every byte they replace (D#539): the broken file and its `-wal` move to
 * `keptAs` and `keptAs-wal`, the names SQLite pairs, and only the `-shm` is deleted. The restore
 * ends with `fts-check rebuild`, the step the check ran after the product's open. Each starts
 * with a guard so running it a second time stops before overwriting the first kept copy, and
 * `touch` gives `mv` a log to move when there is none (an empty `-wal` reads as no log).
 * Chained with `&&` only: fish has no `{ }` grouping. The kept name carries the broken file's
 * mtime, not the clock, so every doctor run on one broken file prints the same command (and the
 * --json face matches the human one); a later broken file gets another name. When that name or its
 * `-wal` already exists (a kept file moved back keeps its mtime) a `-1`, `-2`, … is added, so the
 * command doctor prints never stops at its own guard.
 *
 * `found` is the sentence about the snapshots, which doctor puts in front of its own command
 * sentence; `note` is what the SessionStart notice prints. `snapshotCount` counts the non-empty
 * snapshots, so a caller does not re-read the directory for it.
 *
 * `err`, when given, picks the family: a schema SQLite cannot read gets kind 'schema', which
 * carries no command (see SCHEMA_UNREADABLE_RE).
 *
 * @param {string} dbPath
 * @param {unknown} [err]
 * @param {{check?: (path: string) => ReturnType<typeof checkSnapshot>, stampMs?: number}} [opts]
 *   `stampMs` replaces the broken file's mtime in the kept name (tests)
 * @returns {{kind: 'restore'|'set-aside'|'unknown'|'schema', command: string, keptAs: string, found: string, note: string, snapshotCount: number}}
 */
export function dbUnusableRemedy(dbPath, err, { check, stampMs } = {}) {
  const schema = SCHEMA_UNREADABLE_RE.test(String(err?.message ?? err ?? ''));
  let stamp = stampMs;
  if (stamp === undefined) {
    try {
      stamp = statSync(dbPath).mtimeMs;
    } catch {
      stamp = Date.now();
    }
  }
  const keptBase = `${dbPath}.corrupt-${new Date(Math.floor(stamp)).toISOString().replace(/[:.]/g, '-')}`;
  let keptAs = keptBase;
  for (let i = 1; existsSync(keptAs) || existsSync(`${keptAs}-wal`); i++) keptAs = `${keptBase}-${i}`;
  const setAsideCommand = [
    `test ! -e ${shellWord(keptAs)}`,
    `test ! -e ${shellWord(`${keptAs}-wal`)}`,
    `rm -f ${shellWord(`${dbPath}-shm`)}`,
    `touch ${shellWord(`${dbPath}-wal`)}`,
    `mv ${shellWord(dbPath)} ${shellWord(keptAs)}`,
    `mv ${shellWord(`${dbPath}-wal`)} ${shellWord(`${keptAs}-wal`)}`,
  ].join(' && ');
  const keeps = `as ${keptAs} and ${keptAs}-wal`;
  const noCommand = (kind, found, note = found, snapshotCount = 0) => ({
    kind,
    command: '',
    keptAs: '',
    snapshotCount,
    found,
    note,
  });
  const snap = readSnapshots(dbPath);
  if (!snap.ok) {
    const found =
      `Could not read ${dirname(dbPath)} to look for a backup snapshot (${snap.reason}) — ` +
      `fix that directory first, then look for ${basename(dbPath)}.*.bak beside the database.`;
    return noCommand(schema ? 'schema' : 'unknown', found);
  }
  // A 0-byte `.bak` is what a failed snapshot of a damaged store left before 6.31.0 (D#551),
  // usually the newest one; it is not a copy of anything. Newest first by mtime, ties broken by
  // path so the order is total rather than readdir's — the D#9 shape.
  const files = snap.snapshots.filter((s) => s.isFile);
  const snapshots = files
    .filter((s) => s.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
  const empty = files.length - snapshots.length;
  const skipped = empty > 0 ? ` (${empty} empty .bak file${empty === 1 ? '' : 's'} skipped)` : '';
  const count = `${snapshots.length} backup snapshot(s) beside the database${skipped}`;
  const setAside = (found) => ({
    kind: 'set-aside',
    command: setAsideCommand,
    keptAs,
    snapshotCount: snapshots.length,
    found,
    note: `${found} That command moves the broken file and its log aside, ${keeps}, so a fresh store is created on the next session.`,
  });
  if (snapshots.length === 0) {
    const found =
      empty > 0
        ? `No backup snapshot beside the database holds any data${skipped}.`
        : 'No backup snapshot exists beside the database.';
    return schema ? noCommand('schema', found) : setAside(found);
  }
  if (!check) {
    const found = `${snapshots.length} backup snapshot(s) exist beside the database${skipped}.`;
    const checks = schema
      ? 'checks which one restores cleanly'
      : 'checks which one restores cleanly before it gives a command';
    const note = `${found} \`${doctorCommand(dbPath)}\` ${checks}.`;
    return noCommand(schema ? 'schema' : 'unknown', found, note, snapshots.length);
  }
  const rejected = { open: 0, rebuild: 0, integrity: 0, empty: 0 };
  let at = 0;
  let result;
  for (; at < snapshots.length; at++) {
    result = check(snapshots[at].path);
    if (result.verdict === 'ok' || result.verdict === 'unchecked') break;
    const why = result.why === 'rebuild' || result.why === 'integrity' ? result.why : 'open';
    rejected[result.verdict === 'empty' ? 'empty' : why] += 1;
  }
  const why = [
    rejected.open && `${rejected.open} ${rejected.open === 1 ? 'does' : 'do'} not open`,
    rejected.rebuild && `${rejected.rebuild} ${rejected.rebuild === 1 ? 'fails' : 'fail'} the index rebuild`,
    rejected.integrity &&
      `${rejected.integrity} ${rejected.integrity === 1 ? 'fails' : 'fail'} the integrity check`,
    rejected.empty && `${rejected.empty} ${rejected.empty === 1 ? 'holds' : 'hold'} no observations`,
  ]
    .filter(Boolean)
    .join(', ');
  if (at === snapshots.length) {
    const found = `None of the ${count} restores cleanly (${why}).`;
    return schema ? noCommand('schema', found, found, snapshots.length) : setAside(found);
  }
  const named = snapshots[at].path;
  const passedOver =
    at === 0
      ? ''
      : `Of the ${count}, the newest ${at === 1 ? 'one does' : `${at} do`} not restore cleanly (${why}); the next one`;
  if (result.verdict === 'unchecked') {
    const found = `${passedOver || `The newest of the ${count}`} could not be checked (${result.reason}): ${result.where ?? named}.`;
    const note = `${found} Once that is resolved, run \`${doctorCommand(dbPath)}\` again; no snapshot goes into a command before then.`;
    return noCommand(schema ? 'schema' : 'unknown', found, note, snapshots.length);
  }
  const what = `a copy of it, restored with its indexes rebuilt the way the command does it, opens in this version, passes SQLite's integrity check and holds ${result.observations} observation(s)${result.listed ? `, ${result.listed - result.observations} fewer than its own index lists` : ''}`;
  const found = passedOver
    ? `${passedOver} does: ${what}.`
    : `The newest of the ${count} restores cleanly: ${what}.`;
  if (schema) {
    const note = `${found} It is ${named}. Restoring it replaces the database file, so copy the broken file aside first.`;
    return noCommand('schema', found, note, snapshots.length);
  }
  const copyLog = result.withLog ? ` && cp ${shellWord(`${named}-wal`)} ${shellWord(`${dbPath}-wal`)}` : '';
  // The rebuild is part of what the check vouched for: an FTS5 index whose damage FTS5's own check
  // does not see (a shadow table's rows out of key order), and an ordinary index whose entries no
  // longer match its table, both pass doctor and fail integrity_check until rebuilt.
  const reindex = `CLAUDE_MEM_DIR=${shellWord(dirname(dbPath))} ${CLI_INVOKE} fts-check rebuild`;
  return {
    kind: 'restore',
    command: `${setAsideCommand} && cp ${shellWord(named)} ${shellWord(dbPath)}${copyLog} && ${reindex}`,
    keptAs,
    snapshotCount: snapshots.length,
    found,
    note: `${found} The command keeps the broken file and its log ${keeps}, and rebuilds the store's indexes.`,
  };
}

/**
 * The user-facing block. Short on purpose — at SessionStart it shares one stdout envelope
 * with the startup dashboard and the `<claude-mem-context>` block.
 *
 * @param {{dbPath: string, remedy: ReturnType<typeof dbUnusableRemedy>}} info
 * @returns {string}
 */
export function formatDbUnusableNotice({ dbPath, remedy }) {
  const lines = [
    '⚠️ [claude-mem-lite] Memory is OFF: the database file cannot be used.',
    remedy.kind === 'schema'
      ? `   ${dbPath} exists but SQLite cannot read its schema.`
      : `   ${dbPath} exists but SQLite does not recognise it as a database.`,
  ];
  if (remedy.command) {
    // Before the command: it moves the database file and its -wal aside and deletes the -shm,
    // under any session still holding the store (D#534). doctor says the same.
    lines.push('   Once every Claude Code session is closed, this one included, run:');
    lines.push(`   ${remedy.command}`);
  }
  if (remedy.note) lines.push(`   ${remedy.note}`);
  lines.push(`   Saves and recall are disabled. \`${doctorCommand(dbPath)}\` re-checks.`);
  return lines.join('\n');
}

/**
 * The same fact, with NO COMMAND IN IT, for the model channel.
 *
 * The schema-skew twin sends one string to both channels and that is safe there — its
 * commands are `git pull` / `claude plugin update` / `npm i -g`. This family's remedy moves the
 * database file and its log out from under every session and copies a snapshot into place, which
 * is safe only once every Claude Code session is closed, and handing that as a ready-to-run shell
 * line to an agent that has Bash, from inside one of those sessions, with no addressee and no
 * "ask first", is a different proposition.
 *
 * So the human gets the command and the model gets the situation. Both still learn memory is
 * off, which is the point of using both channels at all.
 *
 * @param {string} [dbPath] absent when an update killed partway left a 6.30.5 hook.mjs beside this
 *   file (it calls this with no argument)
 * @returns {string}
 */
export function formatDbUnusableModelNotice(dbPath) {
  return [
    '⚠️ [claude-mem-lite] Memory is OFF for this session: the database file is unreadable.',
    '   Saves and recall are disabled. Do not attempt to repair it yourself — tell the user to',
    `   run \`${dbPath ? doctorCommand(dbPath) : `${CLI_INVOKE} doctor`}\`.`,
  ].join('\n');
}
