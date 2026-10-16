// A filter flag a MUTATING command does not read was reported after the write ("the results
// above are UNFILTERED"), by which point `compress --execute --type change` had compressed every
// type and `maintain execute --type change` had decayed and hidden every type; `optimize --run
// --type bugfix` said nothing at all (E2E 2026-10-16, cli F3). A mutating run now refuses before
// it writes; a preview keeps the after-the-fact notice.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
let root, env, cwd;
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf8' });
const db = () => new Database(join(root, 'data', 'claude-mem-lite.db'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-mut-filter-'));
  cwd = join(root, 'w', 'p');
  mkdirSync(cwd, { recursive: true });
  env = {
    ...process.env,
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_PROJECT_DIR: cwd,
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_CODE_PATH: join(root, 'no-claude'),
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  for (const t of [
    'Tidied the stale feature flag list',
    'Archived the legacy migration notes',
    'Dropped an unused gradle task',
  ])
    expect(cli('save', t, '--type', 'discovery', '--importance', '1').status).toBe(0);
  const h = db();
  const old = Date.now() - 60 * 86400000;
  h.prepare('UPDATE observations SET created_at_epoch = ?, created_at = ?').run(
    old,
    new Date(old).toISOString(),
  );
  h.close();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const liveCount = () => {
  const h = db();
  try {
    return h.prepare('SELECT COUNT(*) c FROM observations WHERE COALESCE(compressed_into, 0) = 0').get().c;
  } finally {
    h.close();
  }
};

describe('mutating commands refuse a filter flag they do not read', () => {
  it('compress --execute --type change changes nothing and exits 1', () => {
    const r = cli('compress', '--execute', '--type', 'change');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--type/);
    expect(r.stderr).toMatch(/nothing was changed/);
    expect(liveCount()).toBe(3);
  });

  it('maintain execute --type change changes nothing and exits 1', () => {
    const r = cli('maintain', 'execute', '--type', 'change');
    expect(r.status).toBe(1);
    expect(liveCount()).toBe(3);
  });

  it('optimize --run --type bugfix is refused', () => {
    const r = cli('optimize', '--run', '--type', 'bugfix');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--type/);
  });

  it('a preview with the same flag still runs (and still gets the notice)', () => {
    const r = cli('compress', '--type', 'change');
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/--type was ignored/);
  });

  it('a flag the command reads is fine', () => {
    expect(cli('maintain', 'execute', '--project', 'w--p').status).toBe(0);
  });
});
