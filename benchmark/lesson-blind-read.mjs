#!/usr/bin/env node
// Blind correctness read of the lessons a haiku-tier model A/B kept (D#320).
//
// WHY THIS EXISTS. haiku-model-ab.mjs's `kept` column COUNTS the lessons handleLLMEpisode
// would keep; it does not judge them. Run 4 (2026-10-15) read Claude Haiku 5.5 keeping 26
// against 4.5's 39 on 72 paired episodes, and grounding checks provenance, not truth — the
// 2026-09-28 relabel found WRONG lessons that had passed it. So "fewer" needs a second
// reading before it can mean "worse": how many of each arm's kept lessons are ACCURATE.
//
// THE PROCEDURE, in two commands around a human-free judging step:
//   prepare  reads a `haiku-model-ab.mjs --dump` file, keeps the rows with kept === true,
//            gives each a random id, shuffles with a fixed seed, and writes per-batch item
//            files in TWO different orders (one per judge) plus a key file. Items carry only
//            {id, evidence, lesson}: the arm, the item index and the model never reach a judge.
//   (judge)  two independent judges label every item ACCURATE / PARTLY / WRONG / GENERIC
//            against the evidence alone — the labels of docs/audits/20260928-d101-keyevents-
//            relabel.md §5, read as faithfulness to what the model was shown. Each writes
//            [{id, label, reason}] to a file.
//   score    unblinds with the key: per arm, kept lessons, ACCURATE by BOTH judges (the
//            strict count the decision uses), by EITHER, each judge's label counts, raw
//            4-way agreement, Wilson 95% intervals, and each arm's ratio to the baseline arm.
//
// WHAT IT CANNOT SEE. The judge sees the evidence the model saw, not the repository, so a
// lesson can read ACCURATE here and still be wrong about the code. Lesson wording can hint at
// the model behind it; shuffling hides the arm, not the style.
//
// Usage:
//   node benchmark/lesson-blind-read.mjs prepare <dump.json> <outdir> [--seed 20261015] [--batches 4]
//   node benchmark/lesson-blind-read.mjs score <outdir> [--baseline <arm>]
//     (score reads <outdir>/verdicts-<batch>-{a,b}.json)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson95 } from './wilson.mjs';

export const LABELS = ['ACCURATE', 'PARTLY', 'WRONG', 'GENERIC'];

/** mulberry32 — a seeded PRNG, so the same seed gives the same ids and orders. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded generator; returns a new array. */
export function seededShuffle(xs, seed) {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Blind the kept rows of a dump. Returns judge-facing batches (two orders each) and the key.
 * @param {{items: {item:number, context:string}[], rows: object[]}} dump
 * @returns {{batches: {a: object[], b: object[]}[], key: Record<string, {arm:string, item:number}>}}
 */
export function buildBlind(dump, { seed = 20261015, batches = 4 } = {}) {
  const ctx = new Map(dump.items.map((i) => [i.item, i.context]));
  const kept = dump.rows.filter((r) => r.kept && typeof r.lesson === 'string' && r.lesson);
  const shuffled = seededShuffle(kept, seed);
  const key = {};
  const items = shuffled.map((r, i) => {
    const id = `L${String(i + 1).padStart(3, '0')}`;
    key[id] = { arm: r.arm, item: r.item };
    return { id, evidence: ctx.get(r.item), lesson: r.lesson };
  });
  const size = Math.ceil(items.length / batches) || 1;
  const out = [];
  for (let k = 0; k < items.length; k += size) {
    const a = items.slice(k, k + size);
    out.push({ a, b: seededShuffle(a, seed + k + 1) });
  }
  return { batches: out, key };
}

/**
 * Unblind two judges' labels. `a` and `b` map id → label.
 * @returns {{agreement: {same:number, n:number}, arms: Record<string, object>}}
 */
export function scoreVerdicts(key, a, b, baseline) {
  const arms = {};
  let same = 0;
  let n = 0;
  for (const [id, { arm }] of Object.entries(key)) {
    const la = a[id];
    const lb = b[id];
    const s = (arms[arm] ??= {
      kept: 0,
      judged: 0,
      accurateBoth: 0,
      accurateEither: 0,
      a: Object.fromEntries(LABELS.map((l) => [l, 0])),
      b: Object.fromEntries(LABELS.map((l) => [l, 0])),
    });
    s.kept++;
    if (!LABELS.includes(la) || !LABELS.includes(lb)) continue;
    s.judged++;
    s.a[la]++;
    s.b[lb]++;
    if (la === 'ACCURATE' && lb === 'ACCURATE') s.accurateBoth++;
    if (la === 'ACCURATE' || lb === 'ACCURATE') s.accurateEither++;
    n++;
    if (la === lb) same++;
  }
  const base = arms[baseline]?.accurateBoth ?? 0;
  for (const s of Object.values(arms)) {
    s.accurateBothCI = wilson95(s.accurateBoth, s.judged);
    s.ratioToBaseline = base ? s.accurateBoth / base : null;
  }
  return { agreement: { same, n }, arms };
}

function readVerdicts(path) {
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  return Object.fromEntries(rows.map((r) => [r.id, String(r.label || '').toUpperCase()]));
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const [cmd, p1, p2] = process.argv.slice(2);
  if (cmd === 'prepare') {
    const dump = JSON.parse(readFileSync(p1, 'utf8'));
    const { batches, key } = buildBlind(dump, {
      seed: Number(arg('--seed', '20261015')),
      batches: Number(arg('--batches', '4')),
    });
    mkdirSync(p2, { recursive: true });
    batches.forEach((bt, k) => {
      writeFileSync(join(p2, `batch-${k + 1}-a.json`), JSON.stringify(bt.a, null, 1));
      writeFileSync(join(p2, `batch-${k + 1}-b.json`), JSON.stringify(bt.b, null, 1));
    });
    writeFileSync(join(p2, 'key.json'), JSON.stringify({ arms: dump.arms, key }));
    console.log(`${Object.keys(key).length} kept lessons → ${batches.length} batches in ${p2}`);
    return;
  }
  if (cmd === 'score') {
    const { arms, key } = JSON.parse(readFileSync(join(p1, 'key.json'), 'utf8'));
    const a = {};
    const b = {};
    for (let k = 1; existsSync(join(p1, `batch-${k}-a.json`)); k++) {
      Object.assign(a, readVerdicts(join(p1, `verdicts-${k}-a.json`)));
      Object.assign(b, readVerdicts(join(p1, `verdicts-${k}-b.json`)));
    }
    const baseline = arg('--baseline', arms[0]);
    const r = scoreVerdicts(key, a, b, baseline);
    console.log(JSON.stringify({ baseline, ...r }, null, 2));
    return;
  }
  console.error('usage: prepare <dump.json> <outdir> | score <outdir>');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
