// D#374 precondition: CJK inside an observation's side fields — lesson_learned, facts, concepts,
// search_aliases — was unreachable by any part of it. unicode61 stores a CJK run as ONE token and
// the writers appended CJK index terms (nlp.mjs cjkIndexTerms) for title + narrative only, so a
// query for `泄漏` never matched a lesson reading `连接池泄漏的根因`. 25 of 406 live observations
// carried CJK there (d366 baseline, 2026-10-16). Every writer that builds `text` now takes the
// index terms of the side fields it writes too, and the update rebuild keeps them.
// New behaviour is asserted per writer, so each site can be broken on its own.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  callModelJSON: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));

import { callModelJSONAsync } from '../haiku-client.mjs';
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';
import { cjkIndexTerms } from '../nlp.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const P = 'parent--cjkside';
let db;
beforeEach(() => {
  db = createTestDb();
  insertSession(db, { id: 'sess-1', project: P });
  callModelJSONAsync.mockReset();
});
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
});

async function obsHits(query) {
  const res = await coreRunSearchPipeline(
    {
      db,
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

const LONG_EN =
  'The pool handed out connections that were never returned after a failed command, so the service ran out of them under load during the nightly batch.';

describe('CJK in side fields is searchable', () => {
  it('hook capture: CJK in the lesson and in facts', async () => {
    const { saveObservation } = await import('../hook-llm.mjs');
    const id = saveObservation(
      {
        type: 'bugfix',
        title: 'Pool connections leaked after failed commands',
        narrative: LONG_EN,
        concepts: ['pool'],
        facts: ['缓存穿透时回源打满'],
        lessonLearned: '连接池泄漏的根因是异常路径没有归还',
        importance: 2,
      },
      P,
      'sess-1',
      db,
    );
    expect(id).toBeGreaterThan(0);
    expect(await obsHits('泄漏')).toEqual([id]);
    expect(await obsHits('穿透')).toEqual([id]);
  });

  it('re-enrich: CJK in the model lesson', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { project: P, type: 'bugfix', importance: 1, title: 'Modified pool.js', narrative: 'x' });
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Pool connections leaked',
      narrative: 'connections were not returned',
      concepts: ['pool'],
      facts: [],
      importance: 2,
      lesson_learned: '事务隔离级别过低导致脏读',
      search_aliases: [],
    });
    expect((await executeReenrich(db, 10)).processed).toBe(1);
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    expect(await obsHits('隔离')).toEqual([id]);
  });

  it('cluster merge: CJK in the merged lesson', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { project: P, title: 'Fix deadlock in worker A', narrative: 'lock order', accessCount: 3 });
    insertObs(db, {
      project: P,
      title: 'Fix deadlock in worker B',
      narrative: 'lock order again',
      accessCount: 1,
    });
    const members = db.prepare('SELECT * FROM observations ORDER BY id').all();
    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'Fix worker deadlocks',
      merged_narrative: 'Both workers took the two locks in opposite order.',
      merged_concepts: ['deadlock'],
      merged_facts: [],
      merged_lesson: '两个线程加锁顺序颠倒',
      importance: 2,
    });
    expect((await executeMergeCluster(db, members)).merged).toBe(true);
    expect(await obsHits('颠倒')).toEqual([members[0].id]);
  });

  it('smart compress: CJK in the summary lesson and aliases', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const old = -40 * 86400000;
    insertObs(db, { project: P, title: 'Updated pool.js', narrative: 'tuning', epochOffset: old });
    insertObs(db, { project: P, title: 'Fixed pool.js leak', narrative: 'release', epochOffset: old - 1000 });
    insertObs(db, { project: P, title: 'Linted pool.js', narrative: 'style', epochOffset: old - 2000 });
    const members = db.prepare('SELECT * FROM observations ORDER BY id').all();
    callModelJSONAsync.mockResolvedValue({
      should_compress: true,
      title: 'pool.js maintenance',
      narrative: 'Tuning and a leak fix in pool.js.',
      concepts: ['pool'],
      facts: [],
      lesson_learned: '内存泄漏先排查未归还的连接',
      search_aliases: ['连接池调优'],
    });
    const result = await executeSmartCompressCluster(db, members, P);
    expect(result.compressed).toBe(true);
    expect(await obsHits('排查')).toEqual([result.summaryId]);
    expect(await obsHits('调优')).toEqual([result.summaryId]);
  });

  it('save-time enrichment: CJK in the lesson it writes', async () => {
    const { saveObservation } = await import('../lib/save-observation.mjs');
    const { executeSaveEnrich } = await import('../lib/save-enrich.mjs');
    const saved = saveObservation(db, {
      project: P,
      type: 'bugfix',
      title: 'Slow report query',
      content: LONG_EN,
    });
    expect(saved.kind).toBe('saved');
    const res = await executeSaveEnrich(db, saved.id, {
      callJson: async () => ({
        lesson_learned: '联合索引失效导致全表扫描',
        search_aliases: [],
        scope: 'module',
      }),
      acquire: async () => true,
      release: () => {},
    });
    expect(res.enriched).toBe(true);
    expect(await obsHits('失效')).toEqual([saved.id]);
  });

  it('an update keeps CJK in the lesson searchable', async () => {
    const { saveObservation } = await import('../lib/save-observation.mjs');
    const { applyObsUpdate } = await import('../lib/observation-write.mjs');
    const saved = saveObservation(db, {
      project: P,
      type: 'bugfix',
      title: 'Report query timed out',
      content: LONG_EN,
      lesson_learned: '慢查询要先看执行计划',
    });
    expect(await obsHits('执行'), 'premise: the save indexes its lesson').toEqual([saved.id]);
    applyObsUpdate(db, saved.id, { importance: 3 });
    expect(await obsHits('执行')).toEqual([saved.id]);
  });
});

