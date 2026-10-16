// A bare YYYY-MM-DD date bound is the user's LOCAL calendar day on search (parseDateBounds),
// but export parsed it as a UTC day, so the same `--from 2026-10-16` matched a row on search
// and dropped it from the export taken to back it up (E2E 2026-10-16, MCP P2-14). Run under a
// fixed non-UTC zone so the difference is visible on any machine.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
const SERVER = resolve(import.meta.dirname, '../server.mjs');
// 2026-10-15T20:00Z is 2026-10-16 05:00 in Tokyo (UTC+9): the 16th locally, the 15th in UTC.
const EARLY_MORNING = Date.parse('2026-10-15T20:00:00Z');
const TITLE = 'Billing rollback early morning';

let dir, env;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'export-tz-'));
  env = {
    ...process.env,
    TZ: 'Asia/Tokyo',
    CLAUDE_MEM_DIR: dir,
    CLAUDE_MEM_SKIP_UPDATE: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  initSchema(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES ('s', 's', 'p--proj', ?, ?)`,
  ).run(new Date(EARLY_MORNING).toISOString(), EARLY_MORNING);
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
     VALUES ('s', 'p--proj', ?, 'decision', ?, ?, 2, ?, ?)`,
  ).run(TITLE, TITLE, TITLE, new Date(EARLY_MORNING).toISOString(), EARLY_MORNING);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cliExport(...flags) {
  return execFileSync(process.execPath, [CLI, 'export', '--format', 'jsonl', ...flags], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function mcpExport(args) {
  const reqs =
    [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'mem_export', arguments: { format: 'jsonl', ...args } },
      }),
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
      if (m.id === 2) return m.result?.content?.map((c) => c.text).join('\n') || '';
    } catch {
      /* non-JSON log line */
    }
  }
  return '';
}

describe('export date bounds are local calendar days, like search', () => {
  it('CLI: --from on the local day includes the early-morning row, --to the day before excludes it', () => {
    expect(cliExport('--from', '2026-10-16')).toContain(TITLE);
    expect(cliExport('--to', '2026-10-15')).not.toContain(TITLE);
  });

  it('MCP: date_from / date_to read the same local day', () => {
    expect(mcpExport({ date_from: '2026-10-16' })).toContain(TITLE);
    expect(mcpExport({ date_to: '2026-10-15' })).not.toContain(TITLE);
  });

  it('an explicit ISO instant is still honoured as written', () => {
    expect(cliExport('--from', '2026-10-15T21:00:00Z')).not.toContain(TITLE);
    expect(mcpExport({ date_from: '2026-10-15T19:00:00Z' })).toContain(TITLE);
  });
});
