// match_keywords was excluded from scrubbing on a justification that does not hold.
//
// lib/scrub-record.mjs listed the reason: "the value is built from tokenizeHandoff()
// output (alphanumeric tokens only), so secrets cannot survive the upstream tokenizer."
// Measured against the real function, BOTH arms of extractMatchKeywords contradict it:
//
//   file arm  — never reaches tokenizeHandoff at all. It takes `basename(f)` minus the
//               extension straight off the fileSet, and that set holds RAW paths: the
//               scrub runs downstream, on the key_files copy only. A credential that is
//               the basename is stored verbatim (lowercased).
//   prose arm — the tokenizer SPLITS a secret from its keyword, it does not remove it.
//               `token=ghp_…` tokenizes to ["token", "ghp_…"], and the second token is
//               added to the term set on its own.
//
// Exposure is storage, not prompt: nothing renders match_keywords, it is read back for a
// token-set intersection in the intent matcher. Measured, because an earlier draft of this
// docblock asserted egress and was wrong: `EXPORT_COLUMNS` is observations-only and
// `session_handoffs` has ZERO occurrences in server.mjs and the CLI, so no export face reads
// this table. Local-DB-at-rest, no egress path. A credential in a stored column is still
// worth removing; calling it a disclosure would have been a second unverified justification
// standing where a retracted one used to be.
//
// The fix scrubs at the DERIVATION, per ELEMENT, and feeds both sinks from one scrubbed
// array — the shape hook-llm.mjs uses where `obs.files` feeds two sinks. It is NOT identity
// on ordinary prose (`api_key: handling` loses `handling`); what it is, is CONSISTENT — the
// term set now loses exactly the words the stored columns lose, since both route through
// scrubSecrets. The last two cases pin both halves of that.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff } from '../hook-handoff.mjs';
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

const PROJECT = 'mk-proj';
const SESSION = 'hook-mk-proj-1234abcd';
const GH_TOKEN = `ghp_${'a'.repeat(36)}`;

function seed(db, { prompt = 'work on the ranker', files = [], title = 'touched some files' } = {}) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(SESSION, SESSION, PROJECT, 1000);
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, 1, datetime('now'), ?)`,
  ).run(SESSION, prompt, 1000);
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch)
     VALUES (?, ?, 'change', ?, 2, ?, NULL, datetime('now'), ?)`,
  ).run(SESSION, PROJECT, title, JSON.stringify(files), 1100);
}

function keywordsOf(db) {
  return db.prepare('SELECT match_keywords FROM session_handoffs').get().match_keywords;
}

describe('match_keywords does not store credentials', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('file arm: a credential that IS the basename is not stored verbatim', () => {
    seed(db, { files: [`/home/ai/dev/app/${GH_TOKEN}.mjs`] });
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const kw = keywordsOf(db);
    expect(kw, 'premise: no keywords were derived at all').toBeTruthy();
    expect(kw, 'the raw token reached match_keywords').not.toContain(GH_TOKEN.toLowerCase());
  });

  it('prose arm: a credential in the working objective is not stored verbatim', () => {
    // The tokenizer splits on `=`, so the keyword and the secret become two terms and
    // the secret is added on its own merit. Nothing downstream removes it.
    seed(db, { prompt: `the upstream client keeps rejecting token=${GH_TOKEN} on refresh` });
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const kw = keywordsOf(db);
    expect(kw, 'premise: no keywords were derived at all').toBeTruthy();
    expect(kw, 'the raw token reached match_keywords').not.toContain(GH_TOKEN.toLowerCase());
  });

  it('prose arm: a credential in an observation title is not stored verbatim', () => {
    seed(db, { title: `rotated the zebrafish after api_key=${GH_TOKEN} leaked` });
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const kw = keywordsOf(db);
    // The premise its two siblings carry, and this case lacked: without it the assertion
    // would pass identically if the observation title never reached the derivation at all.
    expect(kw, 'premise: the title never reached the keyword derivation').toContain('zebrafish');
    expect(kw, 'the raw token reached match_keywords').not.toContain(GH_TOKEN.toLowerCase());
  });

  it('scrubs each element, so the JOIN cannot invent a match across two of them', () => {
    // Scrubbing the concatenation lets a credential noun ending one element pair with a `:`
    // opening the next, forming a match present in NEITHER — and the derived term set then
    // loses a word both stored columns keep. Measured on exactly this fixture before the fix:
    // working_on and completed both kept `zebrafish`; match_keywords did not.
    seed(db, { prompt: 'we still need to set the api_key', title: ': zebrafish is manual' });
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const row = db.prepare('SELECT working_on, completed, match_keywords FROM session_handoffs').get();
    expect(row.working_on, 'premise: the prompt did not land in working_on').toContain('api_key');
    expect(row.completed, 'premise: the title did not land in completed').toContain('zebrafish');
    expect(row.match_keywords.split(' '), 'the join destroyed a term no column lost').toContain('zebrafish');
  });

  it('loses exactly the terms the stored columns lose, and no others', () => {
    // The control that bounds the fix. NOT "identity on ordinary prose" — that claim is false
    // and an earlier draft of this file made it: `api_key: handling` does lose `handling`,
    // because the structured-key patterns carry no prose lookbehind. What must hold is
    // CONSISTENCY: every term the keyword set drops is a term the rendered columns drop too,
    // so the matcher and the injected block cannot disagree about what the session was about.
    seed(db, {
      prompt: 'rework the handoff dispatch ranker',
      title: 'adjusted scoring-sql thresholds',
      files: ['lib/scoring-sql.mjs', '/abs/path/server.mjs'],
    });
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const terms = keywordsOf(db).split(' ');
    for (const t of ['handoff', 'dispatch', 'ranker', 'thresholds', 'scoring-sql', 'server']) {
      expect(terms, `ordinary term "${t}" was lost`).toContain(t);
    }
    expect(terms, 'a redaction marker appeared on clean input').not.toContain('***');
  });
});
