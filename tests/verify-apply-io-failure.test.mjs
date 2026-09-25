// The one verify-apply failure that happens AFTER the transaction commits: the backup is
// rewritten with the post-apply record, and if that write fails the changes are already in
// the database. The error must say so ("applied, but …") — the CLI and commands/verify.md key
// on that prefix to avoid telling the user "nothing was written" (re-review of dcc8f72, P3-3).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

let writes = 0;
vi.mock('../lib/atomic-write.mjs', async (orig) => {
  const real = await orig();
  return {
    ...real,
    atomicWriteFileSync: (...args) => {
      writes++;
      if (writes === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.atomicWriteFileSync(...args);
    },
  };
});
import {
  parseProposals,
  planVerifyApply,
  runVerifyApply,
  VERIFY_RETIRED_MARKER,
} from '../lib/verify-apply-core.mjs';

describe('runVerifyApply when the post-apply record cannot be written', () => {
  let db;
  let dir;
  beforeEach(() => {
    writes = 0;
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: 'p' });
    dir = mkdtempSync(join(tmpdir(), 'mem-verify-io-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws "applied, but …" — the change IS committed and the pre-apply backup is kept', () => {
    const id = Number(
      insertObs(db, { sessionId: 'manual-p', project: 'p', title: 't', narrative: 'n' }).lastInsertRowid,
    );
    const { plan } = planVerifyApply(
      db,
      parseProposals([{ id, action: 'retire', verdict: 'STALE', evidence: 'x' }]).entries,
      { project: 'p' },
    );
    expect(() => runVerifyApply(db, plan, { backupDir: dir })).toThrow(
      /^applied, but the undo record could not be written/,
    );
    expect(writes).toBe(2); // premise: the failure was the SECOND write, after the commit
    expect(db.prepare('SELECT superseded_by FROM observations WHERE id = ?').get(id).superseded_by).toBe(
      VERIFY_RETIRED_MARKER,
    );
    const [file] = readdirSync(dir);
    expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).applied).toBeNull();
  });
});
