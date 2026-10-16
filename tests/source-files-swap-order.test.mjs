// SOURCE_FILES is the update's swap order: hook-update.mjs renames the entries into the code home
// one at a time in this order, and an older release's updater reads it from the new tarball. An
// entry swapped before a module it imports leaves a mixed tree in which it cannot load if the swap
// is killed in between; grouped by purpose, the list left install.mjs — the repair path — unable to
// load at 77 of 168 split points of a v6.27.0 -> v6.28.0 swap (pre-tag review 2026-10-16). This
// keeps every entry after each listed module it imports, re-exports from or `import()`s by a
// literal path: cli.mjs imports everything lazily, and listed first it left a bare
// `claude-mem-lite` without lib/npx-run.mjs at 15 split points (round-2 review). It also keeps
// package.json last (below). scripts/swap-mixed-tree.mjs checks the cross-release half (an export
// removed that an older, not-yet-swapped module imports), which needs both releases' trees.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { SOURCE_FILES } from '../source-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Listed modules `file` imports, re-exports from or `import()`s by a literal path (an AST walk of
 * the whole module, not a text scan).
 */
function listedDeps(file, listed) {
  if (!/\.(mjs|js)$/.test(file)) return [];
  const ast = acorn.parse(readFileSync(join(ROOT, file), 'utf8').replace(/^#!.*/, ''), {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
  });
  const out = new Set();
  const stack = [ast];
  while (stack.length > 0) {
    const n = stack.pop();
    let spec = null;
    if (
      n.type === 'ImportDeclaration' ||
      n.type === 'ExportAllDeclaration' ||
      n.type === 'ExportNamedDeclaration'
    )
      spec = n.source?.value;
    if (n.type === 'ImportExpression' && n.source.type === 'Literal') spec = n.source.value;
    if (typeof spec === 'string' && spec.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (listed.has(target)) out.add(target);
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const x of v) x && typeof x.type === 'string' && stack.push(x);
      else if (v && typeof v.type === 'string') stack.push(v);
    }
  }
  return [...out];
}

/** `file -> dep` edges where the dep comes LATER in `order` than the file importing it. */
function violations(order) {
  const listed = new Set(order);
  const at = new Map(order.map((f, i) => [f, i]));
  const out = [];
  for (const file of order)
    for (const dep of listedDeps(file, listed)) if (at.get(dep) > at.get(file)) out.push(`${file} -> ${dep}`);
  return out;
}

describe('SOURCE_FILES swap order', () => {
  it('lists every module after each listed module it imports', () => {
    expect(violations(SOURCE_FILES)).toEqual([]);
  });

  // hook-update.mjs's getCurrentVersion reads the code home's package.json, and the daily check
  // re-enters an update (whose first step replays a killed swap's journal) only while that reads
  // the older version. Swapped early, a swap killed after it stays mixed until the next release
  // or a manual install: at 164 of 168 split points of v6.27.0 -> v6.28.0 with it 4th (round-2
  // review). Nothing imports it, so last costs nothing.
  it('swaps package.json last', () => {
    expect(SOURCE_FILES.at(-1)).toBe('package.json');
  });

  it('says so when an entry point is moved ahead of what it imports', () => {
    // install.mjs at the front, as a list grouped by purpose put entry points.
    const moved = ['install.mjs', ...SOURCE_FILES.filter((f) => f !== 'install.mjs')];
    const found = violations(moved);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((v) => v.startsWith('install.mjs -> '))).toBe(true);
    expect(found).toContain('install.mjs -> lib/install-shape.mjs');
  });

  it('reads static imports, re-exports and literal import()s, and only listed relative ones', () => {
    // Premise for the cases above: the walk finds edges at all, and of both kinds.
    const listed = new Set(SOURCE_FILES);
    expect(listedDeps('install.mjs', listed)).toContain('source-files.mjs');
    expect(listedDeps('utils.mjs', listed).length).toBeGreaterThan(0); // utils.mjs re-exports leaf modules
    expect(listedDeps('cli.mjs', listed)).toContain('lib/npx-run.mjs'); // await import('./lib/npx-run.mjs')
    expect(listedDeps('package.json', listed)).toEqual([]);
  });
});
