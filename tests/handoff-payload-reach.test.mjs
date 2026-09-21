// Handoff payload reachability — the `completed` / `key_decisions` / `key_files` fields
// were built with `WHERE memory_session_id = ?`, keyed on the HOOK-minted session id
// (`hook-<project>-<uuid8>`, hook-shared.mjs). Every observation written by an explicit
// `mem_save` carries `manual-<project>` instead (lib/save-observation.mjs), so the two id
// namespaces are disjoint BY CONSTRUCTION and that equality join could never reach a saved
// lesson. Measured on the live DB 2026-09-21: 101 of 105 observations sat in the `manual-`
// namespace, and all 17 stored handoff rows carried `completed` = 0 bytes and
// `key_decisions` = 0 bytes.
//
// Why the existing suite stayed green: tests/handoff-simulation.test.mjs:194-198 (and the
// D#26/D#28 block at :920-992) seed the observation and call buildAndSaveHandoff with the
// SAME id, a shape production never has. A single-namespace fixture is structurally blind
// to this defect, so these cases seed BOTH namespaces and assert the premise that they
// differ before asserting the payload.
//
// The isolation that D#28 bought stays with the TIME WINDOW, not with the id: the control
// case below pins that a prior session's observation is still excluded.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

// Stub git + TaskList for the whole file: this suite runs inside a real git repo, and both
// readers would otherwise leak this repo's own HEAD and pending tasks into the rows.
// (The paused-note reader needs no stub: it neutralises its own default under the test guard.)
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

// observations.memory_session_id is FK-bound to sdk_sessions, and lib/save-observation.mjs
// creates its own `manual-<project>` session row (INSERT OR IGNORE) before writing. Production
// carries both rows per project — verified on the live DB 2026-09-21, where the manual rows
// sit at status 'abandoned' — so the fixture seeds both, with the same status the sweeper
// leaves behind. No handoff query reads sdk_sessions.status; it is mirrored for fidelity only.
function seedSession(db, id, project, status = 'active') {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, ?)`,
  ).run(id, id, project, Date.now(), status);
}

function seedCcPrompt(db, contentId, ccId, text, num, epoch) {
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, cc_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
  ).run(contentId, ccId, text, num, epoch);
}

function seedObsAt(db, memId, project, { title, type = 'change', importance = 1, files = null }, epoch) {
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'), ?)`,
  ).run(memId, project, type, title, importance, files, epoch);
}

