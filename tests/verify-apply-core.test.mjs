// verify-apply — the deterministic write half of /mem:verify (spec:
// docs/superpowers/specs/2026-09-25-mem-verify-design.md). The agent decides WHAT is stale;
// this module is the only thing that writes, so every property the spec promises about a
// write is pinned here: validation before any write, one transaction, a read-back that can
// say NO, and an undo that restores the backed-up row byte-for-byte.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  parseProposals,
  planVerifyApply,
  buildVerifyBackup,
  applyVerifyPlan,
  readBackVerifyPlan,
  undoVerifyBackup,
  VERIFY_RETIRED_MARKER,
} from '../lib/verify-apply-core.mjs';

const P = 'dev--proj';

/** Every row of both tables the writes touch, in a stable order — the "nothing changed" ruler. */
function snapshot(db) {
  const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
  const files = db.prepare('SELECT obs_id, filename FROM observation_files ORDER BY obs_id, filename').all();
  return JSON.stringify({ obs, files });
}

function seed(db, over = {}) {
  const r = insertObs(db, {
    sessionId: 'manual-p',
    project: P,
    type: 'bugfix',
    title: 'Old title',
    narrative: 'The bug in foo.mjs is still open.',
    text: 'The bug in foo.mjs is still open.',
    importance: 2,
    lessonLearned: 'Old lesson',
    filesModified: '["lib/foo.mjs","lib/bar.mjs"]',
    ...over,
  });
  return Number(r.lastInsertRowid);
}

describe('parseProposals — schema validation happens before anything reads the DB', () => {
  it('accepts the three actions in their documented shapes', () => {
    const { entries, errors } = parseProposals([
      { id: 1, action: 'replace', verdict: 'STALE', narrative: 'n', title: 't', evidence: 'abc123' },
      { id: 2, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'n2' }, evidence: 'foo.mjs:3' },
      { id: 3, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.action)).toEqual(['replace', 'edit', 'retire']);
  });

  it.each([
    ['not an array', { id: 1 }, /array/],
    ['empty array', [], /empty/],
    ['unknown action', [{ id: 1, action: 'delete', verdict: 'STALE', evidence: 'x' }], /action/],
    ['unknown key', [{ id: 1, action: 'retire', verdict: 'STALE', evidence: 'x', note: 'y' }], /unknown key/],
    ['non-integer id', [{ id: '7', action: 'retire', verdict: 'STALE', evidence: 'x' }], /id/],
    [
      'duplicate id',
      [
        { id: 1, action: 'retire', verdict: 'STALE', evidence: 'x' },
        { id: 1, action: 'retire', verdict: 'STALE', evidence: 'x' },
      ],
      /duplicate/,
    ],
    ['VALID verdict', [{ id: 1, action: 'retire', verdict: 'VALID', evidence: 'x' }], /verdict/],
    ['empty evidence', [{ id: 1, action: 'retire', verdict: 'STALE', evidence: '  ' }], /evidence/],
    [
      'lesson over 500',
      [
        {
          id: 1,
          action: 'replace',
          verdict: 'STALE',
          narrative: 'n',
          lesson_learned: 'x'.repeat(501),
          evidence: 'e',
        },
      ],
      /500/,
    ],
    [
      'importance 4',
      [{ id: 1, action: 'replace', verdict: 'STALE', narrative: 'n', importance: 4, evidence: 'e' }],
      /importance/,
    ],
    ['edit with empty set', [{ id: 1, action: 'edit', verdict: 'PARTIAL', set: {}, evidence: 'e' }], /set/],
    [
      'edit of a non-editable column',
      [{ id: 1, action: 'edit', verdict: 'PARTIAL', set: { project: 'x' }, evidence: 'e' }],
      /project/,
    ],
    [
      'edit to an empty narrative',
      [{ id: 1, action: 'edit', verdict: 'PARTIAL', set: { narrative: ' ' }, evidence: 'e' }],
      /narrative/,
    ],
  ])('rejects %s', (_label, input, re) => {
    const { entries, errors } = parseProposals(input);
    expect(errors.join('\n')).toMatch(re);
    expect(entries).toEqual([]);
  });
});

