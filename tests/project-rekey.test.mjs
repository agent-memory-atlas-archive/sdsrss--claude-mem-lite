// D9 part 2: rows a non-ASCII project stored under its OLD id follow it to the new one.
//
// Before D9, ~/projects/博客 and ~/projects/商城 both stored everything as `projects----`. The new
// naming rule gives each its own id, which on its own would strand every existing memory under
// the old, shared one. Rows are moved when their recorded file paths prove which directory
// they belong to; the rest cannot be attributed and stay, and the user is told once where.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { createTestDb, insertObs, insertSession, makeFixtureTracker } from './test-helpers.mjs';
import { legacyProjectNameFromDir, rekeyLegacyProject } from '../lib/project-rekey.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const BLOG = '/home/u/projects/博客';
const SHOP = '/home/u/projects/商城';
const OLD = 'projects----';

function obs(db, title, files, extra = {}) {
  const id = Number(insertObs(db, { project: OLD, title, ...extra }).lastInsertRowid);
  for (const f of files)
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, f);
  return id;
}
const projectOf = (db, id) => db.prepare('SELECT project FROM observations WHERE id = ?').get(id).project;

describe('rekeyLegacyProject', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: OLD });
  });
  afterEach(() => db.close());

  it('premise: both directories had the same old id', () => {
    expect(legacyProjectNameFromDir(BLOG)).toBe(OLD);
    expect(legacyProjectNameFromDir(SHOP)).toBe(OLD);
  });

  it("moves the rows whose files are in this directory, and nobody else's", () => {
    const blog = obs(db, 'blog post layout', [`${BLOG}/src/post.js`]);
    const blogRoot = obs(db, 'blog readme', [BLOG]);
    const shop = obs(db, 'shop cart bug', [`${SHOP}/src/cart.js`]);
    const lookalike = obs(db, 'other blog dir', [`${BLOG}-archive/x.js`]); // prefix, not inside
    const unknown = obs(db, 'relative path only', ['src/post.js']);

    const r = rekeyLegacyProject(db, { dir: BLOG, project: 'projects--博客', legacy: OLD });
    expect(r).toEqual({ moved: 2, left: 3 });
    expect(projectOf(db, blog)).toBe('projects--博客');
    expect(projectOf(db, blogRoot)).toBe('projects--博客');
    for (const id of [shop, lookalike, unknown]) expect(projectOf(db, id)).toBe(OLD);
  });

  it('keeps a compression cluster in one project', () => {
    const keeper = obs(db, 'blog keeper', []);
    const member = obs(db, 'blog member', [`${BLOG}/a.js`], { compressedInto: keeper });
    const sibling = obs(db, 'blog member 2', [], { compressedInto: keeper });
    rekeyLegacyProject(db, { dir: BLOG, project: 'projects--博客', legacy: OLD });
    for (const id of [keeper, member, sibling]) expect(projectOf(db, id)).toBe('projects--博客');
  });

  it('treats LIKE metacharacters in the directory literally', () => {
    const odd = obs(db, 'odd', ['/w/a_b%/x.js']);
    const other = obs(db, 'other', ['/w/aXbYZ/x.js']);
    rekeyLegacyProject(db, { dir: '/w/a_b%', project: 'w--a_b-', legacy: OLD });
    expect(projectOf(db, odd)).toBe('w--a_b-');
    expect(projectOf(db, other)).toBe(OLD);
  });

  it('matches a path the OS spelled decomposed', () => {
    const nfd = '/w/cafe\u0301';
    const id = obs(db, 'cafe', [`${nfd}/x.js`], { project: 'w--caf--' });
    rekeyLegacyProject(db, { dir: '/w/caf\u00e9', project: 'w--caf\u00e9', legacy: 'w--caf--' });
    expect(projectOf(db, id)).toBe('w--caf\u00e9');
  });
});

describe('at SessionStart', () => {
  let home, dir;
  beforeEach(() => {
    const root = fixtures.track(join(tmpdir(), `mem-rekey-${randomUUID().slice(0, 8)}`));
    home = join(root, 'home');
    dir = join(root, 'projects', '博客');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    initSchema(db);
    insertSession(db, { id: 'sess-1', project: OLD });
    const id = Number(insertObs(db, { project: OLD, title: 'blog layout lesson' }).lastInsertRowid);
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, `${dir}/post.js`);
    insertObs(db, { project: OLD, title: 'unattributable' });
    db.close();
  });

  const start = () =>
    execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      input: JSON.stringify({ session_id: 'cc-1', source: 'startup', cwd: dir }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: dir,
        CLAUDE_MEM_HOOK_RUNNING: '',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        CLAUDE_MEM_SKIP_COMPRESS: '1',
        CLAUDE_MEM_SKIP_OPTIMIZE: '1',
        CLAUDE_MEM_SKIP_SUMMARY: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
      encoding: 'utf8',
      timeout: 20000,
    });

  it('moves the attributable rows once and tells the user once', () => {
    const first = start();
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), { readonly: true });
    const rows = db.prepare('SELECT title, project FROM observations ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { title: 'blog layout lesson', project: 'projects--博客' },
      { title: 'unattributable', project: OLD },
    ]);
    expect(first).toContain('projects--博客');
    expect(first).toContain(`--project ${OLD}`);
    expect(
      readdirSync(join(home, '.claude-mem-lite', 'runtime')).some((f) => f.startsWith('.project-rekeyed-')),
    ).toBe(true);
    expect(start()).not.toContain(`--project ${OLD}`);
  });
});
