// E2E 2026-10-16 MCP P2-10: `source` re-reads EVERY id from one table, so with the mixed lists
// mem_search prints, mem_get({ids: ["P#1", "#2"], source: "prompt"}) fetched P#2 for the
// observation #2 and said nothing — the record shown was not the one asked for, under the id
// that was asked for. `source` keeps its documented precedence (lib/id-routing.mjs, the CLI's
// --source); both faces now say when it overrode an id's own prefix.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as idRouting from '../lib/id-routing.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('bucketIdTokens: ids whose own prefix source overrode', () => {
  it('lists a prefixed id read from another table, and no bare number', () => {
    const r = idRouting.bucketIdTokens(['P#1', '#2', 'E#3', '4'], { explicit: 'prompt' });
    expect(r.bySrc.prompt).toEqual([1, 2, 3, 4]);
    expect(r.overridden).toEqual([
      { token: '#2', as: 'P#2' },
      { token: 'E#3', as: 'P#3' },
    ]);
  });

  it('lists nothing without an explicit source', () => {
    expect(idRouting.bucketIdTokens(['P#1', '#2']).overridden).toEqual([]);
  });
});

describe('mem_get and get say when source overrode a prefix', () => {
  let dir, env, projectDir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'get-override-'));
    projectDir = join(dir, 'work', 'overrideproj');
    env = {
      ...process.env,
      CLAUDE_MEM_DIR: dir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_PROJECT_DIR: projectDir,
      PWD: projectDir,
    };
    const saved = spawnSync(
      process.execPath,
      [join(REPO, 'cli.mjs'), 'save', 'Refresh tokens leaked through localStorage', '--type', 'bugfix'],
      { env, encoding: 'utf8' },
    );
    expect(saved.status, saved.stderr).toBe(0);
    const db = new Database(join(dir, 'claude-mem-lite.db'));
    try {
      const now = Date.now();
      db.prepare(
        "INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES ('s1', 's1', 'x', ?, ?, 'active')",
      ).run(new Date(now).toISOString(), now);
      db.prepare(
        "INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES ('s1', 'Why does the invoice export time out?', 1, ?, ?)",
      ).run(new Date(now).toISOString(), now);
    } finally {
      db.close();
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function memGet(args) {
    const reqs =
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'mem_get', arguments: args },
        }),
      ].join('\n') + '\n';
    const raw = execFileSync(process.execPath, [join(REPO, 'server.mjs')], {
      env,
      input: reqs,
      encoding: 'utf8',
      timeout: 30000,
    });
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return {};
        }
      })
      .find((m) => m.id === 2).result.content[0].text;
  }

  it('mem_get notes "#1 read as P#1"', () => {
    const text = memGet({ ids: ['P#1', '#1'], source: 'prompt' });
    expect(text).toContain('Why does the invoice export time out?');
    expect(text).toContain('source="prompt" read #1 as P#1');
  });

  it('mem_get notes it when nothing is found, too', () => {
    const text = memGet({ ids: ['#1'], source: 'session' });
    expect(text).toContain('No records found');
    expect(text).toContain('source="session" read #1 as S#1');
  });

  it('get notes it on stderr', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'get', 'P#1', '#1', '--source', 'prompt'], {
      env,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('--source prompt read #1 as P#1');
  });
});
