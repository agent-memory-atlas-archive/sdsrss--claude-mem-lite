#!/usr/bin/env node
// Tool-surface A/B across CODE TREES: does a change to what the MCP server advertises (a tool
// description, a parameter's text, a declared alias) change which tool a model calls and with
// what arguments? Built for D367's second half (2026-10-16): five places where the surface told
// the model something the server does not do.
//
// AN ARM IS A TREE. `setup` archives `--base` and, per change, the base plus ONLY that change's
// product diff (`git diff <sha>^ <sha> -- tool-schemas.mjs server.mjs`), each with a node_modules
// symlink. Each probe belongs to one change and runs on the base arm and that change's arm only,
// so one change is measured at a time; the other changes' text is identical in both.
//
// THE LEG is a real Claude Code session, one per call: `claude -p --model sonnet --output-format
// stream-json --verbose --strict-mcp-config --mcp-config <only that tree's server.mjs> --tools ""
// --allowedTools mcp__mem`, prompt on stdin (--tools and --allowedTools are variadic and swallow a
// trailing prompt). Every call gets its own CLAUDE_CONFIG_DIR (a symlink to the credentials and a
// settings.json allowing mcp__mem, nothing else) and its own CLAUDE_MEM_DIR (a copy of one seed
// store). Inherited CLAUDE* / MEM_* variables and the API keys leave the child env
// (stripInheritedEnv); proxies stay. The server runs with CLAUDE_MEM_AUTO_DEEP=0, save-enrich off
// and CLAUDE_CODE_PATH pointing nowhere, so it makes no model call of its own.
//
// SELF-CHECKS per call, in the record and the score: the session's own tool list (stream-json
// `init`) holds mcp__mem__ tools only and the server reports `connected`; `is_error` false; the
// model is claude-sonnet-5-5. A call failing any of them is counted as invalid, not scored.
// `setup` refuses a run dir under a directory holding a CLAUDE.md (Claude Code loads ancestor
// CLAUDE.md files into the session).
//
// ORDER. Every probe, both arms, back to back, arm order alternating with (probe + rep), a 2 s
// stagger between launches (concurrent `claude -p` on one credential races its OAuth refresh).
//
// Usage:
//   node benchmark/tool-text-ab.mjs setup --base <sha> --arm B1=<sha> [--arm B2=<sha> ...] [--run-dir d]
//   node benchmark/tool-text-ab.mjs run [--reps 5] [--parallel 3] [--probes P1,P4] [--run-dir d]
//   node benchmark/tool-text-ab.mjs score [--run-dir d]
// Raw rows (whole replies) stay in the run dir; delete it after reading.

import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripInheritedEnv } from './prompt-guard-ab.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const MODEL = 'claude-sonnet-5-5';

/**
 * Probes, written before the first real call (tasks/specs/d367-tool-descriptions.md). Each names
 * the change it measures and the metric it is scored on; `higherIsBetter: false` marks a metric
 * that counts a failure (an operator the server ignores).
 */
export const PROBES = {
  P1: {
    change: 'B1',
    prompt: 'Search my memories for refresh token problems, but leave out anything about expiry.',
  },
  P2: {
    change: 'B1',
    prompt: 'Look through my memories for anything migration-related (migrate, migrated, migrations).',
  },
  P3: { change: 'B1', prompt: 'Search my memories for the redis connection pool leak.' },
  P4: { change: 'B2', prompt: 'Show me the full content of P#1 and #2 from my memory.' },
  P5: { change: 'B3', prompt: 'What have I been working on recently? Check my memory.' },
  P6: { change: 'B3', prompt: 'Find my memories about redis.' },
  P7: { change: 'B3', prompt: 'List my bugfix memories from this week.' },
  P8: { change: 'B4', prompt: 'Show me the full details of deferred item D#2.' },
  P9: {
    change: 'B5',
    prompt:
      'Save this as a bugfix memory: the invoice export timed out for tenants with more than 50k rows because one query held a lock for 40 s. Lesson: page the export in 500-row chunks and stream each page.',
  },
  P10: { change: 'B5', prompt: 'Show the timeline around memory #5.' },
  // Added 2026-10-17: the registered `prefix*` probe P2 replaced, in its registered wording.
  P11: { change: 'B1', prompt: '找所有以 migr 开头的记忆' },
  P12: { change: 'B1', prompt: '找所有以 migr 开头的记忆' },
};

