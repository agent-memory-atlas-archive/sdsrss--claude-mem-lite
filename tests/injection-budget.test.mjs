// benchmark/injection-budget.mjs — bytes per face and line class, over a frozen corpus.
//
// The two self-checks are driven with synthetic inputs until they FAIL (a guard nobody has
// watched fire is not known to work), and one subprocess run over a hand-built transcript
// root pins the population rule, the record cut, the accounting and --freeze's round trip.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertClassesSumToText,
  assertHookTableCoversShippedWiring,
  classifyLines,
  cutLines,
  isEcho,
  memFaceOf,
  sessionVerdict,
  triggerKind,
  visibleText,
} from '../benchmark/injection-budget.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'injection-budget.mjs');

describe('hook table vs the shipped wiring', () => {
  it('passes on hooks/hooks.json as shipped', () => {
    expect(() => assertHookTableCoversShippedWiring()).not.toThrow();
  });

  it('THROWS when a shipped hook maps to no face', () => {
    const hooks = {
      hooks: { PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/brand-new.js"' }] }] },
    };
    expect(() => assertHookTableCoversShippedWiring(hooks)).toThrow(/brand-new\.js.* → 0 faces/);
  });

  it('THROWS when one hook maps to two faces', () => {
    const hooks = { hooks: { Stop: [{ hooks: [{ command: 'node hook.mjs stop' }] }] } };
    const table = [
      { face: 'a', event: 'Stop', mark: 'hook.mjs' },
      { face: 'b', event: 'Stop', mark: 'stop' },
    ];
    expect(() => assertHookTableCoversShippedWiring(hooks, table)).toThrow(/2 faces/);
  });

  it('keeps the two UserPromptSubmit legs apart, quoted or not', () => {
    expect(memFaceOf('UserPromptSubmit', 'node "/x/scripts/hook-launcher.mjs" hook.mjs user-prompt')).toBe(
      'ups_context',
    );
    expect(
      memFaceOf('UserPromptSubmit', 'node "/x/scripts/hook-launcher.mjs" scripts/user-prompt-search.js'),
    ).toBe('ups_search');
    expect(memFaceOf('PreToolUse', 'bash "/x/scripts/pre-tool-recall-bash.sh"')).toBe('pretool');
    expect(memFaceOf('PostToolUse', 'node "/x/scripts/post-grep-inject.js"')).toBeNull();
  });
});

describe('line accounting', () => {
  const block = [
    '[mem] PreToolUse recall — system-injected context, continue your planned action:',
    '[mem] 📄 big.mjs ~12k tok · a header comment',
    '[mem] Lessons for big.mjs:',
    '  #42 [bugfix] first line of a lesson',
    'that wrapped onto a second line',
    '  E#7 [decision] an event lesson',
    '[mem] ⚠ Before this edit: apply each lesson to this edit or rule it out.',
  ].join('\n');

  it('classifies each line, and a wrapped lesson body inherits its row', () => {
    expect(classifyLines('pretool', block).map((c) => c.cls)).toEqual([
      'header',
      'file_info',
      'lessons_for',
      'lesson_row',
      'lesson_row',
      'lesson_row',
      'edit_directive',
    ]);
  });

  it('names every <claude-mem-context> section by its own heading', () => {
    const ss =
      '<claude-mem-context>\n### Last Session\nRequest: x\n\n### Recent (2026-10-16)\n| #1 | 01:00 | 🔴 | t |\n</claude-mem-context>';
    const cls = classifyLines('session_start', ss).map((c) => c.cls);
    expect(cls).toEqual([
      'ctx_tag',
      'ctx:last_session',
      'ctx:last_session',
      'blank',
      'ctx:recent',
      'ctx:recent',
      'ctx_tag',
    ]);
  });

  it('sums to the block exactly, multibyte included', () => {
    expect(() => assertClassesSumToText('pretool', block)).not.toThrow();
    const total = classifyLines('pretool', block).reduce((a, c) => a + c.bytes, 0);
    expect(total).toBe(Buffer.byteLength(block));
  });

  it('THROWS when the classes do not sum to the block', () => {
    const lost = classifyLines('pretool', block).slice(1);
    expect(() => assertClassesSumToText('pretool', block, lost)).toThrow(/classes sum to/);
  });
});

describe('corpus rules', () => {
  const until = Date.parse('2026-10-16T00:00:00Z');

  it('cuts records stamped at or after --until and keeps unstamped ones', () => {
    const raw = [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-15T23:59:59Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-16T00:00:00Z' }),
      '{"partial',
    ].join('\n');
    expect(cutLines(raw, until).map((k) => k.entry.timestamp ?? 'none')).toEqual([
      'none',
      '2026-10-15T23:59:59Z',
    ]);
  });

  it('admits only interactive cli sessions that start inside the window', () => {
    const prompt = (ts, extra = {}) => ({
      type: 'user',
      timestamp: ts,
      entrypoint: 'cli',
      message: { content: 'hi' },
      ...extra,
    });
    const since = Date.parse('2026-09-30T00:00:00Z');
    expect(sessionVerdict([prompt('2026-10-01T00:00:00Z')], since, until).ok).toBe(true);
    expect(sessionVerdict([prompt('2026-09-29T00:00:00Z')], since, until).ok).toBe(false);
    expect(sessionVerdict([prompt('2026-10-01T00:00:00Z', { entrypoint: 'sdk-cli' })], since, until).ok).toBe(
      false,
    );
    expect(sessionVerdict([prompt('2026-10-01T00:00:00Z', { isMeta: true })], since, until).ok).toBe(false);
  });
});

describe('value-proxy helpers', () => {
  it('reads model-visible text, keeping systemMessage and updatedInput apart', () => {
    const j = {
      systemMessage: 'shown to the user',
      hookSpecificOutput: { additionalContext: 'ctx', updatedInput: { prompt: 'p' } },
    };
    expect(visibleText({ stdout: JSON.stringify(j) })).toEqual({
      text: 'ctx',
      system: 'shown to the user',
      updatedPrompt: 'p',
    });
    expect(visibleText({ stdout: 'plain' })).toEqual({ text: 'plain', system: '', updatedPrompt: null });
  });

  it('tells a partial read from a full one', () => {
    expect(triggerKind({ name: 'Read', input: { file_path: '/a' } })).toBe('read_full');
    expect(triggerKind({ name: 'Read', input: { file_path: '/a', offset: 10 } })).toBe('read_partial');
    expect(triggerKind({ name: 'Bash', input: { command: "sed -n '1,40p' a.mjs" } })).toBe('bash_partial');
    expect(triggerKind({ name: 'Bash', input: { command: 'cat a.mjs' } })).toBe('bash_full');
  });

  it('calls a truncated past question an echo only when one text starts the other', () => {
    expect(
      isEcho(
        '发版 v6.23.3，删除 ~/.cache/tmp 里 156 个旧临时目录…',
        '发版 v6.23.3，删除 ~/.cache/tmp 里 156 个旧临时目录（约 475MB）',
      ),
    ).toBe(true);
    expect(isEcho('按你的建议执行，继续完成剩余工作', '按你的建议实施')).toBe(false);
  });
});

describe('end to end over a hand-built root', () => {
  let root;
  let frozen;
  const hook = (event, command, stdout, ts) => ({
    type: 'attachment',
    timestamp: ts,
    entrypoint: 'cli',
    attachment: { type: 'hook_success', hookEvent: event, command, stdout },
  });
  const pre = (ctx) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'inj-budget-'));
    frozen = join(root, '..', `${root.split('/').pop()}-frozen`);
    mkdirSync(join(root, 'proj'), { recursive: true });
    const lines = [
      { type: 'user', timestamp: '2026-10-01T00:00:00Z', entrypoint: 'cli', message: { content: 'do it' } },
      hook(
        'PreToolUse',
        'bash "/p/scripts/pre-tool-recall-bash.sh"',
        pre('[mem] PreToolUse recall — x:\n[mem] 📄 a.mjs ~2k tok'),
        '2026-10-01T00:00:01Z',
      ),
      hook(
        'PostToolUse',
        'node "/p/scripts/post-grep-inject.js"',
        pre('other plugin'),
        '2026-10-01T00:00:02Z',
      ),
      // after --until: must not count
      hook(
        'PreToolUse',
        'bash "/p/scripts/pre-tool-recall-bash.sh"',
        pre('[mem] 📄 late.mjs ~9k tok'),
        '2026-10-20T00:00:00Z',
      ),
    ];
    writeFileSync(join(root, 'proj', 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // a headless session: same content, no human prompt → outside the population
    writeFileSync(join(root, 'proj', 's2.jsonl'), JSON.stringify(lines[1]) + '\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(frozen, { recursive: true, force: true });
  });

  const run = (env, args) =>
    JSON.parse(
      execFileSync('node', [SCRIPT, ...args, '--json'], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      }),
    );

  it('counts only the population and only records before --until', () => {
    const r = run({ CLAUDE_MEM_TRANSCRIPT_ROOT: root }, ['--since', '2026-09-30', '--until', '2026-10-16']);
    expect(r.meta.sessions).toBe(1);
    const want = Buffer.byteLength('[mem] PreToolUse recall — x:\n[mem] 📄 a.mjs ~2k tok');
    expect(r.faces.pretool.bytes).toBe(want);
    expect(r.faces.pretool.classes.header.lines).toBe(1);
    expect(r.faces.pretool.classes.file_info.lines).toBe(1);
    expect(Object.values(r.others)[0].bytes).toBe(Buffer.byteLength('other plugin'));
  });

  it('--freeze writes a root that reads back to the same numbers', () => {
    const live = run({ CLAUDE_MEM_TRANSCRIPT_ROOT: root }, [
      '--since',
      '2026-09-30',
      '--until',
      '2026-10-16',
      '--freeze',
      frozen,
    ]);
    const man = JSON.parse(readFileSync(join(frozen, 'MANIFEST.json'), 'utf8'));
    expect(man.sessions).toBe(1);
    expect(existsSync(join(frozen, 'proj', 's2.jsonl'))).toBe(false);
    const again = run({ CLAUDE_MEM_TRANSCRIPT_ROOT: frozen }, []);
    expect(again.faces).toEqual(live.faces);
    expect(again.others).toEqual(live.others);
  });
});