// Pre-tag review 2026-10-17 F10: two writers outside the four side fields indexed no CJK terms.
describe('CJK in a weekly summary and an imported body is searchable', () => {
  it('a weekly summary is found by a substring of a member title', async () => {
    const { compressGroup } = await import('../lib/compress-core.mjs');
    for (const t of ['连接池泄漏修复', '缓存击穿排查', '索引重建完成'])
      insertObs(db, { project: P, title: t, narrative: 'x', epochOffset: -40 * 86400000 });
    const members = db.prepare('SELECT * FROM observations ORDER BY id').all();
    const { summaryId } = compressGroup(db, P, members);
    expect(await obsHits('击穿')).toEqual([summaryId]);
  });

  it('an imported tool call is found by a substring of its CJK output', async () => {
    const { importJsonl } = await import('../lib/import-jsonl.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cjk-import-'));
    try {
      const file = join(dir, 't.jsonl');
      const line = (o) => JSON.stringify({ sessionId: 'imp-1', timestamp: '2026-10-16T10:00:00Z', ...o });
      writeFileSync(
        file,
        [
          line({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }],
            },
          }),
          line({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'u1', content: '测试失败：连接池泄漏导致超时' }],
            },
          }),
        ].join('\n') + '\n',
      );
      await importJsonl(db, file, { project: P });
      const id = db.prepare(`SELECT id FROM observations WHERE narrative LIKE '%连接池%'`).get()?.id;
      expect(id, 'premise: the tool call was imported').toBeGreaterThan(0);
      expect(await obsHits('超时')).toEqual([id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a hook-written text blob still reads as derived', () => {
  it('when its CJK index terms come from concepts and the lesson', async () => {
    const { looksAlreadyDerived } = await import('../lib/observation-write.mjs');
    const row = {
      title: 'Pool leak',
      narrative: '',
      concepts: '连接池 redis连接池',
      lesson_learned: '异常路径没有归还连接',
      text: `连接池 redis连接池 ${cjkIndexTerms('连接池 redis连接池 异常路径没有归还连接')}`,
    };
    expect(looksAlreadyDerived(row)).toBe(true);
  });
});
