// Two repositories' `packages/api` (or `.claude/worktrees/<name>`) keep separate memories (D16).
//
// The project id is `parent--basename`, so ~/a/packages/api and ~/b/packages/api were both
// `packages--api`: the other repository's Last Session, handoff and file lessons were injected
// here and consumed. Now the directory that owns an id keeps it, and any other directory that
// maps to the same id gets `<id>~<hash of its path>`. Which directory owns a contested id is
// decided by the data the first time it is claimed, not by who happens to open first.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { createTestDb, insertObs, insertSession, makeFixtureTracker } from './test-helpers.mjs';
import { projectIdForDir, projectNameFromDir, PROJECT_OWNER_PREFIX } from '../project-utils.mjs';
import { electProjectOwner, claimProjectOwner } from '../lib/project-owner.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

let root, A, B, runtime;
beforeEach(() => {
  root = fixtures.track(join(tmpdir(), `mem-owner-${randomUUID().slice(0, 8)}`));
  A = join(root, 'a', 'packages', 'api');
  B = join(root, 'b', 'packages', 'api');
  for (const d of [A, B]) mkdirSync(join(d, 'src'), { recursive: true });
  runtime = join(root, 'runtime');
  mkdirSync(runtime, { recursive: true });
});

const ownerFile = (id) => join(runtime, `${PROJECT_OWNER_PREFIX}${id}`);

describe('projectIdForDir', () => {
  it('premise: the two directories share one plain id', () => {
    expect(projectNameFromDir(A)).toBe('packages--api');
    expect(projectNameFromDir(B)).toBe('packages--api');
  });

  it('is the plain id with no owner, and for the owner', () => {
    expect(projectIdForDir(A, runtime)).toBe('packages--api');
    writeFileSync(ownerFile('packages--api'), A);
    expect(projectIdForDir(A, runtime)).toBe('packages--api');
    expect(projectIdForDir(`${A}/`, runtime)).toBe('packages--api');
  });

  it('gives any other directory its own stable id', () => {
    writeFileSync(ownerFile('packages--api'), A);
    const b = projectIdForDir(B, runtime);
    expect(b).toMatch(/^packages--api~[0-9a-f]{8}$/);
    expect(projectIdForDir(B, runtime)).toBe(b);
    const c = join(root, 'c', 'packages', 'api');
    mkdirSync(c, { recursive: true });
    expect(projectIdForDir(c, runtime)).not.toBe(b);
  });

  it('ignores an owner whose directory is gone', () => {
    writeFileSync(ownerFile('packages--api'), join(root, 'deleted', 'packages', 'api'));
    expect(projectIdForDir(B, runtime)).toBe('packages--api');
  });
});

describe('electProjectOwner', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'packages--api' });
  });
  afterEach(() => db.close());
  const obs = (file, project = 'packages--api') => {
    const id = Number(insertObs(db, { project, title: `t ${file}` }).lastInsertRowid);
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, file);
  };

  it('elects the directory the rows came from, not the one opening now', () => {
    obs(`${A}/src/x.js`);
    obs(`${A}/src/y.js`);
    expect(electProjectOwner(db, { dir: B, id: 'packages--api' })).toBe(A);
  });

  it('elects the directory with more rows when both have some', () => {
    obs(`${A}/src/x.js`);
    obs(`${B}/src/x.js`);
    obs(`${B}/src/y.js`);
    expect(electProjectOwner(db, { dir: A, id: 'packages--api' })).toBe(B);
  });

  it('elects the opening directory when nothing shows another one', () => {
    obs('src/relative.js');
    expect(electProjectOwner(db, { dir: B, id: 'packages--api' })).toBe(B);
    obs(`${join(root, 'gone', 'packages', 'api')}/x.js`); // a directory that no longer exists
    expect(electProjectOwner(db, { dir: B, id: 'packages--api' })).toBe(B);
  });
});

