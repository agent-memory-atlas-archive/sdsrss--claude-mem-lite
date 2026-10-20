// D#462: a plugin install puts no `claude-mem-lite` on PATH, so a hint that prints the bare name
// hands the user, or the model relaying it, a command that is not found.
// Every shipped module names the CLI by path (CLI_INVOKE, cli-path.mjs) or through npx.
//
// Population: walkShipped, every shipped .mjs/.js, comments removed. The four bash hooks under
// scripts/ are outside it (CLAUDE.md, "A sweep is only as wide as its population").

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { walkShipped, relShipped, sourceWithoutComments } from './shipped-tree.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every command cli.mjs dispatches, read from its source: cli.mjs runs on import.
function cliCommands() {
  const src = readFileSync(join(REPO, 'cli.mjs'), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/(?:CLI_COMMANDS|INSTALL_COMMANDS) = new Set\(\[([\s\S]*?)\]\)/g))
    for (const w of m[1].matchAll(/'([a-z-]+)'/g)) out.add(w[1]);
  return out;
}

// adopt-content.mjs writes `${CLI} <cmd>` on purpose, under a header that maps the name to the
// absolute path in the MCP instructions (audit R7 P2-1). install.mjs prints each command's own
// heading as a line `\nclaude-mem-lite <command>…\n`, which is a title, not a hint.
const ALLOWED_FILE = 'adopt-content.mjs';
const HEADING = { file: 'install.mjs', re: /console\.log\(['`]\\nclaude-mem-lite / };

// A `\n` or `\t` escape in the source starts a word too: `'…\nclaude-mem-lite doctor'` is a hint
// on a line of its own (v6.30.0 pre-tag defects review P3-7).
const bareRe = (cmds) =>
  new RegExp(`(?:(?<=\\\\[nt])|(?<![\\w/.-]))(?<!npx )claude-mem-lite (?:${[...cmds].join('|')})(?![\\w-])`);

function bareHits() {
  const cmds = cliCommands();
  const re = bareRe(cmds);
  const hits = [];
  for (const file of walkShipped()) {
    const rel = relShipped(file);
    if (rel === ALLOWED_FILE) continue;
    for (const line of sourceWithoutComments(file).split('\n')) {
      if (!re.test(line)) continue;
      if (rel === HEADING.file && HEADING.re.test(line)) continue;
      hits.push(`${rel}: ${line.trim().slice(0, 140)}`);
    }
  }
  return { cmds, hits };
}

describe('shipped hints name the CLI by path, not by a bare name a plugin install lacks', () => {
  it('premise: the command list was read', () => {
    const { cmds } = bareHits();
    expect(cmds.has('adopt')).toBe(true);
    expect(cmds.has('doctor')).toBe(true);
    expect(cmds.size).toBeGreaterThan(20);
  });

  it('no shipped module prints `claude-mem-lite <command>`', () => {
    expect(bareHits().hits).toEqual([]);
  });

  it('the pattern reads a name after a `\\n` escape, and the heading rule is live', () => {
    const re = bareRe(cliCommands());
    expect(re.test("fail('[mem] failed.\\nclaude-mem-lite doctor fixes it')")).toBe(true);
    expect(HEADING.re.test("fail('[mem] failed.\\nclaude-mem-lite doctor fixes it')")).toBe(false);
    expect(re.test('run `claude-mem-lite doctor`')).toBe(true);
    expect(re.test('npx claude-mem-lite doctor')).toBe(false);
    expect(re.test('/x/claude-mem-lite doctor')).toBe(false);
    const headings = readFileSync(join(REPO, HEADING.file), 'utf8')
      .split('\n')
      .filter((l) => re.test(l) && HEADING.re.test(l));
    expect(headings.length, 'the heading rule no longer lets anything through').toBeGreaterThan(0);
  });

  // The slash commands are read by the model, which runs what they name (v6.30.0 pre-tag claims
  // review P2-7); they spell the CLI `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs"`.
  it('no slash command names `claude-mem-lite <command>`', () => {
    const re = bareRe(cliCommands());
    const dir = join(REPO, 'commands');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length, 'premise: the commands were read').toBeGreaterThan(5);
    const hits = files.flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .map((line, i) => (re.test(line) ? `commands/${f}:${i + 1}` : null))
        .filter(Boolean),
    );
    expect(hits).toEqual([]);
  });
});
