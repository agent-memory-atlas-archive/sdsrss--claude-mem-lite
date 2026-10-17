// Pre-tag review 2026-10-16 P3-5: 4dfa2946 taught the CLI to say so when a read names a project
// with no rows ("No project "otherr-api" has any rows — did you mean "work--other-api"?"), and
// the MCP face was left out: server.mjs never imported unknownProjectNote, so
// mem_search / mem_recent / mem_timeline(project: "otherr-api") answered exactly like a real
// project with nothing matching. The CLI prints the note for every command that takes --project
// except the writes, which make their own check; the MCP face now does the same for every tool
// that takes `project` except mem_save and mem_defer. Driven over the real stdio transport.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const NOTE = 'No project "otherr-api" has any rows — did you mean "work--other-api"?';

let ROOT, DATA_DIR, WORK_DIR, client, transport;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { text, isError: !!res.isError };
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-mcp-projnote-'));
  DATA_DIR = join(ROOT, 'data');
  WORK_DIR = join(ROOT, 'a', 'app');
  mkdirSync(join(ROOT, 'home', '.claude'), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'));
  initSchema(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES ('s-1', 's-1', 'work--other-api', ?, ?, 'active')`,
  ).run(new Date(now).toISOString(), now);
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
     VALUES ('s-1', 'work--other-api', 'redis pool exhaustion', 'bugfix', 'Redis pool exhaustion', 'redis pool exhaustion', 2, ?, ?)`,
  ).run(new Date(now).toISOString(), now);
  db.close();
  const env = {
    ...process.env,
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: DATA_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    CLAUDE_MEM_AUTO_DEEP: '0',
    CLAUDE_MEM_SEARCH_TELEMETRY: '0',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    MEM_QUIET_HOOKS: '1',
  };
  for (const k of [
    'CLAUDE_MEM_HOOK_RUNNING',
    'CLAUDE_PROJECT_DIR',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
  ]) {
    delete env[k];
  }
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: WORK_DIR,
    env,
  });
  client = new Client({ name: 'projnote-test', version: '0.0.0' });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});

// Every tool that takes `project` and is not a write; mem_defer_drop fails here (no such item)
// and carries the note on its error, as the CLI's note precedes a failing command too.
const READS = [
  ['mem_search', { query: 'redis' }],
  ['mem_recent', {}],
  ['mem_timeline', { query: 'redis' }],
  ['mem_recall', { file: 'pool.mjs' }],
  ['mem_browse', {}],
  ['mem_defer_list', {}],
  ['mem_defer_drop', { id: 1, reason: 'done' }],
  ['mem_stats', {}],
  ['mem_export', {}],
  ['mem_compress', { preview: true }],
  ['mem_maintain', { action: 'scan' }],
  ['mem_optimize', { action: 'preview' }],
];

describe('MCP tools naming a project with no rows say so (P3-5)', () => {
  it.each(READS)('%s names the near project', async (name, args) => {
    const { text } = await call(name, { ...args, project: 'otherr-api' });
    expect(text).toContain(NOTE);
  });

  it.each(READS)('control: %s on the real project carries no note', async (name, args) => {
    const { text } = await call(name, { ...args, project: 'work--other-api' });
    expect(text).not.toMatch(/has any rows/);
  });

  it.each([
    ['mem_save', { content: 'pool size raised' }],
    ['mem_defer', { title: 'raise the pool size' }],
  ])('%s keeps its own write check, without the read note', async (name, args) => {
    const { text, isError } = await call(name, { ...args, project: 'otherr-api' });
    expect(text).toMatch(/did you mean "work--other-api"/);
    expect(text).toMatch(/Nothing was saved/);
    expect(text).not.toMatch(/has any rows/);
    expect(isError).toBe(true);
  });
});