describe('claimProjectOwner', () => {
  it('the first claim wins', () => {
    expect(claimProjectOwner(runtime, 'packages--api', A)).toBe(A);
    expect(claimProjectOwner(runtime, 'packages--api', B)).toBe(A);
    expect(readFileSync(ownerFile('packages--api'), 'utf8')).toBe(A);
    expect(readdirSync(runtime).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('replaces an owner whose directory is gone', () => {
    writeFileSync(ownerFile('packages--api'), join(root, 'gone'));
    expect(claimProjectOwner(runtime, 'packages--api', B)).toBe(B);
  });
});

describe('through the hooks', () => {
  let home;
  beforeEach(() => {
    home = join(root, 'home');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    initSchema(db);
    db.close();
  });
  const env = (dir, extra = {}) => ({
    ...process.env,
    HOME: home,
    CLAUDE_PROJECT_DIR: dir,
    CLAUDE_PID: '',
    CLAUDE_MEM_HOOK_RUNNING: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_SUMMARY: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    MEM_NO_AUTO_ADOPT: '1',
    ...extra,
  });
  const hook = (event, dir, payload) =>
    execFileSync(process.execPath, [join(REPO, 'hook.mjs'), event], {
      input: JSON.stringify({ cwd: dir, ...payload }),
      env: env(dir),
      encoding: 'utf8',
      timeout: 20000,
    });
  const q = (sql, ...a) => {
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), { readonly: true });
    try {
      return db.prepare(sql).all(...a);
    } finally {
      db.close();
    }
  };
  const seed = (rows) => {
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    insertSession(db, { id: 'old', project: 'packages--api' });
    for (const [title, file] of rows) {
      const id = Number(insertObs(db, { sessionId: 'old', project: 'packages--api', title }).lastInsertRowid);
      if (file) db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, file);
    }
    db.close();
  };

  it("a second repository's packages/api starts its own memory", () => {
    hook('session-start', A, { session_id: 'cc-a', source: 'startup' });
    hook('user-prompt', A, { session_id: 'cc-a', prompt: 'Fix the ALPHA_API rate limiter' });
    hook('session-start', B, { session_id: 'cc-b', source: 'startup' });
    hook('user-prompt', B, { session_id: 'cc-b', prompt: 'Add the BRAVO_API health route' });
    const projects = Object.fromEntries(
      q(
        `SELECT p.cc_session_id cc, s.project FROM user_prompts p
         JOIN sdk_sessions s ON s.content_session_id = p.content_session_id`,
      ).map((r) => [r.cc, r.project]),
    );
    expect(projects['cc-a']).toBe('packages--api');
    expect(projects['cc-b']).toMatch(/^packages--api~[0-9a-f]{8}$/);
  });

  it('on upgrade, the directory the rows came from keeps the id and the other takes its own rows', () => {
    seed([
      ['alpha limiter lesson', `${A}/src/limiter.js`],
      ['alpha retry lesson', `${A}/src/retry.js`],
      ['bravo health lesson', `${B}/src/health.js`],
      ['no path at all', null],
    ]);
    const out = hook('session-start', B, { session_id: 'cc-b', source: 'startup' }); // B opens first
    const rows = Object.fromEntries(
      q('SELECT title, project FROM observations').map((r) => [r.title, r.project]),
    );
    expect(rows['alpha limiter lesson']).toBe('packages--api');
    expect(rows['alpha retry lesson']).toBe('packages--api');
    expect(rows['no path at all']).toBe('packages--api');
    expect(rows['bravo health lesson']).toMatch(/^packages--api~[0-9a-f]{8}$/);
    expect(out).toContain(A); // told once whose id it was
    expect(JSON.parse(out).systemMessage).toMatch(/Moved 1 memory/);
  });

  it('a non-Latin collision moves the rows stored under the new plain id too', () => {
    // Here the pre-D9 id (`-----`) and the plain id (`项目--博客`) differ, and rows written
    // after D9 but before the owner was settled sit under the plain one.
    const a = join(root, 'a', '项目', '博客');
    const b = join(root, 'b', '项目', '博客');
    for (const d of [a, b]) mkdirSync(d, { recursive: true });
    const plain = projectNameFromDir(a);
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    insertSession(db, { id: 'old', project: plain });
    for (const [title, file] of [
      ['alpha 1', `${a}/x.js`],
      ['alpha 2', `${a}/y.js`],
      ['bravo 1', `${b}/x.js`],
    ]) {
      const id = Number(insertObs(db, { sessionId: 'old', project: plain, title }).lastInsertRowid);
      db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, file);
    }
    db.close();
    hook('session-start', b, { session_id: 'cc-b', source: 'startup' });
    const rows = Object.fromEntries(
      q('SELECT title, project FROM observations').map((r) => [r.title, r.project]),
    );
    expect(rows['alpha 1']).toBe(plain);
    expect(rows['bravo 1']).toMatch(new RegExp(`^${plain}~[0-9a-f]{8}$`));
  });

  it('an owner record for a directory that is gone is swept at SessionStart', () => {
    const rt = join(home, '.claude-mem-lite', 'runtime');
    writeFileSync(
      join(rt, `${PROJECT_OWNER_PREFIX}worktrees--fix`),
      join(root, 'deleted', 'worktrees', 'fix'),
    );
    hook('session-start', A, { session_id: 'cc-a', source: 'startup' });
    expect(existsSync(join(rt, `${PROJECT_OWNER_PREFIX}worktrees--fix`))).toBe(false);
    expect(existsSync(join(rt, `${PROJECT_OWNER_PREFIX}packages--api`))).toBe(true);
  });
});
