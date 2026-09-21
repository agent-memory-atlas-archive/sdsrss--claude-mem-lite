// key_files accepted DIRECTORIES and rejected bare filenames.
//
// The filter required a path separator (`f.includes('/') && f.indexOf('/', 1) !== -1`),
// which asks "does this look like a path" — not "does this look like a FILE". Two costs,
// both measured on the live DB 2026-09-21 over every non-null files_modified row (218
// entries): 59 of them (27%) are repo-root filenames like `hook.mjs` and were dropped on
// the floor, and 3 are extensionless slash-bearing values — directories — which sailed
// through and rendered as key files. That is where `Key Files: claude-mem-lite` in a real
// injection came from — though from the EPISODE BUFFER arm of key_files, not from
// files_modified: no entry in that column equals a project directory. The three
// extensionless slash-bearing values it does hold are one executable and two /var/tmp
// scratch dirs. Corrected by the pre-ship claims lens; isValidFile gates both arms, so the
// predicate under test covers the real source too.
//
// The replacement asks the basename for an extension. Named cost: an extensionless file
// (Makefile, LICENSE) no longer qualifies. The alternative is a hand-drawn list of
// extensionless filenames, which is the shape this repo has rejected three times — a
// hand-drawn class keeps rejecting real cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

beforeEach(() => {
  vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
    changed: [],
    stashes: [],
    branch: null,
    headSha: null,
  });
  vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PROJECT = 'kf-proj';
const SESSION = 'hook-kf-proj-1234abcd';

function seed(db, files) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(SESSION, SESSION, PROJECT, 1000);
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, 'do the work', 1, datetime('now'), ?)`,
  ).run(SESSION, 1000);
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch)
     VALUES (?, ?, 'change', 'touched some files', 2, ?, NULL, datetime('now'), ?)`,
  ).run(SESSION, PROJECT, JSON.stringify(files), 1100);
}

function keyFilesOf(db) {
  return JSON.parse(db.prepare('SELECT key_files FROM session_handoffs').get().key_files);
}

describe('key_files keeps files and drops directories', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('keeps a repo-root filename that carries no separator', () => {
    seed(db, ['hook.mjs', 'schema.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(expect.arrayContaining(['hook.mjs', 'schema.mjs']));
  });

  it('drops a directory path', () => {
    // The exact value that produced `Key Files: claude-mem-lite` in a real injection.
    seed(db, ['/home/ai/dev/claude-mem-lite', 'lib/handoff-constants.mjs']);
    const files = (buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null), keyFilesOf(db));
    expect(files).toContain('lib/handoff-constants.mjs');
    expect(files).not.toContain('/home/ai/dev/claude-mem-lite');
  });

  it('keeps nested and absolute paths, and dotfiles', () => {
    seed(db, ['lib/data-paths.mjs', '/abs/path/server.mjs', '.env.example', 'a.test.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(
      expect.arrayContaining(['lib/data-paths.mjs', '/abs/path/server.mjs', '.env.example', 'a.test.mjs']),
    );
  });

  it('still excludes the device and scratch trees', () => {
    // These exclusions predate this change and are the reason the filter existed at all.
    seed(db, ['/dev/null', '/proc/self/status', '/tmp/scratch.mjs', 'real.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const files = keyFilesOf(db);
    expect(files).toEqual(['real.mjs']);
  });

  it('drops an extensionless value even when it carries separators', () => {
    seed(db, ['/home/ai/dev/some-project/src', 'kept.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(['kept.mjs']);
  });
});
