// D#36: both pre-tool-recall legs ended their ORDER BY on `created_at_epoch DESC` with no id
// tiebreak. On a same-millisecond tie SQLite returns the rows in ascending rowid, so the
// OLDER memory takes the Read slot (LIMIT 1) the newer one should get. CLAUDE.md spells
// the fix `created_at_epoch DESC, id DESC`.
//
// Measured before the fix (live DB, 2026-09-25T17:01Z): 0/242 observation rows and 0/2670
// event rows share (project, file, epoch) with another row, so this is a correctness pin
// on a rare shape, not a frequent one. These cases build the tie directly.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertObs } from './test-helpers.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pre-tool-recall.js');
const PROJECT = 'parent--testproj';
const FILE = 'lib/tie-target.mjs';

let home;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function setup(seed) {
  home = mkdtempSync(join(tmpdir(), 'cml-ptr-tie-'));
  const projectDir = join(home, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
  const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
  initSchema(db);
  // After initSchema, which turns foreign keys on: the fixture rows have no session row.
  db.pragma('foreign_keys = OFF');
  // Absolute path: the hook matches the edited file's full (scrubbed) path or its basename.
  seed(db, Date.now() - 60_000, join(projectDir, FILE));
  db.close();
  return projectDir;
}

function recallRead(projectDir) {
  const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_MEM_SKIP_UPDATE: '1' };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  delete env.CLAUDE_MEM_DIR;
  const out = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(projectDir, FILE) } }),
    encoding: 'utf8',
    env,
    cwd: projectDir,
    timeout: 15000,
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

describe('pre-tool-recall: a same-millisecond tie goes to the newer memory (D#36)', () => {
  it('events leg', () => {
    const projectDir = setup((db, epoch, abs) => {
      const ins = db.prepare(
        `INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
         VALUES (?, 'lesson', ?, ?, ?, 2, ?)`,
      );
      ins.run(PROJECT, 'OLDER tie lesson', 'older body', JSON.stringify([abs]), epoch);
      ins.run(PROJECT, 'NEWER tie lesson', 'newer body', JSON.stringify([abs]), epoch);
    });
    const ctx = recallRead(projectDir);
    // The events leg prints the body. Before the fix: 'E#1 [lesson] older body'.
    expect(ctx).toContain('newer body');
    expect(ctx).not.toContain('older body');
  });

  it('observations leg', () => {
    const projectDir = setup((db, epoch, abs) => {
      // insertObs's files_modified trigger writes the observation_files edge itself.
      for (const title of ['OLDER tie bugfix', 'NEWER tie bugfix']) {
        const id = Number(
          insertObs(db, {
            project: PROJECT,
            type: 'bugfix',
            title,
            importance: 2,
            lessonLearned: `${title}: the lesson`,
            filesModified: JSON.stringify([abs]),
          }).lastInsertRowid,
        );
        db.prepare('UPDATE observations SET created_at_epoch = ? WHERE id = ?').run(epoch, id);
      }
    });
    const ctx = recallRead(projectDir);
    expect(ctx).toContain('NEWER tie bugfix');
    expect(ctx).not.toContain('OLDER tie bugfix');
  });
});