describe('planVerifyApply — every target is checked against the DB before a write', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
    insertSession(db, { id: 'manual-o', project: 'dev--other' });
  });
  afterEach(() => db.close());

  const retire = (id) => ({ id, action: 'retire', verdict: 'STALE', evidence: 'e' });

  it('rejects an unknown id, a foreign project, a superseded row and a compressed row — and names each', () => {
    const foreign = seed(db, { sessionId: 'manual-o', project: 'dev--other' });
    const gone = seed(db, { supersededAt: Date.now(), supersededBy: 1 });
    const compressed = seed(db, { compressedInto: -1 });
    const { plan, errors } = planVerifyApply(
      db,
      [retire(99999), retire(foreign), retire(gone), retire(compressed)],
      {
        project: P,
      },
    );
    expect(plan).toEqual([]);
    const text = errors.join('\n');
    expect(text).toMatch(/#99999.*no such/);
    expect(text).toMatch(new RegExp(`#${foreign}.*project`));
    expect(text).toMatch(new RegExp(`#${gone}.*not live`));
    expect(text).toMatch(new RegExp(`#${compressed}.*not live`));
  });

  it('rejects a replace that would have no body (no narrative given, original narrative empty)', () => {
    const id = seed(db, { narrative: '' });
    const { errors } = planVerifyApply(
      db,
      [{ id, action: 'replace', verdict: 'STALE', title: 't', evidence: 'e' }],
      {
        project: P,
      },
    );
    expect(errors.join('\n')).toMatch(/narrative/);
  });

  it('parse + plan write nothing (the dry-run path)', () => {
    const a = seed(db);
    const b = seed(db, { title: 'second' });
    const before = snapshot(db);
    const { entries } = parseProposals([
      { id: a, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'fixed' }, evidence: 'e' },
      retire(b),
    ]);
    const { errors } = planVerifyApply(db, entries, { project: P });
    expect(errors).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });
});

