// The MCP server opens the database while it is imported and exited 1 on any failure, so another
// writer holding the lock past ensureDb's 5 s wait (a long maintain, or another process's first
// open migrating the store) took the memory tools away for the whole session: "FATAL: Database
// cannot be opened: database is locked" after 5.1 s (round-3 pre-tag review, 2026-10-17). It now
// retries a busy open, within Claude Code's 30 s MCP startup timeout.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_MS = 7000;

let dir;
let env;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'server-open-busy-'));
  env = {
    ...process.env,
    CLAUDE_MEM_DIR: dir,
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_PROJECT_DIR: dir,
  };
  const made = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'stats'], { env, encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  // A store the next open has to migrate (6.27.0's 4-column events index): a migrated store opens
  // without the write lock, so only a migrating open waits for it.
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS events_fts_ai; DROP TRIGGER IF EXISTS events_fts_ad;
      DROP TRIGGER IF EXISTS events_fts_au; DROP TABLE IF EXISTS events_fts;
      CREATE VIRTUAL TABLE events_fts USING fts5(
        title, body, event_type UNINDEXED, project UNINDEXED,
        content='events', content_rowid='id',
        tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
      );
    `);
  } finally {
    db.close();
  }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function holdWriteLock(ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3');
         const db = new D(${JSON.stringify(join(dir, 'claude-mem-lite.db'))});
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${ms});`,
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    child.once('error', reject);
    // Created now: the locker exits on its own once the lock is released, before the test ends.
    child.exited = new Promise((res) => child.once('exit', res));
    child.stdout.once('data', () => resolve(child));
  });
}

function runServer() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(REPO, 'server.mjs')], { env, cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n',
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

describe("MCP server startup under another writer's lock", () => {
  it('waits the lock out and answers initialize instead of exiting 1', async () => {
    const locker = await holdWriteLock(LOCK_MS);
    let r;
    try {
      r = await runServer();
    } finally {
      locker.kill('SIGKILL');
      await locker.exited;
    }
    expect(r.stderr).not.toMatch(/FATAL/);
    expect(r.status).not.toBe(1);
    const reply = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return {};
        }
      })
      .find((m) => m.id === 1);
    expect(reply?.result?.serverInfo, r.stdout).toBeTruthy();
    // Premise: the lock outlasted one 5 s busy wait, so a single open could not have succeeded.
    expect(r.ms).toBeGreaterThan(LOCK_MS - 1000);
  }, 40_000);
});
