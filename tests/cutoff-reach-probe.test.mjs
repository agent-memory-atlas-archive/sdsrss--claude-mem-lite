// benchmark/cutoff-reach-probe.mjs (proposal B3): counts what PreToolUse recall's 60-day cut
// removes, split by whether the edge is still in use. A probe that cannot say NO is not a probe
// (doctrine rule 5): the fresh-row case below must read zero while the old rows read non-zero.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { probeCutoffReach } from '../benchmark/cutoff-reach-probe.mjs';
import { PRETOOL_LOOKBACK_MS, DAY_MS } from '../lib/time-constants.mjs';

const NOW = Date.parse('2026-11-10T00:00:00Z');

describe('probeCutoffReach', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's1', project: 'p' });
  });
  afterEach(() => db.close());

  function obs({ ageDays, importance = 2, files = ['/r/a.mjs'], miss = 0, cited = null }) {
    const { lastInsertRowid } = insertObs(db, {
      sessionId: 's1',
      project: 'p',
      title: `row ${ageDays}d`,
      importance,
      lessonLearned: 'a lesson',
      epochOffset: NOW - Date.now() - ageDays * DAY_MS,
    });
    const id = Number(lastInsertRowid);
    for (const f of files) {
      db.prepare(
        'INSERT INTO observation_files (obs_id, filename, miss_streak, last_cited_session_id) VALUES (?, ?, ?, ?)',
      ).run(id, f, miss, cited);
    }
    return id;
  }

  it('the window is the shipped one', () => {
    expect(PRETOOL_LOOKBACK_MS).toBe(60 * DAY_MS);
  });

  it('reads zero when every row is inside the window — the NO answer', () => {
    obs({ ageDays: 10 });
    obs({ ageDays: 59 });
    const r = probeCutoffReach(db, { now: NOW });
    expect(r.obsEdges.total).toBe(0);
    expect(r.obsEdges.inUse).toEqual([]);
    // first bite = oldest row + 60 days
    expect(r.firstBites).toBe(new Date(NOW - 59 * DAY_MS + PRETOOL_LOOKBACK_MS).toISOString());
  });

  it('splits removed edges into cited / never missed / other, per edge', () => {
    const citedId = obs({ ageDays: 90, cited: 'sess-x', miss: 2 });
    const neverMissedId = obs({ ageDays: 70, files: ['/r/a.mjs', '/r/b.mjs'] });
    obs({ ageDays: 80, miss: 3 }); // passed over three times, never cited: decay's business
    obs({ ageDays: 75, importance: 1 }); // below recall's importance floor: not in the population
    obs({ ageDays: 5 }); // inside the window
    const r = probeCutoffReach(db, { now: NOW });
    expect(r.obsEdges.total).toBe(4);
    expect(r.obsEdges.cited).toBe(1);
    expect(r.obsEdges.neverMissed).toBe(2);
    expect(r.obsEdges.rest).toBe(1);
    expect(r.obsEdges.inUse.map((e) => e.id).sort((a, b) => a - b)).toEqual(
      [citedId, neverMissedId, neverMissedId].sort((a, b) => a - b),
    );
  });

  it('a superseded row is not counted — liveObsFilterSql, as recall applies it', () => {
    const id = obs({ ageDays: 90 });
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(NOW, id);
    expect(probeCutoffReach(db, { now: NOW }).obsEdges.total).toBe(0);
  });
});
