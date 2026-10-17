// E2E 2026-10-16 bg P2-3: a killed `llm-episode` worker (reboot, OOM, kill -9) lost its episode.
// Its `ep-flush-*.json` was handed to that one worker only, nothing re-read it, and the 1 h orphan
// sweep deleted it. SessionStart now hands a flush file that no live worker can still own (older
// than episodeWorkerMaxMs) to a new worker — renamed first, so one SessionStart takes it, and
// renamed to a name that is never handed on again, so a second death cannot loop.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import * as hookLlm from '../hook-llm.mjs';
import {
  recoverOrphanEpisodeFlushes,
  episodeWorkerMaxMs,
  unclaimedFlushMinAgeMs,
  RECOVERED_FLUSH_SUFFIX,
} from '../hook-llm.mjs';
import { sweepOrphanEpisodeFiles, ORPHAN_EPISODE_AGE_MS } from '../hook-shared.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const NOW = 1_800_000_000_000;
const MIN = 60_000;
// Above any pid_max (Linux 2^22, macOS 99998), so kill(pid, 0) reads ESRCH: a worker that is gone.
const GONE_PID = 999_999_999;

function flushFile(dir, name, ageMs, now = NOW) {
  const p = join(dir, name);
  writeFileSync(p, '{}');
  const t = (now - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

describe('recoverOrphanEpisodeFlushes', () => {
  let dir;
  let spawned;
  const recover = (opts = {}) =>
    recoverOrphanEpisodeFlushes(dir, { now: NOW, spawn: (f) => spawned.push(f), ...opts });
  beforeEach(() => {
    dir = fixtures.track(mkdtempSync(join(tmpdir(), 'mem-flushrec-')));
    spawned = [];
  });

  it('leaves a file a live worker may still own', () => {
    const live = flushFile(dir, 'ep-flush-1-live.json', episodeWorkerMaxMs() - MIN);
    expect(recover()).toEqual([]);
    expect(spawned).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  // Pre-tag review 2026-10-16 P3-4: a worker of v6.27.0 or older never claims its file, and can run
  // longer than episodeWorkerMaxMs() (its keyed-provider fallback restarted the CLI's full
  // timeout). During the update from such a version, handing its file on at 275 s let a second
  // worker save the episode it was still saving.
  it('leaves an unclaimed file that a pre-claim worker may still be saving', () => {
    const unclaimed = flushFile(dir, 'ep-flush-2-preclaim.json', episodeWorkerMaxMs() + MIN);
    expect(unclaimedFlushMinAgeMs()).toBeGreaterThan(episodeWorkerMaxMs() + MIN);
    expect(recover()).toEqual([]);
    expect(spawned).toEqual([]);
    expect(existsSync(unclaimed)).toBe(true);
  });

  it('hands an orphaned file to a new worker under a name it is never handed on from', () => {
    flushFile(dir, 'ep-flush-2-dead.json', unclaimedFlushMinAgeMs() + MIN);
    const to = join(dir, `ep-flush-2-dead${RECOVERED_FLUSH_SUFFIX}`);
    expect(recover()).toEqual([to]);
    expect(spawned).toEqual([to]);
    expect(readdirSync(dir)).toEqual([`ep-flush-2-dead${RECOVERED_FLUSH_SUFFIX}`]);
    // Its worker died too: the next SessionStart does not hand it on again.
    spawned = [];
    expect(recover()).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('leaves files past the orphan sweep’s age to the sweep', () => {
    flushFile(dir, 'ep-flush-3-old.json', ORPHAN_EPISODE_AGE_MS + MIN);
    expect(recover()).toEqual([]);
  });

  it('hands on at most `limit` per call, oldest first', () => {
    const base = episodeWorkerMaxMs();
    flushFile(dir, 'ep-flush-4-a.json', base + 3 * MIN);
    flushFile(dir, 'ep-flush-4-b.json', base + 9 * MIN);
    flushFile(dir, 'ep-flush-4-c.json', base + 6 * MIN);
    expect(recover({ limit: 2 }).map((p) => p.slice(dir.length + 1))).toEqual([
      `ep-flush-4-b${RECOVERED_FLUSH_SUFFIX}`,
      `ep-flush-4-c${RECOVERED_FLUSH_SUFFIX}`,
    ]);
    expect(recover({ limit: 2 }).map((p) => p.slice(dir.length + 1))).toEqual([
      `ep-flush-4-a${RECOVERED_FLUSH_SUFFIX}`,
    ]);
  });

  it('ignores names that are not flush files', () => {
    const age = episodeWorkerMaxMs() + MIN;
    flushFile(dir, 'ep-proj.json', age);
    flushFile(dir, 'pending-x.json', age);
    flushFile(dir, 'ep-flush-5.json.tmp-1', age);
    expect(recover()).toEqual([]);
  });

  // D#383: a worker paused past episodeWorkerMaxMs() by a suspended machine still runs once the
  // machine wakes, and saves the episode itself; handing its file on made a second worker save it
  // again (events have no duplicate check). The worker's pid in the name tells the two apart.
  it('leaves a file whose worker is still running, however old the file is', () => {
    const paused = flushFile(dir, `ep-flush-7-paused.w${process.pid}.json`, episodeWorkerMaxMs() + 10 * MIN);
    expect(recover()).toEqual([]);
    expect(spawned).toEqual([]);
    expect(existsSync(paused)).toBe(true);
  });

  it('hands on a claimed file whose worker is gone, under the name an unclaimed one gets', () => {
    flushFile(dir, `ep-flush-8-gone.w${GONE_PID}.json`, episodeWorkerMaxMs() + MIN);
    const to = join(dir, `ep-flush-8-gone${RECOVERED_FLUSH_SUFFIX}`);
    expect(recover()).toEqual([to]);
    expect(readdirSync(dir)).toEqual([`ep-flush-8-gone${RECOVERED_FLUSH_SUFFIX}`]);
  });

  it('never hands on a recovered file that its second worker claimed', () => {
    flushFile(dir, `ep-flush-9-twice.recovered.w${GONE_PID}.json`, episodeWorkerMaxMs() + MIN);
    expect(recover()).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('keeps the 1 h sweep as the backstop for a recovered file', () => {
    flushFile(dir, 'ep-flush-6.json', unclaimedFlushMinAgeMs() + MIN);
    expect(recover(), 'premise: the file was handed on').toHaveLength(1);
    // The rename keeps the mtime, so the sweep's clock still runs from the original flush.
    expect(sweepOrphanEpisodeFiles(dir, { now: NOW + ORPHAN_EPISODE_AGE_MS })).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('claimFlushFile', () => {
  let dir;
  beforeEach(() => {
    dir = fixtures.track(mkdtempSync(join(tmpdir(), 'mem-flushclaim-')));
  });

  it('renames a flush file to carry the worker pid and keeps its mtime', () => {
    const handed = flushFile(dir, 'ep-flush-1-a.json', 3 * MIN, Date.now());
    const before = statSync(handed).mtimeMs;
    const claimed = hookLlm.claimFlushFile(handed, 4242);
    expect(claimed).toBe(join(dir, 'ep-flush-1-a.w4242.json'));
    expect(readdirSync(dir)).toEqual(['ep-flush-1-a.w4242.json']);
    expect(statSync(claimed).mtimeMs).toBe(before);
  });

  it('keeps the recovered mark on a handed-on file', () => {
    const handed = flushFile(dir, `ep-flush-2-b${RECOVERED_FLUSH_SUFFIX}`, 0, Date.now());
    expect(hookLlm.claimFlushFile(handed, 4242)).toBe(join(dir, 'ep-flush-2-b.recovered.w4242.json'));
  });

  it('returns null when the file is gone, so the worker leaves the episode to whoever took it', () => {
    expect(hookLlm.claimFlushFile(join(dir, 'ep-flush-3-c.json'), 4242)).toBeNull();
  });
});

const CLEAN_ENV = {
  CLAUDE_MEM_NO_DELAY: '1',
  CLAUDE_MEM_SKIP_UPDATE: '1',
  CLAUDE_MEM_SKIP_SUMMARY: '1',
  CLAUDE_MEM_SKIP_MAINTAIN: '1',
  CLAUDE_MEM_SKIP_COMPRESS: '1',
  CLAUDE_MEM_SKIP_OPTIMIZE: '1',
  CLAUDE_MEM_SKIP_EPISODE_LLM: '',
  MEM_NO_AUTO_ADOPT: '1',
};

/**
 * A data dir with an empty DB, and a bugfix episode whose flush was written 10 minutes ago.
 * `oneEntry` keeps only its failing command: the mock then answers a bugfix, which is saved as an
 * event, and events have no duplicate check to hide a second save.
 */
function deadSessionFixture(label, { oneEntry = false } = {}) {
  const root = fixtures.track(join(tmpdir(), `mem-flushrec-${label}-${randomUUID().slice(0, 8)}`));
  const home = join(root, 'home');
  const projectDir = join(root, 'work', 'invoice-app');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  const runtime = join(home, '.claude-mem-lite', 'runtime');
  mkdirSync(runtime, { recursive: true });
  const dbPath = join(home, '.claude-mem-lite', 'claude-mem-lite.db');
  const db = new Database(dbPath);
  initSchema(db);
  db.close();
  const file = join(projectDir, 'src/invoice.js');
  const ts = Date.now() - 10 * MIN;
  const episode = {
    sessionId: 'hook-killed-worker',
    project: 'work--invoice-app',
    startedAt: ts - 5000,
    lastAt: ts,
    files: [file],
    entries: [
      {
        tool: 'Bash',
        desc: "npm test → TypeError: Cannot read properties of undefined (reading 'reduce')",
        files: [],
        ts: ts - 3000,
        isError: true,
        isSignificant: true,
        bashSig: 'npm test',
      },
      {
        tool: 'Edit',
        desc: 'invoice.js: guard undefined lines before reduce',
        files: [file],
        ts,
        isError: false,
        isSignificant: true,
        bashSig: null,
      },
    ],
    filesRead: [],
  };
  if (oneEntry) episode.entries = episode.entries.slice(0, 1);
  const flush = join(runtime, `ep-flush-${ts}-deadbeef.json`);
  writeFileSync(flush, JSON.stringify(episode));
  utimesSync(flush, ts / 1000, ts / 1000);
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PID: String(process.pid),
    CLAUDE_CODE_PATH: join(REPO, 'scripts/mock-claude.mjs'),
    ...CLEAN_ENV,
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  return { root, projectDir, runtime, dbPath, flush, env };
}

function sessionStart({ projectDir, env }) {
  execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
    input: JSON.stringify({ session_id: 'cc-next', source: 'startup', cwd: projectDir }),
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

function savedRows(dbPath) {
  const ro = new Database(dbPath, { readonly: true });
  try {
    return [
      ...ro.prepare('SELECT project, title FROM observations').all(),
      ...ro.prepare('SELECT project, title FROM events').all(),
    ];
  } finally {
    ro.close();
  }
}

const flushFilesIn = (runtime) => readdirSync(runtime).filter((f) => f.startsWith('ep-flush-'));

async function until(predicate, timeoutMs) {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe('SessionStart after an episode worker was killed', () => {
  it('saves the episode the dead worker held', async () => {
    const f = deadSessionFixture('killed');
    sessionStart(f);
    let saved = [];
    await until(() => (saved = savedRows(f.dbPath)).length > 0, 15000);
    // The worker's model (mock) title, under the dead session's project: an event for a
    // bugfix, an observation otherwise.
    expect(saved).toEqual([{ project: 'work--invoice-app', title: 'Mock episode summary' }]);
    expect(flushFilesIn(f.runtime)).toEqual([]);
  });
});

// D#383: the shape a suspended laptop leaves. The worker is alive but its flush file is already
// past episodeWorkerMaxMs() when the next SessionStart looks; that worker saves the episode
// itself once the machine wakes, so handing the file on as well stores it twice.
describe('SessionStart while an episode worker is still running past the bound', () => {
  it('leaves that worker its file, and the episode is saved once', async () => {
    const f = deadSessionFixture('paused', { oneEntry: true });
    // A model call that takes 3 s, with a marker for "the worker has its episode in hand".
    const started = join(f.root, 'cli-started');
    const cli = join(f.root, 'slow-claude.sh');
    writeFileSync(
      cli,
      `#!/bin/sh\n: > '${started}'\nsleep 3\nexec '${process.execPath}' '${join(REPO, 'scripts/mock-claude.mjs')}' "$@"\n`,
    );
    chmodSync(cli, 0o755);
    const env = { ...f.env, CLAUDE_CODE_PATH: cli, CLAUDE_MEM_NO_LESSON_RETRY: '1' };
    const worker = spawn(process.execPath, [join(REPO, 'hook.mjs'), 'llm-episode', f.flush], {
      env,
      stdio: 'ignore',
    });
    const exited = new Promise((r) => worker.once('exit', r));
    expect(await until(() => existsSync(started), 10000), 'premise: the worker reached its model call').toBe(
      true,
    );

    sessionStart({ ...f, env });
    await exited;
    // A second worker, if SessionStart handed the file on, runs its own 3 s call.
    await until(() => flushFilesIn(f.runtime).length === 0, 20000);
    await new Promise((r) => setTimeout(r, 500));
    expect(savedRows(f.dbPath)).toEqual([{ project: 'work--invoice-app', title: 'Mock single observation' }]);
    expect(flushFilesIn(f.runtime)).toEqual([]);
  }, 45000);
});
