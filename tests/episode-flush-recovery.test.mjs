// E2E 2026-10-16 bg P2-3: a killed `llm-episode` worker (reboot, OOM, kill -9) lost its episode.
// Its `ep-flush-*.json` was handed to that one worker only, nothing re-read it, and the 1 h orphan
// sweep deleted it. SessionStart now hands a flush file that no live worker can still own (older
// than episodeWorkerMaxMs) to a new worker — renamed first, so one SessionStart takes it, and
// renamed to a name that is never handed on again, so a second death cannot loop.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { recoverOrphanEpisodeFlushes, episodeWorkerMaxMs, RECOVERED_FLUSH_SUFFIX } from '../hook-llm.mjs';
import { sweepOrphanEpisodeFiles, ORPHAN_EPISODE_AGE_MS } from '../hook-shared.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const NOW = 1_800_000_000_000;
const MIN = 60_000;

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

  it('hands an orphaned file to a new worker under a name it is never handed on from', () => {
    flushFile(dir, 'ep-flush-2-dead.json', episodeWorkerMaxMs() + MIN);
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

  it('keeps the 1 h sweep as the backstop for a recovered file', () => {
    flushFile(dir, 'ep-flush-6.json', episodeWorkerMaxMs() + MIN);
    recover();
    // The rename keeps the mtime, so the sweep's clock still runs from the original flush.
    expect(sweepOrphanEpisodeFiles(dir, { now: NOW + ORPHAN_EPISODE_AGE_MS })).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('SessionStart after an episode worker was killed', () => {
  it('saves the episode the dead worker held', async () => {
    const root = fixtures.track(join(tmpdir(), `mem-flushrec-e2e-${randomUUID().slice(0, 8)}`));
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
    // Written by a flush whose worker died 10 minutes ago, past any live worker's bound.
    const flush = join(runtime, `ep-flush-${ts}-deadbeef.json`);
    writeFileSync(flush, JSON.stringify(episode));
    utimesSync(flush, ts / 1000, ts / 1000);

    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_PATH: join(REPO, 'scripts/mock-claude.mjs'),
      CLAUDE_MEM_NO_DELAY: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_SUMMARY: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '',
      MEM_NO_AUTO_ADOPT: '1',
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      input: JSON.stringify({ session_id: 'cc-next', source: 'startup', cwd: projectDir }),
      env,
      encoding: 'utf8',
      timeout: 20000,
    });

    let saved = [];
    for (let i = 0; i < 150 && saved.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const ro = new Database(dbPath, { readonly: true });
      try {
        // The worker's model (mock) title, under the dead session's project: an event for a
        // bugfix, an observation otherwise.
        saved = [
          ...ro.prepare('SELECT project, title FROM observations').all(),
          ...ro.prepare('SELECT project, title FROM events').all(),
        ];
      } finally {
        ro.close();
      }
    }
    expect(saved).toEqual([{ project: 'work--invoice-app', title: 'Mock episode summary' }]);
    expect(readdirSync(runtime).filter((f) => f.startsWith('ep-flush-'))).toEqual([]);
  });
});