// The seed store: eight observations, three deferred items, one stored prompt (P#1). The probes'
// expected answers name these rows, so ids are checked after seeding.
const SEED_SAVES = [
  [
    'bugfix',
    'Refresh token rotation failed after expiry',
    'Rotate the refresh token before the access token expires, with a 60 s margin',
  ],
  [
    'bugfix',
    'Refresh token stored in localStorage leaked through an XSS bug',
    'Keep refresh tokens in an httpOnly cookie, never in localStorage',
  ],
  [
    'discovery',
    'Refresh token endpoint is rate-limited during deploys',
    'The auth gateway caps /token at 20 req/s while a deploy drains pods',
  ],
  [
    'bugfix',
    'Migration 042 dropped an index the monthly reports needed',
    'Check pg_indexes for report queries before a migration drops an index',
  ],
  [
    'change',
    'Migrated the settings table to JSON columns',
    'Store per-tenant settings as one JSON column read through a typed accessor',
  ],
  [
    'bugfix',
    'Redis connection pool leaked connections under load',
    'Release redis clients in a finally block after every command',
  ],
  [
    'discovery',
    'Redis cache keys missed the tenant prefix',
    'Prefix every cache key with the tenant id so tenants never share entries',
  ],
  [
    'decision',
    'Chose Kafka over RabbitMQ for the audit log stream',
    'Kafka keeps the audit log replayable for 30 days; RabbitMQ deletes on ack',
  ],
];
const SEED_DEFERS = [
  [
    'Flaky checkout e2e test on Safari',
    'The cart badge renders after the assertion; wait for the network idle event first.',
  ],
  [
    'Invoice export times out for large tenants',
    'Split the export into pages of 500 rows and stream them; the single query holds a lock for 40 s.',
  ],
  [
    'Rotate the staging database password',
    'The password in the staging vault is 400 days old; rotate it and update the two CI secrets.',
  ],
];
const SEED_PROMPT = 'Why does the invoice export time out for large tenants on Mondays?';

