#!/usr/bin/env node
// Haiku-tier model A/B: does a candidate model answer the SHIPPED haiku-tier prompts as
// usably as the current one? Built for the Claude Haiku 4.5 → 5.5 move (2026-10-15).
//
// WHY THIS EXISTS. The two rulers on this tree that touch an LLM are blind to a haiku-tier
// model change, and quoting either would be a reading from the wrong ruler (doctrine rule 9):
// deep-search-holdout.mjs replays RECORDED rewrites and never calls a model, and
// compress-veto-rate.mjs judges smart-compress, which runs the SONNET tier.
//
// THREE SITES, each through shipped code end to end:
//   episode  buildEpisodePrompt(sub) → callLLM → parseJsonFromLLM → unwrapObservationEnvelope.
//            Usable = the gate handleLLMEpisode enriches on: an object, not an array, with a
//            usable title or hasEnrichmentContent. Population: the sub-episodes
//            episode-flush-replay.mjs says the shipped flush hands the llm-episode worker,
//            from this machine's transcripts since --since, --n of them evenly spaced in time.
//   rewrite  rewriteQuery(query) with its shipped provider and retry. Usable = >= 2 variants
//            (the original plus one real rewrite). Population: the three fixture query sets,
//            --n of them evenly spaced.
//   rerank   deepSearch(db, {query}, {rerank: true}) on the seed fixture, rewrite stubbed off,
//            so candidates and their text are the shipped ones. Usable = `reranked` (the
//            answer parsed). Population: test-queries.json queries with >= 2 results, --n of them.
//
// ARMS are OpenRouter slugs, switched per call through OPENROUTER_MODEL, which
// resolveOpenRouterModel reads on every call. Each item runs every arm back to back in one
// process, arm order alternating by item, so time drift and provider hiccups land on both
// (doctrine rule 2).
//
// THE HAZARD THIS IS BUILT AROUND. Every dispatcher falls back to `claude -p` when the keyed
// call fails, and that CLI resolves `haiku` to Claude Haiku 5.5 (Claude Code >= 2.1.293). A
// failed 4.5 call would come back as a 5.5 answer and score for the wrong arm. main() points
// CLAUDE_CODE_PATH at a binary that does not exist, and assertFallbackBlocked refuses the run
// unless getClaudePath() resolves to it AND a control arm with an invalid slug reads 0 usable.
//
// WHAT IT CANNOT SEE. For rewrite and rerank a null from the shipped path is a transport
// error or a non-answer alike (episode separates them: no reply vs an unusable reply).
// OpenRouter's usage and cost never reach the shipped path. hook-optimize's inline re-enrich
// prompts (scope / aliases / concepts / importance) are not sampled.
//
// GATE, set before the first run (tasks/specs/haiku-5-5-migration.md SC1): per site,
// usable(candidate) >= usable(baseline) - 1 over the same items.
//
// Usage (needs OPENROUTER_API_KEY and no ANTHROPIC_API_KEY — the API leg ignores the slug):
//   node benchmark/haiku-model-ab.mjs                       # 4.5 vs 5.5, all three sites
//   node benchmark/haiku-model-ab.mjs --n 24 --since 2026-10-01 --sites episode,rerank
//   node benchmark/haiku-model-ab.mjs --arms anthropic/claude-haiku-4.5,anthropic/claude-haiku-5.5
//   node benchmark/haiku-model-ab.mjs --json
//   node benchmark/haiku-model-ab.mjs --sites episode --n 72 \
//        --arms anthropic/claude-haiku-4.5,anthropic/claude-haiku-5.5,cli --dump rows.json
//
// THE `cli` ARM is the leg default users run: no key, `claude -p --model haiku`, whatever
// model Claude Code's alias resolves to (the report records `claude --version`). It removes
// OPENROUTER_API_KEY and the CLI block for its own calls only, so the shipped dispatchers
// take their cli-mode branch. It costs subscription quota, not OpenRouter credit.
// --dump writes the episode rows with lesson text and the prompt's user part (the evidence
// the model saw) — the input for a blind correctness read (D#320).

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const DEFAULT_ARMS = ['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-5.5'];
const CONTROL_SLUG = 'anthropic/claude-haiku-0-0-no-such-model';
export const MISSING_CLI = join(HERE, '.no-such-claude-cli');
export const CLI_ARM = 'cli';
const CONTROL_ITEMS = 2;

