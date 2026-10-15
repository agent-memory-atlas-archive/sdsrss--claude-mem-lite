// benchmark/lesson-blind-read.mjs decides whether "Haiku 5.5 keeps fewer lessons" means
// "worse": the blinding must not leak the arm, and the strict count must need both judges.
import { describe, it, expect } from 'vitest';
import { seededShuffle, buildBlind, scoreVerdicts } from '../benchmark/lesson-blind-read.mjs';

const DUMP = {
  arms: ['base', 'cand'],
  items: [
    { item: 0, context: 'ctx zero' },
    { item: 1, context: 'ctx one' },
  ],
  rows: [
    { item: 0, arm: 'base', kept: true, lesson: 'base lesson 0' },
    { item: 0, arm: 'cand', kept: false, lesson: 'dropped' },
    { item: 1, arm: 'base', kept: true, lesson: 'base lesson 1' },
    { item: 1, arm: 'cand', kept: true, lesson: 'cand lesson 1' },
  ],
};

describe('seededShuffle', () => {
  it('is a permutation and repeats for the same seed', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const a = seededShuffle(xs, 7);
    expect([...a].sort((x, y) => x - y)).toEqual(xs);
    expect(seededShuffle(xs, 7)).toEqual(a);
    expect(seededShuffle(xs, 8)).not.toEqual(a);
  });
});

describe('buildBlind', () => {
  const { batches, key } = buildBlind(DUMP, { seed: 1, batches: 1 });
  const all = batches.flatMap((b) => b.a);
  it('takes kept rows only, each with its own evidence', () => {
    expect(all.map((i) => i.lesson).sort()).toEqual(['base lesson 0', 'base lesson 1', 'cand lesson 1']);
    for (const i of all) expect(i.evidence).toBe(DUMP.items.find((x) => x.item === key[i.id].item).context);
  });
  it('gives a judge {id, evidence, lesson} and nothing that names the arm', () => {
    for (const i of all) expect(Object.keys(i).sort()).toEqual(['evidence', 'id', 'lesson']);
    expect(JSON.stringify(batches)).not.toMatch(/"(base|cand)"|"arm"|"item"/);
  });
  it('hands the second judge the same items in its own order', () => {
    expect(batches[0].b.map((i) => i.id).sort()).toEqual(batches[0].a.map((i) => i.id).sort());
  });
});

describe('scoreVerdicts', () => {
  const key = { L1: { arm: 'base' }, L2: { arm: 'base' }, L3: { arm: 'cand' } };
  it('counts ACCURATE only when both judges say so, and agreement on all four labels', () => {
    const a = { L1: 'ACCURATE', L2: 'ACCURATE', L3: 'ACCURATE' };
    const b = { L1: 'ACCURATE', L2: 'PARTLY', L3: 'ACCURATE' };
    const r = scoreVerdicts(key, a, b, 'base');
    expect(r.arms.base).toMatchObject({ kept: 2, judged: 2, accurateBoth: 1, accurateEither: 2 });
    expect(r.arms.cand).toMatchObject({ accurateBoth: 1, ratioToBaseline: 1 });
    expect(r.agreement).toEqual({ same: 2, n: 3 });
  });
  it('a missing or unknown label is not judged, and never counts as ACCURATE', () => {
    const r = scoreVerdicts(key, { L1: 'ACCURATE', L3: 'MAYBE' }, { L1: 'ACCURATE', L3: 'ACCURATE' }, 'base');
    expect(r.arms.base).toMatchObject({ kept: 2, judged: 1, accurateBoth: 1 });
    expect(r.arms.cand).toMatchObject({ kept: 1, judged: 0, accurateBoth: 0 });
  });
});
