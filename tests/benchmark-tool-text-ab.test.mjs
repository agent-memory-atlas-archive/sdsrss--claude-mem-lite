// benchmark/tool-text-ab.mjs scores a tool-surface change off real Claude Code sessions, so each
// classifier it scores with must be able to say NO: the operator test, every self-check that
// keeps a call out of the score, and each probe's metric on a hit and on a miss.
import { describe, it, expect } from 'vitest';
import {
  hasOperator,
  invalidReason,
  score,
  parseStream,
  METRICS,
  PROBES,
} from '../benchmark/tool-text-ab.mjs';

const VALID = {
  is_error: false,
  models: ['claude-sonnet-5-5'],
  initTools: ['mcp__mem__mem_search', 'mcp__mem__mem_get'],
  mcpStatus: 'connected',
  rep: 1,
};
const call = (name, input) => ({ name: `mcp__mem__${name}`, input });
const rec = (probe, fields) => ({
  ...VALID,
  probe,
  arm: 'before',
  toolCalls: [],
  toolResults: [],
  ...fields,
});

describe('hasOperator', () => {
  it('flags what the query sanitiser drops', () => {
    for (const q of [
      'refresh token NOT expiry',
      'migrate OR migrated',
      'redis -pool',
      'migr*',
      'title:redis',
      '"exact phrase"',
    ])
      expect(hasOperator(q), q).toBe(true);
  });
  it('passes plain keywords, hyphenated words and lowercase "or"', () => {
    for (const q of ['refresh token', 'migrate migrated migration', 'non-blocking io', 'redis or kafka', ''])
      expect(hasOperator(q), q).toBe(false);
  });
});

describe('invalidReason', () => {
  it('accepts a call that passed every self-check', () => {
    expect(invalidReason(VALID)).toBeNull();
  });
  it('refuses a call with built-in tools, another model, a failed server or an error', () => {
    expect(invalidReason({ ...VALID, initTools: [...VALID.initTools, 'Bash'] })).toMatch(/built-in/);
    expect(invalidReason({ ...VALID, initTools: [] })).toMatch(/init/);
    expect(invalidReason({ ...VALID, models: ['claude-opus-5-5'] })).toMatch(/model/);
    expect(invalidReason({ ...VALID, mcpStatus: 'failed' })).toMatch(/mcp/);
    expect(invalidReason({ ...VALID, is_error: true })).toMatch(/is_error/);
  });
});

describe('METRICS', () => {
  it('has one metric per probe', () => {
    expect(Object.keys(METRICS).sort()).toEqual(Object.keys(PROBES).sort());
  });
  const cases = {
    P1: [
      { toolCalls: [call('mem_search', { query: 'refresh token NOT expiry' })] },
      { toolCalls: [call('mem_search', { query: 'refresh token' })] },
    ],
    P3: [
      { toolCalls: [call('mem_search', { query: 'redis pool' })] },
      { toolCalls: [call('mem_recent', {})] },
    ],
    P4: [
      {
        toolResults: [
          'Why does the invoice export time out for large tenants on Mondays?',
          'stored in localStorage',
        ],
      },
      { toolResults: ['Why does the invoice export time out for large tenants on Mondays?'] },
    ],
    P5: [{ toolCalls: [call('mem_recent', {})] }, { toolCalls: [call('mem_search', { query: 'recent' })] }],
    P7: [
      { result: 'Rotation failed; localStorage leak; Migration 042 index; connection pool leak.' },
      { result: 'Rotation failed; localStorage leak; Migration 042 index; Kafka chosen.' },
    ],
    P8: [
      { toolResults: ['Split the export into pages of 500 rows and stream them'] },
      { toolResults: ['Invoice export times out'] },
    ],
    P9: [
      { newRows: [{ lesson_learned: 'page the export in 500-row chunks' }] },
      { newRows: [{ lesson_learned: null }] },
    ],
    P10: [
      { toolCalls: [call('mem_timeline', { id: 5 })] },
      { toolCalls: [call('mem_timeline', { anchor: 6 })] },
    ],
    P11: [
      { toolCalls: [call('mem_search', { query: 'migr*' })] },
      { toolCalls: [call('mem_search', { query: 'migration migrate' })] },
    ],
    P12: [
      { toolResults: ['#4 Migration 042 dropped an index', '#5 Migrated the settings table'] },
      { toolResults: ['#4 Migration 042 dropped an index'] },
    ],
  };
  for (const [probe, [hit, miss]] of Object.entries(cases)) {
    it(`${probe} reads a hit as a hit and a miss as a miss`, () => {
      expect(METRICS[probe].hit(rec(probe, hit))).toBe(true);
      expect(METRICS[probe].hit(rec(probe, miss))).toBe(false);
    });
  }
});

describe('score', () => {
  it('counts hits over valid calls only, and keeps the smoke rep (0) out', () => {
    const hit = { toolCalls: [call('mem_recent', {})] };
    const t = score([
      rec('P5', hit),
      rec('P5', { ...hit, arm: 'B3' }),
      rec('P5', { arm: 'B3' }),
      rec('P5', { ...hit, arm: 'B3', initTools: ['Bash'] }),
      rec('P5', { ...hit, rep: 0 }),
    ]);
    expect(t.P5.before).toEqual({ n: 1, hits: 1, invalid: 0 });
    expect(t.P5.B3).toEqual({ n: 2, hits: 1, invalid: 1 });
  });
});

describe('parseStream', () => {
  it('reads the init tool list, tool calls, tool results and the final event', () => {
    const lines = [
      {
        type: 'system',
        subtype: 'init',
        tools: ['mcp__mem__mem_get'],
        mcp_servers: [{ name: 'mem', status: 'connected' }],
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'x' },
            { type: 'tool_use', name: 'mcp__mem__mem_get', input: { ids: ['D#2'] } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'detail' }] }] },
      },
      { type: 'result', is_error: false, result: 'done' },
    ];
    const p = parseStream([...lines.map((l) => JSON.stringify(l)), 'not json'].join('\n'));
    expect(p.init.tools).toEqual(['mcp__mem__mem_get']);
    expect(p.toolCalls).toEqual([{ name: 'mcp__mem__mem_get', input: { ids: ['D#2'] } }]);
    expect(p.toolResults).toEqual(['detail']);
    expect(p.final.result).toBe('done');
  });
});
