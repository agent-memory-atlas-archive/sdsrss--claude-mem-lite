// d366 gap 2 (write side): a Latin identifier or number glued to CJK — `修复了redis连接池泄漏` —
// was unreachable by its Latin part. unicode61 indexes the whole mixed run as ONE token, and the
// write path appended only CJK bigrams, so neither `redis` nor any other term the query side can
// produce ever matched that row unless `redis` also stood alone somewhere in it.
//
// The write path now appends the glued ASCII runs next to the bigrams (nlp.mjs cjkIndexTerms),
// at every writer that appended bigrams, and a one-shot cleanup fills rows written before it.
// New names are imported inside the cases that need them, so on a tree without them each case
// fails on its own assertion instead of the whole file failing to load.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { runDeferredCleanups, backfillEventSearchTerms } from '../schema.mjs';
import { saveEvent, searchEvents } from '../lib/activity.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { looksAlreadyDerived } from '../lib/observation-write.mjs';
import { cjkBigrams } from '../nlp.mjs';
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

const P = 'parent--gluedlatin';
let db;
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
});

async function obsHits(d, query) {
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
      effectiveSource: 'observations',
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
  return res.page.filter((r) => r.source === 'obs').map((r) => r.id);
}

describe('cjkIndexTerms', () => {
  it('appends the ASCII run glued to CJK, after the CJK segmentation', async () => {
    const { cjkIndexTerms } = await import('../nlp.mjs');
    const terms = cjkIndexTerms('修复了redis连接池泄漏').split(' ');
    expect(terms).toContain('redis');
    for (const bg of cjkBigrams('修复了redis连接池泄漏').split(' ')) expect(terms).toContain(bg);
  });

  it('keeps number runs of two or more characters, and skips a run that already stands alone', async () => {
    const { cjkIndexTerms } = await import('../nlp.mjs');
    const terms = cjkIndexTerms('沪深300 最大1000条 5分钟 redis 修复了redis连接池').split(' ');
    expect(terms).toContain('300');
    expect(terms).toContain('1000');
    expect(terms).not.toContain('5');
    expect(terms).not.toContain('redis');
  });

  it('adds nothing to text with no CJK, and equals cjkBigrams for pure CJK', async () => {
    const { cjkIndexTerms } = await import('../nlp.mjs');
    expect(cjkIndexTerms('redis pool drained under load')).toBe('');
    expect(cjkIndexTerms('连接池在高并发下耗尽')).toBe(cjkBigrams('连接池在高并发下耗尽'));
  });
});

describe('glued Latin is searchable (d366 gap 2, write side)', () => {
  it('a saved observation is found by the Latin run glued into its text, and only that row', async () => {
    db = createTestDb();
    const hit = saveObservation(db, { project: P, type: 'bugfix', content: '修复了redis连接池泄漏' });
    const miss = saveObservation(db, {
      project: P,
      type: 'bugfix',
      content: '修复了连接池泄漏，换成新的实现',
    });
    expect(hit.kind).toBe('saved');
    expect(miss.kind).toBe('saved');
    expect(await obsHits(db, 'redis')).toEqual([hit.id]);
  });

  it('a saved event is found by the Latin run glued into its title', () => {
    db = createTestDb();
    saveEvent(db, { project: P, event_type: 'discovery', title: '估算token用量的方法', body: null });
    expect(searchEvents(db, 'token', { project: P }).map((r) => r.title)).toEqual(['估算token用量的方法']);
  });

  it('a hook-derived text blob still reads as derived when its title carries a glued run', async () => {
    const { cjkIndexTerms } = await import('../nlp.mjs');
    const title = '修复了redis连接池泄漏';
    const row = { title, narrative: '', concepts: 'pool', text: `pool ${cjkIndexTerms(title)}` };
    expect(looksAlreadyDerived(row)).toBe(true);
  });
});

describe('rows written before the change are backfilled once', () => {
  it('an observation gets its glued run appended to text, once', async () => {
    db = createTestDb();
    const content = '修复了redis连接池泄漏';
    // The pre-d366 write shape: content + CJK bigrams, no glued run.
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES ('s-old', 's-old', ?, ?, ?, 'completed')`,
    ).run(P, new Date().toISOString(), Date.now());
    const id = Number(
      db
        .prepare(
          `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, created_at, created_at_epoch, importance)
           VALUES ('s-old', ?, ?, 'bugfix', ?, ?, ?, ?, 2)`,
        )
        .run(P, `${content} ${cjkBigrams(content)}`, content, content, new Date().toISOString(), Date.now())
        .lastInsertRowid,
    );
    db.prepare(`DELETE FROM migration_cleanups`).run();
    expect(await obsHits(db, 'redis')).toEqual([]); // the gap, on the legacy shape

    runDeferredCleanups(db);
    expect(await obsHits(db, 'redis')).toEqual([id]);
    const once = db.prepare('SELECT text FROM observations WHERE id = ?').get(id).text;

    db.prepare(`DELETE FROM migration_cleanups`).run();
    runDeferredCleanups(db); // a forced re-run must not append it again
    expect(db.prepare('SELECT text FROM observations WHERE id = ?').get(id).text).toBe(once);
    expect(once.split(' ').filter((t) => t === 'redis')).toHaveLength(1);
  });

  // Events are filled by backfillEventSearchTerms, from NULL (every event a pre-d366 build wrote);
  // no release wrote bigram-only search_terms, so nothing recomputes a filled row.
  it('an event a pre-d366 build wrote (no search_terms) is found by its glued run after the backfill', () => {
    db = createTestDb();
    const id = saveEvent(db, {
      project: P,
      event_type: 'discovery',
      title: '估算token用量的方法',
      body: null,
    });
    db.prepare(`UPDATE events SET search_terms = NULL WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM migration_cleanups`).run();
    expect(searchEvents(db, 'token', { project: P })).toEqual([]);

    backfillEventSearchTerms(db);
    expect(searchEvents(db, 'token', { project: P }).map((r) => r.id)).toEqual([id]);
  });
});
