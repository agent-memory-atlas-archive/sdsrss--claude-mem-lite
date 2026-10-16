// An explicit save (mem_save / `save` / /lesson / /bug — the `manual-` writer) is never hidden or
// queued for deletion by the idle passes. Before (E2E 2026-10-16, bg P1-5 / cli F6): an
// importance-3 save without a lesson — a discovery or change, which save-enrich does not give one
// — was decayed 3→2→1, hidden, queued and hard-deleted about 41 days after it was written, while
// Key Context showed it every session (that face does not count as an injection). Decay may still
// lower its importance; only the GC chain skips it. One case per writer: a single mutation for
// several sites would prove nothing about each.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import { COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE } from '../utils.mjs';
import {
  decayAndMarkIdle,
  markAutoCompressible,
  maintenanceStats,
  purgeStale,
  purgeStalePreview,
  hardDeleteCandidateCount,
  HIDE_GRACE_MS,
  STALE_AGE_MS,
} from '../lib/maintain-core.mjs';
import { runIdleCleanup } from '../search-scoring.mjs';
import { findSmartCompressCandidates } from '../hook-optimize.mjs';

const HOOK = resolve(import.meta.dirname, '../hook.mjs');
const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

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

  // Was "stays hidden, not queued"; since round 2 such a row is shown again (case below).
  it('decayAndMarkIdle: does not queue an explicit save hidden before this release', () => {
    const { db, manual } = seed();
    db.prepare(
      `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = ? WHERE id = ?`,
    ).run(Date.now() - HIDE_GRACE_MS - DAY, manual);
    decayAndMarkIdle(db, ctx);
    expect(col(db, manual, 'compressed_into') ?? 0).not.toBe(COMPRESSED_PENDING_PURGE);
    db.close();
  });

  // Round 2 (data S8): decay is the one GC step explicit saves still take, and `maintain scan`
  // did not forecast it ("Decayed 2" from an execute the preview never mentioned).
  it('maintenanceStats: the decay forecast counts what the decay pass lowers', () => {
    const { db, manual, hook } = seed();
    db.prepare('UPDATE observations SET importance = 3 WHERE id IN (?, ?)').run(manual, hook);
    const stats = maintenanceStats(db, ctx);
    expect(stats.decayable).toBe(2);
    expect(decayAndMarkIdle(db, ctx).decayed).toBe(stats.decayable);
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

// E2E 2026-10-16 round 2 (data S1/S2, hooks STILL-BROKEN-3): the exemption missed the passes
// that run past 60 days and the rows an earlier release had already hidden or queued.
describe('explicit saves past 60 days, and those an earlier release took', () => {
  it('purgeStale does not delete an explicit save an earlier release queued', () => {
    const { db, manual, hook } = seed();
    db.prepare(
      `UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE} WHERE id IN (?, ?)`,
    ).run(manual, hook);
    const cutoff = Date.now() - 30 * DAY;
    expect(purgeStalePreview(db, ctx, cutoff).candidates).toBe(1);
    expect(purgeStale(db, ctx, cutoff)).toBe(1);
    expect(col(db, hook, 'id')).toBeUndefined(); // premise: the machine row went
    expect(col(db, manual, 'id')).toBe(manual);
    db.close();
  });

  it('decayAndMarkIdle shows again an explicit save an earlier release hid or queued', () => {
    const { db, manual, hook } = seed();
    const second = Number(
      insertObs(db, { sessionId: 'manual-p', project: 'p', title: 'queued by hand', epochOffset: -120 * DAY })
        .lastInsertRowid,
    );
    db.prepare(
      `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = ? WHERE id IN (?, ?)`,
    ).run(Date.now() - DAY, manual, hook);
    db.prepare(`UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE} WHERE id = ?`).run(
      second,
    );
    const r = decayAndMarkIdle(db, ctx);
    expect(r.restoredExplicit).toBe(2);
    expect(col(db, manual, 'compressed_into') ?? 0).toBe(0);
    expect(col(db, manual, 'hidden_at') ?? null).toBeNull();
    expect(col(db, second, 'compressed_into') ?? 0).toBe(0);
    expect(col(db, hook, 'compressed_into')).toBe(COMPRESSED_AUTO); // a machine row stays hidden
    db.close();
  });

  // Round 3 (data REG-1): scan still counted explicit saves under "Pending purge … purge_stale
  // deletes them" and "Hidden", which purge now skips and decay shows again; the snapshot gate
  // counted them as hard-delete candidates too.
  it("maintain scan's hidden / pending-purge counts match what execute does", () => {
    const { db, manual, hook } = seed();
    const second = Number(
      insertObs(db, { sessionId: 'manual-p', project: 'p', title: 'queued by hand', epochOffset: -120 * DAY })
        .lastInsertRowid,
    );
    db.prepare(
      `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = ? WHERE id IN (?, ?)`,
    ).run(Date.now() - DAY, manual, hook);
    db.prepare(`UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE} WHERE id = ?`).run(
      second,
    );
    const stats = maintenanceStats(db, ctx);
    expect(stats.hidden).toBe(1); // the hook row
    expect(stats.pendingPurge).toBe(0);
    expect(stats.explicitToShowAgain).toBe(2);
    expect(hardDeleteCandidateCount(db, ctx, { purge: true })).toBe(0);
    expect(decayAndMarkIdle(db, ctx).restoredExplicit).toBe(stats.explicitToShowAgain);
    db.close();
  });

  it('smart-compress candidates leave explicit saves out', () => {
    const { db, manual, hook } = seed({ ageDays: 40 });
    const ids = findSmartCompressCandidates(db, 30, { project: 'p' }).map((r) => r.id);
    expect(ids).toContain(hook);
    expect(ids).not.toContain(manual);
    db.close();
  });

  it('the daily auto-compress worker folds machine rows, not explicit saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-autocompress-explicit-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    const db = new Database(join(dir, 'claude-mem-lite.db'));
    db.pragma('journal_mode = WAL');
    initSchema(db);
    insertSession(db, { id: 'manual-p', project: 'p' });
    insertSession(db, { id: 'hook-sess', project: 'p' });
    // One ISO week, 70 days back; three of each writer, so either group alone could compress.
    const base = -70 * DAY;
    const manual = [0, 1, 2].map((i) =>
      Number(
        insertObs(db, {
          sessionId: 'manual-p',
          project: 'p',
          title: `hand note ${i}`,
          epochOffset: base + i * 1000,
        }).lastInsertRowid,
      ),
    );
    const hook = [0, 1, 2].map((i) =>
      Number(
        insertObs(db, {
          sessionId: 'hook-sess',
          project: 'p',
          title: `hook note ${i}`,
          epochOffset: base + i * 1000,
        }).lastInsertRowid,
      ),
    );
    db.close();
    const env = { ...process.env, HOME: join(dir, 'home'), CLAUDE_MEM_DIR: dir, MEM_NO_AUTO_ADOPT: '1' };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [HOOK, 'auto-compress'], { env, encoding: 'utf8', timeout: 30000 });
    expect(r.status, r.stderr).toBe(0);
    const check = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
    const ci = (id) =>
      check.prepare('SELECT compressed_into AS v FROM observations WHERE id = ?').get(id).v ?? 0;
    expect(
      hook.map(ci).every((v) => v > 0),
      'premise: the machine rows were compressed',
    ).toBe(true);
    expect(manual.map(ci)).toEqual([0, 0, 0]);
    check.close();
  });
});
