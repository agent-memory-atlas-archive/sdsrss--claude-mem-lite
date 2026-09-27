// D#95: the background model session summary is opt-in.
//
// The `llm-summary` worker ran after EVERY Stop (one per assistant turn) and on the
// SessionStart /clear path, polled up to CLAUDE_MEM_FLUSH_TIMEOUT for flush files, then
// summarised the session's OBSERVATIONS — a table the episode upgrade-delete empties. Measured
// 2026-09-27: 24 worker runs / 5 sessions, outcome `no-obs` 24/24, zero model calls; D#95's
// 7-day read found 4 of 157 hook sessions holding an observation. Last Session already comes
// from the report extract written synchronously at Stop. CLAUDE_MEM_LLM_SUMMARY=1 restores
// the worker; CLAUDE_MEM_SKIP_SUMMARY still wins (tests/bg-spawn-skip-flag-invariant).
//
// Behavioural, two arms: the worker records one `summary_worker` metric row per exit
// (CLAUDE_MEM_METRICS=1), so its absence under the default is a NO the opted-in arm shows
// the ruler can turn into a YES.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { modelSummaryOptedIn } from '../lib/fast-summary.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SRC = readFileSync(join(REPO, 'hook.mjs'), 'utf8');
const roots = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until no process still names this sandbox — the detached worker included. */
async function quiesce(root) {
  for (let i = 0; i < 50; i++) {
    let out;
    try {
      out = execFileSync('pgrep', ['-f', root], { encoding: 'utf8' });
    } catch {
      return; // pgrep exits 1 when nothing matches
    }
    if (!out.trim()) return;
    await sleep(100);
  }
}

afterAll(async () => {
  for (const r of roots) {
    await quiesce(r);
    rmSync(r, { recursive: true, force: true });
  }
});

function summaryWorkerRows(data) {
  const dir = join(data, 'metrics');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.includes('"summary_worker"'));
}

async function stopInSandbox(extraEnv) {
  const root = mkdtempSync(join(tmpdir(), 'mem-d95-'));
  roots.push(root);
  const data = join(root, 'data');
  const cwd = join(root, 'proj');
  for (const d of [data, cwd, join(root, '.claude')]) mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  Object.assign(env, {
    HOME: root,
    CLAUDE_MEM_DIR: data,
    CLAUDE_MEM_METRICS: '1',
    CLAUDE_MEM_FLUSH_TIMEOUT: '0',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_CODE_PATH: join(root, 'no-such-claude'),
    ANTHROPIC_API_KEY: '',
    MEM_NO_AUTO_ADOPT: '1',
    ...extraEnv,
  });
  const r = spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'stop'], {
    cwd,
    env,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'cc-d95', transcript_path: join(root, 'none.jsonl') }),
  });
  expect(r.status, r.stderr).toBe(0);
  // The worker is detached; give it the time the opted-in arm needs to write its row.
  for (let i = 0; i < 60 && summaryWorkerRows(data).length === 0; i++) await sleep(100);
  await quiesce(root);
  return summaryWorkerRows(data);
}

describe('D#95 — the model session summary is opt-in', () => {
  it('modelSummaryOptedIn reads CLAUDE_MEM_LLM_SUMMARY, default off', () => {
    expect(modelSummaryOptedIn({})).toBe(false);
    expect(modelSummaryOptedIn({ CLAUDE_MEM_LLM_SUMMARY: '0' })).toBe(false);
    for (const v of ['1', 'on', 'true', 'yes'])
      expect(modelSummaryOptedIn({ CLAUDE_MEM_LLM_SUMMARY: v })).toBe(true);
  });

  it('premise: with CLAUDE_MEM_LLM_SUMMARY=1, Stop starts the worker (it records its outcome)', async () => {
    const rows = await stopInSandbox({ CLAUDE_MEM_LLM_SUMMARY: '1' });
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('"outcome":"no-obs"');
  });

  it('by default, Stop starts no summary worker', async () => {
    expect(await stopInSandbox({})).toEqual([]);
  });

  it('both llm-summary spawn sites go through the one predicate', () => {
    const lines = HOOK_SRC.split('\n');
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /spawnBackground\(\s*'llm-summary'/.test(l) && !l.trim().startsWith('//'));
    expect(sites.length).toBe(2);
    for (const { i } of sites) {
      const window = lines
        .slice(Math.max(0, i - 4), i + 1)
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      expect(window, `hook.mjs:${i + 1}`).toContain('modelSummaryOptedIn()');
      expect(window, `hook.mjs:${i + 1}`).toContain('CLAUDE_MEM_SKIP_SUMMARY');
    }
  });
});