// What the query sanitiser drops (nlp.mjs ftsQueryTokens + the AND/OR/NOT words): an uppercase
// operator word, a leading `-`, a trailing `*`, a `column:` filter, a quote.
const OPERATOR_RES = [/\b(NOT|AND|OR)\b/, /(^|\s)-\w/, /\w\*/, /\b\w+:\S/, /"/];

/** True when a mem_search query carries something the server ignores. */
export function hasOperator(query) {
  return typeof query === 'string' && OPERATOR_RES.some((re) => re.test(query));
}

const shortName = (n) => String(n).replace(/^mcp__mem__/, '');
const callsTo = (rec, name) => rec.toolCalls.filter((c) => shortName(c.name) === name);
const allResults = (rec) => rec.toolResults.join('\n');

/** Per probe: what a run is scored on, and whether a hit is the good outcome. */
export const METRICS = {
  P1: {
    label: 'an operator in a mem_search query',
    higherIsBetter: false,
    hit: (r) => callsTo(r, 'mem_search').some((c) => hasOperator(c.input.query)),
  },
  P2: {
    label: 'an operator in a mem_search query',
    higherIsBetter: false,
    hit: (r) => callsTo(r, 'mem_search').some((c) => hasOperator(c.input.query)),
  },
  P3: {
    label: 'mem_search called with a query',
    higherIsBetter: true,
    hit: (r) => callsTo(r, 'mem_search').some((c) => String(c.input.query || '').trim().length > 0),
  },
  P4: {
    label: 'both P#1 and obs #2 fetched',
    higherIsBetter: true,
    hit: (r) => allResults(r).includes(SEED_PROMPT) && allResults(r).includes('localStorage'),
  },
  P5: { label: 'mem_recent called', higherIsBetter: true, hit: (r) => callsTo(r, 'mem_recent').length > 0 },
  P6: { label: 'mem_search called', higherIsBetter: true, hit: (r) => callsTo(r, 'mem_search').length > 0 },
  P7: {
    label: 'answer lists bugfix rows only (>=3 of 4, none of the others)',
    higherIsBetter: true,
    hit: (r) => {
      const t = String(r.result || '').toLowerCase();
      const bug = ['rotation', 'localstorage', 'migration 042', 'connection pool'].filter((w) =>
        t.includes(w),
      ).length;
      const other = ['rate-limited', 'json column', 'tenant prefix', 'kafka'].filter((w) =>
        t.includes(w),
      ).length;
      return bug >= 3 && other === 0;
    },
  },
  P8: {
    label: "D#2's detail fetched",
    higherIsBetter: true,
    hit: (r) => allResults(r).includes('pages of 500 rows'),
  },
  P9: {
    label: 'the saved row keeps the lesson',
    higherIsBetter: true,
    hit: (r) =>
      Array.isArray(r.newRows) && r.newRows.some((x) => String(x.lesson_learned || '').includes('500-row')),
  },
  P10: {
    label: 'mem_timeline anchored on #5',
    higherIsBetter: true,
    hit: (r) => callsTo(r, 'mem_timeline').some((c) => [5, '5', '#5'].includes(c.input.anchor ?? c.input.id)),
  },
  P11: {
    label: 'an operator in a mem_search query',
    higherIsBetter: false,
    hit: (r) => callsTo(r, 'mem_search').some((c) => hasOperator(c.input.query)),
  },
  P12: {
    label: 'both migration rows reached',
    higherIsBetter: true,
    hit: (r) =>
      allResults(r).includes('Migration 042') && allResults(r).includes('Migrated the settings table'),
  },
};

/** Tool calls, their results and the final event of one stream-json transcript. */
export function parseStream(text) {
  const toolCalls = [];
  const toolResults = [];
  let init = null;
  let final = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init') init = ev;
    if (ev.type === 'assistant')
      for (const c of ev.message?.content || [])
        if (c.type === 'tool_use') toolCalls.push({ name: c.name, input: c.input });
    if (ev.type === 'user')
      for (const c of ev.message?.content || [])
        if (c.type === 'tool_result')
          toolResults.push(
            Array.isArray(c.content)
              ? c.content.map((x) => x.text || '').join('\n')
              : String(c.content ?? ''),
          );
    if (ev.type === 'result') final = ev;
  }
  return { toolCalls, toolResults, init, final };
}

/** Why a call cannot be scored, or null. */
export function invalidReason(rec) {
  if (rec.is_error !== false) return `is_error ${rec.is_error}`;
  if (!rec.models || !rec.models.includes(MODEL)) return `model ${JSON.stringify(rec.models)}`;
  if (!rec.initTools || rec.initTools.length === 0) return 'no init tool list';
  if (rec.initTools.some((t) => !t.startsWith('mcp__mem__'))) return 'built-in tools were available';
  if (rec.mcpStatus !== 'connected') return `mcp ${rec.mcpStatus}`;
  return null;
}

/** Hits per probe and arm over valid calls: `{ [probe]: { [arm]: { n, hits, invalid } } }`. */
export function score(records) {
  const out = {};
  for (const rec of records) {
    if (!METRICS[rec.probe] || !(rec.rep > 0)) continue;
    const cell = ((out[rec.probe] ??= {})[rec.arm] ??= { n: 0, hits: 0, invalid: 0 });
    if (invalidReason(rec)) {
      cell.invalid++;
      continue;
    }
    cell.n++;
    if (METRICS[rec.probe].hit(rec)) cell.hits++;
  }
  return out;
}

// ─── Run machinery ───────────────────────────────────────────────────────────

function flagValues(argv, name) {
  const vals = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) vals.push(argv[++i]);
  return vals;
}
const flag = (argv, name, dflt) => flagValues(argv, name).at(-1) ?? dflt;

const childEnv = (extra = {}) => {
  const env = { ...process.env };
  stripInheritedEnv(env);
  return { ...env, ...extra };
};

function serverEnv(dataDir, projectDir) {
  return {
    CLAUDE_MEM_DIR: dataDir,
    MEM_NO_AUTO_ADOPT: '1',
    MEM_QUIET_HOOKS: '1',
    CLAUDE_MEM_AUTO_DEEP: '0',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_CODE_PATH: '/nonexistent/claude',
    CLAUDE_PROJECT_DIR: projectDir,
  };
}

