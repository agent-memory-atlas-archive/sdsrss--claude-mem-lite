// lib/verify-apply-core.mjs — the deterministic write half of /mem:verify.
//
// Spec: docs/superpowers/specs/2026-09-25-mem-verify-design.md. The judgement ("is this memory
// still true?") belongs to an agent with repository tools; that division is measured, not
// taste — a cheap single-shot model reached STALE precision 0.36, and model-written addenda
// were false 29 times in 72, while agent raters agreed at kappa 0.84 (memories #202-#204).
// So the agent PROPOSES and this module is the only thing that WRITES: every write goes
// through the existing choke points (saveObservation's supersede path, applyObsUpdate), in
// one IMMEDIATE transaction, after a validation pass that has already refused anything it
// cannot stand behind.

import { saveObservation } from './save-observation.mjs';
import { applyObsUpdate } from './observation-write.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';

/** `superseded_by` marker for a memory retired with no replacement. */
export const VERIFY_RETIRED_MARKER = 'verify-retired';
/** `superseded_by` marker for a replacement row retired by --undo. */
const VERIFY_UNDONE_MARKER = 'verify-undone';

const BACKUP_KIND = 'claude-mem-lite/verify-backup';
const BACKUP_VERSION = 1;
const LESSON_MAX = 500;

const ACTIONS = new Set(['replace', 'edit', 'retire']);
const VERDICTS = new Set(['STALE', 'PARTIAL']);
const KEYS_BY_ACTION = {
  replace: new Set([
    'id',
    'action',
    'verdict',
    'evidence',
    'title',
    'narrative',
    'lesson_learned',
    'importance',
  ]),
  edit: new Set(['id', 'action', 'verdict', 'evidence', 'set']),
  retire: new Set(['id', 'action', 'verdict', 'evidence']),
};
// The columns applyObsUpdate accepts, minus `type`: a verification corrects what a memory
// SAYS, and re-typing it is a classification change nobody verified.
const EDITABLE = new Set(['title', 'narrative', 'lesson_learned', 'importance', 'concepts']);

// Everything an apply can change on a row it TARGETS. --undo restores exactly these, so the
// usage counters a row accumulated after the apply (injections, citations) are not rolled
// back along with the content.
const RESTORE_COLUMNS = [
  'title',
  'subtitle',
  'narrative',
  'text',
  'facts',
  'concepts',
  'lesson_learned',
  'importance',
  'search_aliases',
  'scope',
  'superseded_at',
  'superseded_by',
];

function checkField(where, key, value, errors) {
  if (key === 'importance') {
    if (!Number.isInteger(value) || value < 1 || value > 3)
      errors.push(`${where}: importance must be 1, 2 or 3`);
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${where}: ${key} must be a non-empty string`);
    return;
  }
  if (key === 'lesson_learned' && value.length > LESSON_MAX) {
    errors.push(`${where}: lesson_learned is ${value.length} chars (max ${LESSON_MAX})`);
  }
}

/**
 * Validate a proposals document's SHAPE. Pure — no DB. Any error empties `entries`, so a
 * caller cannot apply the valid half of a document that was partly wrong.
 * @param {unknown} input parsed JSON
 * @returns {{entries: object[], errors: string[]}}
 */
export function parseProposals(input) {
  const errors = [];
  if (!Array.isArray(input)) return { entries: [], errors: ['proposals must be a JSON array'] };
  if (input.length === 0) return { entries: [], errors: ['proposals array is empty'] };
  const seen = new Set();
  const entries = [];
  input.forEach((e, i) => {
    const where = `entry ${i + 1}${e && Number.isInteger(e.id) ? ` (#${e.id})` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (!Number.isInteger(e.id) || e.id <= 0) errors.push(`${where}: id must be a positive integer`);
    else if (seen.has(e.id)) errors.push(`${where}: duplicate id #${e.id}`);
    else seen.add(e.id);
    if (!ACTIONS.has(e.action)) {
      errors.push(`${where}: action must be one of replace, edit, retire`);
      return;
    }
    for (const k of Object.keys(e))
      if (!KEYS_BY_ACTION[e.action].has(k)) errors.push(`${where}: unknown key "${k}"`);
    if (!VERDICTS.has(e.verdict)) errors.push(`${where}: verdict must be STALE or PARTIAL`);
    if (typeof e.evidence !== 'string' || e.evidence.trim().length === 0) {
      errors.push(`${where}: evidence is required (a commit, or file:line)`);
    }
    if (e.action === 'replace') {
      for (const k of ['title', 'narrative', 'lesson_learned', 'importance']) {
        if (e[k] !== undefined) checkField(where, k, e[k], errors);
      }
    } else if (e.action === 'edit') {
      const set = e.set;
      if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
        errors.push(`${where}: edit needs a non-empty "set" object`);
      } else {
        for (const [k, v] of Object.entries(set)) {
          if (!EDITABLE.has(k))
            errors.push(`${where}: "${k}" is not editable (allowed: ${[...EDITABLE].join(', ')})`);
          else checkField(where, k, v, errors);
        }
      }
    }
    entries.push(e);
  });
  return errors.length ? { entries: [], errors } : { entries, errors };
}