describe('applyVerifyPlan + readBackVerifyPlan', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
  });
  afterEach(() => db.close());

  function planOf(input) {
    const { entries, errors } = parseProposals(input);
    expect(errors).toEqual([]);
    const planned = planVerifyApply(db, entries, { project: P });
    expect(planned.errors).toEqual([]);
    return planned.plan;
  }

  it('lands all three actions and the read-back reports every entry ok', () => {
    const r = seed(db);
    const e = seed(db, { title: 'edit me', narrative: 'line 10 moved', text: 'line 10 moved' });
    const t = seed(db, { title: 'retire me' });
    const plan = planOf([
      {
        id: r,
        action: 'replace',
        verdict: 'STALE',
        title: 'Bug in foo.mjs (fixed in abc123)',
        narrative: 'The bug was fixed in abc123.',
        evidence: 'abc123',
      },
      {
        id: e,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'line 12 moved' },
        evidence: 'foo.mjs:12',
      },
      { id: t, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);
    const results = applyVerifyPlan(db, plan);

    const rep = results.find((x) => x.id === r);
    const oldRow = db.prepare('SELECT * FROM observations WHERE id = ?').get(r);
    const newRow = db.prepare('SELECT * FROM observations WHERE id = ?').get(rep.newId);
    expect(oldRow.superseded_at).not.toBeNull();
    expect(Number(oldRow.superseded_by)).toBe(rep.newId);
    expect(newRow.superseded_at).toBeNull();
    expect(newRow.project).toBe(P);
    expect(newRow.type).toBe('bugfix');
    expect(newRow.importance).toBe(2);
    expect(newRow.title).toBe('Bug in foo.mjs (fixed in abc123)');
    expect(newRow.narrative).toBe('The bug was fixed in abc123.');
    expect(newRow.lesson_learned).toBe('Old lesson'); // not in the entry -> copied from the original
    const newFiles = db
      .prepare('SELECT filename FROM observation_files WHERE obs_id = ? ORDER BY filename')
      .all(rep.newId);
    expect(newFiles.map((f) => f.filename)).toEqual(['lib/bar.mjs', 'lib/foo.mjs']);

    const edited = db.prepare('SELECT * FROM observations WHERE id = ?').get(e);
    expect(edited.narrative).toBe('line 12 moved');
    expect(edited.title).toBe('edit me');
    expect(edited.superseded_at).toBeNull();
    expect(edited.text).toContain('line 12 moved'); // derived FTS text rebuilt through applyObsUpdate

    const retired = db.prepare('SELECT * FROM observations WHERE id = ?').get(t);
    expect(retired.superseded_at).not.toBeNull();
    expect(retired.superseded_by).toBe(VERIFY_RETIRED_MARKER);

    const check = readBackVerifyPlan(db, plan, results);
    expect(check.map((c) => [c.id, c.ok])).toEqual([
      [r, true],
      [e, true],
      [t, true],
    ]);
  });

  it('read-back says NO when a row does not hold what the plan wrote', () => {
    const e = seed(db);
    const plan = planOf([
      { id: e, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'new body' }, evidence: 'x' },
    ]);
    const results = applyVerifyPlan(db, plan);
    db.prepare('UPDATE observations SET narrative = ? WHERE id = ?').run('someone else wrote this', e);
    const [c] = readBackVerifyPlan(db, plan, results);
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/narrative/);
  });

  // One case per action, the superseded target placed LAST so the entries before it have
  // already written when the check fires — a rollback, not a refusal up front. Per action
  // because the re-check guards three different write paths: applyObsUpdate has no liveness
  // predicate of its own, so a single retire-shaped case (whose UPDATE carries one) passed
  // with the re-check deleted.
  it.each(['edit', 'replace', 'retire'])(
    'is all-or-nothing: a %s target superseded after planning aborts the whole run',
    (victimAction) => {
      const others = ['edit', 'replace', 'retire'].filter((a) => a !== victimAction);
      const ids = [
        seed(db, { title: 'first' }),
        seed(db, { title: 'second' }),
        seed(db, { title: 'victim' }),
      ];
      const actions = [...others, victimAction];
      const entry = (id, action) =>
        action === 'edit'
          ? { id, action, verdict: 'PARTIAL', set: { narrative: `edited ${id}` }, evidence: 'x' }
          : action === 'replace'
            ? { id, action, verdict: 'STALE', narrative: `replaced ${id}`, evidence: 'x' }
            : { id, action, verdict: 'STALE', evidence: 'x' };
      const plan = planOf(ids.map((id, i) => entry(id, actions[i])));
      // A concurrent hook retires the LAST target between the plan and the write.
      db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?').run(
        Date.now(),
        'auto-dedup',
        ids[2],
      );
      const before = snapshot(db);
      expect(() => applyVerifyPlan(db, plan)).toThrow(new RegExp(`#${ids[2]}: no longer live`));
      expect(snapshot(db)).toBe(before);
    },
  );
});

describe('undoVerifyBackup', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
  });
  afterEach(() => db.close());

  it('restores every backed-up row byte-for-byte and retires the replacement', () => {
    const r = seed(db);
    const e = seed(db, { title: 'e', narrative: 'old body', text: 'old body' });
    const t = seed(db, { title: 't' });
    const { entries } = parseProposals([
      { id: r, action: 'replace', verdict: 'STALE', narrative: 'corrected', evidence: 'x' },
      {
        id: e,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'new body', importance: 3 },
        evidence: 'x',
      },
      { id: t, action: 'retire', verdict: 'STALE', evidence: 'x' },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const original = new Map(
      [r, e, t].map((id) => [id, db.prepare('SELECT * FROM observations WHERE id = ?').get(id)]),
    );
    const backup = JSON.parse(JSON.stringify(buildVerifyBackup(db, plan)));
    const results = applyVerifyPlan(db, plan);
    const newId = results.find((x) => x.id === r).newId;

    const undone = undoVerifyBackup(db, backup);
    expect(undone.errors).toEqual([]);
    for (const [id, row] of original) {
      expect(db.prepare('SELECT * FROM observations WHERE id = ?').get(id)).toEqual(row);
    }
    const repl = db.prepare('SELECT superseded_at, superseded_by FROM observations WHERE id = ?').get(newId);
    expect(repl.superseded_at).not.toBeNull();
  });

  it('refuses a backup that is not one of ours, writing nothing', () => {
    const id = seed(db);
    const before = snapshot(db);
    const res = undoVerifyBackup(db, { kind: 'something-else', rows: [{ id }] });
    expect(res.errors.join(' ')).toMatch(/backup/);
    expect(snapshot(db)).toBe(before);
  });
});