function buildTree(runDir, name, base, sha) {
  const dir = join(runDir, 'trees', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('bash', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', '_', REPO, base, dir]);
  if (sha) {
    const diff = execFileSync(
      'git',
      ['-C', REPO, 'diff', `${sha}^`, sha, '--', 'tool-schemas.mjs', 'server.mjs'],
      {
        encoding: 'utf8',
      },
    );
    if (!diff.trim()) throw new Error(`${name}: ${sha} has no tool-schemas.mjs/server.mjs diff`);
    execFileSync('patch', ['-p1', '--no-backup-if-mismatch', '-d', dir], { input: diff });
  }
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

function ancestorClaudeMd(dir) {
  for (let d = dir; ; d = dirname(d)) {
    for (const f of ['CLAUDE.md', join('.claude', 'CLAUDE.md')])
      if (existsSync(join(d, f))) return join(d, f);
    if (dirname(d) === d) return null;
  }
}

async function openDb(path, readonly) {
  const { default: Database } = await import('better-sqlite3');
  return new Database(path, { readonly });
}

async function setup(argv, runDir) {
  const base = flag(argv, 'base');
  const arms = flagValues(argv, 'arm').map((s) => s.split('='));
  if (!base || arms.length === 0) throw new Error('setup needs --base <sha> and at least one --arm B1=<sha>');
  rmSync(runDir, { recursive: true, force: true });
  const projectDir = join(runDir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const stray = ancestorClaudeMd(projectDir);
  if (stray) throw new Error(`${stray} would load into every session; pick another --run-dir`);
  const trees = { before: buildTree(runDir, 'before', base, null) };
  for (const [name, sha] of arms) trees[name] = buildTree(runDir, name, base, sha);
  const seed = join(runDir, 'seed');
  mkdirSync(seed, { recursive: true });
  const cli = (args) =>
    execFileSync(process.execPath, [join(trees.before, 'cli.mjs'), ...args], {
      cwd: projectDir,
      env: childEnv(serverEnv(seed, projectDir)),
      encoding: 'utf8',
    });
  // Content first: `--force "<text>"` reads the text as --force's value.
  for (const [type, title, lesson] of SEED_SAVES)
    cli([
      'save',
      `${title}. ${lesson}.`,
      '--type',
      type,
      '--importance',
      '2',
      '--title',
      title,
      '--lesson',
      lesson,
      '--force',
    ]);
  for (const [title, detail] of SEED_DEFERS) cli(['defer', 'add', '--title', title, '--detail', detail]);
  execFileSync(process.execPath, [join(trees.before, 'hook.mjs'), 'user-prompt'], {
    cwd: projectDir,
    input: JSON.stringify({ session_id: 'seed-session', cwd: projectDir, prompt: SEED_PROMPT }),
    env: childEnv(serverEnv(seed, projectDir)),
  });
  const db = await openDb(join(seed, 'claude-mem-lite.db'), false);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const obs = db.prepare('SELECT id, title FROM observations ORDER BY id').all();
  const prompts = db.prepare('SELECT id, prompt_text FROM user_prompts ORDER BY id').all();
  const deferred = db.prepare('SELECT id, title FROM deferred_work ORDER BY id').all();
  db.close();
  const expect = [
    [obs.length === SEED_SAVES.length && obs[1]?.title === SEED_SAVES[1][1], 'obs #1..#8 in order'],
    [prompts.length === 1 && prompts[0].id === 1, 'P#1 is the seed prompt'],
    [deferred[1]?.id === 2 && deferred[1]?.title === SEED_DEFERS[1][0], 'D#2 is the export item'],
  ];
  for (const [ok, what] of expect) if (!ok) throw new Error(`seed check failed: ${what}`);
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ base, arms: Object.fromEntries(arms), trees, projectDir, seedObs: obs.length }, null, 2),
  );
  console.log(
    `setup: ${Object.keys(trees).join(', ')}; seed ${obs.length} obs, ${prompts.length} prompt, ${deferred.length} deferred`,
  );
}

function runOne(runDir, st, { arm, probe, rep }) {
  const id = `${probe}-${arm}-${rep}`;
  const dir = join(runDir, 'runs', id);
  rmSync(dir, { recursive: true, force: true });
  const cfg = join(dir, 'cfg');
  const data = join(dir, 'data');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(data, { recursive: true });
  copyFileSync(join(runDir, 'seed', 'claude-mem-lite.db'), join(data, 'claude-mem-lite.db'));
  symlinkSync(join(homedir(), '.claude', '.credentials.json'), join(cfg, '.credentials.json'));
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__mem'] } }));
  const mcp = join(dir, 'mcp.json');
  writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        mem: {
          command: process.execPath,
          args: [join(st.trees[arm], 'server.mjs')],
          env: serverEnv(data, st.projectDir),
        },
      },
    }),
  );
  const args = [
    '-p',
    '--model',
    'sonnet',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
  ];
  args.push('--mcp-config', mcp, '--tools', '', '--allowedTools', 'mcp__mem');
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: st.projectDir,
      env: childEnv({ CLAUDE_CONFIG_DIR: cfg }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(PROBES[probe].prompt);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      writeFileSync(join(dir, 'stream.jsonl'), out);
      const { toolCalls, toolResults, init, final } = parseStream(out);
      let newRows;
      try {
        const db = await openDb(join(data, 'claude-mem-lite.db'), true);
        newRows = db
          .prepare('SELECT id, title, lesson_learned FROM observations WHERE id > ? ORDER BY id')
          .all(st.seedObs);
        db.close();
      } catch (e) {
        newRows = String(e.message);
      }
      const rec = {
        id,
        arm,
        probe,
        rep,
        change: PROBES[probe].change,
        ms: Date.now() - t0,
        code,
        signal,
        is_error: final?.is_error ?? null,
        models: final?.modelUsage ? Object.keys(final.modelUsage) : null,
        cost: final?.total_cost_usd ?? null,
        initTools: init?.tools ?? null,
        mcpStatus: init?.mcp_servers?.find((s) => s.name === 'mem')?.status ?? null,
        result: final?.result ?? null,
        toolCalls,
        toolResults,
        newRows,
        stderr: err.slice(-2000),
      };
      appendFileSync(join(runDir, 'results.jsonl'), JSON.stringify(rec) + '\n');
      resolve(rec);
    });
  });
}

