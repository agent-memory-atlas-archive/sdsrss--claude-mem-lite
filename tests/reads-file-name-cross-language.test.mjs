// `reads-<project>.txt` is written by bash, read by Node, and reaped by a third site — and
// no accessor can be shared across the language boundary.
//
// R12 gave the episode buffer a single spelling by routing every site through
// `episodeFile()`. Its sibling cannot be fixed that way: `scripts/post-tool-use.sh` appends
// the Read fast-path's file paths to this file without ever starting Node, so the name is
// necessarily written twice, once per language. What CAN be checked is that the two spellings
// agree — which is the only thing that makes them safe.
//
// The harm is already recorded in the writer's own comments, twice, from when it happened:
// a runtime dir resolved differently on the two sides "made flushEpisode read a DIFFERENT
// reads-<project>.txt, silently dropping this session's Read context AND orphaning the
// bash-named file (nothing ever collects it)". Note both halves: the reader goes quiet AND
// the writer's file becomes garbage nobody reaps.
//
// THREE SITES, NOT TWO, and the third is why this guard checks the sweeper as well:
//
//   scripts/post-tool-use.sh   writes   "${runtime_dir}/reads-${project}.txt"
//   hook.mjs                   reads    join(RUNTIME_DIR, `reads-${…}.txt`)
//   hook-shared.mjs            reaps    f.startsWith('reads-') && f.endsWith('.txt')
//
// The sweeper matches on a PREFIX and a SUFFIX rather than constructing the name, so a
// renamed file is not merely unread — it is also never collected, and grows without bound in
// the user's runtime directory. A guard that compared only the writer and the reader would
// pass while that third site silently stopped reaping.
//
// POPULATION: this is one of the three shipped bash hooks that `walkShipped` (".mjs/.js") is
// structurally blind to — the blind spot that hid two setup.sh defects for twelve audit
// rounds. Both shipped languages are named explicitly here rather than swept.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// D#207: join(), never new URL('../x.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** Strip whole-line comments so a docblock quoting the name is not mistaken for a site. */
const codeLines = (src, commentRe) => src.split('\n').filter((l) => !commentRe.test(l));

/** `reads-<something>.txt` built in bash: `"${dir}/reads-${var}.txt"`. */
function bashConstructions() {
  const lines = codeLines(read('scripts/post-tool-use.sh'), /^\s*#/);
  return lines
    .map((l) => /\/(reads-)\$\{[^}]+\}(\.[a-z]+)"/.exec(l))
    .filter(Boolean)
    .map((m) => ({ prefix: m[1], suffix: m[2] }));
}

/** `reads-<something>.txt` built in a shipped Node module. */
function nodeConstructions() {
  const out = [];
  for (const f of ['hook.mjs', 'hook-shared.mjs', 'hook-episode.mjs', 'hook-llm.mjs']) {
    for (const l of codeLines(read(f), /^\s*(\/\/|\*|\/\*)/)) {
      const m = /`(reads-)\$\{[^`]*\}(\.[a-z]+)`/.exec(l);
      if (m) out.push({ file: f, prefix: m[1], suffix: m[2] });
    }
  }
  return out;
}

/** The reaper's predicate: a prefix test and a suffix test on the same line. */
function sweeperPredicate() {
  for (const l of codeLines(read('hook-shared.mjs'), /^\s*(\/\/|\*|\/\*)/)) {
    const m = /startsWith\('(reads-)'\)\s*&&\s*[\w.]*\.endsWith\('(\.[a-z]+)'\)/.exec(l);
    if (m) return { prefix: m[1], suffix: m[2] };
  }
  return null;
}

describe('the reads-file name means the same thing in bash and in Node', () => {
  it('every extractor found its site', () => {
    // Premise before criteria. Three empty lists agree with each other perfectly, so without
    // this the guard is loudest exactly when it has stopped looking at anything.
    expect(bashConstructions(), 'no reads-file construction found in post-tool-use.sh').toHaveLength(1);
    expect(nodeConstructions().length, 'no reads-file construction found in the Node hooks').toBe(1);
    expect(sweeperPredicate(), 'no prefix/suffix reaper predicate found in hook-shared.mjs').not.toBeNull();
  });

  it('the writer and the reader agree', () => {
    const [bash] = bashConstructions();
    const [node] = nodeConstructions();
    expect(
      { prefix: node.prefix, suffix: node.suffix },
      `${node.file} builds ${node.prefix}…${node.suffix} while scripts/post-tool-use.sh writes ` +
        `${bash.prefix}…${bash.suffix}. The bash fast path never starts Node, so these two ` +
        'spellings are the whole contract: when they diverge the reader goes silent AND the ' +
        'written file is never collected. Change both, or neither.',
    ).toEqual({ prefix: bash.prefix, suffix: bash.suffix });
  });

  it('the reaper matches what the writer produces', () => {
    const [bash] = bashConstructions();
    const sweep = sweeperPredicate();
    expect(
      sweep,
      `hook-shared.mjs reaps ${sweep.prefix}*${sweep.suffix} but the writer produces ` +
        `${bash.prefix}*${bash.suffix}. A file outside the reaper's predicate is written ` +
        "forever and never swept — it does not fail, it accumulates in the user's runtime dir.",
    ).toEqual({ prefix: bash.prefix, suffix: bash.suffix });
  });
});
