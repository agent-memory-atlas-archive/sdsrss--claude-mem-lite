// The plugin switched off in Claude Code: hook.mjs exited, but the recall scripts behind the
// same launcher (user-prompt-search, pre-tool-recall, post-tool-recall, pre-agent-inject) kept
// injecting memory through the direct settings.json hook set (E2E 2026-10-16, hooks F8). The
// launcher now stops every Node hook entry for a disabled plugin, with hook.mjs's fail-open.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { PLUGIN_KEY } from '../lib/plugin-key.mjs';

const REPO = resolve(import.meta.dirname, '..');
const LAUNCHER = join(REPO, 'scripts', 'hook-launcher.mjs');
let root, home, proj, fp, env;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-launcher-off-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  proj = join(root, 'parent', 'app');
  mkdirSync(proj, { recursive: true });
  fp = join(proj, 'invoice.js');
  writeFileSync(fp, 'export const x = 1;\n');
  const db = new Database(join(root, 'claude-mem-lite.db'));
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 's', project: 'parent--app', memoryId: 'm' });
  insertObs(db, {
    sessionId: 'm',
    project: 'parent--app',
    type: 'bugfix',
    importance: 2,
    title: 'applyDiscount leaked fractional cents',
    lessonLearned: 'Money math in cents must Math.round after percentage ops',
    filesModified: `["${fp}"]`,
  });
  db.close();
  env = {
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: root,
    CLAUDE_PROJECT_DIR: proj,
    CLAUDE_MEM_HOOK_RUNNING: '',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_PID;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pretool = () =>
  spawnSync(process.execPath, [LAUNCHER, 'scripts/pre-tool-recall.js'], {
    input: JSON.stringify({
      tool_name: 'Read',
      session_id: `s-${Math.random()}`,
      tool_input: { file_path: fp },
    }),
    env,
    encoding: 'utf8',
  });

const settings = (obj) => writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(obj));

describe('the hook launcher honours a disabled plugin', () => {
  it('premise: with the plugin enabled the recall script injects the lesson', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: true } });
    expect(pretool().stdout).toContain('Math.round after percentage ops');
  });

  it('disabled: nothing is injected and nothing is written', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: false } });
    const r = pretool();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('follows an absolute CLAUDE_CONFIG_DIR, like lib/data-paths.mjs claudeConfigDir', () => {
    const other = join(root, 'profile');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_KEY]: false } }));
    settings({ enabledPlugins: { [PLUGIN_KEY]: true } }); // the default home says enabled
    env.CLAUDE_CONFIG_DIR = other;
    expect(pretool().stdout).toBe('');
    env.CLAUDE_CONFIG_DIR = 'relative/profile'; // ignored, as claudeConfigDir ignores it
    expect(pretool().stdout).toContain('Math.round');
  });

  it('an unparseable settings.json fails open', () => {
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    expect(pretool().stdout).toContain('Math.round');
  });

  it('the launcher spells the same key as lib/plugin-key.mjs', () => {
    expect(readFileSync(LAUNCHER, 'utf8')).toContain(`'${PLUGIN_KEY}'`);
  });
});
