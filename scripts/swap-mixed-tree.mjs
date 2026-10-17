#!/usr/bin/env node
// Release check (dev only, not shipped; ci.yml's swap-mixed-tree job runs it from the last release
// tag on every push to main, and it is run by hand before tagging): would an update from <old> to
// <new> that is killed between two renames leave an entry point that cannot load?
//
// hook-update.mjs swaps SOURCE_FILES into the code home one rename at a time in the NEW release's
// order (an older updater reads the list from the new tarball), then scripts/, then node_modules/.
// A kill after entry i leaves SOURCE_FILES[0..i] at <new> and everything else at <old>. For every
// split point this walks the import graph (AST, not text) from each entry point, static imports
// and import() calls with a literal path alike, and reports a module that is missing or a named
// import its target does not export (for a dynamic import, the names its result is destructured
// into or read by, Promise.all elements included — see dynamicImports; any other shape is checked
// for the module's existence only). The two
// shapes it catches: a module swapped before something it imports (source-files.mjs states the
// order rule), and an export removed that a not-yet-swapped module of <old> still imports. A
// dynamic import fails only when its code path runs, so it is reported as such.
//
// Usage: node scripts/swap-mixed-tree.mjs <old-rev> [<new-rev> = HEAD; `.` = the working tree]
// (exit 1 on any failure)
// Found by the v6.28.0 pre-tag review (2026-10-16), from the reviewer's own analysis script.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const [OLD, NEW = 'HEAD'] = process.argv.slice(2);
if (!OLD) {
  console.error('usage: node scripts/swap-mixed-tree.mjs <old-rev> [<new-rev>]');
  process.exit(2);
}

