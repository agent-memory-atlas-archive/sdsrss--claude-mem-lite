// benchmark/haiku-model-ab.mjs decides a released default (the haiku-tier model), so each
// of its verdicts must be able to say NO: the gate, the fallback/control guard, and the
// episode classifier that mirrors handleLLMEpisode's enrichment gate.
import { describe, it, expect, vi } from 'vitest';
import {
  pickEvenly,
  runSite,
  gateVerdict,
  assertFallbackBlocked,
  classifyEpisode,
  lessonKept,
  enterArm,
  CLI_ARM,
  MISSING_CLI,
} from '../benchmark/haiku-model-ab.mjs';
import { parseJsonFromLLM } from '../utils.mjs';
import { unwrapObservationEnvelope, hasEnrichmentContent } from '../hook-llm.mjs';

const parsers = { parseJsonFromLLM, unwrapObservationEnvelope, hasEnrichmentContent };

describe('pickEvenly', () => {
  it('spreads over the whole population, deterministically', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    expect(pickEvenly(xs, 4)).toEqual([0, 25, 50, 75]);
    expect(pickEvenly(xs, 4)).toEqual(pickEvenly(xs, 4));
  });
  it('returns everything when n covers the population', () => {
    expect(pickEvenly([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('runSite', () => {
  it('runs every arm on every item, alternating which arm goes first', async () => {
    const seen = [];
    const res = await runSite([0, 1, 2], ['a', 'b'], async (item, arm) => {
      seen.push(`${item}${arm}`);
      return { usable: arm === 'b' };
    });
    expect(seen).toEqual(['0a', '0b', '1b', '1a', '2a', '2b']);
    expect(res.get('a')).toMatchObject({ n: 3, usable: 0 });
    expect(res.get('b')).toMatchObject({ n: 3, usable: 3 });
  });
  it('counts a throw as an error, never as usable', async () => {
    const res = await runSite([0], ['a'], async () => {
      throw new Error('boom');
    });
    expect(res.get('a')).toMatchObject({ n: 1, usable: 0, errors: 1 });
  });
});

describe('gateVerdict', () => {
  it('passes a candidate that loses at most one item', () => {
    expect(gateVerdict({ usable: 20, n: 24 }, { usable: 19, n: 24 }).pass).toBe(true);
  });
  it('fails a candidate that loses two', () => {
    expect(gateVerdict({ usable: 20, n: 24 }, { usable: 18, n: 24 }).pass).toBe(false);
  });
});

describe('assertFallbackBlocked', () => {
  it('refuses a run whose CLI fallback still resolves to a real binary', () => {
    expect(() => assertFallbackBlocked('claude', { usable: 0, n: 6 })).toThrow(/CLI fallback not blocked/);
  });
  it('refuses a run whose invalid-slug control answered', () => {
    expect(() => assertFallbackBlocked(MISSING_CLI, { usable: 1, n: 6 })).toThrow(/control arm/);
    expect(() => assertFallbackBlocked(MISSING_CLI, { usable: 0, n: 6 })).not.toThrow();
  });
});

describe('classifyEpisode', () => {
  it('no reply is an error, not a model verdict', () => {
    expect(classifyEpisode(null, parsers)).toMatchObject({ usable: false, error: true });
  });
  it('a fenced object with a title is usable, and the fence is recorded', () => {
    const v = classifyEpisode('```json\n{"type":"bugfix","title":"Fix split crash"}\n```', parsers);
    expect(v).toMatchObject({ usable: true, fenced: true });
  });
  it('an envelope is peeled the way the handler peels it', () => {
    const v = classifyEpisode('{"observation":{"type":"change","title":"Rename x"}}', parsers);
    expect(v.usable).toBe(true);
    expect(v.parsed.title).toBe('Rename x');
  });
  it('prose and bare arrays are not usable', () => {
    expect(classifyEpisode('I could not find a change worth recording.', parsers).usable).toBe(false);
    expect(classifyEpisode('["a","b"]', parsers).usable).toBe(false);
  });
});

describe('lessonKept', () => {
  const EV = new Set(['bugfix', 'decision']);
  it('an event type keeps only a grounded lesson', () => {
    expect(lessonKept({ type: 'bugfix', lesson: true, grounded: true }, EV)).toBe(true);
    expect(lessonKept({ type: 'bugfix', lesson: true, grounded: false }, EV)).toBe(false);
  });
  it('a change row keeps its lesson ungrounded', () => {
    expect(lessonKept({ type: 'change', lesson: true, grounded: false }, EV)).toBe(true);
  });
  it('no lesson is never kept', () => {
    expect(lessonKept({ type: 'change', lesson: false, grounded: false }, EV)).toBe(false);
  });
});

describe('enterArm', () => {
  // toStrictEqual, not toEqual: a restore that assigns undefined instead of deleting reads
  // equal under toEqual, and on process.env that assignment stores the string "undefined".
  // The slug arm starts WITHOUT CLAUDE_CODE_PATH, so only the arm itself can set the block.
  const base = () => ({ OPENROUTER_API_KEY: 'sk-or', OTHER: 'x' });
  const withCli = () => ({
    ...base(),
    CLAUDE_CODE_PATH: '/usr/bin/claude',
    OPENROUTER_MODEL: 'anthropic/x',
  });
  it('a slug arm names the slug and keeps the CLI fallback blocked, then restores', () => {
    const env = base();
    const reset = vi.fn();
    const restore = enterArm('anthropic/claude-haiku-5.5', env, reset);
    expect(env).toMatchObject({
      OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5',
      CLAUDE_CODE_PATH: MISSING_CLI,
    });
    restore();
    expect(env).toStrictEqual(base());
    expect(reset).toHaveBeenCalledTimes(2);
  });
  it('the cli arm drops the OpenRouter key, model and CLAUDE_CODE_PATH, then puts them back', () => {
    const env = withCli();
    const restore = enterArm(CLI_ARM, env);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_PATH).toBeUndefined();
    expect(env.OPENROUTER_MODEL).toBeUndefined();
    restore();
    expect(env).toStrictEqual(withCli());
  });
  // cli:<option>… sets Claude Code switches the spawn inherits (cliSpawnEnv passes process.env on):
  // the auto-memory section and the effort level (D#483, D#334), verified to change the request.
  it('a cli arm with options sets only those switches, and the plain cli arm clears them', () => {
    const env = { ...withCli(), CLAUDE_CODE_EFFORT_LEVEL: 'high' };
    const restore = enterArm(`${CLI_ARM}:noautomem:low`, env);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    restore();
    expect(env).toStrictEqual({ ...withCli(), CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    const restorePlain = enterArm(CLI_ARM, env);
    expect(env.CLAUDE_CODE_EFFORT_LEVEL, 'the baseline runs Claude Code defaults').toBeUndefined();
    restorePlain();
  });
  it('an unknown cli arm option is refused rather than ignored', () => {
    expect(() => enterArm(`${CLI_ARM}:fast`, {})).toThrow(/fast/);
  });
});
