// MCP findings from the 2026-10-16 real-user E2E round, driven over the real stdio
// transport (server.mjs spawned, MCP SDK client on the other end). Isolation follows
// tests/feature-sweep-mcp.test.mjs: sandbox CLAUDE_MEM_DIR and HOME, cwd as the only
// project source, no LLM (CLAUDE_CODE_PATH points nowhere), no enrichment worker.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(REPO, 'server.mjs');

let ROOT, DATA_DIR, WORK_DIR, client, transport;

const textOf = (res) =>
  (res?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { text: textOf(res), isError: !!res.isError };
}

function withDb(fn) {
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Write a row the way another session's process would: straight into the shared store. */
function insertForeignRow(project, title) {
  return withDb((db) => {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
    ).run(`s-${project}`, `s-${project}`, project, new Date(now).toISOString(), now);
    return Number(
      db
        .prepare(
          `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
           VALUES (?, ?, ?, 'discovery', ?, ?, 2, ?, ?)`,
        )
        .run(`s-${project}`, project, title, title, title, new Date(now).toISOString(), now).lastInsertRowid,
    );
  });
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-mcpe2e-'));
  DATA_DIR = join(ROOT, 'data');
  WORK_DIR = join(ROOT, 'a', 'app');
  mkdirSync(join(ROOT, 'home', '.claude'), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const env = {
    ...process.env,
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: DATA_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_AUTO_DEEP: '0',
    CLAUDE_MEM_SEARCH_TELEMETRY: '0',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    MEM_QUIET_HOOKS: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: WORK_DIR,
    env,
  });
  client = new Client({ name: 'mem-e2e-20261016', version: '0.0.0' });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  try {
    await client?.close();
  } finally {
    if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  }
});

describe('project-name resolution in the long-lived server', () => {
  // The server lives for a whole Claude Code session. A short name resolved before its
  // canonical project had rows was cached for the life of the process, so reads stayed
  // empty after another session wrote `b--gamma`, while a fresh process found them.
  it('a short name resolved before its project had rows sees the rows written later', async () => {
    const before = await call('mem_recent', { project: 'gamma' });
    expect(before.text).toMatch(/No recent observations/);
    insertForeignRow('b--gamma', 'Gamma kafka consumer lag fixed by lowering poll size');
    const after = await call('mem_recent', { project: 'gamma' });
    expect(after.text).toContain('Gamma kafka consumer lag');
  });

  it('a write naming a short project lands in the canonical project created since', async () => {
    const first = await call('mem_save', {
      content: 'Delta note one about eviction policy',
      project: 'delta',
    });
    expect(first.text).toMatch(/in project "delta"/);
    insertForeignRow('b--delta', 'Delta session save about connection reuse');
    const second = await call('mem_save', { content: 'Delta note two about warmup order', project: 'delta' });
    expect(second.text).toMatch(/in project "b--delta"/);
  });
});

describe('mem_optimize resolves a short project name like its sibling tools', () => {
  // Every other project-taking handler resolves `opt` to `b--opt`; mem_optimize passed the
  // raw string, so preview counted 0 candidates and `run` silently processed nothing.
  it('preview reports and filters on the canonical project', async () => {
    insertForeignRow('b--opt', 'Optimize probe row about retry budgets');
    const r = await call('mem_optimize', { project: 'opt' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Project filter: b--opt');
  });
});

describe('mem_defer_drop names what it dropped', () => {
  // Ordinals follow priority: two adds can both be told "item 1", and `id: 1` then drops the
  // urgent one. The confirmation carries the title so the model sees which row it hit.
  it('a drop by ordinal echoes the dropped title', async () => {
    await call('mem_defer', { title: 'Rename helper (cosmetic)', priority: 2, project: 'b--ord' });
    await call('mem_defer', { title: 'Backup job skips WAL file', priority: 3, project: 'b--ord' });
    const r = await call('mem_defer_drop', { id: 1, reason: 'rename not needed', project: 'b--ord' });
    expect(r.text).toMatch(/Dropped D#\d+ "Backup job skips WAL file"/);
  });
});