function show(rev, file) {
  try {
    if (rev === '.') return readFileSync(join(REPO, file), 'utf8'); // the working tree
    return execFileSync('git', ['-C', REPO, 'show', `${rev}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 28,
    });
  } catch {
    return null;
  }
}

/** The release's own manifest, evaluated from its committed text. */
async function manifest(rev) {
  const dir = mkdtempSync(join(tmpdir(), 'swap-mixed-tree-'));
  try {
    const file = join(dir, 'source-files.mjs');
    writeFileSync(file, show(rev, 'source-files.mjs'));
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Calls fn on every AST node under (and including) n. */
function walk(n, fn) {
  const stack = [n];
  while (stack.length > 0) {
    const x = stack.pop();
    fn(x);
    for (const k of Object.keys(x))
      for (const c of [x[k]].flat()) if (c && typeof c.type === 'string') stack.push(c);
  }
}

/**
 * Every import() call with a literal path in the module, with the names its result is read by:
 * `const { a } = await import(...)`, `({ a } = await import(...))`, `(await import(...)).a`, an
 * element of `const [{ a }, m] = await Promise.all([import(...), …])`, and a namespace bound to a
 * name (a declaration, an assignment or a Promise.all element) by the `m.a` reads in the function
 * that binds it. A name the code probes for (`m.a?.()`, `m.a ?? x`, `typeof m.a`, `if (m.a)`) is
 * one it expects may be missing, so it is not checked. Any other use (`.then`, a namespace passed
 * on) checks only that the module exists.
 */
/** Each node's parent. */
function parents(ast) {
  const parent = new Map();
  walk(ast, (n) => {
    for (const k of Object.keys(n))
      for (const c of [n[k]].flat()) if (c && typeof c.type === 'string') parent.set(c, n);
  });
  return parent;
}

function dynamicImports(ast, parent) {
  const found = [];
  walk(ast, (n) => {
    if (n.type === 'ImportExpression' && n.source.type === 'Literal' && typeof n.source.value === 'string')
      found.push(n);
  });
  return found.map((n) => ({ spec: n.source.value, names: boundNames(n, parent), dynamic: true }));
}

/**
 * The names a static `import * as ns` reads: `ns.x` anywhere in the module (minus the probed
 * ones) and `const { x } = ns` (pre-tag review 2026-10-17 P3-1: install.mjs's
 * `const { lockHeld } = procLock` went unchecked).
 */
function namespaceReads(name, ast, parent) {
  const names = new Set(memberReads(name, ast, parent));
  walk(ast, (n) => {
    if (
      n.type === 'VariableDeclarator' &&
      n.init?.type === 'Identifier' &&
      n.init.name === name &&
      n.id.type === 'ObjectPattern'
    )
      for (const q of n.id.properties)
        if (q.type === 'Property' && !q.computed) names.add(q.key.name ?? q.key.value);
  });
  return [...names];
}

const isPromiseAll = (c) =>
  c.type === 'MemberExpression' &&
  !c.computed &&
  c.object.type === 'Identifier' &&
  c.object.name === 'Promise' &&
  c.property.name === 'all';

function boundNames(imp, parent) {
  let awaited = parent.get(imp);
  let index = null; // the element of Promise.all's array, when that is where the import() sits
  if (awaited?.type === 'ArrayExpression') {
    const call = parent.get(awaited);
    if (call?.type !== 'CallExpression' || call.arguments[0] !== awaited || !isPromiseAll(call.callee))
      return [];
    index = awaited.elements.indexOf(imp);
    awaited = parent.get(call);
  }
  if (awaited?.type !== 'AwaitExpression') return [];
  const site = parent.get(awaited);
  let target = null;
  if (site?.type === 'VariableDeclarator' && site.init === awaited) target = site.id;
  else if (site?.type === 'AssignmentExpression' && site.operator === '=' && site.right === awaited)
    target = site.left;
  else if (site?.type === 'MemberExpression' && site.object === awaited && !site.computed && index === null)
    return [site.property.name];
  if (index !== null) target = target?.type === 'ArrayPattern' ? target.elements[index] : null;
  if (target?.type === 'ObjectPattern')
    return target.properties
      .filter((q) => q.type === 'Property' && !q.computed)
      .map((q) => q.key.name ?? q.key.value);
  if (target?.type === 'Identifier') return memberReads(target.name, site, parent);
  return [];
}

/** The `name.x` reads in the function (or module) holding `site`, minus the names it probes for. */
function memberReads(name, site, parent) {
  let scope = site;
  while (scope && !/Function|Program/.test(scope.type)) scope = parent.get(scope);
  const read = new Set();
  const probed = new Set();
  walk(scope, (n) => {
    if (
      n.type !== 'MemberExpression' ||
      n.computed ||
      n.object.type !== 'Identifier' ||
      n.object.name !== name
    )
      return;
    const up = parent.get(n);
    if (up?.type === 'AssignmentExpression' && up.left === n) return;
    const tested =
      n.optional ||
      (up?.type === 'CallExpression' && up.callee === n && up.optional) ||
      (up?.type === 'LogicalExpression' && up.left === n) ||
      (up?.type === 'UnaryExpression' && (up.operator === 'typeof' || up.operator === '!')) ||
      ((up?.type === 'IfStatement' || up?.type === 'ConditionalExpression') && up.test === n);
    (tested ? probed : read).add(n.property.name);
  });
  return [...read].filter((x) => !probed.has(x));
}

const parsed = new Map();
function parse(rev, file) {
  const key = `${rev}:${file}`;
  if (parsed.has(key)) return parsed.get(key);
  const src = /\.(mjs|js)$/.test(file) ? show(rev, file) : null;
  let info = null;
  if (src !== null) {
    const ast = acorn.parse(src.replace(/^#!.*/, ''), {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
    const imports = [];
    const exports = new Set();
    const star = [];
    const parent = parents(ast);
    for (const n of ast.body) {
      if (n.type === 'ImportDeclaration')
        imports.push({
          spec: n.source.value,
          names: n.specifiers.flatMap((s) =>
            s.type === 'ImportSpecifier'
              ? [s.imported.name ?? s.imported.value]
              : s.type === 'ImportNamespaceSpecifier'
                ? namespaceReads(s.local.name, ast, parent)
                : [],
          ),
        });
      if (n.type === 'ExportNamedDeclaration') {
        const d = n.declaration;
        if (d?.id) exports.add(d.id.name);
        for (const x of d?.declarations ?? []) if (x.id.type === 'Identifier') exports.add(x.id.name);
        for (const s of n.specifiers ?? []) exports.add(s.exported.name ?? s.exported.value);
        if (n.source)
          imports.push({
            spec: n.source.value,
            names: n.specifiers.map((s) => s.local.name ?? s.local.value),
          });
      }
      if (n.type === 'ExportAllDeclaration') {
        star.push(n.source.value);
        imports.push({ spec: n.source.value, names: [] });
      }
      if (n.type === 'ExportDefaultDeclaration') exports.add('default');
    }
    for (const d of dynamicImports(ast, parent)) imports.push(d);
    info = { imports, exports, star };
  } else if (show(rev, file) !== null) {
    info = { imports: [], exports: new Set(), star: [] }; // a non-JS file: present, imports nothing
  }
  parsed.set(key, info);
  return info;
}

const { SOURCE_FILES, HOOK_SCRIPT_FILES = [] } = await manifest(NEW);
const position = new Map(SOURCE_FILES.map((f, i) => [f, i]));
// Files outside SOURCE_FILES (scripts/, node_modules/) are swapped after it: still <old>.
const revAt = (file, i) => ((position.get(file) ?? Infinity) <= i ? NEW : OLD);

function exportsOf(file, i, seen = new Set()) {
  const p = parse(revAt(file, i), file);
  if (!p) return null;
  const out = new Set(p.exports);
  for (const s of p.star) {
    const t = posix.normalize(posix.join(posix.dirname(file), s));
    if (seen.has(t)) continue;
    seen.add(t);
    for (const x of exportsOf(t, i, seen) ?? []) if (x !== 'default') out.add(x);
  }
  return out;
}

function loadErrors(entry, i) {
  const errors = [];
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const p = parse(revAt(file, i), file);
    if (!p) {
      errors.push(`missing ${file}@${revAt(file, i)}`);
      continue;
    }
    for (const im of p.imports) {
      if (!im.spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), im.spec));
      const how = im.dynamic ? 'import()s' : 'imports';
      if (!parse(revAt(target, i), target)) {
        errors.push(`${file}@${revAt(file, i)} ${how} ${target}, missing at ${revAt(target, i)}`);
        continue;
      }
      const ex = exportsOf(target, i);
      for (const name of im.names)
        if (!ex.has(name))
          errors.push(`${file}@${revAt(file, i)} ${how} {${name}} that ${target}@${revAt(target, i)} lacks`);
      stack.push(target);
    }
  }
  return errors;
}

const ENTRIES = [
  'install.mjs',
  'hook-update.mjs',
  'hook.mjs',
  'server.mjs',
  'cli.mjs',
  'mem-cli.mjs',
  ...HOOK_SCRIPT_FILES.filter((f) => /\.(mjs|js)$/.test(f)).map((f) => `scripts/${f}`),
  'scripts/launch.mjs',
].filter((f, k, all) => all.indexOf(f) === k && (parse(NEW, f) || parse(OLD, f)));

let failing = 0;
for (const entry of ENTRIES) {
  const bad = [];
  for (let i = -1; i < SOURCE_FILES.length; i++) {
    const errors = loadErrors(entry, i);
    if (errors.length > 0) bad.push({ i, errors });
  }
  if (bad.length === 0) {
    console.log(`${entry}: loads at all ${SOURCE_FILES.length + 1} split points`);
    continue;
  }
  failing++;
  console.log(
    `${entry}: FAILS at ${bad.length} of ${SOURCE_FILES.length + 1} split points (i = ${bad[0].i}..${bad.at(-1).i})`,
  );
  for (const e of [...new Set(bad.flatMap((b) => b.errors))].slice(0, 10)) console.log(`  ${e}`);
}
console.log(
  `${OLD} -> ${NEW}: ${failing === 0 ? 'every entry point loads at every split point' : `${failing} entry point(s) fail`}`,
);
process.exit(failing === 0 ? 0 : 1);
