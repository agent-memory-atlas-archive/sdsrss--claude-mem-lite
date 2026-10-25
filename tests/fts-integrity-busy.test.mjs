// A database another session is writing to is BUSY, not corrupt. checkFTSIntegrity labelled
// every exception "CORRUPT", so doctor run while a hook held a write transaction reported all
// four indexes as damaged and then rebuilt them — on a large store a long write that blocks
// the live hooks — or, with the lock held throughout, failed the rebuild and exited 1 after
// 24 s (E2E 2026-10-16, install P1-5). Classified on err.code, per CLAUDE.md.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema, checkFTSIntegrity } from '../schema.mjs';
import { handleMemFtsCheck } from '../server/fts-check.mjs';
import { cmdFtsCheck } from '../cli/fts-check.mjs';

const REPO = resolve(import.meta.dirname, '..');

let dir, dbPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-fts-busy-'));
  dbPath = join(dir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('checkFTSIntegrity on a database another connection is writing', () => {
  it('reports "not checked — in use", not CORRUPT, and stops at the first busy table', () => {
    const holder = new Database(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 0');
    try {
      const r = checkFTSIntegrity(db);
      expect(r.healthy).toBe(false);
      expect(r.busy).toBe(true);
      expect(r.details.join('\n')).not.toMatch(/CORRUPT/);
      expect(r.details[0]).toMatch(/not checked/);
      expect(r.details).toHaveLength(1);
    } finally {
      holder.exec('COMMIT');
      holder.close();
      db.close();
    }
  });

  it('a healthy, idle database is still reported healthy', () => {
    const db = new Database(dbPath);
    try {
      const r = checkFTSIntegrity(db);
      expect(r.healthy).toBe(true);
      expect(r.busy).toBe(false);
    } finally {
      db.close();
    }
  });
});

// E2E round 2 (install B9): the CLI and MCP faces ignored `busy` and printed "FTS5 issues
// found", which invites `fts-check rebuild` / `mem_fts_check rebuild` on a healthy store.
describe('fts-check and mem_fts_check say "not checked" for a busy database', () => {
  function underLock(fn) {
    const holder = new Database(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 0');
    try {
      return fn(db);
    } finally {
      holder.exec('COMMIT');
      holder.close();
      db.close();
    }
  }
  it('MCP: no "issues found", and it says not to rebuild', () => {
    const text = underLock((db) => handleMemFtsCheck(db, { action: 'check' }).content[0].text);
    expect(text).not.toMatch(/issues found/i);
    expect(text).toMatch(/in use/);
    expect(text).toMatch(/not corrupt|do not rebuild/i);
  });
  it('CLI: no "issues found", exit 1 since nothing was checked', () => {
    const lines = [];
    const write = process.stdout.write;
    const prevCode = process.exitCode;
    process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
    try {
      underLock((db) => cmdFtsCheck(db, ['check']));
    } finally {
      process.stdout.write = write;
    }
    const code = process.exitCode;
    process.exitCode = prevCode;
    const text = lines.join('');
    expect(text).not.toMatch(/issues found/i);
    expect(text).toMatch(/in use/);
    expect(code).toBe(1);
  });
});

describe('doctor does not rebuild the indexes of a database that is merely busy', () => {
  it('says the check was skipped and rebuilds nothing', async () => {
    // A separate process holds the write lock, like a hook in another session.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(${JSON.stringify(join(REPO, 'node_modules', 'better-sqlite3'))});
         const db = new D(${JSON.stringify(dbPath)}); db.exec('BEGIN EXCLUSIVE');
         process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 20000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise((res, rej) => {
        holder.stdout.once('data', res);
        holder.once('exit', () => rej(new Error('lock holder exited early')));
      });
      const home = join(dir, 'home');
      mkdirSync(join(home, '.claude'), { recursive: true });
      const out = await new Promise((res) => {
        const p = spawn(process.execPath, [join(REPO, 'cli.mjs'), 'doctor'], {
          env: {
            ...process.env,
            HOME: home,
            CLAUDE_MEM_DIR: dir,
            MEM_NO_AUTO_ADOPT: '1',
            CLAUDE_MEM_SKIP_UPDATE: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let s = '';
        p.stdout.on('data', (d) => (s += d));
        p.stderr.on('data', (d) => (s += d));
        p.on('exit', () => res(s));
      });
      expect(out).not.toMatch(/CORRUPT/);
      expect(out).not.toMatch(/Attempting FTS5 rebuild/);
      expect(out).toMatch(/FTS5 integrity: not checked/);
      // The whole-store check rebuilds indexes too, so it is skipped the same way (D#590).
      expect(out).toMatch(/Database integrity: not checked — the database is in use/);
      expect(out).not.toMatch(/Rebuilding the indexes/);
    } finally {
      holder.kill();
    }
  }, 60000);
});
