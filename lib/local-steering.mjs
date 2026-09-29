// lib/local-steering.mjs — the steering block in <git top-level>/CLAUDE.local.md.
//
// Why this file exists (docs/audits/20260929-sandbox-usage-eval.md §8.5, tasks/specs/
// sandbox-eval-l3.md r3): auto-adopt used to write the block into CLAUDE.md, which swept the
// plugin's files into the user's next commit (4/4 sandbox repos). Injecting the same text as
// SessionStart context instead left the repository alone but lost most of what the block
// was for — proactive memory writes fell from 5.25 to 1.5 per trajectory (exact p=0.029) and
// subagents, which do not receive SessionStart context, saw it 0/12 times. CLAUDE.local.md
// is loaded by Claude Code with the same standing as CLAUDE.md (and reaches subagents: 12/12),
// and listed in the repository's info/exclude it never enters a commit or `git status`.
//
// Where it refuses to write, the caller falls back to injection:
//   - outside a git work tree (nothing can keep the file out of a commit, and a shared
//     directory such as /var/tmp would steer every project below it);
//   - a work tree whose top-level is $HOME or `/` (same ancestor problem, larger);
//   - a TRACKED CLAUDE.local.md (writing it would change the user's repository).
// Every git failure reads as "refuse": a missing file is the safe mistake here.

import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse, resolve } from 'path';
import { readBlockAt, writeBlockAt, removeBlockAt, orphanResidueNote } from '../claudemd.mjs';
import { getDetailDoc } from '../adopt-content.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { resolveDataDir } from './resolve-data-dir.mjs';

export const LOCAL_MD = 'CLAUDE.local.md';

/**
 * The detail doc the block points at, kept in the plugin's data dir (never in the project:
 * both the injected and the CLAUDE.local.md block carry its absolute path). Rewritten only
 * when its text changed. Resolved at call time, not import time, so a caller that set
 * CLAUDE_MEM_DIR or HOME after loading this module still gets its own data dir.
 * @returns {string} absolute path
 */
export function ensureSteeringDetailDoc() {
  const p = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'plugin_claude_mem_lite.md');
  const doc = getDetailDoc();
  let current = null;
  try {
    current = readFileSync(p, 'utf8');
  } catch {
    /* first run */
  }
  if (current !== doc) {
    mkdirSync(dirname(p), { recursive: true });
    atomicWriteFileSync(p, doc);
  }
  return p;
}
// The exclude entry is two lines — a comment naming its owner, then the pattern — because
// git ignore syntax has no trailing comments, and removal must touch only what we added.
const EXCLUDE_OWNER_LINE = '# claude-mem-lite: memory guidance for Claude Code, kept out of commits';

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return null;
  }
}

function gitOk(cwd, args) {
  try {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the local steering file belongs for `cwd`: its git top-level, or null when there is
 * none or it is $HOME or a filesystem root.
 * @param {string} cwd
 * @returns {string|null}
 */
export function localSteeringRoot(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const root = resolve(top);
  if (root === resolve(homedir()) || root === parse(root).root) return null;
  return root;
}

/** @returns {string} */
export function localMdPath(root) {
  return join(root, LOCAL_MD);
}

/**
 * @returns {{ exists: boolean, version: string|null, body: string|null, raw: string }}
 */
export function readLocalSteering(root, slug) {
  return readBlockAt(localMdPath(root), slug);
}

function excludePath(root) {
  const p = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!p) return null;
  return isAbsolute(p) ? p : join(root, p);
}

function ensureExcluded(root) {
  if (gitOk(root, ['check-ignore', '-q', '--', LOCAL_MD])) return 'already';
  const p = excludePath(root);
  if (!p) return 'failed';
  try {
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
    appendFileSync(p, `${sep}${EXCLUDE_OWNER_LINE}\n${LOCAL_MD}\n`);
  } catch {
    return 'failed';
  }
  return gitOk(root, ['check-ignore', '-q', '--', LOCAL_MD]) ? 'added' : 'failed';
}

function removeExcluded(root) {
  const p = excludePath(root);
  if (!p || !existsSync(p)) return 'absent';
  try {
    const cur = readFileSync(p, 'utf8');
    const next = cur.split(`${EXCLUDE_OWNER_LINE}\n${LOCAL_MD}\n`).join('');
    if (next === cur) return 'absent';
    writeFileSync(p, next);
    return 'removed';
  } catch {
    return 'failed';
  }
}

/**
 * Insert or refresh the block in CLAUDE.local.md and keep the file out of commits.
 * `refused` means nothing was written; the caller injects the steering instead.
 * @param {string} root from localSteeringRoot
 * @returns {{action: 'created'|'updated'|'unchanged'|'refused', reason?: string}}
 */
export function writeLocalSteering(root, { slug, version, block }) {
  if (gitOk(root, ['ls-files', '--error-unmatch', '--', LOCAL_MD]))
    return { action: 'refused', reason: 'tracked' };
  // Exclude first: a file that cannot be kept out of `git status` is not written at all.
  const excluded = ensureExcluded(root);
  if (excluded === 'failed') return { action: 'refused', reason: 'exclude-failed' };
  try {
    return writeBlockAt(localMdPath(root), { slug, version, block });
  } catch {
    return { action: 'refused', reason: 'write-failed' };
  }
}

/**
 * Remove the block (deleting a file left empty) and the exclude lines this module added.
 * @returns {{action: 'removed'|'partial'|'absent', residue?: string}}
 */
export function removeLocalSteering(root, slug) {
  const p = localMdPath(root);
  const { action, orphans } = removeBlockAt(p, slug);
  if (action === 'removed' || !existsSync(p)) removeExcluded(root);
  if (orphans > 0 && action === 'removed') return { action, residue: orphanResidueNote(orphans, slug, p) };
  return { action };
}
