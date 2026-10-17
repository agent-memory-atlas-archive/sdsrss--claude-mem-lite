// Pre-tag review 2026-10-16 P3-4 / D#398(3): `save` and `defer add` refuse a --project one or two
// edits from an existing project (checkWriteProject), and the dispatcher leaves `activity save`
// and `import-jsonl` out of its read-side note "to their own write-side check" — which neither
// had. `activity save --project invoice-ap` beside `work--invoice-app` exited 0 and wrote the
// stray project (or, resolving in READ mode, landed in whatever project the fuzzy match guessed);
// `import-jsonl --project invoice-ap` imported under it. Once a stray project has a row,
// checkWriteProject counts it as existing, so the next save under the typo was accepted too.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

let root, dataDir, projectDir;
function cli(...args) {
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: projectDir,
    env,
  });
}
/** Every project id any table holds. */
function projects() {
  const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
  const rows = db
    .prepare(
      `SELECT project FROM observations UNION SELECT project FROM events
       UNION SELECT project FROM sdk_sessions UNION SELECT project FROM deferred_work`,
    )
    .all()
    .map((r) => r.project);
  db.close();
  return rows.sort();
}
function transcript() {
  const file = join(root, 't.jsonl');
  writeFileSync(
    file,
    [
      '{"type":"user","sessionId":"imp-1","timestamp":"2026-10-16T10:00:00.000Z","message":{"role":"user","content":"why does the invoice total drift by a cent"}}',
      '{"type":"assistant","sessionId":"imp-1","timestamp":"2026-10-16T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/p/total.mjs"}}]}}',
      '{"type":"user","sessionId":"imp-1","timestamp":"2026-10-16T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"rounding happens per line"}]}}',
    ].join('\n') + '\n',
  );
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-write-project-'));
  dataDir = join(root, 'data');
  projectDir = join(root, 'work', 'invoice-app');
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  initSchema(db);
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('activity save checks the project it writes to', () => {
  it('a near miss of a project holding an observation is refused, not resolved to it', () => {
    expect(cli('save', 'invoice rounding is per line', '--title', 'rounding').status).toBe(0);
    expect(projects()).toEqual(['work--invoice-app']);
    const r = cli(
      'activity',
      'save',
      '--type',
      'discovery',
      '--title',
      'evt typo',
      '--project',
      'invoice-ap',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did you mean "work--invoice-app"/);
    expect(r.stdout).toBe('');
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    db.close();
    expect(events).toBe(0);
  });

  it('a near miss of a project holding only events is refused, not written as a new project', () => {
    expect(cli('activity', 'save', '--type', 'discovery', '--title', 'seed event').status).toBe(0);
    expect(projects()).toEqual(['work--invoice-app']);
    const r = cli(
      'activity',
      'save',
      '--type',
      'discovery',
      '--title',
      'evt typo',
      '--project',
      'invoice-ap',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did you mean "work--invoice-app"/);
    expect(projects()).toEqual(['work--invoice-app']);
  });

  it('a new name nothing resembles is written, with a note on stderr', () => {
    expect(cli('save', 'invoice rounding is per line', '--title', 'rounding').status).toBe(0);
    const r = cli(
      'activity',
      'save',
      '--type',
      'discovery',
      '--title',
      'billing evt',
      '--project',
      'zebra-billing',
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
    expect(r.stderr).toMatch(/new project "zebra-billing"/);
    expect(projects()).toEqual(['work--invoice-app', 'zebra-billing']);
  });
});

describe('import-jsonl checks the project it writes to', () => {
  it('a near miss of an existing project is refused and imports nothing', () => {
    expect(cli('save', 'invoice rounding is per line', '--title', 'rounding').status).toBe(0);
    const r = cli('import-jsonl', transcript(), '--project', 'invoice-ap');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did you mean "work--invoice-app"/);
    expect(r.stdout).not.toMatch(/\+1 prompts/);
    expect(projects()).toEqual(['work--invoice-app']);
  });

  it('a new name nothing resembles is imported, and says it is a new project', () => {
    expect(cli('save', 'invoice rounding is per line', '--title', 'rounding').status).toBe(0);
    const r = cli('import-jsonl', transcript(), '--project', 'zebra-billing');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\+1 prompts/);
    expect(r.stdout).toMatch(/new project "zebra-billing"/);
    expect(projects()).toEqual(['work--invoice-app', 'zebra-billing']);
  });
});
