// The 2026-10-17 prompt audit of commands/*.md. These files are prompts: the model reads them
// and does what they say, so each finding is a behaviour. B1 and B2 take their rule from the
// code the prompt has to agree with (the hidden tool set, the plugin name); B2's built-in check
// reads a hand-kept copy of Claude Code's command table; B3 and B5 are text patterns and catch
// only the spelling they name. B4 (an undefined term) has no guard.

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

  // D#454: typed bare, a name Claude Code also uses runs Claude Code's command — `/bug` opens
  // its bug report to Anthropic. The names and aliases of the command table at
  // code.claude.com/docs/en/commands, read 2026-10-19. Hand-kept: a built-in added later is
  // missed until it is added here.
  const BUILTIN = new Set(
    `add-dir advisor agents artifact-capabilities artifact-diagramming artifacts auto-mode-setup
    autocompact autofix-pr background batch branch btw bug cd chrome claude-api claude-in-chrome
    clear code-review color compact config context copy cost dataviz debug deep-research design
    design-login design-sync desktop diff doctor effort exit export fast feedback
    fewer-permission-prompts focus fork goal heapdump help hooks ide import init insights
    install-github-app install-slack-app keybindings list-agents login logout loop mcp memory mobile
    model output-style passes permissions plan plugin plugin-authoring powerup pr-comments
    privacy-settings radio rate-limit-options recap release-notes reload-plugins reload-skills
    remote-control remote-env rename resume review rewind run run-skill-generator sandbox schedule
    scroll-speed security-review setup-bedrock setup-vertex simplify skill-doctor skills slides
    stats status statusline stickers stop subtask tasks team-onboarding teleport terminal-setup
    theme tui ultraplan ultrareview update-config upgrade usage usage-credits verify vim voice
    web-setup workflow-authoring workflows
    allowed-tools android app bg checkpoint checkup continue ios new proactive quit rc reset
    routines settings share undo`.split(/\s+/),
  );
  const clashing = [...names].filter((n) => BUILTIN.has(n));

  it('premise: some of this plugin’s command names are Claude Code’s too', () => {
    expect(clashing).toEqual(expect.arrayContaining(['bug', 'memory']));
  });

  it('a command whose name Claude Code also uses is written with the plugin namespace', () => {
    const bare = COMMANDS.flatMap((f) =>
      [...read(f).matchAll(/(?<![\w/:.${}-])\/([a-z][a-z0-9-]*)(?![a-z0-9-])/g)]
        .filter((m) => clashing.includes(m[1]))
        .map((m) => `commands/${f}: ${m[0]} → /${plugin}:${m[1]}`),
    );
    expect(bare, 'these run the Claude Code command, not this plugin’s').toEqual([]);
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

describe('/update is started by a person, not by the model', () => {
  // /update applies cleanup (a hard delete), decay, boost, dedup and `compress --execute` across
  // every project without asking, and that compress folds explicit saves, which
  // lib/compress-core.mjs leaves to "a person running compress" (the daily worker skips them).
  // Claude Code lets the model start a command on its own unless its frontmatter sets
  // `disable-model-invocation: true` (code.claude.com/docs/en/slash-commands).
  it('commands/update.md sets disable-model-invocation: true', () => {
    const front = read('update.md').match(/^---\n([\s\S]*?)\n---\n/);
    expect(front, 'commands/update.md lost its frontmatter').not.toBeNull();
    expect(front[1]).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });
});
