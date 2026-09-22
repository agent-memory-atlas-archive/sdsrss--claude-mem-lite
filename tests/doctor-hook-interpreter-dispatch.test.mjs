// The DISPATCH, which is the half `resolveBashHookCount`'s own tests never covered.
// That helper was already exported and already unit-tested; what had no unit coverage was
// the code that turns its {count, source, scripts} plus a bash probe into doctor's ok/⚠
// lines — and that is exactly where the pre-ship review found P1-1 (a green
// "no hook command needs bash" printed on a shape where two were registered).
//
// It had no coverage for a structural reason, not an oversight: it shelled out to `bash`,
// so one of its four outcomes needs a machine without bash. tests/doctor-bash-hooks.test.mjs
// buys that one by spawning doctor with an emptied PATH, which works and is slow and can only
// assert on the rendered report. Injecting the probe makes all four reachable in-process.
// Both are kept: the E2E proves the wiring, these prove the branches.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHookInterpreter } from '../lib/doctor-hook-interpreter.mjs';

// Stands in for doctor's shadowed helpers, recording level the way `checks` does.
function recorder() {
  const lines = [];
  return {
    lines,
    report: {
      ok: (m) => lines.push({ level: 'ok', message: m }),
      dwarn: (m) => lines.push({ level: 'warn', message: m }),
    },
  };
}

const INSTALL_DIR = '/home/u/.claude-mem-lite';
const SETTINGS_PATH = '/home/u/.claude/settings.json';

function ctx(over = {}) {
  return {
    manifestPath: join(tmpdir(), 'doctor-hi-absent', 'hooks.json'),
    settingsPath: SETTINGS_PATH,
    settingsCommands: [],
    installDir: INSTALL_DIR,
    bashPresent: () => true,
    ...over,
  };
}

