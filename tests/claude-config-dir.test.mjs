// CLAUDE_CONFIG_DIR moves Claude Code's whole config home — `projects/<dir>/memory`, and the
// `.claude.json` state file with it (verified 2026-09-29 on Claude Code 2.1.284: a session
// run with CLAUDE_CONFIG_DIR=<d> wrote <d>/.claude.json and <d>/projects/). The plugin hard-coded
// ~/.claude in four read paths, so for such a user `adopt --disable` wrote its sentinel where
// the host never looks, and `adopt --status` / `unadopt --all` / `memdir-audit --all` scanned
// the wrong projects. lib/bash-file-targets.mjs already followed the variable.

import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { claudeConfigDir, claudeStatePath } from '../lib/data-paths.mjs';
import { memdirPath } from '../memdir.mjs';
import { readProjectTasks } from '../lib/task-reader.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const saved = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

describe('the host config home follows CLAUDE_CONFIG_DIR', () => {
  it('defaults to ~/.claude and ~/.claude.json', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
    expect(claudeStatePath()).toBe(join(homedir(), '.claude.json'));
  });

  it('moves both under CLAUDE_CONFIG_DIR, read at call time', () => {
    process.env.CLAUDE_CONFIG_DIR = '/srv/cc';
    expect(claudeConfigDir()).toBe('/srv/cc');
    expect(claudeStatePath()).toBe('/srv/cc/.claude.json');
  });

  it('ignores a relative value rather than resolving it against an arbitrary cwd', () => {
    process.env.CLAUDE_CONFIG_DIR = 'relative/dir';
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
  });

  it('memdirPath lands in the moved projects dir', () => {
    process.env.CLAUDE_CONFIG_DIR = '/srv/cc';
    expect(memdirPath('/work/app')).toBe('/srv/cc/projects/-work-app/memory');
  });

  it('the task reader looks under the moved config home', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'cml-cfgdir-'));
    try {
      mkdirSync(join(cfg, 'tasks', 'list-1'), { recursive: true });
      writeFileSync(
        join(cfg, 'tasks', 'list-1', '1.json'),
        JSON.stringify({ id: '1', subject: 'probe task', status: 'pending' }),
      );
      process.env.CLAUDE_CONFIG_DIR = cfg;
      expect(readProjectTasks().map((t) => t.title)).toEqual(['probe task']);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