function filesOf(db, id) {
  return db
    .prepare('SELECT filename FROM observation_files WHERE obs_id = ? ORDER BY filename')
    .all(id)
    .map((r) => r.filename);
}

function isLive(row) {
  return row.superseded_at === null && (row.compressed_into === null || row.compressed_into === 0);
}

/**
 * Check every entry against the DB: the row exists, is live, and belongs to `project`.
 * Read-only. Any error empties `plan`.
 * @returns {{plan: object[], errors: string[]}}
 */
export function planVerifyApply(db, entries, { project }) {
  const errors = [];
  const plan = [];
  for (const e of entries) {
    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(e.id);
    if (!row) {
      errors.push(`#${e.id}: no such observation`);
      continue;
    }
    if (row.project !== project) {
      errors.push(`#${e.id}: belongs to project ${row.project}, not ${project}`);
      continue;
    }
    if (!isLive(row)) {
      errors.push(`#${e.id}: not live (already superseded or compressed)`);
      continue;
    }
    if (e.action === 'replace' && !String(e.narrative ?? row.narrative ?? '').trim()) {
      errors.push(`#${e.id}: replace needs a narrative (the original has none to copy)`);
      continue;
    }
    plan.push({ ...e, before: row, files: filesOf(db, e.id) });
  }
  return errors.length ? { plan: [], errors } : { plan, errors };
}

/**
 * The rows a plan will touch, as they are now — written to disk BEFORE the apply.
 * @returns {object} JSON-serialisable backup document
 */
export function buildVerifyBackup(db, plan, { now = new Date() } = {}) {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    created_at: now.toISOString(),
    project: plan[0]?.before.project ?? null,
    rows: plan.map((p) => ({
      action: p.action,
      row: db.prepare('SELECT * FROM observations WHERE id = ?').get(p.id),
      files: filesOf(db, p.id),
    })),
  };
}

/**
 * Apply a validated plan in ONE immediate transaction. Throws — and writes nothing — if any
 * target stopped being live (or changed project) since it was planned: a hook can supersede a
 * row between the dry run the user approved and this write, and applying the other N-1
 * entries of an approved set is not what was approved.
 * @returns {Array<{id: number, action: string, newId?: number}>}
 */
export function applyVerifyPlan(db, plan, { now = new Date() } = {}) {
  const tx = db.transaction(() => {
    const results = [];
    for (const p of plan) {
      const live = db
        .prepare(`SELECT project FROM observations WHERE id = ? AND ${liveObsFilterSql('')}`)
        .get(p.id);
      if (!live || live.project !== p.before.project) {
        throw new Error(`#${p.id}: no longer live in ${p.before.project} — aborted, nothing written`);
      }
      if (p.action === 'retire') {
        const res = db
          .prepare(
            `UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ? AND ${liveObsFilterSql('')}`,
          )
          .run(now.getTime(), VERIFY_RETIRED_MARKER, p.id);
        if (res.changes !== 1) throw new Error(`#${p.id}: retire did not land — aborted, nothing written`);
        results.push({ id: p.id, action: p.action });
      } else if (p.action === 'edit') {
        applyObsUpdate(db, p.id, p.set);
        results.push({ id: p.id, action: p.action });
      } else {
        // `force`: the user approved this correction explicitly, and the original it replaces
        // is by construction a near-duplicate of it — the 5-minute dedup window would refuse
        // exactly the save that was asked for.
        const r = saveObservation(db, {
          content: p.narrative ?? p.before.narrative,
          title: p.title ?? p.before.title,
          type: p.before.type,
          importance: p.importance ?? p.before.importance,
          project: p.before.project,
          files: p.files,
          lesson_learned: p.lesson_learned ?? p.before.lesson_learned,
          supersedes: [p.id],
          force: true,
          now,
        });
        if (r.kind !== 'saved' || !r.supersededIds.includes(p.id)) {
          throw new Error(`#${p.id}: replacement did not supersede the original — aborted, nothing written`);
        }
        results.push({ id: p.id, action: p.action, newId: r.id });
      }
    }
    return results;
  });
  return tx.immediate();
}

