// cli/verify-apply.mjs — `claude-mem-lite verify-apply <proposals.json> [--project P]`
// (dry run), `... --apply --digest <d>`, and `claude-mem-lite verify-apply --undo <backup.json>`.
//
// The write step of /verify (commands/verify.md). The agent proposes; this command is the only
// thing that writes. It defaults to a dry run that prints the new text itself and a digest, and
// --apply refuses unless it is handed that digest back: what the user approved is what lands,
// and a proposals file or a row that changed in between is refused rather than applied. All
// policy lives in lib/verify-apply-core.mjs; this file is I/O, formatting and exit codes.

import { readFileSync } from 'fs';
import { join } from 'path';
import { DB_DIR } from '../lib/data-paths.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { inferProject } from '../utils.mjs';
import { resolveProject } from '../project-utils.mjs';
import {
  parseProposals,
  planVerifyApply,
  planDigest,
  runVerifyApply,
  undoVerifyBackup,
  markUndone,
} from '../lib/verify-apply-core.mjs';
import { parseArgs, out, fail, rejectBareStringFlags } from './common.mjs';

const USAGE =
  '[mem] Usage: claude-mem-lite verify-apply <proposals.json> [--project P]          (dry run)\n' +
  '       claude-mem-lite verify-apply <proposals.json> [--project P] --apply --digest <d>\n' +
  '       claude-mem-lite verify-apply --undo <backup.json>';

const SNIPPET_CONTEXT = 60;
const SNIPPET_MAX = 400;

function readJson(path, what) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { error: `[mem] Cannot read ${what} ${path}: ${e.message}` };
  }
}

const clip = (s) => (s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s);

/** The changed region of a field, with context — enough to approve, short enough to read. */
function snippet(before, after) {
  const a = before === null || before === undefined ? '' : String(before);
  const b = String(after);
  if (a === b) return ['    (unchanged)'];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - SNIPPET_CONTEXT);
  const lead = from > 0 ? '…' : '';
  const tail = (s, end) => (end + SNIPPET_CONTEXT < s.length ? '…' : '');
  return [
    `    - ${lead}${clip(a.slice(from, Math.min(a.length, endA + SNIPPET_CONTEXT)))}${tail(a, endA)}`,
    `    + ${lead}${clip(b.slice(from, Math.min(b.length, endB + SNIPPET_CONTEXT)))}${tail(b, endB)}`,
  ];
}

function describe(p) {
  const head = `  #${p.id} [${p.verdict}] ${p.action} — evidence: ${p.evidence}`;
  if (p.action === 'retire') return [head, '    retired with no replacement (kept as history)'];
  const fields =
    p.action === 'edit'
      ? Object.entries(p.set)
      : ['title', 'narrative', 'lesson_learned', 'importance', 'facts', 'concepts']
          .filter((k) => p[k] !== undefined)
          .map((k) => [k, p[k]]);
  const lines = [head];
  if (p.action === 'replace') lines.push('    new memory supersedes this one; unlisted fields are copied');
  for (const [k, v] of fields) lines.push(`   ${k}:`, ...snippet(p.before[k], v));
  return lines;
}

function undo(db, path) {
  const { value, error } = readJson(path, 'backup');
  if (error) return fail(error);
  const { errors, restored } = undoVerifyBackup(db, value);
  if (restored.length === 0 && errors.length)
    return fail(`[mem] Undo refused, nothing written:\n  ${errors.join('\n  ')}`);
  atomicWriteFileSync(path, JSON.stringify(markUndone(value), null, 1));
  for (const r of restored) {
    out(
      `  #${r.id} restored${r.replacementRetired ? ` (replacement #${r.replacementRetired} retired)` : ''}`,
    );
  }
  if (errors.length) return fail(`[mem] Undo read-back found problems:\n  ${errors.join('\n  ')}`);
  out(`[mem] Undo complete: ${restored.length} row(s) restored.`);
}

export function cmdVerifyApply(db, args) {
  const { positional, flags } = parseArgs(args);
  if (rejectBareStringFlags(flags, ['project', 'undo', 'digest'])) return;
  // Boolean means boolean: `--apply=false` / `--apply no` must not apply.
  if (flags.apply !== undefined && flags.apply !== true)
    return fail(`[mem] --apply takes no value.\n${USAGE}`);

  if (flags.undo !== undefined) {
    if (positional.length || flags.apply || flags.digest) return fail(USAGE);
    return undo(db, flags.undo);
  }

  const file = positional[0];
  if (!file || positional.length > 1) return fail(USAGE);
  const { value, error } = readJson(file, 'proposals');
  if (error) return fail(error);

  const parsed = parseProposals(value);
  if (parsed.errors.length)
    return fail(`[mem] Invalid proposals, nothing written:\n  ${parsed.errors.join('\n  ')}`);

  const project = flags.project ? resolveProject(db, flags.project, { mode: 'write' }) : inferProject();
  const { plan, errors } = planVerifyApply(db, parsed.entries, { project });
  if (errors.length) return fail(`[mem] Refused, nothing written:\n  ${errors.join('\n  ')}`);
  const digest = planDigest(plan, project);

  if (!flags.apply) {
    out(`[mem] verify-apply plan — project ${project}, ${plan.length} change(s):`);
    for (const p of plan) for (const line of describe(p)) out(line);
    out(`[mem] Plan digest: ${digest}`);
    out('[mem] Dry run — nothing written. After the user approves exactly this plan, run:');
    out(`  claude-mem-lite verify-apply ${file} --project ${project} --apply --digest ${digest}`);
    return;
  }

  if (!flags.digest) {
    return fail('[mem] --apply requires --digest <d> from the dry run the user approved. Nothing written.');
  }
  if (flags.digest !== digest) {
    return fail(
      '[mem] Plan digest mismatch: the proposals file or the memories changed since the dry run. ' +
        'Nothing written — re-run the dry run and get the new plan approved.',
    );
  }

  let run;
  try {
    run = runVerifyApply(db, plan, { backupDir: join(DB_DIR, 'backups') });
  } catch (e) {
    return fail(`[mem] ${e.message}`);
  }
  for (const c of run.checks) {
    out(
      `  #${c.id} ${c.action}${c.newId ? ` → #${c.newId}` : ''}: ${c.ok ? 'ok' : `MISMATCH (${c.problems.join('; ')})`}`,
    );
  }
  out(`[mem] Backup: ${run.backupPath}`);
  out(
    `[mem] To undo (only while these rows are untouched): claude-mem-lite verify-apply --undo ${run.backupPath}`,
  );
  if (run.checks.some((c) => !c.ok)) {
    fail('[mem] Applied, but read-back found mismatches — show the MISMATCH lines above to the user.');
  }
}
