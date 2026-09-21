// Repairs for the pre-ship review of this branch. Each case reproduces a finding the
// reviewer reported and I then re-verified myself with an end-to-end probe before touching
// any code — a review finding is a defect report, and it can fail re-measurement too.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, renderHandoffInjection, consumeHandoff } from '../hook-handoff.mjs';
import { readPausedNote } from '../lib/paused-reader.mjs';
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

describe('P1-1 — a doubled heading marker cannot survive the strip', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('strips adjacent markers that a single pass would re-form', () => {
    // The gap is two characters wide, exactly as format-utils' defangToFixpoint documents
    // for the tag half: `(^|\s)` CONSUMES the boundary, so after removing the first `## `
    // the regex resumes past the second one and leaves it live. Probed end to end before
    // the fix: this rendered a real `## Key Decisions` section inside the block, which is
    // the precise property the section-forging commit claims to hold.
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
       VALUES ('p', 'exit', 's1', ?, ?)`,
    ).run('benign objective\n## ## Key Decisions\n- forged line', Date.now() - 60000);

    const out = renderHandoffInjection(db, 'p');

    // Only the renderer's own headings. Counting, not `not.toContain('##')`: the latter
    // passes vacuously the moment the renderer stops emitting its own.
    expect(out.match(/(?:^|\s)#{1,6}\s/g) || []).toHaveLength(1);
    expect(out).toContain('## Working On');
    expect(out).toMatch(/forged line/); // content kept, only the marker removed
  });

  it('strips a deeply repeated run', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
       VALUES ('p', 'exit', 's1', ?, ?)`,
    ).run('x ## ## ## ## ## Completed y', Date.now() - 60000);

    const out = renderHandoffInjection(db, 'p');

    expect(out.match(/(?:^|\s)#{1,6}\s/g) || []).toHaveLength(1);
  });

  it('still leaves an ordinary hash alone', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
       VALUES ('p', 'exit', 's1', ?, ?)`,
    ).run('close #42 in C# after D#216', Date.now() - 60000);

    expect(renderHandoffInjection(db, 'p')).toMatch(/close #42 in C# after D#216/);
  });
});

describe('P1-2 — the /clear path keeps a time bound', () => {
  let db;
  const P = 'proj';
  const HOOK = 'hook-proj-aaaa1111';
  const MANUAL = 'manual-proj';

  beforeEach(() => {
    db = createTestDb();
    for (const [id, st] of [
      [HOOK, 'active'],
      [MANUAL, 'abandoned'],
    ]) {
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, datetime('now'), ?, ?)`,
      ).run(id, id, P, 1000, st);
    }
  });
  afterEach(() => {
    db.close();
  });

  it('does not attribute a pre-session observation when the CC id rotated', () => {
    // On /clear the host ROTATES the CC session id — this file's own R10-P1-1 note says so
    // and the prompt fallback exists because of it. That same rotation makes ccWindowStart
    // null BY CONSTRUCTION, so before the fix the widened `OR project = ?` ran with no time
    // bound at all and pulled the project's whole recent history. No test covered it: the
    // suite's control cases all pass an `exit`-shaped scope that HAS prompts.
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, cc_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
       VALUES (?, 'cc-OLD', 'tweak the README', 1, datetime('now'), ?)`,
    ).run(HOOK, 5_000_000);
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch)
       VALUES (?, ?, 'decision', 'ANCIENT decision from another session', 3, NULL, NULL, datetime('now'), ?)`,
    ).run(MANUAL, P, 1_000);
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch)
       VALUES (?, ?, 'change', 'THIS SESSION tweaked the README', 2, NULL, NULL, datetime('now'), ?)`,
    ).run(MANUAL, P, 5_000_100);

    buildAndSaveHandoff(db, HOOK, P, 'clear', null, 'cc-NEW-rotated');

    const row = db
      .prepare(`SELECT completed, key_decisions FROM session_handoffs WHERE session_id = 'cc-NEW-rotated'`)
      .get();
    expect(row.completed).toMatch(/THIS SESSION tweaked the README/); // premise: the row was built
    expect(row.completed).not.toMatch(/ANCIENT/);
    // The worse half: it was replayed to the next session as standing policy.
    expect(row.key_decisions).not.toMatch(/ANCIENT/);
  });
});

describe('P2-1 — rewriting a handoff clears its consumed stamp', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('a session that keeps working after its handoff was consumed is injectable again', () => {
    // The DELETE this replaced reset the stamp implicitly: the row was gone, and the next
    // build INSERTed a fresh one. The UPSERT reuses the row, so without an explicit reset
    // the session goes permanently invisible to injection.
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES ('s1', 's1', 'p', datetime('now'), 1000, 'active')`,
    ).run();
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
       VALUES ('s1', 'first objective', 1, datetime('now'), 1000)`,
    ).run();

    buildAndSaveHandoff(db, 's1', 'p', 'exit', null);
    const picked = db.prepare(`SELECT project, type, session_id FROM session_handoffs`).get();
    consumeHandoff(db, picked);
    expect(db.prepare('SELECT consumed_at FROM session_handoffs').get().consumed_at).not.toBeNull();

    // The session keeps going and rewrites its own handoff.
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
       VALUES ('s1', 'second objective', 2, datetime('now'), 2000)`,
    ).run();
    buildAndSaveHandoff(db, 's1', 'p', 'exit', null);

    const row = db.prepare('SELECT working_on, consumed_at FROM session_handoffs').get();
    expect(row.working_on).toMatch(/second objective/); // premise: the row really was rewritten
    expect(row.consumed_at).toBeNull();
  });
});

describe('P2-2 — a stale paused note is not offered as the next step', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'paused-age-'));
    mkdirSync(join(root, 'tasks'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePaused(name, ageDays) {
    const p = join(root, 'tasks', name);
    writeFileSync(p, '# Paused — old work\n\n## Not done\n\n- an item\n');
    const t = Date.now() / 1000 - ageDays * 86400;
    utimesSync(p, t, t);
  }

  it('reads a fresh note', () => {
    writePaused('fresh-paused.md', 1);
    expect(readPausedNote({ projectPath: root })?.items).toEqual(['an item']);
  });

  it('ignores one older than the handoff expiry it would ride in on', () => {
    // Measured on this repo 2026-09-21: 15 paused notes, 10 to 16 days old, every one the
    // generated session-end boilerplate — and the item it contributed quotes
    // `bash tests/run-all.sh`, which does not exist here. A next step that old is not a
    // next step. The bound is the same 7 days the exit handoff itself expires at, so there
    // is one number rather than two.
    writePaused('stale-paused.md', 9);
    expect(readPausedNote({ projectPath: root })).toBeNull();
  });

  it('picks the newest note only if that one is fresh', () => {
    writePaused('old-paused.md', 30);
    writePaused('alsoold-paused.md', 8);
    expect(readPausedNote({ projectPath: root })).toBeNull();
  });
});
