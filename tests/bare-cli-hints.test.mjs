// D#462: a plugin install puts no `claude-mem-lite` on PATH (only `npm i -g` does), so a hint that
// prints the bare name hands the user, or the model relaying it, a command that is not found.
// Every shipped module names the CLI by path (CLI_INVOKE, cli-path.mjs) or through npx.
//
// Population: walkShipped, every shipped .mjs/.js, comments removed. The four bash hooks under
// scripts/ are outside it (CLAUDE.md, "A sweep is only as wide as its population").

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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
// absolute path in the MCP instructions (audit R7 P2-1). The two install.mjs lines are headings.
const ALLOWED = [
  ['adopt-content.mjs', null],
  ['install.mjs', "console.log('\\nclaude-mem-lite doctor\\n')"],
  ['install.mjs', "console.log('\\nclaude-mem-lite self-update\\n')"],
];

function bareHits() {
  const cmds = cliCommands();
  const re = new RegExp(`(?<![\\w/.-])(?<!npx )claude-mem-lite (?:${[...cmds].join('|')})(?![\\w-])`);
  const hits = [];
  for (const file of walkShipped()) {
    const rel = relShipped(file);
    if (ALLOWED.some(([f, line]) => f === rel && line === null)) continue;
    for (const line of sourceWithoutComments(file).split('\n')) {
      if (!re.test(line)) continue;
      if (ALLOWED.some(([f, l]) => f === rel && l !== null && line.includes(l))) continue;
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
});
