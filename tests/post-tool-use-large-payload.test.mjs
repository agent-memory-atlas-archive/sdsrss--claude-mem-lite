// A PostToolUse payload past 256 KB used to vanish: scripts/post-tool-use.sh handed node only
// `head -c 262144`, hook.mjs flagged truncation only when it read MORE than its own 256 KB cap
// (never, for an exactly-capped prefix), so JSON.parse failed and the event was dropped. An Edit
// carries the whole file in tool_response.originalFile, so every edit of a file over ~250 KB and
// every Write over ~128 KB left no episode entry, no files_modified edge and no handoff key file
// (E2E 2026-10-16, hooks F1). PostToolUse now reads the whole-file tier (8 MB), as PreToolUse
// already does, and a payload past even that is salvaged with its path and session.
//
// Driven through the registered command (the bash prefilter), sandboxed HOME and data dir.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');
const sandboxes = [];
afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true });
});

function postToolUse(payload) {
  const home = mkdtempSync(join(tmpdir(), 'mem-bigptu-home-'));
  const memDir = mkdtempSync(join(tmpdir(), 'mem-bigptu-data-'));
  sandboxes.push(home, memDir);
  mkdirSync(join(home, '.claude'), { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PID$)/.test(k)) delete base[k];
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify(payload),
    env: { ...base, HOME: home, CLAUDE_MEM_DIR: memDir, CLAUDE_PROJECT_DIR: '/tmp/org/proj' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000,
  });
  const runtime = join(memDir, 'runtime');
  let buffer = null;
  try {
    const ep = readdirSync(runtime).find((f) => f.startsWith('ep-') && f.endsWith('.json'));
    if (ep) buffer = JSON.parse(readFileSync(join(runtime, ep), 'utf8'));
  } catch {
    /* no runtime dir: nothing was buffered */
  }
  return { r, buffer };
}

const edit = (bytes) => ({
  session_id: 'big-edit',
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/org/proj/src/rates.js', old_string: 'rate0 = 0', new_string: 'rate0 = 1' },
  tool_response: { filePath: '/tmp/org/proj/src/rates.js', originalFile: 'x'.repeat(bytes) },
});

describe('PostToolUse past 256 KB still reaches the episode buffer', () => {
  it('control: a small Edit is buffered with its file', () => {
    const { r, buffer } = postToolUse(edit(1000));
    expect(r.status).toBe(0);
    expect(JSON.stringify(buffer?.entries ?? [])).toContain('/tmp/org/proj/src/rates.js');
  });

  it('an Edit of a 300 KB file is buffered with its file and change', () => {
    const { r, buffer } = postToolUse(edit(300 * 1024));
    expect(r.status).toBe(0);
    const entries = JSON.stringify(buffer?.entries ?? []);
    expect(entries).toContain('/tmp/org/proj/src/rates.js');
    expect(entries).toContain('rate0 = 1');
  }, 30000);

  it('an Edit past the 8 MB tier is still buffered with its file', () => {
    const { r, buffer } = postToolUse(edit(9 * 1024 * 1024));
    expect(r.status).toBe(0);
    expect(JSON.stringify(buffer?.entries ?? [])).toContain('/tmp/org/proj/src/rates.js');
  }, 30000);
});
