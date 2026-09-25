// An approved /verify correction must not be rewritten by a model pass — including one that
// was already in flight when the user approved it (re-review of dcc8f72, P2-1).
//
// verify-apply stamps optimized_at on every row it approves, and the passes that rewrite
// title/narrative with model output (re-enrich narrow/wide, cluster-merge) select only rows
// with optimized_at NULL. But they select, then wait on a model call of up to
// BG_LLM_TIMEOUT_MS, then write — and the write re-checked liveness only. An edit approved
// inside that window was overwritten: narrow wrote the model's title/narrative over it, wide
// wrote back the PRE-edit narrative it had read before the call. The mocked model call below
// runs the approval inside that window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));
import { callModelJSONAsync } from '../haiku-client.mjs';
import { parseProposals, planVerifyApply, runVerifyApply } from '../lib/verify-apply-core.mjs';

const P = 'test';
const LONG =
  'A concurrent-deduction race let two requests read the same balance and both deduct, double-spending; the fix serializes with SELECT ... FOR UPDATE row locking so the second waits.';
const APPROVED =
  'APPROVED: the double-spend was fixed in abc1234 by serialising deductions with row locking; the race no longer reproduces.';

let db;
let dir;
beforeEach(() => {
  db = createTestDb();
  insertSession(db, { id: 'sess-1', project: P });
  dir = mkdtempSync(join(tmpdir(), 'mem-verify-race-'));
  callModelJSONAsync.mockReset();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(over = {}) {
  return Number(
    insertObs(db, {
      type: 'bugfix',
      importance: 2,
      title: 'Race in balance deduction',
      narrative: LONG,
      ...over,
    }).lastInsertRowid,
  );
}

function approveEdit(id) {
  const { entries } = parseProposals([
    { id, action: 'edit', verdict: 'STALE', set: { narrative: APPROVED }, evidence: 'abc1234' },
  ]);
  const { plan, errors } = planVerifyApply(db, entries, { project: P });
  expect(errors).toEqual([]);
  runVerifyApply(db, plan, { backupDir: dir });
}

describe('re-enrich does not overwrite an approval that landed during its model call', () => {
  it.each(['narrow', 'wide'])('%s', async (scope) => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(id); // the user approves while the model is thinking
      return {
        type: 'bugfix',
        importance: 2,
        title: 'MODEL title',
        narrative: 'MODEL narrative',
        lesson_learned: 'MODEL lesson',
      };
    });
    const res = await executeReenrich(db, 10, { scope });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1); // premise: the row WAS a candidate
    expect(res.processed).toBe(0);
    const row = db.prepare('SELECT title, narrative, lesson_learned FROM observations WHERE id = ?').get(id);
    expect(row).toEqual({ title: 'Race in balance deduction', narrative: APPROVED, lesson_learned: null });
  });

  it('narrow auto-hide (model says importance 0) does not hide a row approved during the call', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(id);
      return { type: 'bugfix', importance: 0, title: 'MODEL title', narrative: 'MODEL narrative' };
    });
    await executeReenrich(db, 10, { scope: 'narrow' });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    const row = db
      .prepare('SELECT narrative, COALESCE(compressed_into, 0) AS c FROM observations WHERE id = ?')
      .get(id);
    expect(row).toEqual({ narrative: APPROVED, c: 0 });
  });

  it('and an approved row is not a candidate at all afterwards', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const id = seed();
    expect(findReenrichCandidates(db, 10, { scope: 'narrow' }).map((c) => c.id)).toContain(id); // premise
    approveEdit(id);
    for (const scope of ['narrow', 'wide']) {
      expect(findReenrichCandidates(db, 10, { scope }).map((c) => c.id)).not.toContain(id);
    }
  });
});

describe('cluster-merge does not fold away an approval that landed during its model call', () => {
  it('aborts the merge and leaves both rows as they are', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    const a = seed();
    const b = seed({ title: 'Race in balance deduction (dup)', importance: 1 });
    const cluster = db
      .prepare(
        'SELECT id, title, narrative, project, type, access_count, importance, created_at_epoch, minhash_sig, lesson_learned, concepts, facts FROM observations WHERE id IN (?, ?)',
      )
      .all(a, b);
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(a);
      return {
        should_merge: true,
        merged_title: 'MODEL merged title',
        merged_narrative: 'MODEL merged narrative',
        merged_concepts: [],
        merged_facts: [],
        merged_lesson: null,
        importance: 2,
      };
    });
    const res = await executeMergeCluster(db, cluster);
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    expect(res.merged).toBe(false);
    const rows = db
      .prepare(
        'SELECT id, narrative, COALESCE(compressed_into, 0) AS compressed_into, superseded_at FROM observations WHERE id IN (?, ?) ORDER BY id',
      )
      .all(a, b);
    expect(rows).toEqual([
      { id: a, narrative: APPROVED, compressed_into: 0, superseded_at: null },
      { id: b, narrative: LONG, compressed_into: 0, superseded_at: null },
    ]);
  });
});
