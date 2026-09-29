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
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path';
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
 * `p` with the home directory written as `~`. The block lands in a file on disk that
 * packagers which ignore info/exclude (`npm pack`, a docker build context) can pick up, so it
 * must not carry the user's home path.
 * @param {string} p
 * @returns {string}
 */
export function tildePath(p) {
  const h = resolve(homedir());
  return p === h ? '~' : p.startsWith(h + sep) ? `~${p.slice(h.length)}` : p;
}

// Per-repository memory of "this plugin created CLAUDE.local.md here", kept in the
// repository's own git dir (invisible to git, gone with the clone). Without it the plugin
// cannot tell a file it never wrote from one the user deleted or `unadopt` removed, and wrote
// the file straight back on the next session (pre-tag claims review P1-2/P1-3).
function stateFile(root) {
  const p = git(root, ['rev-parse', '--git-path', 'claude-mem-lite-local-steering.json']);
  if (!p) return null;
  return isAbsolute(p) ? p : join(root, p);
}

function readState(root) {
  const p = stateFile(root);
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { created: 'unknown' };
  }
}

/**
 * Forget that the block was created here, so the next session writes it again
 * (`adopt --enable`).
 * @returns {boolean} whether there was anything to forget
 */
export function forgetLocalSteering(root) {
  const p = stateFile(root);
  if (!p || !existsSync(p)) return false;
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert or refresh the block in CLAUDE.local.md and keep the file out of commits.
 * `refused` means nothing was written; the caller injects the steering instead. A block this
 * plugin created before and that is gone now was removed by the user or by `unadopt`: it is
 * not written back (reason `removed`) until `adopt --enable` forgets it.
 * @param {string} root from localSteeringRoot
 * @returns {{action: 'created'|'updated'|'unchanged'|'refused', reason?: string}}
 */
export function writeLocalSteering(root, { slug, version, block }) {
  if (gitOk(root, ['ls-files', '--error-unmatch', '--', LOCAL_MD]))
    return { action: 'refused', reason: 'tracked' };
  const present = readBlockAt(localMdPath(root), slug).body !== null;
  if (!present && readState(root)) return { action: 'refused', reason: 'removed' };
  // Exclude first: a file that cannot be kept out of `git status` is not written at all.
  const excluded = ensureExcluded(root);
  if (excluded === 'failed') return { action: 'refused', reason: 'exclude-failed' };
  let r;
  try {
    r = writeBlockAt(localMdPath(root), { slug, version, block });
  } catch {
    return { action: 'refused', reason: 'write-failed' };
  }
  if (r.action === 'created') {
    try {
      const p = stateFile(root);
      if (p) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ created: new Date().toISOString() }) + '\n');
      }
    } catch {
      /* best-effort: without it a removal is not remembered, which is the old behaviour */
    }
  }
  return r;
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