describe('checkHookInterpreter — every outcome reports exactly once', () => {
  it('says so, at ⚠, when NEITHER registration can be read', () => {
    // The P1-1 shape. `count: null` is the absence of an answer, and the thing that must
    // not happen here is a ✓ — a green line ends the reader's search.
    const { lines, report } = recorder();
    checkHookInterpreter(report, ctx());
    expect(lines).toHaveLength(1);
    expect(lines[0].level, 'an unreadable registration was reported as fine').toBe('warn');
    expect(lines[0].message).toContain('could not read either hook registration');
    // Both paths named, because "I could not look" is only actionable if it says where.
    expect(lines[0].message).toContain(SETTINGS_PATH);
    expect(lines[0].message).not.toMatch(/no hook command needs bash/);
  });

  it('reports ✓ and names the source when zero commands need bash', () => {
    const { lines, report } = recorder();
    // An entry of ours that is NOT a bash command: readable registration, count 0.
    checkHookInterpreter(report, ctx({ settingsCommands: [`node "${INSTALL_DIR}/hook.mjs"`] }));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('ok');
    expect(lines[0].message).toBe('Hook interpreter: no hook command needs bash (per the settings)');
  });

  it('reports ✓ with the count when bash is present and needed', () => {
    const { lines, report } = recorder();
    checkHookInterpreter(
      report,
      ctx({
        settingsCommands: [`bash "${INSTALL_DIR}/scripts/post-tool-use.sh"`],
        bashPresent: () => true,
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('ok');
    expect(lines[0].message).toBe('Hook interpreter: bash present (1 hook command(s) need it)');
  });

  it('warns, naming the scripts and bounding the damage, when bash is needed and absent', () => {
    const { lines, report } = recorder();
    checkHookInterpreter(
      report,
      ctx({
        settingsCommands: [
          `bash "${INSTALL_DIR}/scripts/post-tool-use.sh"`,
          `bash "${INSTALL_DIR}/scripts/agent-prefilter.sh"`,
        ],
        bashPresent: () => false,
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    const m = lines[0].message;
    expect(m).toContain('2 hook command(s)');
    // NAMED from the live registration. The first cut described them from memory and
    // glossed a count of three as two items (P3-1), so the names are asserted, not the shape.
    expect(m).toContain('post-tool-use.sh');
    expect(m).toContain('agent-prefilter.sh');
    // The bound, so the reader does not conclude the whole plugin is dead.
    expect(m).toContain('MCP server');
    expect(m).toMatch(/Git for Windows|WSL/);
  });

  it('is advisory in every branch — nothing here reports at fail severity', () => {
    // doctor's exit code derives from `level`, and this check is explicitly not an issue:
    // an install whose MCP server and node hooks are fine is not broken.
    for (const over of [
      {},
      { settingsCommands: [`node "${INSTALL_DIR}/hook.mjs"`] },
      { settingsCommands: [`bash "${INSTALL_DIR}/s.sh"`], bashPresent: () => false },
    ]) {
      const { lines, report } = recorder();
      checkHookInterpreter(report, ctx(over));
      expect(
        lines.every((l) => l.level !== 'fail'),
        JSON.stringify(lines),
      ).toBe(true);
    }
  });

  it('degrades to a ⚠ instead of throwing when the probe itself blows up', () => {
    // The outer catch. It had no case at all: a throwing probe is not something the E2E
    // can arrange, and an uncaught throw here would take down every check after it.
    const { lines, report } = recorder();
    checkHookInterpreter(
      report,
      ctx({
        settingsCommands: [`bash "${INSTALL_DIR}/s.sh"`],
        bashPresent: () => {
          throw new Error('spawn EPERM');
        },
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].message).toBe('Hook interpreter: check failed — spawn EPERM');
  });

  it('counts only commands that INVOKE bash, not ones whose path merely contains it', () => {
    // Kills the mutant `startsWith('bash ')` -> `includes('bash')`, which survived the whole
    // doctor suite. This repo ships a root module literally named `bash-utils.mjs`, so a
    // future hook command naming it would be miscounted and nothing would go red.
    const { lines, report } = recorder();
    checkHookInterpreter(
      report,
      ctx({ settingsCommands: [`node "${INSTALL_DIR}/bash-utils.mjs"`], bashPresent: () => true }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].message, 'a node command was counted as needing bash').toBe(
      'Hook interpreter: no hook command needs bash (per the settings)',
    );
  });

  it('applies that same rule on the MANIFEST side, which is a separate call site', () => {
    // Per-site mutation, not per-predicate: the same `startsWith('bash ')` test appears twice
    // in resolveBashHookCount, and the settings-side case above leaves the manifest-side one
    // alive. One mutation covering N sites proves nothing about any one of them.
    const dir = mkdtempSync(join(tmpdir(), 'doctor-hi-bashname-'));
    try {
      const manifestPath = join(dir, 'hooks.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'node "$DIR/bash-utils.mjs"' }] }] } }),
      );
      const { lines, report } = recorder();
      checkHookInterpreter(report, ctx({ manifestPath, bashPresent: () => true }));
      expect(lines[0].message, 'a node command in the manifest was counted as needing bash').toBe(
        'Hook interpreter: no hook command needs bash (per the manifest)',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the manifest when it is present, and falls through when it is torn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-hi-manifest-'));
    try {
      const manifestPath = join(dir, 'hooks.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          hooks: { PostToolUse: [{ hooks: [{ command: 'bash "$DIR/scripts/post-tool-use.sh"' }] }] },
        }),
      );
      const a = recorder();
      checkHookInterpreter(a.report, ctx({ manifestPath, bashPresent: () => true }));
      expect(a.lines[0].message).toBe('Hook interpreter: bash present (1 hook command(s) need it)');

      // A torn manifest is not evidence of zero bash hooks: it must fall through to
      // settings.json rather than report a confident 0.
      writeFileSync(manifestPath, '{ not json');
      const b = recorder();
      checkHookInterpreter(
        b.report,
        ctx({ manifestPath, settingsCommands: [`bash "${INSTALL_DIR}/s.sh"`], bashPresent: () => true }),
      );
      expect(b.lines[0].message).toBe('Hook interpreter: bash present (1 hook command(s) need it)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
