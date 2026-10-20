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
// absolute path in the MCP instructions (audit R7 P2-1).
const ALLOWED = ['adopt-content.mjs'];

const bareRe = (cmds) =>
  new RegExp(`(?<![\\w/.-])(?<!npx )claude-mem-lite (?:${[...cmds].join('|')})(?![\\w-])`);

function bareHits() {
  const cmds = cliCommands();
  const re = bareRe(cmds);
  const hits = [];
  for (const file of walkShipped()) {
    const rel = relShipped(file);
    if (ALLOWED.includes(rel)) continue;
    for (const line of sourceWithoutComments(file).split('\n')) {
      if (re.test(line)) hits.push(`${rel}: ${line.trim().slice(0, 140)}`);
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
