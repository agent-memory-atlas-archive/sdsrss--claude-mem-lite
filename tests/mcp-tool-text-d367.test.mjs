// D#367 (E2E 2026-10-16 MCP report §6/§8/§10/§20): five places where the tool surface told the
// model something the server does not do. The model follows the description, gets a wrong or
// empty answer, and nothing says why. These pin the corrected text and the two argument aliases;
// the real-model A/B behind each change is tasks/specs/d367-tool-descriptions.md.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { tools, memSearchSchema, memSaveSchema, memTimelineSchema } from '../tool-schemas.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const descriptionOf = (name) => tools.find((t) => t.name === name).description;

describe('mem_search query (P2-8)', () => {
  it('does not claim FTS5 syntax, and names what the sanitiser drops', () => {
    const text = memSearchSchema.query.description;
    expect(text).not.toMatch(/FTS5 syntax/);
    for (const op of ['NOT', '-term', 'prefix*', 'column:', '"phrase"']) expect(text).toContain(op);
  });
});

describe('mem_get (P2-10)', () => {
  it('no longer tells the model to pass source for S#/P# hits', () => {
    expect(descriptionOf('mem_get')).not.toMatch(/pass source=/);
    expect(descriptionOf('mem_get')).toMatch(/each prefix routes itself/);
  });
});

describe('mem_recent (P2-20)', () => {
  it('does not say it does no filtering', () => {
    expect(descriptionOf('mem_recent')).not.toMatch(/does no filtering/);
    expect(descriptionOf('mem_recent')).toMatch(/filters by type and date, not by words/);
  });
});

describe('mem_defer_list (P2-20)', () => {
  it('points a single item at mem_get D#N', () => {
    expect(descriptionOf('mem_defer_list')).not.toMatch(/look up the row directly/);
    expect(descriptionOf('mem_defer_list')).toContain('mem_get ids=["D#N"]');
  });
});

describe('argument aliases the descriptions invite (P2-6)', () => {
  let dir, env;

  function callTool(name, args) {
    const reqs =
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
      ].join('\n') + '\n';
    const raw = execFileSync(process.execPath, [SERVER], {
      env,
      input: reqs,
      encoding: 'utf8',
      timeout: 30000,
    });
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const m = JSON.parse(line);
        if (m.id === 2) return m.result?.content?.[0]?.text || JSON.stringify(m.error);
      } catch {
        /* server also logs non-JSON lines */
      }
    }
    return '';
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-d367-'));
    env = {
      ...process.env,
      CLAUDE_MEM_DIR: dir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_PROJECT_DIR: '/x/d367proj',
      PWD: '/x/d367proj',
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mem_save keeps a lesson passed as `lesson`, the CLI flag its description prints', () => {
    expect(descriptionOf('mem_save')).toContain('--lesson');
    expect(Object.keys(memSaveSchema)).toContain('lesson');
    const out = callTool('mem_save', {
      content: 'Invoice totals crashed when lines was undefined',
      type: 'bugfix',
      lesson: 'Default invoice lines to an empty array before reduce',
    });
    expect(out).toMatch(/Saved/);
    const db = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT lesson_learned FROM observations').all()).toEqual([
        { lesson_learned: 'Default invoice lines to an empty array before reduce' },
      ]);
    } finally {
      db.close();
    }
  });

  it('mem_save still prefers lesson_learned when both are given', () => {
    callTool('mem_save', {
      content: 'Cache key omitted the locale so French users saw English pages',
      lesson_learned: 'Include the locale in the cache key',
      lesson: 'a different text',
    });
    const db = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT lesson_learned FROM observations').get().lesson_learned).toBe(
        'Include the locale in the cache key',
      );
    } finally {
      db.close();
    }
  });

  it('mem_timeline anchors on `id` as on `anchor`', () => {
    expect(Object.keys(memTimelineSchema)).toContain('id');
    for (const n of [1, 2, 3, 4, 5]) {
      callTool('mem_save', {
        content: `Timeline row number ${n} about a distinct subject ${'abcde'[n - 1]}lpha`,
        title: `row ${n}`,
        force: true,
      });
    }
    const byAnchor = callTool('mem_timeline', { anchor: 2, before: 1, after: 1 });
    const byId = callTool('mem_timeline', { id: 2, before: 1, after: 1 });
    expect(byAnchor).toMatch(/#2\b/);
    expect(byId).toBe(byAnchor);
  });
});
