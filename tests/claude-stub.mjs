// A `claude` for tests that run `install.mjs install`, kept free of the store and its imports.
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * PATH with a `claude` that exits 0 in front. Install registers its MCP server with
 * `claude mcp add` and exits 3 when that fails, so a test running it failed on a machine without
 * Claude Code (v6.28.0's Release validate on the GitHub runner, 2026-10-17: "spawnSync claude
 * ENOENT") and ran the real CLI on one with it.
 * @param {string} root a temp directory the test owns
 * @returns {string}
 */
export function pathWithClaudeStub(root) {
  const dir = join(root, 'claude-stub-bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return `${dir}${delimiter}${process.env.PATH}`;
}
