// d366 gap 2 (query side): a whitespace token that mixes CJK with ASCII and holds no dictionary
// word — `redis连接池`, `估算token`, `docs/measurement/，其余` — was kept WHOLE. That whole token is
// a required strict-AND term no index entry can satisfy (unicode61 stores a glued run as one
// token only when the document glues the very same characters), so strict FTS returned 0 and a
// single-token query had no OR fallback at all. It is now split the way the write side indexes
// it: the ASCII runs (nlp.mjs ASCII_RUN, the extraction gluedAsciiRuns uses) plus the CJK
// bigrams. The dictionary branch takes its Latin runs from the same extraction, so a run with
// digits (`redis6`) is queried as the write side stores it.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { sanitizeFtsQuery, ftsQueryTokens } from '../nlp.mjs';
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

const P = 'parent--mixedsplit';
let db;
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
});

async function obsSearch(d, query) {
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
  return { ids: res.page.filter((r) => r.source === 'obs').map((r) => r.id), relaxed: res.orFallbackFired };
}

describe('mixed CJK+ASCII query tokens without a dictionary word (d366 gap 2, query side)', () => {
  it('are split into the ASCII run and the CJK bigrams, not kept whole', () => {
    const { tokens } = ftsQueryTokens('redis连接池');
    expect(tokens).toContain('redis');
    expect(tokens).toContain('连接');
    expect(tokens).not.toContain('redis连接池');
  });

  it('a punctuation-joined token is split too', () => {
    const { tokens } = ftsQueryTokens('docs/measurement/，其余');
    expect(tokens).toEqual(expect.arrayContaining(['docs', 'measurement', '其余']));
  });

  it('the dictionary branch keeps digits in the run, as the write side indexes it', () => {
    expect(ftsQueryTokens('redis6缓存问题').tokens).toContain('redis6');
  });

  it('a glued query finds the glued row under STRICT AND, and only that row', async () => {
    db = createTestDb();
    const hit = saveObservation(db, { project: P, type: 'bugfix', content: '修复了redis连接池泄漏' });
    saveObservation(db, { project: P, type: 'bugfix', content: '连接池泄漏的另一次排查记录' });
    const { ids, relaxed } = await obsSearch(db, 'redis连接池');
    expect(relaxed).toBe(false);
    expect(ids).toEqual([hit.id]);
  });

  it('the Latin run stays a required strict-AND term', () => {
    const strict = sanitizeFtsQuery('xyzAbc不存在');
    expect(strict.split(/\s+/)).toContain('xyzabc');
    const t = createTestDb();
    try {
      t.exec(`CREATE VIRTUAL TABLE probe USING fts5(content)`);
      t.prepare('INSERT INTO probe(content) VALUES (?)').run('这个配置项不存在 不存 存在');
      expect(t.prepare('SELECT count(*) c FROM probe WHERE probe MATCH ?').get(strict).c).toBe(0);
    } finally {
      t.close();
    }
  });
});
