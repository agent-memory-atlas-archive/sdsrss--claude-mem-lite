// d366 gap 1: CJK text in EVENTS was unsearchable, even by its exact title.
//
// unicode61 indexes a whole CJK run as ONE token, and the query side reduces CJK to dictionary
// words + bigrams (nlp.mjs). Observations bridge the two by appending the run's segmentation to
// their indexed `text` column; events_fts indexed title/body raw, so `activity search` and the
// events leg of `search` matched a CJK event only when the query happened to equal a whole run.
// events now carry `search_terms` (the same segmentation), indexed as a fifth events_fts column.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { initSchema, runDeferredCleanups, backfillEventSearchTerms } from '../schema.mjs';
import { saveEvent, searchEvents } from '../lib/activity.mjs';
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

const P = 'parent--cjkevents';
let db;
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
});

const titles = (rows) => rows.map((r) => r.title);

async function pipelineEvents(d, query) {
  const res = await coreRunSearchPipeline(
    {
      db: d,
      currentProject: P,
      env: {},
      searchObservationsHybrid,
      deepSearch: async () => ({ rows: [] }),
      shouldEscalateToDeep: () => false,
      autoDeepLlmReady: () => false,
      reRankWithContext: async (rows) => rows,
      llm: null,
    },
    {
      query,
      ftsQuery: buildSearchFtsQuery(query),
      effectiveSource: 'events',
      deepMode: 'normal',
      rerank: false,
      limit: 10,
      offset: 0,
      project: P,
      obsType: null,
      sort: 'relevance',
      obsTypeScoped: false,
      obsTypeFallback: false,
      crossSourceEpochSortNoFts: false,
      rerankPolicy: 'cli',
      rerankProject: P,
      recentListingNoFts: false,
      tolerateMissingFts: false,
      tierPosition: 'early',
      tierProject: P,
    },
  );
  return res.page.filter((r) => r.source === 'event');
}

describe('events CJK search (d366 gap 1)', () => {
  it('finds a CJK event by a substring of its title and by the exact title', () => {
    db = createTestDb();
    saveEvent(db, { project: P, event_type: 'bugfix', title: '修复连接池泄漏问题', body: 'pool drained' });
    expect(titles(searchEvents(db, '连接池', { project: P }))).toEqual(['修复连接池泄漏问题']);
    expect(titles(searchEvents(db, '修复连接池泄漏问题', { project: P }))).toEqual(['修复连接池泄漏问题']);
  });

  it('finds a CJK event by a substring of its body', () => {
    db = createTestDb();
    saveEvent(db, {
      project: P,
      event_type: 'discovery',
      title: 'Scorer layout',
      body: 'unified_scorer.py 负责统一买点评分，weight_loader 只加载权重',
    });
    expect(titles(searchEvents(db, '买点评分', { project: P }))).toEqual(['Scorer layout']);
  });

  it('the search pipeline events leg returns the CJK event', async () => {
    db = createTestDb();
    saveEvent(db, { project: P, event_type: 'bugfix', title: '修复连接池泄漏问题', body: null });
    const rows = await pipelineEvents(db, '连接池');
    expect(rows.map((r) => r.title)).toEqual(['修复连接池泄漏问题']);
  });

  it('a CJK query whose answer is absent returns no event (holdout)', () => {
    db = createTestDb();
    saveEvent(db, { project: P, event_type: 'bugfix', title: '修复连接池泄漏问题', body: null });
    saveEvent(db, { project: P, event_type: 'feature', title: '新增导出功能', body: '支持导出为表格' });
    expect(searchEvents(db, '缓存击穿', { project: P })).toEqual([]);
  });

  it('English events index no extra terms and keep their hits', () => {
    db = createTestDb();
    const id = saveEvent(db, {
      project: P,
      event_type: 'bugfix',
      title: 'zirconium coupling fix',
      body: 'guard',
    });
    expect(db.prepare('SELECT search_terms FROM events WHERE id = ?').get(id).search_terms).toBe('');
    expect(titles(searchEvents(db, 'zirconium', { project: P }))).toEqual(['zirconium coupling fix']);
  });

  it('an existing DB (4-column events_fts, no search_terms) is backfilled and searchable after open', () => {
    db = createTestDb();
    // Recreate the pre-d366 shape: narrow index, old triggers, no search_terms column.
    db.exec(`DROP TRIGGER IF EXISTS events_fts_ai`);
    db.exec(`DROP TRIGGER IF EXISTS events_fts_ad`);
    db.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
    db.exec(`DROP TABLE IF EXISTS events_fts`);
    try {
      db.exec(`ALTER TABLE events DROP COLUMN search_terms`);
    } catch {
      /* base tree: the column never existed */
    }
    db.exec(`
      CREATE VIRTUAL TABLE events_fts USING fts5(
        title, body, event_type UNINDEXED, project UNINDEXED,
        content='events', content_rowid='id',
        tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
      );
      CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, title, body, event_type, project)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
      END;
    `);
    db.prepare(
      `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, 'bugfix', ?, ?, 2, ?)`,
    ).run(P, '修复连接池泄漏问题', '连接池在高并发下耗尽', Date.now());
    expect(searchEvents(db, '连接池', { project: P })).toEqual([]); // the gap, on the legacy shape

    // The next open, as ensureDb runs it: the pass adds the column and the index, then the
    // deferred cleanups and the events backfill.
    initSchema(db);
    runDeferredCleanups(db);
    backfillEventSearchTerms(db);

    expect(titles(searchEvents(db, '连接池', { project: P }))).toEqual(['修复连接池泄漏问题']);
    expect(titles(searchEvents(db, '高并发', { project: P }))).toEqual(['修复连接池泄漏问题']);
  });
});
