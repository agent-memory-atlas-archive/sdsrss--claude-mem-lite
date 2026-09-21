// Tree state in the handoff injection.
//
// `git_sha_at_handoff` has been captured since v25, but only ever as an INPUT to
// detectContinuationIntent's commit anchor — renderHandoffFromRow never emitted it, so a
// resuming session was told what was being worked on and not where the tree stood. The
// first thing a resumed session did was run `git status` / `git rev-parse` to find out.
// readGitState already returns branch and the changed-file list on the call
// buildAndSaveHandoff was making anyway; both are now stored and rendered.
//
// A dirty count of 0 and a dirty count of NULL are different answers — "measured, clean"
// versus "not measured" — and are rendered differently. Collapsing them would turn a
// handoff written outside a git repo into a claim that the tree was clean.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, renderHandoffInjection } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

beforeEach(() => {
  vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function seedSession(db, id, project) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(id, id, project, Date.now());
}

function seedPrompt(db, sessionId, text) {
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, 1, datetime('now'), ?)`,
  ).run(sessionId, text, Date.now());
}

function insertRow(db, { branch = null, dirty = null, sha = null }) {
  db.prepare(
    `INSERT INTO session_handoffs (project, type, session_id, working_on, git_branch, git_dirty_count, git_sha_at_handoff, created_at_epoch)
     VALUES ('p', 'exit', 's1', 'the task', ?, ?, ?, ?)`,
  ).run(branch, dirty, sha, Date.now() - 60000);
}

describe('buildAndSaveHandoff captures branch and dirty count', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedSession(db, 's1', 'mem');
    seedPrompt(db, 's1', 'work on the ranker');
  });
  afterEach(() => {
    db.close();
  });

  it('stores branch and the number of changed files', () => {
    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [' M hook-handoff.mjs', '?? tests/new.test.mjs'],
      stashes: [],
      branch: 'converge/handoff-payload',
      headSha: 'deadbeef1234567',
    });

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db
      .prepare(`SELECT git_branch, git_dirty_count, git_sha_at_handoff FROM session_handoffs`)
      .get();
    expect(row.git_branch).toBe('converge/handoff-payload');
    expect(row.git_dirty_count).toBe(2);
    expect(row.git_sha_at_handoff).toBe('deadbeef1234567');
  });

  it('stores a dirty count of 0 for a clean tree, not NULL', () => {
    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'abc1234567890',
    });

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db.prepare(`SELECT git_dirty_count FROM session_handoffs`).get();
    expect(row.git_dirty_count).toBe(0); // measured and clean — distinct from "not measured"
  });

  it('stores NULL for both on a non-git cwd', () => {
    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: null,
      headSha: null,
    });

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db.prepare(`SELECT git_branch, git_dirty_count FROM session_handoffs`).get();
    expect(row.git_branch).toBeNull();
    expect(row.git_dirty_count).toBeNull();
  });
});

describe('the injection renders tree state', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: null,
      headSha: null,
    });
  });
  afterEach(() => {
    db.close();
  });

  it('names the branch, the short sha and the dirty count', () => {
    insertRow(db, { branch: 'converge/handoff-payload', dirty: 3, sha: 'deadbeef1234567' });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toContain('## Tree state');
    expect(out).toMatch(/converge\/handoff-payload/);
    expect(out).toMatch(/deadbee\b/); // 7-char short sha, git's own default width
    expect(out).toMatch(/3 uncommitted/);
  });

  it('says clean rather than "0 uncommitted" for a measured-clean tree', () => {
    insertRow(db, { branch: 'main', dirty: 0, sha: 'abc1234567890' });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toMatch(/clean/);
    expect(out).not.toMatch(/0 uncommitted/);
  });

  it('omits the dirty clause entirely when it was never measured', () => {
    // A row written before this change carries a sha and no count. Rendering it as "clean"
    // would be a claim nobody made.
    insertRow(db, { branch: null, dirty: null, sha: 'abc1234567890' });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toContain('## Tree state');
    expect(out).toMatch(/abc1234/);
    expect(out).not.toMatch(/clean/);
    expect(out).not.toMatch(/uncommitted/);
  });

  it('omits the whole section when the row carries no git state at all', () => {
    insertRow(db, { branch: null, dirty: null, sha: null });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toContain('## Working On'); // premise: the block rendered at all
    expect(out).not.toContain('## Tree state');
  });

  it('renders a branch-only row (sha unavailable)', () => {
    insertRow(db, { branch: 'main', dirty: 1, sha: null });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toContain('## Tree state');
    expect(out).toMatch(/main/);
    expect(out).toMatch(/1 uncommitted/);
  });
});