async function run(argv, runDir) {
  const st = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const reps = Number(flag(argv, 'reps', '5'));
  const parallel = Number(flag(argv, 'parallel', '3'));
  const only = flag(argv, 'probes', null)?.split(',');
  const jobs = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const [probe, p] of Object.entries(PROBES)) {
      if ((only && !only.includes(probe)) || !st.trees[p.change]) continue;
      const order = (Number(probe.slice(1)) + rep) % 2 === 0 ? ['before', p.change] : [p.change, 'before'];
      for (const arm of order) jobs.push({ arm, probe, rep });
    }
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async (_, w) => {
      await new Promise((r) => setTimeout(r, w * 2000));
      while (next < jobs.length) {
        const rec = await runOne(runDir, st, jobs[next++]);
        const why = invalidReason(rec);
        console.log(
          `${rec.id} ${rec.ms}ms ${why ? `INVALID: ${why}` : rec.toolCalls.map((c) => shortName(c.name)).join('>')}`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    }),
  );
}

function printScore(runDir) {
  const records = readFileSync(join(runDir, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const table = score(records);
  let cost = 0;
  for (const r of records) cost += r.cost || 0;
  console.log('probe\tchange\tmetric\tbefore\tafter');
  for (const [probe, cells] of Object.entries(table)) {
    const change = PROBES[probe].change;
    const fmt = (c) => (c ? `${c.hits}/${c.n}${c.invalid ? ` (+${c.invalid} invalid)` : ''}` : '-');
    const better = METRICS[probe].higherIsBetter ? 'higher is better' : 'lower is better';
    console.log(
      `${probe}\t${change}\t${METRICS[probe].label} (${better})\t${fmt(cells.before)}\t${fmt(cells[change])}`,
    );
  }
  console.log(`calls ${records.length}, cost $${cost.toFixed(2)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const runDir = flag(argv, 'run-dir', join('/run/user', String(userInfo().uid), 'tool-text-ab'));
  if (cmd === 'setup') await setup(argv, runDir);
  else if (cmd === 'run') await run(argv, runDir);
  else if (cmd === 'score') printScore(runDir);
  else {
    console.error('usage: tool-text-ab.mjs setup|run|score [--run-dir d] (see the header)');
    process.exit(2);
  }
}
