// P3 findings from the pre-ship defect review that were worth taking.
// P3-4 and P3-6 were logged and skipped — see the repair commit body for the reasons.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb } from './test-helpers.mjs';
import { renderHandoffInjection } from '../hook-handoff.mjs';
import { readPausedNote } from '../lib/paused-reader.mjs';

describe('P3-2 — dedup does not collapse two rows that share a title but not a type', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  function insertRow(completed, key_decisions) {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, completed, key_decisions, created_at_epoch)
       VALUES ('p', 'exit', 's1', 'obj', ?, ?, ?)`,
    ).run(completed, key_decisions, Date.now() - 60000);
  }

  it('keeps the [change] row when only the [decision] row is standing policy', () => {
    // Two observations, same title, different type — a real shape when a change is later
    // formalised as a decision. Matching on the stripped title dropped BOTH from Completed.
    insertRow('[change] 更新测试\n[decision] 更新测试', '[decision] 更新测试');

    const out = renderHandoffInjection(db, 'p');
    const completed = out.split('## Completed')[1].split(/\n##\s|<\/session-handoff>/)[0];

    expect(completed).toMatch(/\[change\] 更新测试/);
    expect(completed).not.toMatch(/\[decision\] 更新测试/);
  });

  it('still dedups a legacy row that carries a bare title', () => {
    // Rows written before key_decisions carried the prefix hold bare titles. Only those get
    // the looser title-only match, so the accommodation is scoped to the rows that need it
    // rather than to every row forever.
    insertRow('[decision] chose the window\n[change] tidied a comment', 'chose the window');

    const out = renderHandoffInjection(db, 'p');
    const completed = out.split('## Completed')[1].split(/\n##\s|<\/session-handoff>/)[0];

    expect(completed).not.toMatch(/chose the window/);
    expect(completed).toMatch(/tidied a comment/);
  });
});

describe('P3-5 — a detached HEAD does not render the literal branch name HEAD', () => {
  it('readGitState returns null rather than the string HEAD when detached', async () => {
    const { readGitState } = await import('../lib/git-state.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'detached-'));
    const { execFileSync } = await import('child_process');
    const run = (...a) => execFileSync(a[0], a.slice(1), { cwd: repo, stdio: 'pipe' });
    run('git', 'init', '-q');
    run('git', 'config', 'user.email', 't@t');
    run('git', 'config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    run('git', 'add', 'f.txt');
    run('git', 'commit', '-qm', 'one');
    const sha = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo })).trim();
    run('git', 'checkout', '-q', sha); // detach

    const st = readGitState({ cwd: repo });

    expect(st.headSha).toBe(sha); // premise: we really are on that commit
    expect(st.branch).toBeNull(); // not the literal 'HEAD'
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('P3-7 — an oversized paused note is skipped, not read whole', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'paused-size-'));
    mkdirSync(join(root, 'tasks'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a normal note', () => {
    writeFileSync(join(root, 'tasks', 'a-paused.md'), '# Paused — x\n\n## Not done\n\n- an item\n');
    expect(readPausedNote({ projectPath: root })?.items).toEqual(['an item']);
  });

  it('skips one past the size cap', () => {
    // The read is synchronous and on the Stop path, once per assistant turn. Output was
    // already bounded (5 items x 200 chars); the INPUT was not.
    const huge = '# Paused — x\n\n## Not done\n\n' + '- item\n'.repeat(200_000);
    writeFileSync(join(root, 'tasks', 'huge-paused.md'), huge);
    expect(readPausedNote({ projectPath: root })).toBeNull();
  });
});
