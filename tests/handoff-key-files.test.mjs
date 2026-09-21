// key_files accepted DIRECTORIES and rejected bare filenames.
//
// The filter required a path separator (`f.includes('/') && f.indexOf('/', 1) !== -1`),
// which asks "does this look like a path" — not "does this look like a FILE". Two costs,
// both measured on the live DB 2026-09-21 over every non-null files_modified row (218
// entries): 59 of them (27%) are repo-root filenames like `hook.mjs` and were dropped on
// the floor, and 3 are extensionless slash-bearing values — directories — which sailed
// through and rendered as key files. That is where `Key Files: claude-mem-lite` in a real
// injection came from — though from the EPISODE BUFFER arm of key_files, not from
// files_modified: no entry in that column equals a project directory. The three
// extensionless slash-bearing values it does hold are one executable and two /var/tmp
// scratch dirs. Corrected by the pre-ship claims lens; isValidFile gates both arms, so the
// predicate under test covers the real source too.
//
// The replacement asks the basename for an extension. Named cost: an extensionless file
// (Makefile, LICENSE) no longer qualifies. The alternative is a hand-drawn list of
// extensionless filenames, which is the shape this repo has rejected three times — a
// hand-drawn class keeps rejecting real cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, renderHandoffInjection } from '../hook-handoff.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

beforeEach(() => {
  vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
    changed: [],
    stashes: [],
    branch: null,
    headSha: null,
  });
  vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PROJECT = 'kf-proj';
const SESSION = 'hook-kf-proj-1234abcd';

function seed(db, files) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(SESSION, SESSION, PROJECT, 1000);
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, 'do the work', 1, datetime('now'), ?)`,
  ).run(SESSION, 1000);
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch)
     VALUES (?, ?, 'change', 'touched some files', 2, ?, NULL, datetime('now'), ?)`,
  ).run(SESSION, PROJECT, JSON.stringify(files), 1100);
}

function keyFilesOf(db) {
  return JSON.parse(db.prepare('SELECT key_files FROM session_handoffs').get().key_files);
}

