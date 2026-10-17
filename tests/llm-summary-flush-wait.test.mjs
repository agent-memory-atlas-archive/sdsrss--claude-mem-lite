// Audit 2026-09-02 P1-7: `handleLLMSummary` waited for `readdirSync(RUNTIME_DIR)` to hold no
// `ep-flush-*` file at all — a condition about the WHOLE MACHINE, checked by a worker that
// only cares about its own session's flushes.
//
// Two unbounded consequences, and the first is the expensive one: a single crashed
// llm-episode worker leaves a flush file nothing deletes, so from then on EVERY project's
// summary burns the full timeout on EVERY Stop until a maintain run sweeps it — and orphan
// cleanup sits behind a 24 h gate. The second: an unrelated project flushing while this
// summary waits extends the wait, for work this summary will never read.
//
// The fix is a defined set snapshotted at entry, filtered to files young enough to belong to
// a live worker. These cases drive the real `handleLLMSummary` and measure the thing that
// actually went wrong — elapsed time — rather than asserting on the shape of the filter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync, renameSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// Above any pid_max (Linux 2^22, macOS 99998), so kill(pid, 0) reads ESRCH: a worker that is gone.
const GONE_PID = 999_999_999;

let root;
let runtimeDir;

// The wait loop sleeps FIRST and checks AFTER (`await sleep(1000)` then filter,
// the loop in `handleLLMSummary`), so it only ever moves in whole 1000 ms ticks: a file removed at
// 1.1 s is first observed gone on the SECOND tick, at ~2.0 s. Every bound below is stated in
// ticks for that reason — a bound placed between two adjacent ticks is a coin flip, not a
// test.
const POLL_MS = 1000;

/**
 * Timeout for the two cases that assert "did not burn the timeout", and the bound they use.
 *
 * These two used the 3 s default, which left them exactly ONE tick of margin: a correct run
 * lands at ~2 s and the ceiling was 3 s. Measured 2026-09-08 on an idle machine, 6/6 runs
 * read 2013-2018 ms — 982-987 ms of headroom. Delaying the removal timer by a single tick,
 * which is what a loaded runner does to a `setTimeout`, put 6/6 runs at 3013-3032 ms and
 * reproduced `expected 3022 to be less than 3000` — the failure that turned v6.0.0's Release
 * validate job red AFTER the tag had been pushed.
 *
 * 8 s with a 5-tick bound instead. A correct run still exits on tick 2, so the bound sits 3
 * ticks above the expected value; a dir-wide predicate waits on the latecomer for all 8,
 * so it sits 3 ticks below the broken one. Symmetric, and both halves are a tick count
 * rather than a tuned millisecond. Raising the timeout costs no suite time in the green
 * case — a correct run exits when ITS file clears, not when the timeout expires.
 */
const SLOW_TIMEOUT_S = 8;
const NOT_BURNED_MS = 5 * POLL_MS;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'mem-flushwait-'));
  runtimeDir = join(root, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  process.env.CLAUDE_MEM_DIR = root;
  // 3s rather than the 15s default: every case here asserts on elapsed time, and the
  // difference between "waited" and "did not wait" has to be legible without a 15s test.
  process.env.CLAUDE_MEM_FLUSH_TIMEOUT = '3';
});