const expectStr = (v) => (typeof v === 'string' ? scrubSecrets(v) : v);

/**
 * Read every touched row back and compare it with what the plan wrote. The comparison is
 * against the SCRUBBED expectation, because both write paths scrub on the way in.
 * @returns {Array<{id: number, action: string, ok: boolean, problems: string[], newId?: number}>}
 */
export function readBackVerifyPlan(db, plan, results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const get = (id) => db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  return plan.map((p) => {
    const problems = [];
    const row = get(p.id);
    const res = byId.get(p.id);
    if (!row || !res) problems.push('row or result missing');
    else if (p.action === 'retire') {
      if (row.superseded_at === null) problems.push('not superseded');
      if (row.superseded_by !== VERIFY_RETIRED_MARKER) problems.push(`superseded_by is ${row.superseded_by}`);
    } else if (p.action === 'edit') {
      if (!isLive(row)) problems.push('no longer live');
      for (const [k, v] of Object.entries(p.set)) if (row[k] !== expectStr(v)) problems.push(`${k} differs`);
    } else {
      if (Number(row.superseded_by) !== res.newId || row.superseded_at === null) {
        problems.push(`original not superseded by #${res.newId}`);
      }
      const nw = get(res.newId);
      if (!nw) problems.push(`replacement #${res.newId} missing`);
      else {
        if (!isLive(nw)) problems.push('replacement not live');
        const want = {
          project: p.before.project,
          type: p.before.type,
          title: expectStr(p.title ?? p.before.title),
          narrative: expectStr(p.narrative ?? p.before.narrative),
          lesson_learned: expectStr(p.lesson_learned ?? p.before.lesson_learned) ?? null,
          importance: p.importance ?? p.before.importance ?? 2,
        };
        for (const [k, v] of Object.entries(want)) if (nw[k] !== v) problems.push(`replacement ${k} differs`);
        if (JSON.stringify(filesOf(db, res.newId)) !== JSON.stringify(p.files))
          problems.push('replacement files differ');
      }
    }
    return {
      id: p.id,
      action: p.action,
      ok: problems.length === 0,
      problems,
      ...(res?.newId ? { newId: res.newId } : {}),
    };
  });
}

/**
 * Undo an apply from its backup: restore RESTORE_COLUMNS on every backed-up row and retire the
 * replacement a `replace` created. Validates the whole document first; any error means no
 * write. One immediate transaction.
 * @returns {{errors: string[], restored: Array<{id: number, replacementRetired: number|null}>}}
 */
export function undoVerifyBackup(db, backup, { now = new Date() } = {}) {
  if (
    !backup ||
    backup.kind !== BACKUP_KIND ||
    backup.version !== BACKUP_VERSION ||
    !Array.isArray(backup.rows)
  ) {
    return { errors: ['not a verify-apply backup file'], restored: [] };
  }
  const errors = [];
  for (const [i, b] of backup.rows.entries()) {
    const id = b?.row?.id;
    if (!Number.isInteger(id)) errors.push(`backup row ${i + 1}: no id`);
    else if (!db.prepare('SELECT 1 FROM observations WHERE id = ?').get(id))
      errors.push(`#${id}: no longer exists`);
    else if (RESTORE_COLUMNS.some((c) => !(c in b.row))) errors.push(`#${id}: backup row is missing columns`);
  }
  if (errors.length) return { errors, restored: [] };

  const tx = db.transaction(() => {
    const restored = [];
    for (const b of backup.rows) {
      const id = b.row.id;
      let replacementRetired = null;
      if (b.action === 'replace') {
        const cur = db.prepare('SELECT superseded_by FROM observations WHERE id = ?').get(id);
        const replId = Number(cur.superseded_by);
        if (Number.isInteger(replId) && replId > 0) {
          const res = db
            .prepare(
              `UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ? AND ${liveObsFilterSql('')}`,
            )
            .run(now.getTime(), VERIFY_UNDONE_MARKER, replId);
          if (res.changes === 1) replacementRetired = replId;
        }
      }
      db.prepare(
        `UPDATE observations SET ${RESTORE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ).run(...RESTORE_COLUMNS.map((c) => b.row[c]), id);
      restored.push({ id, replacementRetired });
    }
    return restored;
  });
  const restored = tx.immediate();
  for (const b of backup.rows) {
    const now2 = db.prepare('SELECT * FROM observations WHERE id = ?').get(b.row.id);
    const diff = RESTORE_COLUMNS.filter((c) => now2[c] !== b.row[c]);
    if (diff.length) errors.push(`#${b.row.id}: restore mismatch on ${diff.join(', ')}`);
  }
  return { errors, restored };
}
