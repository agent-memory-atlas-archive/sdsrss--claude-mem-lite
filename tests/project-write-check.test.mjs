// E2E 2026-10-16 (cli F14, data S9): a mistyped `--project` on a write silently created a new
// project ("otherr-api" next to "work--other-api"), and a short name written from the project's
// own directory before it had rows became a bare-name project that "<parent>--<name>" shadowed
// once it existed, leaving those rows unreachable by name.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { resolveProject, checkWriteProject, _resetProjectCache } from '../project-utils.mjs';

let db;
beforeEach(() => {
  db = createTestDb();
  _resetProjectCache();
  insertSession(db, { id: 'sess-1', project: 'work--other-api' });
  insertObs(db, { project: 'work--other-api', title: 'Redis pool exhaustion' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetProjectCache();
});

describe('resolveProject write mode', () => {
  it("a short name that is the caller's own directory resolves to its full id", () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', '/home/u/b/newapp');
    expect(resolveProject(db, 'newapp', { mode: 'write' })).toBe('b--newapp');
  });
  it('control: a short name of another directory is still kept as given', () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', '/home/u/a/app');
    expect(resolveProject(db, 'zeta', { mode: 'write' })).toBe('zeta');
  });
});

describe('checkWriteProject', () => {
  it('refuses a new name one edit away from an existing project, naming it', () => {
    const r = checkWriteProject(db, 'otherr-api');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did you mean "work--other-api"/);
    expect(r.message).toMatch(/Nothing was saved/);
  });
  it('lets a new name nothing resembles through, with a note', () => {
    const r = checkWriteProject(db, 'zeta-billing');
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/new project "zeta-billing"/);
  });
  it('an existing project passes with no note', () => {
    expect(checkWriteProject(db, 'work--other-api')).toEqual({ ok: true, note: '' });
  });
  it('a project known only from another table counts as existing', () => {
    db.prepare(
      "INSERT INTO deferred_work (project, title, priority, status, created_at_epoch) VALUES ('ops--deploy', 't', 2, 'open', ?)",
    ).run(Date.now());
    expect(checkWriteProject(db, 'ops--deploy')).toEqual({ ok: true, note: '' });
  });
  it('a full id that resembles another is deliberate: noted, not refused', () => {
    const r = checkWriteProject(db, 'work--other-apis');
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/new project/);
  });
  it('short names need a closer match before they are refused', () => {
    insertObs(db, { project: 'x--app', title: 'a' });
    expect(checkWriteProject(db, 'api').ok).toBe(true);
  });
  // Pre-tag review 2026-10-16 P3-6: ids containing "--" skipped the near-name check, so
  // `save --project Dev--Claude-Mem-Lite` beside `dev--claude-mem-lite` was written as a new
  // project the lower-case reads never find.
  it('a full id that differs from an existing one only in case is refused, naming it', () => {
    const r = checkWriteProject(db, 'Work--Other-Api');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did you mean "work--other-api"/);
    expect(r.message).toMatch(/Nothing was saved/);
    expect(r.message).toMatch(/only in case/);
  });
  it('a case variant of a project known only from another table is refused too', () => {
    db.prepare(
      "INSERT INTO deferred_work (project, title, priority, status, created_at_epoch) VALUES ('ops--deploy', 't', 2, 'open', ?)",
    ).run(Date.now());
    expect(checkWriteProject(db, 'OPS--Deploy').ok).toBe(false);
  });
});
