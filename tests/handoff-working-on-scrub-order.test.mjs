// `working_on` was TRUNCATED before it was SCRUBBED, which is the opposite of the order
// buildAndSaveHandoff's own persistence-boundary comment prescribes ("scrub raw values
// BEFORE truncation, so a secret straddling the truncation boundary doesn't fall below
// scrubSecrets's regex length floors"). The three call sites that build `working_on`
// — the dedup key, the join, and the carry-forward fallback — each took `truncate()`
// first, so the rule sat two dozen lines below the code that broke it.
//
// Why truncating first LEAKS rather than merely mangling: a pattern with a FIXED length
// stops matching entirely once the value is cut short, so the retained head is stored
// verbatim. Measured on a 244-cut-point sweep across five credential families (the cut
// point walked through the token one character at a time): 33 cut points leak >=12
// characters under truncate-then-scrub and 0 under scrub-then-truncate. Worst cases are
// the fixed-length families — `ghp_`+36 retained 28 of its 36 entropy characters and
// `AKIA`+16 retained 14 of 16, because a short read matches nothing at all. Variable
// length families leak only the prefix (`sk-ant-api03-` retained 0 entropy characters).
//
// The destination is not a log line: `session_handoffs.working_on` is persisted and then
// replayed into a later session's prompt by both renderers.
//
// FIXTURES ARE ASSEMBLED FROM PARTS, never written as one literal — a well-formed
// credential literal in a test file is what GitHub push protection rejected the v6.10.1
// release push over (GH013), and it was a fixture for this very feature.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff } from '../hook-handoff.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
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

const PROJECT = 'wo-proj';
const SESSION = 'hook-wo-proj-1234abcd';

// truncate(str, 200) keeps `str.slice(0, 199)` and appends U+2026, so the cut lands at 199.
const CUT = 199;

function seedSession(db) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(SESSION, SESSION, PROJECT, 1000);
}

function addPrompt(db, text, n = 1) {
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, ?, datetime('now'), ?)`,
  ).run(SESSION, text, n, 1000 + n);
}

function workingOnOf(db) {
  return db.prepare('SELECT working_on FROM session_handoffs').get().working_on;
}

/**
 * Build a prompt in which `token` STRADDLES the truncation boundary, leaving exactly
 * `headLen` of its characters on the kept side. Returns the prompt plus the head, so the
 * case asserts on the measured overlap rather than on an arithmetic assumption.
 */
function straddling(token, headLen) {
  const start = CUT - headLen;
  // The pad must END on a token boundary. SECRET_PATTERNS anchor on one, so a pad running
  // straight into the token (`ppppppghp_aaa…`) means the scrubber never matches it at ANY
  // length — the behavioural cases would then go red for a reason that has nothing to do
  // with the truncation order. The first draft of this helper did exactly that and the
  // premise case below is what caught it.
  const prompt = 'p'.repeat(start - 1) + ' ' + token + ' and the rest of the sentence runs past the cap';
  return { prompt, head: token.slice(0, headLen), start };
}

// Assembled, never one literal. Both are fixed-length families, which is the worst case.
const GH_TOKEN = 'ghp_' + 'a'.repeat(36); // 40 chars
const AWS_TOKEN = 'AKIA' + 'Q'.repeat(16); // 20 chars

describe('working_on is scrubbed BEFORE it is truncated', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  // Every case below is worthless if the fixture does not actually straddle the cut, or if
  // the scrubber cannot see the whole token in the first place. Both are asserted here so a
  // future edit to `truncate`'s cap or to SECRET_PATTERNS turns this red rather than vacuous.
  it.each([
    ['github-pat', GH_TOKEN, 19],
    ['aws-akid', AWS_TOKEN, 18],
  ])('premise: the %s fixture straddles the cut and is otherwise redactable', (_n, token, headLen) => {
    const { prompt, head, start } = straddling(token, headLen);

    expect(prompt.length, 'fixture never reaches the truncation path').toBeGreaterThan(200);
    expect(start, 'token starts after the cut — nothing would be retained').toBeLessThan(CUT);
    expect(start + token.length, 'token ends before the cut — it would not straddle').toBeGreaterThan(CUT);
    expect(head).toHaveLength(headLen);

    // The scrubber CAN redact this token when it sees all of it...
    expect(scrubSecrets(prompt)).not.toContain(token);
    // ...and CANNOT once the cut has shortened it. This is the mechanism under test: without
    // it the case would pass for the wrong reason (a token the scrubber never matched).
    expect(
      scrubSecrets(prompt.slice(0, CUT)),
      'the truncated head is still matched, so this fixture cannot discriminate the two orders',
    ).toContain(head);
  });

  it.each([
    ['github-pat', GH_TOKEN, 19],
    ['aws-akid', AWS_TOKEN, 18],
  ])('does not store the retained head of a straddling %s', (_n, token, headLen) => {
    const { prompt, head } = straddling(token, headLen);
    seedSession(db);
    addPrompt(db, prompt);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);

    const stored = workingOnOf(db);
    expect(stored, 'premise: nothing was stored for working_on').toBeTruthy();
    expect(stored, 'the retained head of the credential survived into the column').not.toContain(head);
  });

  it('redacts a credential that sits well inside the cap (control)', () => {
    // Control for the arm above: this one never reaches the truncation boundary, so it was
    // ALREADY redacted before the fix. If this ever goes red the fix broke the ordinary path.
    seedSession(db);
    addPrompt(db, 'rotate ' + GH_TOKEN + ' before release');
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);

    const stored = workingOnOf(db);
    expect(stored).not.toContain(GH_TOKEN);
    expect(stored).toContain('***');
  });

  it('leaves an ordinary over-long prompt byte-identical up to the cut (control)', () => {
    // Guards the other direction: scrubbing earlier must not over-redact ordinary prose.
    const prose = 'refactor the handoff builder and keep the renderer contract stable. '.repeat(6);
    expect(prose.length).toBeGreaterThan(200);
    seedSession(db);
    addPrompt(db, prose);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);

    const stored = workingOnOf(db);
    expect(stored).toBe(prose.trim().slice(0, CUT) + '…');
  });

  it('scrubs the carry-forward fallback title before truncating it', () => {
    // The third site: when every prompt is a meta trigger, working_on falls back to a stored
    // observation title truncated to 180. Titles are scrubbed on write TODAY, but the column
    // predates that and the persistence-boundary comment calls this arm defense-in-depth for
    // exactly that reason — D#49 still has three bare credential-shaped values backfilled in
    // a sibling column. Inserted raw here, which is the legacy-row shape.
    const headLen = 17; // truncate(title, 180) keeps 179 chars
    const start = 179 - headLen;
    // Same boundary requirement as straddling() above.
    const title = 'investigated the deploy failure '.padEnd(start - 1, 'q') + ' ' + AWS_TOKEN + ' tail';
    expect(title.indexOf(AWS_TOKEN), 'fixture does not start where the arithmetic says').toBe(start);
    expect(start + AWS_TOKEN.length, 'token does not straddle the 180 cap').toBeGreaterThan(179);
    expect(scrubSecrets(title), 'premise: the scrubber cannot see this token at all').not.toContain(
      AWS_TOKEN,
    );
    expect(
      scrubSecrets(title.slice(0, 179)),
      'the truncated head is still matched, so this fixture cannot discriminate',
    ).toContain(AWS_TOKEN.slice(0, headLen));

    seedSession(db);
    addPrompt(db, '继续'); // meta trigger → subjectPrompts is empty → fallback arm
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, importance, narrative, created_at, created_at_epoch)
       VALUES (?, ?, 'change', ?, 3, NULL, datetime('now'), ?)`,
    ).run(SESSION, PROJECT, title, 1100);
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);

    const stored = workingOnOf(db);
    expect(stored, 'premise: the fallback arm did not run').toContain('(carry-forward subject)');
    expect(stored).not.toContain(AWS_TOKEN.slice(0, headLen));
  });
});

