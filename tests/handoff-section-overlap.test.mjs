// `## Completed` and `## Key Decisions` were rendering the same lines twice.
//
// Measured on the live corpus 2026-09-21 with the real predicates (liveObsFilterSql +
// LOW_SIGNAL_TITLE, not re-derived ones), population = every project with observations:
// 35 of 35 rendered Key Decisions lines were byte-identical to a Completed line — 100%,
// in all 8 projects. The overlap only became visible once the payload fix landed; before
// that both sections were empty, which is why nothing had ever noticed.
//
// The two fields are NOT redundant in meaning, and the fix must not collapse them. Audit
// 2026-08-14 F4 ruled that `completed` is the session's own history (an overturned decision
// still happened, so it stays) while `key_decisions` is standing policy replayed to a LATER
// session (so it filters superseded_at). The dedup is therefore one-directional and happens
// at RENDER time only: storage is untouched, so all three F4 guards still hold, and the one
// case where the two sections genuinely differ — a retracted decision — is exactly the case
// where the line survives under Completed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, renderHandoffInjection } from '../hook-handoff.mjs';
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

function insertRow(db, { completed, key_decisions }) {
  db.prepare(
    `INSERT INTO session_handoffs (project, type, session_id, working_on, completed, key_decisions, created_at_epoch)
     VALUES ('p', 'exit', 's1', 'the objective', ?, ?, ?)`,
  ).run(completed, key_decisions, Date.now() - 60000);
}

/** The lines of one `## X` section of the rendered block. */
function section(block, name) {
  const after = block.split(`## ${name}`)[1];
  if (after === undefined) return null;
  return after.split(/\n##\s|<\/session-handoff>/)[0];
}

describe('Completed and Key Decisions do not render the same line twice', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('a decision rendered as standing policy is not repeated under Completed', () => {
    insertRow(db, {
      completed: '[decision] chose the project-scoped pool predicate\n[change] tidied a comment',
      key_decisions: '[decision] chose the project-scoped pool predicate',
    });

    const out = renderHandoffInjection(db, 'p');

    expect(section(out, 'Key Decisions')).toMatch(/chose the project-scoped pool predicate/);
    expect(section(out, 'Completed')).toMatch(/tidied a comment/); // the non-decision survives
    expect(section(out, 'Completed')).not.toMatch(/chose the project-scoped pool predicate/);
    // Counting guard: the title appears exactly once in the whole block. `not.toMatch` on
    // one section alone would pass if the renderer stopped emitting that section at all.
    expect(out.match(/chose the project-scoped pool predicate/g)).toHaveLength(1);
  });

  it('a RETRACTED decision still renders under Completed — it is not standing policy', () => {
    // The F4 case, and the whole reason the dedup runs one way only. The retracted title is
    // absent from key_decisions (the superseded filter dropped it), so nothing removes it
    // from the session's own history.
    insertRow(db, {
      completed: '[decision] RETRACTED reset the backoff per hop\n[decision] CURRENT carry it across hops',
      key_decisions: '[decision] CURRENT carry it across hops',
    });

    const out = renderHandoffInjection(db, 'p');

    expect(section(out, 'Completed')).toMatch(/RETRACTED reset the backoff per hop/);
    expect(section(out, 'Completed')).not.toMatch(/CURRENT carry it across hops/);
    expect(section(out, 'Key Decisions')).toMatch(/CURRENT carry it across hops/);
  });

  it('omits Completed entirely when every one of its lines is a decision', () => {
    // The shape three of the eight measured projects had: the session's whole history IS
    // its decisions. An empty `## Completed` header with nothing under it is worse than no
    // header, and the type tags are not lost because key_decisions carries them too.
    insertRow(db, {
      completed: '[bugfix] fixed the tiebreak\n[decision] chose the window',
      key_decisions: '[bugfix] fixed the tiebreak\n[decision] chose the window',
    });

    const out = renderHandoffInjection(db, 'p');

    expect(out).not.toContain('## Completed');
    expect(section(out, 'Key Decisions')).toMatch(/fixed the tiebreak/);
    expect(section(out, 'Key Decisions')).toMatch(/chose the window/);
  });

  it('matches on the title, so a row stored before the type prefix shipped still dedups', () => {
    // Rows written by the previous release carry bare titles in key_decisions while
    // completed carries `[type] title`. They live up to 7 days, so the dedup compares the
    // title portion rather than the whole line.
    insertRow(db, {
      completed: '[decision] chose the window\n[change] tidied a comment',
      key_decisions: 'chose the window',
    });

    const out = renderHandoffInjection(db, 'p');

    expect(section(out, 'Completed')).not.toMatch(/chose the window/);
    expect(section(out, 'Completed')).toMatch(/tidied a comment/);
    expect(out.match(/chose the window/g)).toHaveLength(1);
  });

  it('stores key_decisions WITH the type prefix, so the dedup does not lose the tag', () => {
    // The storage half. Without this case, dropping the prefix from the write is invisible:
    // a per-site mutation over this file read GREEN for exactly that change, because every
    // other case inserts a handoff row by hand instead of building one.
    const SESSION = 'hook-ov-proj-1234abcd';
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, ?, 'ov', datetime('now'), 1000, 'active')`,
    ).run(SESSION, SESSION);
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
       VALUES (?, 'do the work', 1, datetime('now'), 1000)`,
    ).run(SESSION);
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, importance, narrative, created_at, created_at_epoch)
       VALUES (?, 'ov', 'decision', 'chose the window', 3, NULL, datetime('now'), 1100)`,
    ).run(SESSION);

    buildAndSaveHandoff(db, SESSION, 'ov', 'exit', null);

    const row = db
      .prepare(`SELECT completed, key_decisions FROM session_handoffs WHERE project = 'ov'`)
      .get();
    expect(row.key_decisions).toBe('[decision] chose the window');
    // Both fields agree on the format, which is what lets the dedup match line for line.
    expect(row.completed).toContain('[decision] chose the window');
  });

  it('leaves Completed alone when there are no decisions to dedup against', () => {
    insertRow(db, { completed: '[change] one\n[change] two', key_decisions: null });

    const out = renderHandoffInjection(db, 'p');

    expect(section(out, 'Completed')).toMatch(/one/);
    expect(section(out, 'Completed')).toMatch(/two/);
    expect(out).not.toContain('## Key Decisions');
  });
});
