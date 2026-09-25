// cli/verify-apply.mjs — `claude-mem-lite verify-apply <proposals.json> [--apply] [--project P]`
// and `claude-mem-lite verify-apply --undo <backup.json>`.
//
// The write step of /mem:verify (commands/verify.md). The agent proposes; this command is the
// only thing that writes, and it defaults to a dry run so the plan the user approves is the plan
// that was printed. All policy lives in lib/verify-apply-core.mjs; this file is I/O and exit codes.

import { readFileSync } from 'fs';
import { join } from 'path';
import { DB_DIR } from '../lib/data-paths.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { inferProject } from '../utils.mjs';
import { resolveProject } from '../project-utils.mjs';
import {
  parseProposals,
  planVerifyApply,
  buildVerifyBackup,
  applyVerifyPlan,
  readBackVerifyPlan,
  undoVerifyBackup,
} from '../lib/verify-apply-core.mjs';
import { parseArgs, out, fail } from './common.mjs';

const USAGE =
  '[mem] Usage: claude-mem-lite verify-apply <proposals.json> [--apply] [--project P]\n' +
  '       claude-mem-lite verify-apply --undo <backup.json>';

function readJson(path, what) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { error: `[mem] Cannot read ${what} ${path}: ${e.message}` };
  }
}

function describe(p) {
  if (p.action === 'retire') return 'retire (superseded, no replacement)';
  if (p.action === 'edit') {
    return `edit ${Object.entries(p.set)
      .map(([k, v]) => `${k} ${String(p.before[k] ?? '').length}→${String(v).length} chars`)
      .join(', ')}`;
  }
  const changed = ['title', 'narrative', 'lesson_learned', 'importance'].filter((k) => p[k] !== undefined);
  return `replace with a new memory (${changed.length ? changed.join(', ') : 'fields copied'}; original kept as history)`;
}

export function cmdVerifyApply(db, args) {
  const { positional, flags } = parseArgs(args);

  if (flags.undo !== undefined) {
    if (typeof flags.undo !== 'string') return fail(USAGE);
    const { value, error } = readJson(flags.undo, 'backup');
    if (error) return fail(error);
    const { errors, restored } = undoVerifyBackup(db, value);
    if (restored.length === 0 && errors.length)
      return fail(`[mem] Undo refused, nothing written:\n  ${errors.join('\n  ')}`);
    for (const r of restored) {
      out(
        `  #${r.id} restored${r.replacementRetired ? ` (replacement #${r.replacementRetired} retired)` : ''}`,
      );
    }
    if (errors.length) return fail(`[mem] Undo read-back found problems:\n  ${errors.join('\n  ')}`);
    out(`[mem] Undo complete: ${restored.length} row(s) restored.`);
    return;
  }

  const file = positional[0];
  if (!file) return fail(USAGE);
  const { value, error } = readJson(file, 'proposals');
  if (error) return fail(error);

  const parsed = parseProposals(value);
  if (parsed.errors.length)
    return fail(`[mem] Invalid proposals, nothing written:\n  ${parsed.errors.join('\n  ')}`);

  const project =
    typeof flags.project === 'string' ? resolveProject(db, flags.project, { mode: 'write' }) : inferProject();
  const { plan, errors } = planVerifyApply(db, parsed.entries, { project });
  if (errors.length) return fail(`[mem] Refused, nothing written:\n  ${errors.join('\n  ')}`);

  out(`[mem] verify-apply plan — project ${project}, ${plan.length} change(s):`);
  for (const p of plan) out(`  #${p.id} [${p.verdict}] ${describe(p)} — evidence: ${p.evidence}`);

  if (!flags.apply) {
    out('[mem] Dry run — nothing written. Re-run with --apply to write these changes.');
    return;
  }

  const now = new Date();
  const backupPath = join(DB_DIR, 'backups', `verify-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  atomicWriteFileSync(backupPath, JSON.stringify(buildVerifyBackup(db, plan, { now }), null, 1));

  let results;
  try {
    results = applyVerifyPlan(db, plan, { now });
  } catch (e) {
    return fail(`[mem] ${e.message}`);
  }
  const checks = readBackVerifyPlan(db, plan, results);
  for (const c of checks) {
    out(
      `  #${c.id} ${c.action}${c.newId ? ` → #${c.newId}` : ''}: ${c.ok ? 'ok' : `MISMATCH (${c.problems.join('; ')})`}`,
    );
  }
  out(`[mem] Backup: ${backupPath}`);
  out(`[mem] To undo: claude-mem-lite verify-apply --undo ${backupPath}`);
  if (checks.some((c) => !c.ok)) fail('[mem] Read-back found mismatches — review the rows above.');
}
