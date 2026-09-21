// Consuming a handoff MARKS it, it does not DELETE it.
//
// handleUserPrompt used to `DELETE FROM session_handoffs` the moment it injected a row
// (hook.mjs, pre-change). Two costs: a handoff injected at a moment the model could not use
// it was gone forever, and nothing downstream could ever be audited — the row that produced
// a bad injection no longer existed by the time anyone looked. `consumed_at` keeps the row
// until the existing expiry GC (hook.mjs auto-maintain) reaps it on age, as before.
//
// Filling the column EVICTS the row from every pool whose WHERE clause keyed on its
// availability, which is the point — but "which sites need the predicate" is a decision, not
// a sweep, so each of the five reading sites gets a case here and hook.mjs's post-write
// read-back is named as the one deliberate exclusion (it reads the row it just wrote, by
// exact PK, before any injection could have consumed it).
//
// Every case asserts the PREMISE first — that the thing is present while consumed_at is
// NULL. Without that, a case that silently stopped reaching the code under test (a quiet
// filter, a changed section name) would pass for the wrong reason.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { consumeHandoff, detectContinuationIntent, pickHandoffToInject } from '../hook-handoff.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { buildDashboard } from '../lib/startup-dashboard.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

const NEUTRAL_GIT = { changed: [], stashes: [], branch: null, headSha: null };