describe('handoff payload reaches observations across session-id namespaces', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  const PROJECT = 'reach-proj';
  const HOOK_ID = 'hook-reach-proj-a1b2c3d4'; // what the hook mints and hands to buildAndSaveHandoff
  const MANUAL_ID = 'manual-reach-proj'; // what every explicit mem_save writes under

  it('premise: the two id namespaces a real install uses are different strings', () => {
    // If this ever becomes false the rest of this file proves nothing.
    expect(HOOK_ID).not.toBe(MANUAL_ID);
  });

  it('completed includes a mem_save observation from this session window', () => {
    seedSession(db, HOOK_ID, PROJECT);
    seedSession(db, MANUAL_ID, PROJECT, 'abandoned');
    seedCcPrompt(db, HOOK_ID, 'cc-now', 'fix the ranker tiebreak', 1, 5000);
    seedObsAt(
      db,
      MANUAL_ID,
      PROJECT,
      { title: 'MANUAL-SAVE ranker tiebreak fixed', type: 'bugfix', importance: 2 },
      5100,
    );

    buildAndSaveHandoff(db, HOOK_ID, PROJECT, 'exit', null, 'cc-now');

    const row = db.prepare('SELECT completed FROM session_handoffs WHERE session_id = ?').get('cc-now');
    expect(row.completed).toMatch(/MANUAL-SAVE ranker tiebreak fixed/);
  });

  it('key_decisions includes a mem_save decision from this session window', () => {
    seedSession(db, HOOK_ID, PROJECT);
    seedSession(db, MANUAL_ID, PROJECT, 'abandoned');
    seedCcPrompt(db, HOOK_ID, 'cc-now', 'decide the pool predicate', 1, 5000);
    seedObsAt(
      db,
      MANUAL_ID,
      PROJECT,
      { title: 'MANUAL-SAVE chose project-scoped pool predicate', type: 'decision', importance: 3 },
      5100,
    );

    buildAndSaveHandoff(db, HOOK_ID, PROJECT, 'exit', null, 'cc-now');

    const row = db.prepare('SELECT key_decisions FROM session_handoffs WHERE session_id = ?').get('cc-now');
    expect(row.key_decisions).toMatch(/MANUAL-SAVE chose project-scoped pool predicate/);
  });

  it('key_files includes files from a mem_save observation in this session window', () => {
    seedSession(db, HOOK_ID, PROJECT);
    seedSession(db, MANUAL_ID, PROJECT, 'abandoned');
    seedCcPrompt(db, HOOK_ID, 'cc-now', 'touch the scoring module', 1, 5000);
    seedObsAt(
      db,
      MANUAL_ID,
      PROJECT,
      {
        title: 'MANUAL-SAVE scoring multiplier rewired',
        importance: 2,
        files: '["src/scoring-sql.mjs"]',
      },
      5100,
    );

    buildAndSaveHandoff(db, HOOK_ID, PROJECT, 'exit', null, 'cc-now');

    const row = db.prepare('SELECT key_files FROM session_handoffs WHERE session_id = ?').get('cc-now');
    expect(row.key_files).toMatch(/scoring-sql\.mjs/);
  });

  it('control: a mem_save observation from BEFORE this session window is still excluded', () => {
    // The D#28 isolation must survive the widening — it is the time window that does that
    // work, not the id equality. Without this case the fix could silently merge sessions.
    seedSession(db, HOOK_ID, PROJECT);
    seedSession(db, MANUAL_ID, PROJECT, 'abandoned');
    seedCcPrompt(db, HOOK_ID, 'cc-old', 'yesterday: tune the ranker', 1, 1000);
    seedObsAt(
      db,
      MANUAL_ID,
      PROJECT,
      { title: 'PRIOR-SESSION ranker tuning done', type: 'change', importance: 3 },
      1100,
    );
    seedCcPrompt(db, HOOK_ID, 'cc-now', 'today: add restore command', 2, 5000);
    seedObsAt(
      db,
      MANUAL_ID,
      PROJECT,
      { title: 'TODAY restore command added', type: 'change', importance: 3 },
      5100,
    );

    buildAndSaveHandoff(db, HOOK_ID, PROJECT, 'exit', null, 'cc-now');

    const row = db
      .prepare('SELECT completed, key_decisions FROM session_handoffs WHERE session_id = ?')
      .get('cc-now');
    expect(row.completed).toMatch(/TODAY restore command added/);
    expect(row.completed).not.toMatch(/PRIOR-SESSION ranker tuning/);
    expect(row.key_decisions).not.toMatch(/PRIOR-SESSION ranker tuning/);
  });

  it('control: another project in the same DB never bleeds in', () => {
    seedSession(db, HOOK_ID, PROJECT);
    seedSession(db, MANUAL_ID, PROJECT, 'abandoned');
    seedCcPrompt(db, HOOK_ID, 'cc-now', 'work here', 1, 5000);
    seedObsAt(db, MANUAL_ID, PROJECT, { title: 'MINE own-project work', importance: 2 }, 5100);
    seedSession(db, 'manual-other-proj', 'other-proj', 'abandoned');
    seedObsAt(
      db,
      'manual-other-proj',
      'other-proj',
      { title: 'THEIRS other-project work', importance: 3 },
      5200,
    );

    buildAndSaveHandoff(db, HOOK_ID, PROJECT, 'exit', null, 'cc-now');

    const row = db
      .prepare('SELECT completed, key_decisions FROM session_handoffs WHERE session_id = ?')
      .get('cc-now');
    expect(row.completed).toMatch(/MINE own-project work/);
    expect(row.completed).not.toMatch(/THEIRS other-project work/);
    expect(row.key_decisions).not.toMatch(/THEIRS other-project work/);
  });

  it('unscoped arm (no CC session id) reaches the mem_save namespace too', () => {
    // The legacy / no-stdin path has no CC window; it must still see the project's work
    // rather than only rows that happen to share the hook id.
    seedSession(db, HOOK_ID, PROJECT);
    seedSession(db, MANUAL_ID, PROJECT, 'abandoned');
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
       VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(HOOK_ID, 'investigate the slow path', 1, 1000);
    seedObsAt(
      db,
      MANUAL_ID,
      PROJECT,
      { title: 'MANUAL-SAVE legacy finding recorded', type: 'bugfix', importance: 2 },
      1100,
    );

    buildAndSaveHandoff(db, HOOK_ID, PROJECT, 'exit', null);

    const row = db.prepare('SELECT completed FROM session_handoffs WHERE session_id = ?').get(HOOK_ID);
    expect(row.completed).toMatch(/MANUAL-SAVE legacy finding recorded/);
  });
});
