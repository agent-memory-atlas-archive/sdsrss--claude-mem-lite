// D#380: provenance is per row (memory_session_id), so a lesson a model distilled onto an explicit
// save — save-time enrichment, or the narrow/wide re-enrich retrying it — read as the person's
// own: no mark anywhere. Such a lesson now starts with the mark search already uses for
// machine-written rows, and get's header says what it means.

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
import { saveObservation } from '../lib/save-observation.mjs';
import { executeSaveEnrich } from '../lib/save-enrich.mjs';
import { autoHeaderNote, markAutoLesson } from '../lib/provenance.mjs';

const P = 'parent--autolesson';
const LONG =
  'The export command now streams rows in fixed-size batches of 500 instead of loading the whole table, which kept memory flat on a 2 GB store during the staging run.';
let db;
beforeEach(() => {
  db = createTestDb();
  insertSession(db, { id: 'sess-1', project: P });
  callModelJSONAsync.mockReset();
});
afterEach(() => db.close());

const row = (id) => db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
const enrich = (id, reply) =>
  executeSaveEnrich(db, id, { callJson: async () => reply, acquire: async () => true, release: () => {} });

describe('a model-written lesson on an explicit save is marked', () => {
  it('save-time enrichment marks the lesson it writes, and get says so', async () => {
    const saved = saveObservation(db, { project: P, type: 'bugfix', title: 'Slow export', content: LONG });
    expect(
      (await enrich(saved.id, { lesson_learned: 'Stream large exports in batches.', search_aliases: [] }))
        .enriched,
    ).toBe(true);
    const r = row(saved.id);
    expect(r.lesson_learned).toBe('🤖 Stream large exports in batches.');
    expect(autoHeaderNote(r)).toBe(' · 🤖 lesson auto-written');
  });

  it("a person's own lesson stays unmarked, and get adds nothing", async () => {
    const saved = saveObservation(db, {
      project: P,
      type: 'bugfix',
      title: 'Slow export',
      content: LONG,
      lesson_learned: 'Stream large exports in batches.',
    });
    await enrich(saved.id, { lesson_learned: 'model text', search_aliases: ['batch export'] });
    const r = row(saved.id);
    expect(r.lesson_learned).toBe('Stream large exports in batches.');
    expect(autoHeaderNote(r)).toBe('');
  });

  it.each([
    ['narrow', 'bugfix'],
    ['wide', 'feature'],
  ])('%s re-enrich marks the lesson it writes on an explicit save', async (scope, type) => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertSession(db, { id: 'manual-x', project: P });
    insertObs(db, {
      sessionId: 'manual-x',
      project: P,
      type,
      importance: 2,
      title: 'Export streams rows',
      narrative: LONG,
    });
    callModelJSONAsync.mockResolvedValue({
      type,
      title: 'Model title',
      narrative: 'model narrative',
      concepts: ['export'],
      facts: [],
      importance: 2,
      lesson_learned: 'Stream large exports in batches.',
      search_aliases: [],
    });
    expect((await executeReenrich(db, 10, { scope })).processed).toBe(1);
    expect(db.prepare('SELECT lesson_learned FROM observations LIMIT 1').get().lesson_learned).toBe(
      '🤖 Stream large exports in batches.',
    );
  });

  it('re-enrich leaves a machine-written row unmarked: the row is marked already', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { project: P, type: 'bugfix', importance: 1, title: 'Modified export.js', narrative: 'x' });
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Model title',
      narrative: 'model narrative',
      concepts: ['export'],
      facts: [],
      importance: 2,
      lesson_learned: 'Stream large exports in batches.',
      search_aliases: [],
    });
    expect((await executeReenrich(db, 10)).processed).toBe(1);
    const r = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(r.lesson_learned).toBe('Stream large exports in batches.');
    expect(autoHeaderNote(r)).toBe(' · 🤖 auto-written, not an explicit save');
  });

  // unicode61 indexes 🤖 (outside the BMP) as a token, so the mark is one inert term: the query
  // side drops it, so no search can match on it, and the lesson's own words still match.
  it('the mark is never a search term', async () => {
    const { buildSearchFtsQuery } = await import('../lib/search-core.mjs');
    const saved = saveObservation(db, { project: P, type: 'bugfix', title: 'Slow export', content: LONG });
    await enrich(saved.id, { lesson_learned: 'Stream exports through a cursor.', search_aliases: [] });
    expect(buildSearchFtsQuery('🤖')).toBeNull();
    const hit = db
      .prepare('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?')
      .all(buildSearchFtsQuery('cursor'))
      .map((r) => r.rowid);
    expect(hit).toEqual([saved.id]);
  });

  it('marks once, and leaves an absent lesson absent', () => {
    expect(markAutoLesson('🤖 Stream exports.')).toBe('🤖 Stream exports.');
    expect(markAutoLesson(null)).toBeNull();
  });
});