/** `n` items evenly spaced over `items` (deterministic; all of them when n >= length). */
export function pickEvenly(items, n) {
  if (n >= items.length) return [...items];
  if (n <= 0) return [];
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/**
 * Run every arm on every item, arm order alternating by item. `call(item, arm)` resolves
 * {usable: boolean, error?: boolean, ...extra}; a throw counts as an error.
 * @returns {Promise<Map<string, {n:number, usable:number, errors:number, ms:number[], rows:object[]}>>}
 */
export async function runSite(items, arms, call) {
  const out = new Map(arms.map((a) => [a, { n: 0, usable: 0, errors: 0, ms: [], rows: [] }]));
  for (let i = 0; i < items.length; i++) {
    const order = i % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) {
      const t0 = Date.now();
      let r;
      try {
        r = await call(items[i], arm);
      } catch (e) {
        r = { usable: false, error: true, thrown: String(e?.message || e) };
      }
      const agg = out.get(arm);
      agg.n++;
      if (r.usable) agg.usable++;
      if (r.error) agg.errors++;
      agg.ms.push(Date.now() - t0);
      agg.rows.push({ item: i, ...r });
    }
  }
  return out;
}

/**
 * Point the shipped dispatchers at one arm, in `env` (process.env in a run). A slug arm keeps
 * the OpenRouter leg with the CLI fallback blocked; the `cli` arm drops the OpenRouter key and
 * the block, so detectMode() answers 'cli' and the real `claude -p` runs. Returns the function
 * that puts `env` back exactly; `resetMode` (haiku-client's _resetMode) runs on both edges
 * because detectMode() caches its answer.
 */
export function enterArm(arm, env, resetMode = () => {}) {
  const keys = ['OPENROUTER_MODEL', 'OPENROUTER_API_KEY', 'CLAUDE_CODE_PATH'];
  const saved = Object.fromEntries(keys.map((k) => [k, env[k]]));
  if (arm === CLI_ARM) {
    for (const k of keys) delete env[k];
  } else {
    env.OPENROUTER_MODEL = arm;
    env.CLAUDE_CODE_PATH = MISSING_CLI;
  }
  resetMode();
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
    resetMode();
  };
}

/** SC1: the candidate may lose at most `slack` usable items against the baseline. */
export function gateVerdict(baseline, candidate, slack = 1) {
  return {
    pass: candidate.usable >= baseline.usable - slack,
    baseline: `${baseline.usable}/${baseline.n}`,
    candidate: `${candidate.usable}/${candidate.n}`,
  };
}

/**
 * The ruler is only a ruler if a dead arm reads dead: the CLI fallback must be cut off
 * (it would answer with Haiku 5.5 for any arm) and the invalid-slug control must score 0.
 */
export function assertFallbackBlocked(claudePath, control) {
  if (claudePath !== MISSING_CLI) {
    throw new Error(
      `CLI fallback not blocked: getClaudePath() is ${claudePath} (a settings.json CLAUDE_CODE_PATH ` +
        'outranks the env var) — a failed call could be answered by `claude -p` for the wrong arm',
    );
  }
  if (control.usable > 0) {
    throw new Error(
      `control arm ${CONTROL_SLUG} read ${control.usable}/${control.n} usable — something other ` +
        'than the named model is answering; no reading from this run is valid',
    );
  }
}

/**
 * Episode verdict from the raw reply, by the gate handleLLMEpisode enriches on.
 * @param {string|null} raw
 * @param {object} deps shipped parsers (injected so this stays importable without the client)
 */
