// The 2026-10-17 prompt audit of commands/*.md. These files are prompts: the model reads them
// and does what they say, so each finding is a behaviour. B1 and B2 take their rule from the
// code the prompt has to agree with (the hidden tool set, the plugin name); B3 and B5 are text
// patterns and catch only the spelling they name. B4 (an undefined term) has no guard.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tools } from '../tool-schemas.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = readdirSync(join(REPO, 'commands')).filter((f) => f.endsWith('.md'));
const read = (f) => readFileSync(join(REPO, 'commands', f), 'utf8');

describe('B1 — commands name only tools the model can call', () => {
  // server.mjs drops `hidden: true` tools from tools/list (tests/tool-visibility.test.mjs), and
  // Claude Code gives the model only the listed ones, so a command that names a hidden tool sends
  // the model after a tool it does not have. The hidden tools are maintenance and admin tools
  // with CLI equivalents; a command runs those through `cli.mjs`.
  const hidden = tools.filter((t) => t.hidden === true).map((t) => t.name);

  it('premise: some tools are hidden, and every command file is read', () => {
    expect(hidden.length).toBeGreaterThan(0);
    expect(COMMANDS.length).toBeGreaterThanOrEqual(8);
  });

  it('no command names a hidden tool', () => {
    const named = COMMANDS.flatMap((f) =>
      hidden
        // Not `\\b`: `_` is a word character, so `\\bmem_compress` misses the qualified
        // `mcp__plugin_claude-mem-lite_mem-lite__mem_compress`.
        .filter((name) => new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9_])`).test(read(f)))
        .map((name) => `commands/${f}: ${name}`),
    );
    expect(named, 'these commands tell the model to use a tool tools/list does not give it').toEqual([]);
  });
});

describe('B2 — slash-command references use the plugin namespace', () => {
  // A plugin command's namespace is the plugin's name. The full `/<plugin>:<command>` form always
  // resolves; a bare name only while nothing else claims it, and `/memory` is a Claude Code
  // built-in. `/mem:memory` named a namespace that does not exist.
  const plugin = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  const names = new Set(COMMANDS.map((f) => f.replace(/\.md$/, '')));
  const refs = COMMANDS.flatMap((f) =>
    [...read(f).matchAll(/(?<![\w/:.])\/([a-z0-9-]+):([a-z0-9-]+)/g)].map((m) => ({
      f,
      ref: m[0],
      ns: m[1],
      name: m[2],
    })),
  );

  it('premise: the scan finds namespaced references (verify.md has one)', () => {
    expect(refs.some((r) => r.f === 'verify.md' && r.ns === plugin)).toBe(true);
  });

  it('every /namespace:command reference names this plugin and one of its commands', () => {
    const wrong = refs
      .filter((r) => r.ns !== plugin || !names.has(r.name))
      .map((r) => `commands/${r.f}: ${r.ref}`);
    expect(wrong, `references that resolve to no command of plugin "${plugin}"`).toEqual([]);
  });
});

describe('B3 — commands carry no release history', () => {
  // How a command used to work is CHANGELOG material. The model running it needs the rule as it
  // is now, plus the reason when the rule needs one, said in the present tense.
  it('no command cites a release version', () => {
    const cited = COMMANDS.flatMap((f) =>
      [...read(f).matchAll(/\bv\d+\.\d+\S*/g)].map((m) => `commands/${f}: ${m[0]}`),
    );
    expect(cited).toEqual([]);
  });
});

describe('B5 — commands leave the reply language to the user', () => {
  // A locale written into a command tells the model to answer in it whatever language the user
  // writes in or their settings ask for, for every user at once.
  it('no command fixes a locale', () => {
    const fixed = COMMANDS.flatMap((f) =>
      [...read(f).matchAll(/\b[a-z]{2}-[A-Z]{2}\b/g)].map((m) => `commands/${f}: ${m[0]}`),
    );
    expect(fixed).toEqual([]);
  });
});
