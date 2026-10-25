// install-legacy-db-backup.test.mjs — Bug 2 regression
// install.mjs used to copyFileSync(~/.claude-mem/claude-mem.db, DB_PATH),
// turning legacy claude-mem v16 schema (schema_versions plural table) into
// the new claude-mem-lite v28 schema home. There is no v16→v28 bridge in
// MIGRATIONS[]; the new code FATALs on first launch with
// "no such column: memory_session_id". Instead, install must rename the
// legacy DB to a timestamped backup so the new install creates a clean DB
// and the user can recover the file later if they want.

import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { migrateLegacyClaudeMemData } from '../install.mjs';

function makeDirs() {
  const root = join(tmpdir(), `mem-legacy-${randomUUID().slice(0, 8)}`);
  const oldDir = join(root, '.claude-mem');
  const newDir = join(root, '.claude-mem-lite');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  return { root, oldDir, newDir };
}

describe('Bug 2: migrateLegacyClaudeMemData', () => {
  it('renames legacy claude-mem.db to a timestamped backup in newDir, never as the new DB', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'legacy-content');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      expect(result.backupPath).toContain('claude-mem-lite.db.legacy-backup-');
      // Critically: new DB path must NOT exist after backup — new install
      // creates a fresh v28 schema.
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);
      // Backup file exists and contains the original bytes.
      expect(existsSync(result.backupPath)).toBe(true);
      // Old location no longer holds the DB (renamed, not copied).
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('also backs up -wal and -shm sidecar files when present', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      writeFileSync(join(oldDir, 'claude-mem.db-shm'), 'shm');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('backed-up');
      const stamps = readdirSync(newDir).filter((f) => f.includes('legacy-backup'));
      expect(stamps.some((f) => f.endsWith('.db.legacy-backup-1700000000000'))).toBe(true);
      expect(stamps.some((f) => f.endsWith('.db-wal.legacy-backup-1700000000000'))).toBe(true);
      expect(stamps.some((f) => f.endsWith('.db-shm.legacy-backup-1700000000000'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns action "noop" when old claude-mem.db does not exist', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('noop');
      expect(readdirSync(newDir)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns action "skip" and touches nothing when newDir already has claude-mem-lite.db', () => {
    const { root, oldDir, newDir } = makeDirs();
    try {
      writeFileSync(join(oldDir, 'claude-mem.db'), 'legacy');
      writeFileSync(join(newDir, 'claude-mem-lite.db'), 'fresh');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('skip');
      // Working DB untouched
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(true);
      // Old DB also untouched (don't surprise users with mutations on skip)
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// D#579: with CLAUDE_MEM_DIR on another filesystem than ~/.claude-mem, the rename threw EXDEV and
// install printed "Legacy DB backup failed". Two writable directories on different devices stand in
// for that (here /tmp is a tmpfs and the home directory is not; a CI runner has /dev/shm).
function dirsOnTwoFilesystems() {
  const roots = [tmpdir(), '/dev/shm', join(homedir(), '.cache')];
  const made = [];
  for (const r of roots) {
    try {
      made.push(mkdtempSync(join(r, 'mem-legacy-xdev-')));
    } catch {
      /* not there, or not writable */
    }
  }
  for (const a of made) {
    for (const b of made) {
      if (statSync(a).dev !== statSync(b).dev) {
        for (const m of made) if (m !== a && m !== b) rmSync(m, { recursive: true, force: true });
        return [a, b];
      }
    }
  }
  for (const m of made) rmSync(m, { recursive: true, force: true });
  return null;
}
const probe = dirsOnTwoFilesystems();
for (const d of probe ?? []) rmSync(d, { recursive: true, force: true });

describe.skipIf(!probe)('migrateLegacyClaudeMemData across filesystems (D#579)', () => {
  it('copies the legacy store and its sidecars to the backup names and leaves the source', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(oldDir, 'claude-mem.db-wal'), 'wal');
      const result = migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 });
      expect(result.action).toBe('copied');
      expect(readFileSync(result.backupPath, 'utf8')).toBe('main');
      expect(readFileSync(join(newDir, 'claude-mem-lite.db-wal.legacy-backup-1700000000000'), 'utf8')).toBe(
        'wal',
      );
      expect(readdirSync(newDir).sort()).toEqual([
        'claude-mem-lite.db-wal.legacy-backup-1700000000000',
        'claude-mem-lite.db.legacy-backup-1700000000000',
      ]);
      expect(
        readFileSync(join(oldDir, 'claude-mem.db'), 'utf8'),
        'the source stays, as setup.sh leaves it',
      ).toBe('main');
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // A copy killed partway leaves its private file, a whole copy of the store, which nothing else removes.
  it('removes a private copy an earlier, killed copy left', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      mkdirSync(newDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      writeFileSync(join(newDir, '.legacy-backup-copy-999999-1600000000000'), 'half a copy');
      expect(migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 }).action).toBe('copied');
      expect(readdirSync(newDir)).toEqual(['claude-mem-lite.db.legacy-backup-1700000000000']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  // The source stays, so without this every install would add another copy (the D#573 shape).
  it('copies once: a backup already in the data dir is enough', () => {
    const [a, b] = dirsOnTwoFilesystems();
    try {
      const oldDir = join(a, '.claude-mem');
      const newDir = join(b, '.claude-mem-lite');
      mkdirSync(oldDir);
      writeFileSync(join(oldDir, 'claude-mem.db'), 'main');
      expect(migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000000 }).action).toBe('copied');
      expect(migrateLegacyClaudeMemData(oldDir, newDir, { now: 1700000000001 }).action).toBe('skip');
      expect(readdirSync(newDir)).toEqual(['claude-mem-lite.db.legacy-backup-1700000000000']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
