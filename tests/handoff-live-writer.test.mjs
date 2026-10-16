// E2E 2026-10-16 F5: a handoff whose writer is another Claude Code process still running is that
// open session's, not a previous one's, and must not be resumed into a second session. hook.mjs
// names those handoffs (liveOtherHostHandoffIds) and every reader below leaves them out — in SQL,
// because Stage -1/0 read one row and pickHandoffToInject five. One case per query site: each
// fails on its own when that site's filter is removed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { detectContinuationIntent, pickHandoffToInject } from '../hook-handoff.mjs';
import { buildDashboard } from '../lib/startup-dashboard.mjs';
import * as gitStateModule from '../lib/git-state.mjs';

const HEAD = 'deadbeefcafe1234deadbeefcafe1234deadbeef';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
const LIVE = ['cc-live'];

let db, spy;
const insert = (type, session, sha, keywords, ageMs = 0) =>
  db
    .prepare(
      `INSERT INTO session_handoffs (project, type, session_id, git_sha_at_handoff, match_keywords, working_on, created_at_epoch)
       VALUES ('p', ?, ?, ?, ?, ?, ?)`,
    )
    .run(type, session, sha, keywords, `${session} work`, Date.now() - ageMs);

beforeEach(() => {
  db = createTestDb();
  spy = vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({ headSha: HEAD });
});
afterEach(() => {
  spy.mockRestore();
  db.close();
});

describe('Stage -1 (commit anchor)', () => {
  for (const cc of ['cc-new', null]) {
    it(`does not continue on a live writer's anchor (${cc ? 'scoped' : 'unscoped'})`, () => {
      insert('exit', 'cc-live', HEAD, 'invoice rounding totals');
      expect(detectContinuationIntent(db, 'ok thanks', 'p', cc)).toBe(true); // premise
      expect(detectContinuationIntent(db, 'ok thanks', 'p', cc, LIVE)).toBe(false);
    });
  }

  it("does not let a live writer's anchor resume an older handoff at another commit", () => {
    insert('exit', 'cc-live', HEAD, 'invoice rounding totals');
    insert('exit', 'cc-gone', OTHER, 'readme docs section', 60_000);
    expect(detectContinuationIntent(db, 'ok thanks', 'p', 'cc-new', LIVE)).toBe(false);
  });
});

describe('Stage 0 (clear handoff)', () => {
  beforeEach(() => spy.mockReturnValue({ headSha: null }));

  it('unscoped: skips a live writer’s clear handoff', () => {
    insert('clear', 'cc-live', null, 'invoice rounding totals');
    expect(detectContinuationIntent(db, 'invoice rounding', 'p', null)).toBe(true); // premise
    expect(detectContinuationIntent(db, 'invoice rounding', 'p', null, LIVE)).toBe(false);
  });

  it('scoped: skips a clear handoff of this session id when a live writer holds it', () => {
    insert('clear', 'cc-live', null, 'invoice rounding totals');
    expect(detectContinuationIntent(db, 'ok', 'p', 'cc-live')).toBe(true); // premise
    expect(detectContinuationIntent(db, 'ok', 'p', 'cc-live', LIVE)).toBe(false);
  });
});

describe('Stage 2 (keyword overlap)', () => {
  beforeEach(() => spy.mockReturnValue({ headSha: null }));
  const prompt = 'the invoice rounding totals are still wrong for discounted lines';

  for (const cc of ['cc-new', null]) {
    it(`does not count a live writer's exit handoff (${cc ? 'scoped' : 'unscoped'})`, () => {
      insert('exit', 'cc-live', null, 'invoice rounding totals discounted lines');
      expect(detectContinuationIntent(db, prompt, 'p', cc)).toBe(true); // premise
      expect(detectContinuationIntent(db, prompt, 'p', cc, LIVE)).toBe(false);
    });
  }
});

describe('pickHandoffToInject', () => {
  for (const cc of ['cc-new', null]) {
    it(`returns the newest handoff whose writer is gone (${cc ? 'scoped' : 'unscoped'})`, () => {
      insert('exit', 'cc-gone', HEAD, 'readme docs', 60_000);
      insert('exit', 'cc-live', HEAD, 'invoice rounding');
      expect(pickHandoffToInject(db, 'p', cc)?.session_id).toBe('cc-live'); // premise
      expect(pickHandoffToInject(db, 'p', cc, LIVE)?.session_id).toBe('cc-gone');
    });
  }
});

describe('SessionStart continuation pointer', () => {
  it('does not offer a handoff whose writer is still running', () => {
    insert('exit', 'cc-live', HEAD, 'invoice rounding');
    const stubs = { git: { changed: [], stashes: [] }, tasks: [], plans: [] };
    expect(buildDashboard({ db, project: 'p', stubs })).toContain('Continuation available'); // premise
    expect(buildDashboard({ db, project: 'p', stubs, excludeHandoffIds: LIVE })).not.toContain(
      'Continuation available',
    );
  });
});