describe('scrubSecrets is idempotent on its own output', () => {
  // The fix makes `working_on` pass through scrubSecrets twice: once at the source (this
  // change) and once at the persistence boundary via scrubRecord, which stays in place as
  // defense-in-depth for values that arrive from stored rows rather than from prompts.
  // buildAndSaveHandoff's comment block asserts "no value is scrubbed twice" about the
  // keyword/column derivations; that claim no longer covers this column, so the property the
  // second pass now relies on is pinned HERE rather than restated in a comment. D#46 is open
  // on idempotence-by-CONTRACT; this measures it for the families that reach this path.
  const bearers = [
    'sk-ant-api03-' + 'A'.repeat(80),
    'ghp_' + 'B'.repeat(36),
    'github_pat_' + 'C'.repeat(60),
    'xoxb-' + '1'.repeat(12) + '-' + '2'.repeat(12) + '-' + 'c'.repeat(24),
    'AKIA' + 'Q'.repeat(16),
    'password=' + 'd'.repeat(32),
    'api_key: ' + 'e'.repeat(40),
    'Authorization: Bearer ' + 'f'.repeat(48),
    'postgres://u:p@h:5432/db',
    'AccountKey=' + 'h'.repeat(60) + '==',
    'AIza' + 'm'.repeat(35),
  ];

  it.each(bearers.map((b) => [b.slice(0, 24), b]))('is a fixpoint for %s', (_label, bearer) => {
    const ctx = `before ${bearer} after`;
    const once = scrubSecrets(ctx);
    expect(once, 'premise: this bearer matches no pattern, so the case is vacuous').not.toBe(ctx);
    expect(scrubSecrets(once)).toBe(once);
  });

  it('is a fixpoint for all families in one string', () => {
    const all = bearers.join(' | ');
    const p1 = scrubSecrets(all);
    expect(p1).not.toBe(all);
    const p2 = scrubSecrets(p1);
    expect(p2).toBe(p1);
    expect(scrubSecrets(p2)).toBe(p2);
  });
});
