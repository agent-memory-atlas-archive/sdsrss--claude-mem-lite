// After /compact the earlier recall blocks are gone from the model's context, but the per-file
// cooldown (keyed by the host session id, which compaction does not rotate) still said "already
// recalled this file in-session", so a file's lesson was never shown again that session (E2E
// 2026-10-16, hooks F2). SessionStart(compact) now marks the main thread's cooldown entries
// compacted: the next touch of each file recalls again, and the entries stay for the Stop-side
// readers (edge attribution, cite-back) that credit the pre-compact injections.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import Database from 'better-sqlite3';

const REPO = resolve(import.meta.dirname, '..');

function run(args, input, env) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', () => res({ stdout }));
    child.on('error', rej);
    child.stdin.end(JSON.stringify(input));
    setTimeout(() => {
      child.kill();
      rej(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

describe('a file is recalled again after /compact', () => {
  let tmpRoot, home, projectDir, fp, env;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mem-compact-recall-'));
    home = join(tmpRoot, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    projectDir = join(tmpRoot, 'parent', 'app');
    mkdirSync(projectDir, { recursive: true });
    fp = join(projectDir, 'invoice.js');
    writeFileSync(fp, 'export const applyDiscount = (c, p) => c - (c * p) / 100;\n');
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-c', project: 'parent--app', memoryId: 'mem-c' });
    insertObs(db, {
      sessionId: 'mem-c',
      project: 'parent--app',
      type: 'bugfix',
      importance: 2,
      title: 'applyDiscount leaked fractional cents',
      lessonLearned: 'Money math in cents must Math.round after percentage ops',
      filesModified: `["${fp}"]`,
    });
    db.close();
    env = {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: tmpRoot,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_MEM_HOOK_RUNNING: '',
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SUMMARY: '1',
      CLAUDE_CODE_PATH: join(tmpRoot, 'no-claude'),
      // The production default: auto-adopt makes effectiveQuiet() true, which drops Key Context
      // from SessionStart(compact), so nothing there re-delivers the lesson. Without this the
      // compact SessionStart prints Key Context with #1, and the pretool dedup is then right.
      MEM_QUIET_HOOKS: '1',
    };
    delete env.CLAUDE_PID;
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const pretool = (sid) =>
    run(
      [join(REPO, 'scripts', 'pre-tool-recall.js')],
      { tool_name: 'Read', session_id: sid, tool_input: { file_path: fp } },
      env,
    );

  it('the first Read after SessionStart(compact) shows the lesson again', async () => {
    expect((await pretool('c1')).stdout).toContain('Math.round after percentage ops'); // premise
    expect((await pretool('c1')).stdout).not.toContain('Math.round'); // premise: in-session dedup
    await run(
      [join(REPO, 'hook.mjs'), 'session-start'],
      { session_id: 'c1', source: 'compact', cwd: projectDir },
      env,
    );
    expect((await pretool('c1')).stdout).toContain('Math.round after percentage ops');
    // …and once shown again, the dedup holds for the rest of the new context window.
    expect((await pretool('c1')).stdout).not.toContain('Math.round');
    // The pre-compact entry's data stays readable for the Stop-side readers.
    const cd = JSON.parse(readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-c1.json'), 'utf8'));
    expect(cd[fp]).toBeTruthy();
  }, 60000);

  it('SessionStart(startup) of another session leaves this one alone', async () => {
    expect((await pretool('c2')).stdout).toContain('Math.round');
    await run(
      [join(REPO, 'hook.mjs'), 'session-start'],
      { session_id: 'other', source: 'startup', cwd: projectDir },
      env,
    );
    expect((await pretool('c2')).stdout).not.toContain('Math.round');
  }, 60000);
});