export function classifyEpisode(raw, { parseJsonFromLLM, unwrapObservationEnvelope, hasEnrichmentContent }) {
  if (raw === null || raw === undefined || raw === '') return { usable: false, error: true };
  let parsed = parseJsonFromLLM(raw);
  if (parsed && typeof parsed === 'object') parsed = unwrapObservationEnvelope(parsed);
  const isObj = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  const titleUsable = isObj && typeof parsed.title === 'string' && !!parsed.title;
  return {
    usable: isObj && (titleUsable || hasEnrichmentContent(parsed)),
    parsed: isObj ? parsed : null,
    fenced: /^\s*```/.test(raw),
  };
}

/**
 * Would handleLLMEpisode KEEP this first-pass lesson? An event type's lesson survives only
 * when it quotes the window's DIAGNOSIS (D#69 grounding, on by default); a `change` row's
 * lesson is kept as written. The bugfix/decision lesson retry is not modelled.
 * @param {{type?: string, lesson: boolean, grounded: boolean}} row
 * @param {Set<string>} eventTypes
 */
export function lessonKept(row, eventTypes) {
  if (!row.lesson) return false;
  return eventTypes.has(row.type) ? row.grounded : true;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const json = process.argv.includes('--json');
  const arms = arg('--arms', DEFAULT_ARMS.join(',')).split(',');
  const sites = arg('--sites', 'episode,rewrite,rerank').split(',');
  const n = Number(arg('--n', '24'));
  const since = Date.parse(arg('--since', new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10)));

  if (process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is set: the direct-API leg runs first and ignores OPENROUTER_MODEL.');
    process.exit(2);
  }
  process.env.CLAUDE_CODE_PATH = MISSING_CLI;
  process.env.CLAUDE_MEM_NO_DELAY = '1';

  const hc = await import('../haiku-client.mjs');
  if (hc.detectMode() !== 'openrouter') {
    console.error(`provider mode is ${hc.detectMode()}, not openrouter: set OPENROUTER_API_KEY.`);
    process.exit(2);
  }
  const { callLLM } = await import('../lib/llm-call.mjs');
  const { parseJsonFromLLM } = await import('../utils.mjs');
  const hl = await import('../hook-llm.mjs');
  const { isLessonGrounded } = await import('../lib/episode-input-filter.mjs');
  const { OBS_TYPE_SET } = await import('../lib/obs-types.mjs');
  const { EVENT_TYPES } = await import('../lib/activity.mjs');
  const eventTypes = new Set(EVENT_TYPES);
  const { rewriteQuery, deepSearch } = await import('../deep-search.mjs');
  const parsers = {
    parseJsonFromLLM,
    unwrapObservationEnvelope: hl.unwrapObservationEnvelope,
    hasEnrichmentContent: hl.hasEnrichmentContent,
  };
  const withModel = async (arm, fn) => {
    const restore = enterArm(arm, process.env, hc._resetMode);
    try {
      return await fn();
    } finally {
      restore();
    }
  };
  let cliVersion = null;
  if (arms.includes(CLI_ARM)) {
    const restore = enterArm(CLI_ARM, process.env, hc._resetMode);
    try {
      cliVersion = execFileSync(hc.getClaudePath(), ['--version'], {
        encoding: 'utf8',
        timeout: 30000,
      }).trim();
    } finally {
      restore();
    }
  }

  // ── populations ──
  const pops = {};
  if (sites.includes('episode')) {
    const { collectEvents, replayProject } = await import('./episode-flush-replay.mjs');
    const { byProject } = collectEvents({ since });
    const subs = [];
    for (const [project, events] of byProject) {
      events.sort((a, b) => a.ts - b.ts);
      replayProject(events, project, { llmSubs: subs });
    }
    subs.sort((a, b) => (a.entries[0]?.ts ?? 0) - (b.entries[0]?.ts ?? 0));
    pops.episode = { total: subs.length, items: pickEvenly(subs, n) };
  }
  const readQueries = (f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')).queries.map((q) => q.query);
  if (sites.includes('rewrite')) {
    const qs = [
      ...readQueries('test-queries.json'),
      ...readQueries('test-queries-vocab-mismatch.json'),
      ...readQueries('test-queries-cjk.json'),
    ];
    pops.rewrite = { total: qs.length, items: pickEvenly(qs, n) };
  }
  let db = null;
  if (sites.includes('rerank')) {
    const { createTestDb } = await import('../tests/test-helpers.mjs');
    const { seedDatabase } = await import('./benchmark.mjs');
    db = createTestDb();
    seedDatabase(db, JSON.parse(readFileSync(join(FIXTURES, 'seed-data.json'), 'utf8')));
    const noRewrite = async () => null;
    const qs = [];
    for (const q of readQueries('test-queries.json')) {
      const { results } = await deepSearch(db, { query: q, limit: 10 }, { llm: noRewrite });
      if (results.length >= 2) qs.push(q);
    }
    pops.rerank = { total: qs.length, items: pickEvenly(qs, n) };
  }

  // ── per-site calls, all through shipped code ──
  const calls = {
    episode: (sub, arm) =>
      withModel(arm, async () => {
        const raw = await callLLM(hl.buildEpisodePrompt(sub));
        const v = classifyEpisode(raw, parsers);
        const p = v.parsed;
        const lesson = p && typeof p.lesson_learned === 'string' ? p.lesson_learned : null;
        return {
          usable: v.usable,
          error: !!v.error,
          fenced: !!v.fenced,
          typeOk: !!p && OBS_TYPE_SET.has(p.type),
          lesson: !!lesson && !hl.isLowSignalLesson(lesson),
          grounded: !!lesson && isLessonGrounded(lesson, hl.episodeDiagnosis(sub)),
          type: p?.type,
          lessonText: lesson,
          rawHead: v.usable ? undefined : String(raw ?? '').slice(0, 160),
        };
      }),
    rewrite: (q, arm) =>
      withModel(arm, async () => {
        const variants = await rewriteQuery(q);
        return { usable: variants.length >= 2, variants: variants.length };
      }),
    rerank: (q, arm) =>
      withModel(arm, async () => {
        const { reranked } = await deepSearch(
          db,
          { query: q, limit: 10 },
          { llm: async () => null, rerank: true },
        );
        return { usable: reranked };
      }),
  };

  // ── control first: a run whose dead arm reads alive measures nothing ──
  const controlItems = sites.flatMap((s) => pickEvenly(pops[s].items, CONTROL_ITEMS).map((it) => [s, it]));
  const control = (await runSite(controlItems, [CONTROL_SLUG], ([s, it], arm) => calls[s](it, arm))).get(
    CONTROL_SLUG,
  );
  assertFallbackBlocked(hc.getClaudePath(), control);

  const report = { arms, cliVersion, gate: 'usable(candidate) >= usable(baseline) - 1', control, sites: {} };
  const dumpPath = arg('--dump', null);
  for (const s of sites) {
    const res = await runSite(pops[s].items, arms, calls[s]);
    const perArm = Object.fromEntries(
      [...res].map(([a, r]) => [
        a,
        {
          n: r.n,
          usable: r.usable,
          errors: r.errors,
          medianMs: median(r.ms),
          ...(s === 'episode'
            ? {
                fenced: r.rows.filter((x) => x.fenced).length,
                typeOk: r.rows.filter((x) => x.typeOk).length,
                lesson: r.rows.filter((x) => x.lesson).length,
                grounded: r.rows.filter((x) => x.grounded).length,
                kept: r.rows.filter((x) => lessonKept(x, eventTypes)).length,
                unusable: r.rows.filter((x) => !x.usable).map((x) => ({ item: x.item, head: x.rawHead })),
              }
            : {}),
        },
      ]),
    );
    const verdicts = arms.slice(1).map((a) => ({ arm: a, ...gateVerdict(res.get(arms[0]), res.get(a)) }));
    report.sites[s] = { population: pops[s].total, sampled: pops[s].items.length, perArm, verdicts };
    if (s === 'episode' && dumpPath) {
      const items = pops.episode.items.map((sub, i) => ({
        item: i,
        context: hl.buildEpisodePrompt(sub).user,
      }));
      const rows = [...res].flatMap(([a, r]) =>
        r.rows.map((x) => ({
          item: x.item,
          arm: a,
          usable: x.usable,
          type: x.type ?? null,
          lesson: x.lessonText ?? null,
          grounded: x.grounded,
          kept: lessonKept(x, eventTypes),
        })),
      );
      writeFileSync(dumpPath, JSON.stringify({ arms, cliVersion, items, rows }));
    }
  }
  if (db) db.close();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Haiku-tier model A/B — ${arms.join(' vs ')}${cliVersion ? ` (cli: ${cliVersion})` : ''}`);
    console.log(
      `control ${CONTROL_SLUG}: ${control.usable}/${control.n} usable, ${control.errors} errors (must be 0 usable)`,
    );
    for (const [s, r] of Object.entries(report.sites)) {
      console.log(`\n${s}: ${r.sampled} items (population ${r.population})`);
      for (const [a, x] of Object.entries(r.perArm)) {
        const extra =
          s === 'episode'
            ? `  fenced ${x.fenced}  type-ok ${x.typeOk}  lesson ${x.lesson}  grounded ${x.grounded}  kept ${x.kept}`
            : '';
        console.log(
          `  ${a.padEnd(32)} usable ${x.usable}/${x.n}  errors ${x.errors}  median ${x.medianMs}ms${extra}`,
        );
      }
      for (const v of r.verdicts) {
        console.log(`  gate ${v.arm}: ${v.candidate} vs ${v.baseline} → ${v.pass ? 'PASS' : 'FAIL'}`);
      }
    }
  }
  process.exit(Object.values(report.sites).every((r) => r.verdicts.every((v) => v.pass)) ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
