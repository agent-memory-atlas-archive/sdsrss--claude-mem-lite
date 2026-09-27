// Every injection surface stays under the host's 10,000-character hook-output cap.
//
// Over the cap the host does not truncate at 10,000: it writes the text to a file and hands
// the model a 2,000-character preview it is never asked to follow (lib/hook-text-cap.mjs
// quotes the hooks reference). Three layers here:
//   1. capHookText / writePlainHookText units;
//   2. the envelope writer caps each field it emits;
//   3. a REAL overflow reached through a shipped surface — the UserPromptSubmit deferred-work
//      block, which injects a D#'s detail "never truncated" — spawned as a subprocess;
//   4. STRUCTURAL: no registered hook entry point writes stdout except through the two
//      capped writers, so a new plain write cannot bypass the cap unnoticed.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HOOK_TEXT_CAP, capHookText, writePlainHookText, resetPlainHookText } from '../lib/hook-text-cap.mjs';
import {
  queueHookContext,
  queueHookSystemMessage,
  flushHookStdout,
  resetHookStdout,
} from '../lib/hook-stdout.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function rows(n, width = 90) {
  return Array.from({ length: n }, (_, i) => `- #${i + 1} ${'x'.repeat(width)}`);
}

describe('capHookText', () => {
  it('returns text within the cap unchanged', () => {
    const s = rows(10).join('\n');
    expect(capHookText(s)).toBe(s);
  });

  it('trims by whole lines under the cap and names the dropped ids', () => {
    const s = rows(300).join('\n'); // ~29K
    const out = capHookText(s);
    expect(out.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    const lines = out.split('\n');
    // every kept row is whole
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^- #\d+ x{90}$/);
    const footer = lines[lines.length - 1];
    expect(footer).toMatch(
      /^\[claude-mem-lite\] \d+ more line\(s\) not shown — hook output limit \(ids: #\d+/,
    );
    // kept rows are #1..#(lines.length-1), so the first dropped one is #(lines.length)
    expect(footer).toContain(`(ids: #${lines.length},`);
    expect(footer).toMatch(/\+\d+ more\)$/);
  });

  it('closes a tag block whose closing line was cut', () => {
    const s = ['<memory-context relevance="high">', ...rows(300), '</memory-context>'].join('\n');
    const out = capHookText(s);
    expect(out.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(out.startsWith('<memory-context relevance="high">')).toBe(true);
    expect(out.endsWith('</memory-context>')).toBe(true);
    expect(out.match(/<\/memory-context>/g)).toHaveLength(1);
  });

  it('a line cut short is marked, and its footer names the ids in the cut part (review P3-1)', () => {
    const line = `Memory — a past lesson applies. You must: ${'do the thing. '.repeat(80)}(#4242)`;
    const out = capHookText(line, 700);
    expect(out.length).toBeLessThanOrEqual(700);
    const [head, footer] = out.split('\n');
    expect(head.endsWith('…')).toBe(true);
    expect(footer).toBe('[claude-mem-lite] a line was cut short — hook output limit (ids: #4242)');
  });

  it('never leaves half of a surrogate pair at the cut (review P3-1)', () => {
    for (let pad = 0; pad < 4; pad++) {
      const out = capHookText(`${'x'.repeat(pad)}${'🔴'.repeat(400)}`, 700);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    }
  });

  it('the footer does not count a closing line it re-appends (review P3-3)', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `- row ${i} ${'y'.repeat(90)}`);
    const out = capHookText(['<memory-context>', ...rows, '</memory-context>'].join('\n'));
    const shown = out.split('\n').filter((l) => l.startsWith('- row ')).length;
    const n = Number(out.match(/(\d+) more line\(s\) not shown/)[1]);
    expect(shown + n).toBe(200);
  });

  it('hard-cuts a single line longer than the budget', () => {
    const out = capHookText('y'.repeat(50_000));
    expect(out.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(out.startsWith('yyyy')).toBe(true);
  });
});

describe('writePlainHookText — the budget is per process', () => {
  beforeEach(() => resetPlainHookText());

  it('two chunks that each fit are capped together', () => {
    const written = [];
    const write = (s) => written.push(s);
    writePlainHookText(rows(70).join('\n'), { write }); // ~6.6K
    writePlainHookText(rows(70).join('\n'), { write }); // would reach ~13K
    const total = written.join('');
    expect(total.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(total).toContain('not shown — hook output limit');
  });

  it('a chunk arriving after the budget is spent becomes a one-line note', () => {
    const written = [];
    const write = (s) => written.push(s);
    writePlainHookText('z'.repeat(9_800), { write });
    writePlainHookText(['<memory-context>', '- #77 later row', '</memory-context>'].join('\n'), { write });
    const total = written.join('');
    expect(total.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(written[1]).toMatch(
      /^\[claude-mem-lite\] 3 more line\(s\) not shown — hook output limit \(ids: #77\)\n$/,
    );
  });
});

describe('flushHookStdout caps each field separately', () => {
  beforeEach(() => resetHookStdout());

  it('additionalContext and systemMessage are each ≤ the cap', () => {
    let out = '';
    queueHookContext('SessionStart', rows(300).join('\n'));
    queueHookSystemMessage('n'.repeat(12_000));
    flushHookStdout({ write: (s) => (out += s) });
    const env = JSON.parse(out);
    expect(env.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(env.hookSpecificOutput.additionalContext).toContain('not shown — hook output limit');
    expect(env.systemMessage.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
  });
});

describe('a real overflow through a shipped surface (subprocess)', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'mem-textcap-'));
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('UserPromptSubmit deferred-work block with a 30K detail stays under the cap', () => {
    const data = join(ROOT, 'data');
    const home = join(ROOT, 'home');
    const cwd = join(ROOT, 'proj-textcap');
    for (const d of [data, join(home, '.claude'), cwd]) mkdirSync(d, { recursive: true });
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PWD;
    Object.assign(env, {
      HOME: home,
      CLAUDE_MEM_DIR: data,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_REPOS: '1',
      MEM_NO_AUTO_ADOPT: '1',
    });
    const detail = rows(320)
      .map((l) => `item ${l.slice(2)}`)
      .join('\n'); // ~30K, one line per row; must not start with '-' (a CLI flag)
    const add = spawnSync(
      process.execPath,
      [join(REPO, 'cli.mjs'), 'defer', 'add', 'Overflowing deferred item', '--detail', detail],
      { cwd, env, encoding: 'utf8' },
    );
    expect(add.status, add.stderr).toBe(0);
    const id = Number((add.stdout + add.stderr).match(/D#(\d+)/)[1]);
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'user-prompt-search.js')], {
      cwd,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'cc-textcap', prompt: `please pick up D#${id} now` }),
    });
    expect(r.status, r.stderr).toBe(0);
    // premise: the surface really fired — otherwise a length check passes vacuously
    expect(r.stdout).toContain(`D#${id}`);
    expect(r.stdout).toContain('Overflowing deferred item');
    expect(r.stdout.length).toBeLessThanOrEqual(HOOK_TEXT_CAP);
    expect(r.stdout).toContain('not shown — hook output limit');
  });
});

describe('STRUCTURAL: hook entry points write stdout only through the capped writers', () => {
  // The files that deliver injected text. hook-stdout.mjs and hook-text-cap.mjs are the two
  // writers; everything else must call them.
  const ENTRIES = [
    'hook.mjs',
    'hook-precompact.mjs',
    'scripts/user-prompt-search.js',
    'scripts/pre-tool-recall.js',
    'scripts/post-tool-recall.js',
    'scripts/pre-agent-inject.js',
  ];

  for (const rel of ENTRIES) {
    it(`${rel} has no raw process.stdout.write`, () => {
      const p = join(REPO, rel);
      expect(existsSync(p)).toBe(true);
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      expect(code).not.toMatch(/process\.stdout\.write\(/);
    });
  }
});
