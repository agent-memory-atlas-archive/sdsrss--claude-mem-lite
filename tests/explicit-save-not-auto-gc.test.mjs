// An explicit save (mem_save / `save` / /lesson / /bug — the `manual-` writer) is never hidden or
// queued for deletion by the idle passes. Before (E2E 2026-10-16, bg P1-5 / cli F6): an
// importance-3 save without a lesson — a discovery or change, which save-enrich does not give one
// — was decayed 3→2→1, hidden, queued and hard-deleted about 41 days after it was written, while
// Key Context showed it every session (that face does not count as an injection). Decay may still
// lower its importance; only the GC chain skips it. One case per writer: a single mutation for
// several sites would prove nothing about each.

import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_AUTO } from '../utils.mjs';
import {
  decayAndMarkIdle,
  markAutoCompressible,
  maintenanceStats,
  HIDE_GRACE_MS,
  STALE_AGE_MS,
} from '../lib/maintain-core.mjs';
import { runIdleCleanup } from '../search-scoring.mjs';

const DAY = 86400000;
const ctx = { projectFilter: '', baseParams: [], staleAge: Date.now() - STALE_AGE_MS, opCap: 1000 };
const col = (db, id, c) => db.prepare(`SELECT ${c} AS v FROM observations WHERE id = ?`).get(id)?.v;

/** An explicit save and a hook-written row of the same idle shape: the only difference is the writer. */
function seed({ title = 'old idle row', type = 'discovery', ageDays = 120 } = {}) {
  const db = createTestDb();
  insertSession(db, { id: 'manual-p', project: 'p' });
  insertSession(db, { id: 'hook-sess', project: 'p' });
  const mk = (sessionId, t) =>
    Number(
      insertObs(db, { sessionId, project: 'p', type, title: t, importance: 1, epochOffset: -ageDays * DAY })
        .lastInsertRowid,
    );
  return {
    db,
    manual: mk('manual-p', `${title} saved by hand`),
    hook: mk('hook-sess', `${title} from a hook`),
  };
}

describe('the idle GC passes skip explicit saves', () => {
  it('decayAndMarkIdle: hides the hook row, not the explicit save', () => {
    const { db, manual, hook } = seed();
    decayAndMarkIdle(db, ctx);
    expect(col(db, hook, 'compressed_into')).toBe(COMPRESSED_AUTO); // premise
    expect(col(db, manual, 'compressed_into') ?? 0).toBe(0);
    db.close();
  });

  it('decayAndMarkIdle: does not queue an explicit save hidden before this release', () => {
    const { db, manual } = seed();
    db.prepare(
      `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = ? WHERE id = ?`,
    ).run(Date.now() - HIDE_GRACE_MS - DAY, manual);
    decayAndMarkIdle(db, ctx);
    expect(col(db, manual, 'compressed_into')).toBe(COMPRESSED_AUTO);
    db.close();
  });

  it('maintenanceStats: the stale forecast counts what the hide pass hides', () => {
    const { db } = seed();
    const stats = maintenanceStats(db, ctx);
    expect(stats.stale).toBe(1);
    expect(decayAndMarkIdle(db, ctx).idleHidden).toBe(stats.stale);
    db.close();
  });

  it('markAutoCompressible aged pass', () => {
    const { db, manual, hook } = seed();
    markAutoCompressible(db, 'p');
    expect(col(db, hook, 'compressed_into')).toBe(COMPRESSED_AUTO);
    expect(col(db, manual, 'compressed_into') ?? 0).toBe(0);
    db.close();
  });

  it('markAutoCompressible low-signal pass', () => {
    const { db, manual, hook } = seed({ title: 'Modified config.yml', ageDays: 10 });
    markAutoCompressible(db, 'p');
    expect(col(db, hook, 'compressed_into')).toBe(COMPRESSED_AUTO);
    expect(col(db, manual, 'compressed_into') ?? 0).toBe(0);
    db.close();
  });

  it('runIdleCleanup (MCP idle timer)', () => {
    const { db, manual, hook } = seed();
    runIdleCleanup(db);
    expect(col(db, hook, 'compressed_into')).toBe(COMPRESSED_AUTO);
    expect(col(db, manual, 'compressed_into') ?? 0).toBe(0);
    db.close();
  });
});