afterEach(() => {
  delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
  delete process.env.CLAUDE_MEM_DIR;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Write a flush file and backdate it by `ageMs`. */
function flushFile(name, ageMs = 0) {
  const p = join(runtimeDir, name);
  writeFileSync(p, '{}');
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

/**
 * Import a fresh handleLLMSummary bound to this test's RUNTIME_DIR, and time one run.
 *
 * `arrange` schedules the case's timers, and it runs AFTER the import on purpose (D#50). The
 * import is cold on every case (`vi.resetModules()`), so it takes anywhere from ~5 ms warm to
 * ~260 ms cold to more under coverage — and timers scheduled before it start on a clock the
 * wait's tick grid does not share. Pinning the wait's start 125 ms after the timers put its
 * first tick between a removal at 1100 ms and a latecomer at 1150 ms and failed 1/1; 0 ms and
 * 200 ms both passed. Scheduled here, the timers and the wait share one origin, and
 * `handleLLMSummary` snapshots its set synchronously before its first `await`, so no timer
 * can fire before the snapshot.
 */
async function timeSummary(arrange = () => {}) {
  const { handleLLMSummary } = await import('../hook-llm.mjs');
  arrange();
  const t0 = Date.now();
  await handleLLMSummary();
  return Date.now() - t0;
}

describe('handleLLMSummary flush wait', () => {
  it('does not wait at all when no flush file exists (premise)', async () => {
    // Establishes the floor the other cases are measured against. Without it, "the orphan
    // case returned fast" could equally mean the function bailed for an unrelated reason.
    expect(await timeSummary()).toBeLessThan(1000);
  });

  it('does not wait on an ORPHANED flush file left by a crashed worker', async () => {
    // The defect. This file is older than ORPHAN_EPISODE_AGE_MS (1h), so no live worker
    // owns it; the old predicate could not tell it from work in progress and burned the
    // whole timeout — on every project, every Stop, for up to a day.
    const orphan = flushFile('ep-flush-1-orphan.json', 2 * 60 * 60 * 1000);
    expect(existsSync(orphan), 'premise: the orphan file exists').toBe(true);
    expect(await timeSummary()).toBeLessThan(1000);
    // And it is left alone — reclaiming it is the orphan sweep's job, not this worker's.
    expect(existsSync(orphan), "the summary must not delete another worker's file").toBe(true);
  });

  it('DOES wait on a fresh flush file, then stops when it disappears', async () => {
    // The behaviour that must survive the fix: a real in-flight flush still blocks, or the
    // summary reads the DB before the episode worker has written to it.
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const fresh = flushFile('ep-flush-2-live.json');
    const elapsed = await timeSummary(() =>
      setTimeout(() => {
        try {
          rmSync(fresh);
        } catch {
          /* ignore */
        }
      }, 1200),
    );
    // Lower bound: it really waited. Removal is a tick in, so at least one tick must pass —
    // an implementation that skipped the wait entirely reads ~10 ms here.
    expect(elapsed).toBeGreaterThanOrEqual(POLL_MS);
    // Upper bound: it stopped when the file went, rather than burning SLOW_TIMEOUT_S.
    expect(elapsed).toBeLessThan(NOT_BURNED_MS);
  });

  it('ignores a flush file that appears AFTER it started waiting', async () => {
    // Another project's Stop, mid-wait. Under the old dir-wide predicate this extended the
    // wait for work this summary will never read. The set is snapshotted at entry, so a
    // latecomer is somebody else's.
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const fresh = flushFile('ep-flush-3-mine.json');
    // Offsets on HALF ticks, from the wait's own origin: the latecomer lands mid-tick-1 and
    // the removal mid-tick-2, so the removal is first seen on tick 2. Timers fire in deadline
    // order however late the loop runs them, so the latecomer (0.5) always precedes tick 2
    // (>= 2.0) — the old 1100/1150 pair straddled nothing and relied on where tick 1 fell.
    const elapsed = await timeSummary(() => {
      setTimeout(() => flushFile('ep-flush-4-someone-else.json'), 0.5 * POLL_MS);
      setTimeout(() => {
        try {
          rmSync(fresh);
        } catch {
          /* ignore */
        }
      }, 1.5 * POLL_MS);
    });
    expect(elapsed).toBeLessThan(NOT_BURNED_MS);
    // Premise: the latecomer really is still on disk, so "finished early" is not just
    // "the file was gone anyway".
    expect(existsSync(join(runtimeDir, 'ep-flush-4-someone-else.json'))).toBe(true);
  });

  // E2E 2026-10-16 P2-4: the default wait was 15 s, below one CLI-leg episode (2-5 s delay +
  // 8-13 s call, + the lesson retry on a bugfix), so the summary found no observation yet and the
  // session kept its Stop-time baseline. The default now spans the episode worker's own bound.
  it('by default keeps waiting past 15 s for an episode worker still inside its bound', async () => {
    delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { handleLLMSummary } = await import('../hook-llm.mjs');
      const inFlight = flushFile('ep-flush-6-cli-leg.json');
      let done = false;
      const run = handleLLMSummary().then(() => {
        done = true;
      });
      // delay 5 s + call 13 s + lesson retry 13 s: the slow end of a CLI-leg bugfix episode.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(done, 'gave up on an episode worker that was still working').toBe(false);
      rmSync(inFlight);
      await vi.advanceTimersByTimeAsync(2 * POLL_MS);
      await run;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // D#383: an episode worker renames its flush file to carry its pid when it starts, and a
  // hand-off renames it again; the episode is in flight until no file of that flush is left.
  it('keeps waiting on a flush file its worker renamed, until no name of it is left', async () => {
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { handleLLMSummary } = await import('../hook-llm.mjs');
      const handed = flushFile('ep-flush-8-claimed.json');
      let done = false;
      const run = handleLLMSummary().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0.5 * POLL_MS);
      // A running worker's pid (this process): a claim by a gone pid no longer holds the wait.
      const claimed = join(runtimeDir, `ep-flush-8-claimed.w${process.pid}.json`);
      renameSync(handed, claimed);
      await vi.advanceTimersByTimeAsync(3 * POLL_MS);
      expect(done, 'stopped waiting when the worker claimed its file').toBe(false);
      rmSync(claimed);
      await vi.advanceTimersByTimeAsync(2 * POLL_MS);
      await run;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait on a flush file older than an episode worker can live', async () => {
    // Its worker is gone however young the file is next to the 1 h sweep: waiting on it only
    // delays this summary (by the whole default wait, now that the default spans that bound).
    const { episodeWorkerMaxMs } = await import('../hook-llm.mjs');
    const orphan = flushFile('ep-flush-7-dead-worker.json', episodeWorkerMaxMs() + 60_000);
    expect(await timeSummary()).toBeLessThan(1000);
    expect(existsSync(orphan)).toBe(true);
  });

  it('gives up after the timeout rather than hanging on a file that never clears', async () => {
    flushFile('ep-flush-5-stuck.json');
    const elapsed = await timeSummary();
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(6000);
  });

  // Pre-tag review 2026-10-16 P3-3: a worker that died after claiming its file (`.w<pid>`) leaves
  // that file for SessionStart's hand-off, and until then every Stop's summary worker waited the
  // whole default (275 s, ~82 MB resident each) on an episode nobody was going to save.
  it('does not wait on a fresh flush file whose claiming worker is gone', async () => {
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const dead = flushFile(`ep-flush-10-died.w${GONE_PID}.json`);
    expect(await timeSummary()).toBeLessThan(POLL_MS);
    expect(existsSync(dead), 'the hand-off, not the summary, owns that file').toBe(true);
  });

  it('stops waiting once the worker that claimed the file dies', async () => {
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise((r) => worker.once('exit', r));
    flushFile(`ep-flush-11-dies.w${worker.pid}.json`);
    let t0;
    let diedAt;
    const elapsed = await timeSummary(() => {
      t0 = Date.now();
      setTimeout(() => {
        worker.kill('SIGKILL');
        exited.then(() => {
          diedAt = Date.now() - t0;
        });
      }, 1.5 * POLL_MS);
    });
    // The overlap the case claims: the worker was alive for the first tick, so the wait held on
    // it, and it died during the wait rather than before or after it.
    expect(diedAt, 'premise: the worker died during the wait').toBeLessThan(elapsed);
    expect(elapsed, 'premise: a live claim held the wait for a tick').toBeGreaterThanOrEqual(POLL_MS);
    expect(elapsed - diedAt, 'stopped within two ticks of the death').toBeLessThanOrEqual(2 * POLL_MS);
    expect(elapsed).toBeLessThan(NOT_BURNED_MS);
  });

  // The same review: Stop spawns one summary worker per turn, and each waited out the flush even
  // after a later Stop had made its reply one the write would drop (summarySuperseded).
  it('stops waiting once a later Stop of its session is recorded', async () => {
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const argv = process.argv.slice(3, 6);
    const spawnEpoch = Date.now() - 60_000;
    process.argv[3] = 'cc-superseded';
    process.argv[4] = 'proj';
    process.argv[5] = String(spawnEpoch);
    try {
      const { handleLLMSummary } = await import('../hook-llm.mjs');
      const { ensureDb } = await import('../schema.mjs');
      const db = ensureDb();
      const stop = (epoch) =>
        db
          .prepare(
            `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status, completed_at_epoch)
             VALUES ('cc-superseded', 'cc-superseded', 'proj', '', 0, 'completed', ?)
             ON CONFLICT(content_session_id) DO UPDATE SET completed_at_epoch = excluded.completed_at_epoch`,
          )
          .run(epoch);
      stop(spawnEpoch);
      flushFile('ep-flush-12-in-flight.json');
      let laterStopAt;
      const t0 = Date.now();
      setTimeout(() => {
        stop(spawnEpoch + 30_000);
        laterStopAt = Date.now() - t0;
      }, 1.5 * POLL_MS);
      await handleLLMSummary();
      const elapsed = Date.now() - t0;
      db.close();
      expect(laterStopAt, 'premise: the later Stop landed during the wait').toBeLessThan(elapsed);
      expect(elapsed, 'premise: its own Stop alone held the wait for a tick').toBeGreaterThanOrEqual(POLL_MS);
      expect(elapsed).toBeLessThan(NOT_BURNED_MS);
    } finally {
      [process.argv[3], process.argv[4], process.argv[5]] = argv;
    }
  });
});