describe('key_files keeps files and drops directories', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('keeps a repo-root filename that carries no separator', () => {
    seed(db, ['hook.mjs', 'schema.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(expect.arrayContaining(['hook.mjs', 'schema.mjs']));
  });

  it('drops a directory path', () => {
    // The exact value that produced `Key Files: claude-mem-lite` in a real injection.
    seed(db, ['/home/ai/dev/claude-mem-lite', 'lib/handoff-constants.mjs']);
    const files = (buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null), keyFilesOf(db));
    expect(files).toContain('lib/handoff-constants.mjs');
    expect(files).not.toContain('/home/ai/dev/claude-mem-lite');
  });

  it('keeps nested and absolute paths, and dotfiles', () => {
    seed(db, ['lib/data-paths.mjs', '/abs/path/server.mjs', '.env.example', 'a.test.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(
      expect.arrayContaining(['lib/data-paths.mjs', '/abs/path/server.mjs', '.env.example', 'a.test.mjs']),
    );
  });

  it('still excludes the device and scratch trees', () => {
    // These exclusions predate this change and are the reason the filter existed at all.
    seed(db, ['/dev/null', '/proc/self/status', '/tmp/scratch.mjs', 'real.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const files = keyFilesOf(db);
    expect(files).toEqual(['real.mjs']);
  });

  it('drops an extensionless value even when it carries separators', () => {
    seed(db, ['/home/ai/dev/some-project/src', 'kept.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(['kept.mjs']);
  });
});

// key_files was the SEVENTH and last path column still scrubbing whole-string. The other
// six (observations.files_modified, observations.files_read, observation_files.filename,
// events.file_paths, deferred_work.files, session_handoffs.next_steps.file) all route
// through the named helper; this one called `scrubSecrets(String(f))` per element, which
// is element-wise as lib/scrub-record.mjs's header prescribes but with the wrong function.
//
// SEVENTH, not sixth: `deferred_work.files` already holds the ordinal "the SIXTH path
// column" at lib/deferred-work.mjs:52 and tests/secret-scrub-coverage.test.mjs — that was
// the v6.8.2 frame, before `next_steps.file` existed. A draft of this block said SIXTH and
// then enumerated six columns after the words "the other five", so two shipped files claimed
// the same ordinal for different columns. Count the enumeration, not the memory of it.
//
// Why that is not cosmetic: many SECRET_PATTERNS carry a value class that does not
// exclude `/` (the `password=`/`token=`/`api_key=` KV arms take `[^\s,;'"}\]]{6,}`; the
// measured count and its population are stated once, in lib/scrub-record.mjs). Run whole-path, the match eats the separator and everything after
// it, so the FILENAME is destroyed at write time and is unrecoverable from the stored row.
// The renderer emits `basename(f)`, so the cost lands in the injected block a resuming
// session reads: `## Key Files` says `password=***` where the file was `notes.mjs`.
//
// The credential-in-the-BASENAME shape is redacted identically either way, which is why
// it cannot tell the two functions apart — the directory-segment shape is the discriminator,
// and both are pinned below so the fix cannot be mistaken for a weakening of the scrub.
const CRED_DIR_A = '/home/ai/dev/app/password=hunter2abcdef/alpha.mjs';
const CRED_DIR_B = '/home/ai/dev/app/password=hunter2abcdef/beta.mjs';
const CRED_BASENAME = `/home/ai/dev/app/ghp_${'a'.repeat(36)}.mjs`;

describe('key_files scrubs per path SEGMENT, not whole-string', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('keeps the filename when the credential is in a directory segment', () => {
    seed(db, [CRED_DIR_A]);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(['/home/ai/dev/app/password=***/alpha.mjs']);
  });

  it('still redacts the credential itself', () => {
    seed(db, [CRED_DIR_A]);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const stored = db.prepare('SELECT key_files FROM session_handoffs').get().key_files;
    expect(stored, 'the credential survived into the stored column').not.toContain('hunter2abcdef');
    expect(stored).toContain('password=***');
  });

  it('renders the real basename in the ## Key Files line', () => {
    // The artifact, not the column: this is the sentence a resuming session actually reads.
    seed(db, [CRED_DIR_A]);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const out = renderHandoffInjection(db, PROJECT);
    expect(out, 'premise: the block did not render a Key Files section at all').toContain('## Key Files');
    expect(out).toMatch(/## Key Files\nalpha\.mjs/);
    expect(out).not.toContain('password=***');
  });

  it('keeps two files in one credential-bearing directory distinct', () => {
    // Asserting LENGTH here would be vacuous: the Set is keyed on the raw path and the
    // scrub runs after it, so whole-path scrubbing stores two entries that are the same
    // string. The cost is not the count, it is that both entries name the same nothing —
    // so the assertion has to be on the deduplicated VALUES.
    seed(db, [CRED_DIR_A, CRED_DIR_B]);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const files = keyFilesOf(db);
    expect(new Set(files).size, 'both files collapsed onto one string').toBe(2);
    expect(files.map((f) => f.split('/').pop()).sort()).toEqual(['alpha.mjs', 'beta.mjs']);
  });

  it('still redacts a credential that IS the basename', () => {
    seed(db, [CRED_BASENAME]);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(['/home/ai/dev/app/***.mjs']);
  });

  it('leaves an ordinary path byte-identical', () => {
    seed(db, ['lib/scrub-record.mjs', '/abs/path/server.mjs', 'bare.mjs']);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(keyFilesOf(db)).toEqual(['lib/scrub-record.mjs', '/abs/path/server.mjs', 'bare.mjs']);
  });

  it('renders the real basename on the SECOND surface too (### Working State)', () => {
    // key_files has two renderers, not one: renderHandoffFromRow's `## Key Files` above,
    // and hook-context's `- Key files:` inside `### Working State (from /clear)`. Both
    // call basename() on the stored string, so both carried the destroyed filename — one
    // writer, two user-visible surfaces, and a case on only the first would leave the
    // sibling green by inheritance rather than by measurement.
    seed(db, [CRED_DIR_A]);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'clear', null);
    const out = buildSessionContextLines(db, PROJECT, new Date(), SESSION);
    expect(out, 'premise: the Working State block did not render at all').toMatch(/### Working State/);
    expect(out).toMatch(/- Key files: alpha\.mjs/);
    expect(out).not.toContain('password=***');
  });
});
