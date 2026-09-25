// `claude-mem-lite verify-apply` — the CLI face of lib/verify-apply-core.mjs, end to end in a
// subprocess against a real file DB under a sandboxed HOME / CLAUDE_MEM_DIR. The core's
// properties are pinned in verify-apply-core.test.mjs; this file pins what only the face can
// get wrong: dry run is the default and writes NOTHING (not even a backup), --apply writes the
// backup BEFORE the change and prints the undo command, exit codes carry the outcome.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const PROJECT = 'parent--testproj';

let tmpHome;
let dataDir;
let projectDir;
let db;

function runCli(args) {
  const env = {
    ...process.env,
    HOME: tmpHome,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    MEM_NO_AUTO_ADOPT: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  // spawnSync, not execFileSync: stderr is needed on SUCCESS too — a flag this command reads
  // but the CLI's flag catalogue lacks prints "Unknown flag … ignored" on an exit-0 run.
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    timeout: 15000,
    encoding: 'utf8',
    env,
    cwd: projectDir,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status ?? 1 };
}

function snapshot() {
  const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
  const files = db.prepare('SELECT obs_id, filename FROM observation_files ORDER BY obs_id, filename').all();
  return JSON.stringify({ obs, files });
}

function seed(over = {}) {
  return Number(
    insertObs(db, {
      sessionId: 'manual-t',
      project: PROJECT,
      type: 'bugfix',
      title: 'Old title',
      narrative: 'The bug is still open.',
      text: 'The bug is still open.',
      importance: 2,
      lessonLearned: 'Old lesson',
      filesModified: '["lib/foo.mjs"]',
      ...over,
    }).lastInsertRowid,
  );
}

function writeProposals(entries) {
  const p = join(tmpHome, `proposals-${randomUUID().slice(0, 6)}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

const backupsDir = () => join(dataDir, 'backups');

beforeEach(() => {
  tmpHome = join(tmpdir(), `mem-verify-cli-${randomUUID().slice(0, 8)}`);
  dataDir = join(tmpHome, '.claude-mem-lite');
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, 'claude-mem-lite.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'manual-t', project: PROJECT });
  insertSession(db, { id: 'manual-o', project: 'parent--other' });
});

afterEach(() => {
  db.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('verify-apply CLI', () => {
  it('without a file prints usage and exits 1', () => {
    const r = runCli(['verify-apply']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Usage: claude-mem-lite verify-apply/);
  });

  it('dry run is the default: prints the plan, exits 0, writes nothing — not even a backup', () => {
    const a = seed();
    const b = seed({ title: 'second' });
    const file = writeProposals([
      {
        id: a,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'The bug was fixed in abc123.' },
        evidence: 'abc123',
      },
      { id: b, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);
    const before = snapshot();
    const r = runCli(['verify-apply', file]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`#${a}\\b.*edit`));
    expect(r.stdout).toMatch(new RegExp(`#${b}\\b.*retire`));
    expect(r.stdout).toMatch(/Dry run/);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    expect(snapshot()).toBe(before);
    expect(existsSync(backupsDir())).toBe(false);
  });

  it('an invalid document exits 1 and writes nothing', () => {
    const a = seed();
    const file = writeProposals([
      { id: a, action: 'retire', verdict: 'STALE', evidence: 'x', note: 'extra' },
    ]);
    const before = snapshot();
    const r = runCli(['verify-apply', file, '--apply']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown key "note"/);
    expect(snapshot()).toBe(before);
    expect(existsSync(backupsDir())).toBe(false);
  });

  it('a target in another project exits 1 and writes nothing, even with --apply', () => {
    const foreign = seed({ sessionId: 'manual-o', project: 'parent--other' });
    const file = writeProposals([{ id: foreign, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const before = snapshot();
    const r = runCli(['verify-apply', file, '--apply']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/parent--other/);
    expect(snapshot()).toBe(before);
  });

  it('--apply backs up first, applies, reads back ok, and --undo restores the rows', () => {
    const a = seed();
    const b = seed({ title: 'second' });
    const c = seed({ title: 'third' });
    const originals = [a, b, c].map((id) => db.prepare('SELECT * FROM observations WHERE id = ?').get(id));
    const file = writeProposals([
      {
        id: a,
        action: 'replace',
        verdict: 'STALE',
        narrative: 'The bug was fixed in abc123.',
        evidence: 'abc123',
      },
      {
        id: b,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'line 12 now' },
        evidence: 'foo.mjs:12',
      },
      { id: c, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);

    const r = runCli(['verify-apply', file, '--apply']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    const backups = readdirSync(backupsDir()).filter((f) => f.startsWith('verify-') && f.endsWith('.json'));
    expect(backups).toHaveLength(1);
    const backupPath = join(backupsDir(), backups[0]);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    expect(backup.rows.map((x) => x.row)).toEqual(originals);
    expect(r.stdout.match(/\bok\b/g) || []).toHaveLength(3);
    expect(r.stdout).toContain(`verify-apply --undo ${backupPath}`);
    expect(
      db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(a).superseded_at,
    ).not.toBeNull();
    expect(db.prepare('SELECT narrative FROM observations WHERE id = ?').get(b).narrative).toBe(
      'line 12 now',
    );

    const u = runCli(['verify-apply', '--undo', backupPath]);
    expect(u.exitCode, u.stderr).toBe(0);
    expect(u.stderr).not.toMatch(/Unknown flag/);
    for (const row of originals) {
      expect(db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id)).toEqual(row);
    }
  });
});
