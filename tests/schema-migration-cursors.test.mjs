// migration_cursors (D#395): the progress of a deferred cleanup that works across opens, one row
// per cleanup (`name`, the id its walk continues below). Additive and without a
// CURRENT_SCHEMA_VERSION bump, like idx_events_terms_pending: the table is created by the first
// batch of backfillObservationIndexTerms rather than by the migration pass, because the pass is
// unreachable on a store whose version row already says 49, and a bump would lock every older
// code home out of the store (lib/schema-skew.mjs). An older build never reads the table.
//
// This file MUST set CLAUDE_MEM_DIR and dynamic-import schema.mjs before anything binds DB_DIR,
// so ensureDb() opens a sandbox store and never the user's.

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mem-cursors-'));
process.env.CLAUDE_MEM_DIR = tmp;
const { ensureDb, initSchema, CURRENT_SCHEMA_VERSION } = await import('../schema.mjs');
const { cjkBigrams } = await import('../nlp.mjs');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const hasTable = (d) =>
  !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_cursors'`).get();
const version = (d) => d.prepare('SELECT version FROM schema_version LIMIT 1').get().version;

describe('migration_cursors', () => {
  it('is not created by the migration pass, and the version stays at CURRENT_SCHEMA_VERSION', () => {
    const d = new Database(':memory:');
    initSchema(d);
    expect(hasTable(d)).toBe(false);
    expect(version(d)).toBe(CURRENT_SCHEMA_VERSION);
    d.close();
  });

  it('is created by the first open of a 6.28.1 store and walks it to the end across opens', () => {
    // A 6.28.1 store: migrated, the glued-runs cleanup done, observations written before D#374.
    const seed = ensureDb();
    seed.prepare(`DELETE FROM migration_cleanups WHERE name = 'backfill-cjk-index-terms'`).run();
    seed.exec(`DROP TABLE IF EXISTS migration_cursors`);
    seed
      .prepare(
        `INSERT OR IGNORE INTO migration_cleanups (name, done_at_epoch) VALUES ('backfill-glued-ascii-runs', 1)`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
         VALUES ('s', 's', 'p--x', ?, ?, 'completed')`,
      )
      .run(new Date().toISOString(), Date.now());
    const ins = seed.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, lesson_learned, created_at, created_at_epoch)
       VALUES ('s', 'p--x', ?, 'bugfix', ?, ?, ?, ?)`,
    );
    const n = 3000;
    seed.transaction(() => {
      for (let i = 0; i < n; i++) {
        const title = `连接池泄漏第${i}次`;
        ins.run(
          `${title} ${cjkBigrams(title)}`,
          title,
          `缓存键缺少租户前缀`,
          new Date().toISOString(),
          Date.now(),
        );
      }
    })();
    expect(hasTable(seed), 'premise: the 6.28.1 shape has no cursor table').toBe(false);
    seed.close();

    const first = ensureDb();
    expect(hasTable(first)).toBe(true);
    const cursor = first
      .prepare(`SELECT below_id FROM migration_cursors WHERE name = 'backfill-cjk-index-terms'`)
      .get();
    expect(cursor.below_id).toBeGreaterThanOrEqual(1);
    expect(version(first)).toBe(CURRENT_SCHEMA_VERSION);
    first.close();

    let opens = 1;
    for (;;) {
      const d = ensureDb();
      const done = !!d
        .prepare(`SELECT 1 FROM migration_cleanups WHERE name = 'backfill-cjk-index-terms'`)
        .get();
      const left = d
        .prepare(`SELECT COUNT(*) AS c FROM observations WHERE (' ' || text || ' ') NOT LIKE '% 租户 %'`)
        .get().c;
      d.close();
      if (done) {
        expect(left).toBe(0);
        break;
      }
      opens++;
      expect(opens, 'the walk finishes').toBeLessThan(200);
    }
    const d = new Database(join(tmp, 'claude-mem-lite.db'));
    expect(d.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    d.close();
  });
});
