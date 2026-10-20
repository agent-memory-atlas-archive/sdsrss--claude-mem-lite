// E2E 2026-10-16 (cli F5, MCP 8): NOT, -term, OR, prefix* and column: in a query were dropped by
// the sanitizer with no word, so `redis NOT pool` and `redis -pool` returned exactly the rows the
// user meant to exclude, and `redis OR pool` silently required both words. Excluding is a
// retrieval change; what both faces now do is say which operators were ignored and what that did.

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { handleSearchForTest } from '../server.mjs';
import { ignoredOperatorNote } from '../lib/search-core.mjs';

describe('ignoredOperatorNote', () => {
  it('names each ignored operator and its effect', () => {
    expect(ignoredOperatorNote('redis NOT pool')).toMatch(/NOT.*nothing is excluded/);
    expect(ignoredOperatorNote('redis -pool')).toMatch(/-term.*nothing is excluded/);
    expect(ignoredOperatorNote('redis OR pool', { orHint: 'use --or' })).toMatch(/OR.*use --or/);
    expect(ignoredOperatorNote('refr*')).toMatch(/prefix\*/);
    expect(ignoredOperatorNote('title:refresh')).toMatch(/column:/);
  });
  it('says nothing for plain words, hyphenated words, lowercase or, and URLs', () => {
    for (const q of ['redis pool', 'pre-commit hook', 'this or that', 'see https://example.com/x', '']) {
      expect(ignoredOperatorNote(q), q).toBe('');
    }
  });
});

describe('mem_search tells the caller', () => {
  let db;
  beforeAll(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { type: 'bugfix', title: 'Redis pool exhaustion raised maxclients', text: 'redis pool' });
    insertObs(db, {
      type: 'bugfix',
      title: 'Redis cluster failover needs MOVED retry',
      text: 'redis cluster',
    });
  });
  const text = async (args) =>
    (await handleSearchForTest(db, { deep: false, ...args })).content.map((c) => c.text).join('\n');

  it('on a hit', async () => {
    const t = await text({ query: 'redis NOT pool' });
    expect(t).toMatch(/Redis pool exhaustion/);
    expect(t).toMatch(/NOT \(nothing is excluded\)/);
  });
  it('on a miss', async () => {
    const t = await text({ query: 'zzqx NOT yyqw' });
    expect(t).toMatch(/No results/);
    expect(t).toMatch(/NOT \(nothing is excluded\)/);
  });
  it('OR points at or=true, and is not mentioned when or=true is set', async () => {
    expect(await text({ query: 'redis OR failover' })).toMatch(/or=true/);
    expect(await text({ query: 'redis OR failover', or: true })).not.toMatch(/not supported/);
  });
  it('OR is not mentioned when the search relaxed to OR', async () => {
    const t = await text({ query: 'redis OR zzzqqq' });
    expect(t, 'premise: the AND→OR fallback fired').toMatch(/relaxed AND→OR/);
    expect(t).not.toMatch(/every word must match/);
  });
  it('control: a plain query carries no note', async () => {
    expect(await text({ query: 'redis pool' })).not.toMatch(/not supported/);
  });
});
