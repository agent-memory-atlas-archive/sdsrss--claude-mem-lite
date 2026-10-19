// The 2026-10-17 prompt audit of commands/*.md. These files are prompts: the model reads them
// and does what they say, so each finding is a behaviour. Each guard takes its rule from the
// code the prompt has to agree with, not from a hand-kept word list.

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
        .filter((name) => new RegExp(`\\b${name}\\b`).test(read(f)))
        .map((name) => `commands/${f}: ${name}`),
    );
    expect(named, 'these commands tell the model to use a tool tools/list does not give it').toEqual([]);
  });
});
