// D#98: no shipped text asks the agent to report lessons that did NOT apply.
//
// `'#NN n/a — <reason>'` was the adoption contract's second half. Citation decay drops
// dismissal-only ids (lib/citation-tracker.mjs isDismissalAt), so a dismissal earns the
// lesson nothing, and the ask put lesson-id lists into the user's reply. The default
// PreToolUse directive, the CLAUDE.md managed row and the detail doc now ask for `#NN` only
// where a lesson changed what the agent did.
//
// Population: every shipped .mjs/.js (walkShipped, whole-line comments stripped, so prose
// that QUOTES the old form does not trip it) plus every shipped Markdown file named in
// package.json#files. The two opt-in directives in scripts/pre-tool-recall.js keep the old
// shape on purpose (CLAUDE_MEM_SALIENCE=verdict / =bind): a user who selected them asked
// for per-lesson verdicts.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO, walkShipped, relShipped, sourceWithoutComments } from './shipped-tree.mjs';
import { buildClaudeMdBlock, getDetailDoc } from '../adopt-content.mjs';

// The dismissal template in either language: `n/a — <reason>`, `n/a — <理由>`.
const DISMISSAL_ASK = /n\/a — </;
const ALLOWED = [
  {
    file: 'scripts/pre-tool-recall.js',
    line: /^\s*(?:const )?(?:VERDICT|BIND)_DIRECTIVE\b|^\s*"(?:apply each lesson|For each lesson)/,
  },
];

function offending(rel, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (!DISMISSAL_ASK.test(line)) return;
    if (ALLOWED.some((a) => a.file === rel && a.line.test(line))) return;
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

describe('D#98 — no shipped text asks for #NN dismissals', () => {
  it('shipped modules (comments stripped)', () => {
    const files = walkShipped();
    expect(files.length).toBeGreaterThan(50); // premise: the walk reached the tree
    const hits = files.flatMap((f) => offending(relShipped(f), sourceWithoutComments(f)));
    expect(hits).toEqual([]);
  });

  it('shipped Markdown', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const mds = pkg.files.filter((f) => f.endsWith('.md') && existsSync(join(REPO, f)));
    expect(mds.length).toBeGreaterThan(3);
    const hits = mds.flatMap((f) => offending(f, readFileSync(join(REPO, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the rendered adoption block and detail doc ask for applied lessons only', () => {
    const block = buildClaudeMdBlock();
    const doc = getDetailDoc();
    expect(block).toMatch(/lesson changed what you did, name `#NN` once/);
    expect(doc).toContain('没用上的 lesson 不必提');
    for (const t of [block, doc]) expect(t).not.toMatch(DISMISSAL_ASK);
  });

  it('the allowlist still matches the opt-in directives (a stale allowlist is a blind guard)', () => {
    const src = sourceWithoutComments(join(REPO, 'scripts/pre-tool-recall.js'));
    const allowedLines = src.split('\n').filter((l) => DISMISSAL_ASK.test(l));
    expect(allowedLines.length).toBeGreaterThanOrEqual(2); // VERDICT + BIND bodies
    expect(offending('scripts/pre-tool-recall.js', src)).toEqual([]);
  });
});