beforeEach(() => {
  vi.spyOn(gitStateModule, 'readGitState').mockReturnValue(NEUTRAL_GIT);
  vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function insertHandoff(
  db,
  {
    project = 'p',
    type = 'exit',
    sessionId = 's1',
    keywords = null,
    sha = null,
    ageMs = 60000,
    workingOn = 'the resumable task',
  } = {},
) {
  db.prepare(
    `INSERT INTO session_handoffs (project, type, session_id, working_on, match_keywords, git_sha_at_handoff, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(project, type, sessionId, workingOn, keywords, sha, Date.now() - ageMs);
  return { project, type, session_id: sessionId };
}

describe('consumeHandoff marks the row instead of deleting it', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('session_handoffs carries a consumed_at column', () => {
    const names = db
      .prepare(`PRAGMA table_info(session_handoffs)`)
      .all()
      .map((c) => c.name);
    expect(names).toContain('consumed_at');
  });

  it('a DB from the previous release gets the column without a version bump', () => {
    // The reason `consumed_at` ships without a CURRENT_SCHEMA_VERSION bump is that
    // LATEST_MIGRATION_COLUMNS forces the migration pass on a DB whose version row already
    // says "done". That is a claim about reachability, so it is measured here rather than
    // left as a sentence in schema.mjs: drop the column to reproduce exactly the shape a
    // previous-release DB has — version row at CURRENT, column absent — and reopen.
    const cols = () =>
      db
        .prepare(`PRAGMA table_info(session_handoffs)`)
        .all()
        .map((c) => c.name);

    db.exec(`ALTER TABLE session_handoffs DROP COLUMN consumed_at`);

    // Premises: without both of these the case proves nothing about the fast path.
    expect(db.prepare('SELECT version FROM schema_version LIMIT 1').get().version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(cols()).not.toContain('consumed_at');

    initSchema(db);

    expect(cols()).toContain('consumed_at');
  });

  it('the row survives consumption and carries a timestamp', () => {
    const h = insertHandoff(db);
    expect(db.prepare('SELECT consumed_at FROM session_handoffs').get().consumed_at).toBeNull();

    consumeHandoff(db, h);

    const row = db.prepare('SELECT working_on, consumed_at FROM session_handoffs').get();
    expect(row).toBeDefined(); // the whole point: pre-change this row was gone
    expect(row.working_on).toBe('the resumable task');
    expect(typeof row.consumed_at).toBe('number');
  });

  it("consuming one row leaves another session's handoff alone", () => {
    const mine = insertHandoff(db, { sessionId: 'cc-mine' });
    insertHandoff(db, { sessionId: 'cc-theirs' });

    consumeHandoff(db, mine);

    const theirs = db
      .prepare('SELECT consumed_at FROM session_handoffs WHERE session_id = ?')
      .get('cc-theirs');
    expect(theirs.consumed_at).toBeNull();
  });

  // ─── site 1: pickHandoffToInject (both arms) ──────────────────────────────

  it('pickHandoffToInject skips a consumed row — scoped arm', () => {
    const h = insertHandoff(db, { type: 'exit', sessionId: 'cc-old' });
    expect(pickHandoffToInject(db, 'p', 'cc-current')).not.toBeNull(); // premise

    consumeHandoff(db, h);

    expect(pickHandoffToInject(db, 'p', 'cc-current')).toBeNull();
  });

  it('pickHandoffToInject skips a consumed row — unscoped arm', () => {
    const h = insertHandoff(db, { type: 'exit', sessionId: 's1' });
    expect(pickHandoffToInject(db, 'p')).not.toBeNull(); // premise

    consumeHandoff(db, h);

    expect(pickHandoffToInject(db, 'p')).toBeNull();
  });

  // ─── site 2: detectContinuationIntent, all three stages ───────────────────

  it('Stage 0 (fresh clear handoff + short prompt) stops auto-continuing once consumed', () => {
    // No continuation keyword in the prompt: Stage 1 is handoff-independent and would
    // return true regardless, masking the stage under test.
    const prompt = 'ok go ahead now';
    const h = insertHandoff(db, { type: 'clear', sessionId: 'cc-A', keywords: 'ranker bm25' });
    expect(detectContinuationIntent(db, prompt, 'p', 'cc-A')).toBe(true); // premise

    consumeHandoff(db, h);

    expect(detectContinuationIntent(db, prompt, 'p', 'cc-A')).toBe(false);
  });

  it('Stage 2 (keyword overlap with an exit handoff) stops matching once consumed', () => {
    const prompt = 'how did the scoring_sql multiplier and the bm25 floor turn out';
    const h = insertHandoff(db, {
      type: 'exit',
      sessionId: 's1',
      keywords: 'scoring_sql bm25 multiplier',
    });
    expect(detectContinuationIntent(db, prompt, 'p')).toBe(true); // premise

    consumeHandoff(db, h);

    expect(detectContinuationIntent(db, prompt, 'p')).toBe(false);
  });

  it('Stage -1 (git-commit anchor) stops anchoring once consumed', () => {
    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      ...NEUTRAL_GIT,
      headSha: 'cafebabe0001',
    });
    const prompt = 'what next';
    const h = insertHandoff(db, { type: 'exit', sessionId: 's1', sha: 'cafebabe0001' });
    expect(detectContinuationIntent(db, prompt, 'p')).toBe(true); // premise

    consumeHandoff(db, h);

    expect(detectContinuationIntent(db, prompt, 'p')).toBe(false);
  });

  // ─── site 3: the startup dashboard's continuation pointer ─────────────────

  it('the dashboard stops promising a continuation it can no longer deliver', () => {
    const h = insertHandoff(db, { project: 'mem', type: 'exit', sessionId: 's1' });
    const stubs = {
      git: { changed: ['M x'], stashes: [], branch: 'main', headSha: 'abc' },
      tasks: [],
      plans: [],
    };
    expect(buildDashboard({ db, project: 'mem', projectPath: process.cwd(), stubs })).toMatch(
      /Continuation available/,
    ); // premise

    consumeHandoff(db, h);

    expect(buildDashboard({ db, project: 'mem', projectPath: process.cwd(), stubs })).not.toMatch(
      /Continuation available/,
    );
  });

  // ─── site 4: SessionStart "Working State (from /clear)" ───────────────────

  it('the /clear Working State block disappears once the handoff is consumed', () => {
    const h = insertHandoff(db, { project: 'p', type: 'clear', sessionId: 'cc-A' });
    const before = buildSessionContextLines(db, 'p', new Date(), 'cc-A');
    expect(before).toMatch(/Working State/); // premise — also catches a quiet filter swallowing it

    consumeHandoff(db, h);

    expect(buildSessionContextLines(db, 'p', new Date(), 'cc-A')).not.toMatch(/Working State/);
  });

  it('the /clear Working State block honours consumption on the unscoped arm too', () => {
    const h = insertHandoff(db, { project: 'p', type: 'clear', sessionId: 'cc-A' });
    expect(buildSessionContextLines(db, 'p', new Date())).toMatch(/Working State/); // premise

    consumeHandoff(db, h);

    expect(buildSessionContextLines(db, 'p', new Date())).not.toMatch(/Working State/);
  });
});
