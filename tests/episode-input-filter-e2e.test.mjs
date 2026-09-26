// D#69 wiring: the input filters are only real if hook.mjs calls them. These cases drive
// the shipped entry point as a subprocess (PostToolUse → Stop) in a sandboxed data dir,
// each with a control arm through the off switch, so a green here cannot come from the
// fixture never reaching the code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'hook.mjs');
let ROOT, DATA_DIR, RUNTIME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-d69-'));
  DATA_DIR = join(ROOT, 'data');
  RUNTIME_DIR = join(DATA_DIR, 'runtime');
  mkdirSync(join(ROOT, 'home', '.claude'), { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  BASE_ENV = { ...process.env };
  // The developer's own plugin flags must not reach the child (the #8608 leak class).
  for (const k of Object.keys(BASE_ENV)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
  Object.assign(BASE_ENV, {
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: DATA_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
  });
});

afterAll(async () => {
  // Stop spawns a detached summary worker; let it exit before the sandbox goes.
  await new Promise((r) => setTimeout(r, 500));
  rmSync(ROOT, { recursive: true, force: true });
});

function hook(event, { cwd, stdin, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, event], {
      cwd,
      env: { ...BASE_ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${event} did not exit`));
    }, 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(stdin));
  });
}

function workDir(name) {
  const d = join(ROOT, 'work', name);
  mkdirSync(d, { recursive: true });
  return { cwd: d, project: `work--${name}` };
}
const bufferOf = (project) => join(RUNTIME_DIR, `ep-${project}.json`);
function metricRows(event) {
  const dir = join(DATA_DIR, 'metrics');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === event);
}

async function post(cwd, stdin, env) {
  const r = await hook('post-tool-use', { cwd, stdin: { session_id: 'cc-d69', ...stdin }, env });
  expect(r.code, r.stderr).toBe(0);
}
async function stop(cwd, env) {
  const r = await hook('stop', {
    cwd,
    stdin: { session_id: 'cc-d69', transcript_path: join(ROOT, 'none.jsonl') },
    env,
  });
  expect(r.code, r.stderr).toBe(0);
}
function narratives(project) {
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT narrative FROM observations WHERE project = ?')
      .all(project)
      .map((r) => r.narrative);
  } finally {
    db.close();
  }
}

// `schema.sql`, not any .sql: a plain "Modified widgets.sql" title is dropped by the
// write-side noise gate, and then neither arm lands a row to read.
const schemaWrite = (cwd) => ({
  tool_name: 'Write',
  tool_input: { file_path: join(cwd, 'schema.sql'), content: 'CREATE TABLE widgets (id INTEGER);\n' },
  tool_response: `File created successfully at: ${join(cwd, 'schema.sql')}`,
});

describe('D#69 capture: subagent calls stay out of the episode buffer', () => {
  it('a call carrying agent_id buffers nothing; the same call without it does', async () => {
    const { cwd, project } = workDir('sub');
    await post(cwd, { ...schemaWrite(cwd), agent_id: 'adefect-lens-1' });
    expect(existsSync(bufferOf(project)), 'a subagent call reached the episode buffer').toBe(false);
    await post(cwd, schemaWrite(cwd)); // control: the main thread's identical call
    expect(existsSync(bufferOf(project)), 'control: a main-thread call must buffer').toBe(true);
  });

  it('CLAUDE_MEM_EPISODE_INPUT_FILTER=off buffers the subagent call again', async () => {
    const { cwd, project } = workDir('sub-off');
    await post(
      cwd,
      { ...schemaWrite(cwd), agent_id: 'adefect-lens-1' },
      { CLAUDE_MEM_EPISODE_INPUT_FILTER: 'off' },
    );
    expect(existsSync(bufferOf(project))).toBe(true);
  });

  it('captures tags and diagnosis lines onto the buffered entry', async () => {
    const { cwd, project } = workDir('diag');
    await post(cwd, {
      tool_name: 'Bash',
      tool_input: { command: "python3 - <<'PY'\nassert a in s, 'anchor not found'\nPY\necho done" },
      tool_response:
        'Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\nAssertionError: anchor not found\ndone',
    });
    const [e] = JSON.parse(readFileSync(bufferOf(project), 'utf8')).entries;
    expect(e.inputTags).toContain('slip');
    expect(e.diag).toContain('AssertionError: anchor not found');
  });
});

describe('D#69 capture: a Bash patch contributes its comment block as diagnosis', () => {
  it('reads the heredoc comment only because the hook resolved the command as a WRITE', async () => {
    const { cwd, project } = workDir('bash-patch');
    await post(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: {
        command:
          "python3 - <<'PY'\np='lib/a.mjs'; s=open(p).read()\ns=s.replace('x', '''// A LIMIT upstream of a JS filter is a reachability bound:\n// the demoted row was evicted, not ranked lower.\nx''')\nopen(p,'w').write(s)\nPY",
      },
      tool_response: 'patched lib/a.mjs',
    });
    const [e] = JSON.parse(readFileSync(bufferOf(project), 'utf8')).entries;
    expect(e.bashWrites, 'premise: the hook must see this command as a write').toEqual([
      join(cwd, 'lib/a.mjs'),
    ]);
    expect(e.diag).toEqual([
      'A LIMIT upstream of a JS filter is a reachability bound: the demoted row was evicted, not ranked lower.',
    ]);
  });
});

describe('D#69 flush: a probe never reaches the saved observation', () => {
  const PROBE = {
    tool_name: 'Bash',
    tool_input: {
      command:
        'cp lib/x.mjs "$BAK"\nperl -0pi -e "s/a/b/" lib/x.mjs\necho "=== mutation landed? ==="; grep -c b lib/x.mjs',
    },
    tool_response: '=== mutation landed? ===\n1\nPROBEMARK',
  };
  const RED = {
    tool_name: 'Bash',
    tool_input: { command: 'npx vitest run tests/x.test.mjs' },
    tool_response:
      ' FAIL tests/x.test.mjs > guard\nAssertionError: expected 1 to be 0\nREDMARK\n Tests 1 failed (1)',
  };

  async function run(name, env, calls) {
    const { cwd, project } = workDir(name);
    await post(cwd, schemaWrite(cwd), env);
    for (const c of calls) await post(cwd, c, env);
    await stop(cwd, env);
    return narratives(project);
  }

  it('the probe call is gone from the immediate observation, and the flush meters it', async () => {
    const metrics = { CLAUDE_MEM_METRICS: '1' };
    const on = await run('probe', metrics, [PROBE]);
    expect(on, 'premise: the schema write must land a row').toHaveLength(1);
    expect(on[0]).not.toMatch(/mutation landed/);
    expect(metricRows('episode_input_filter')).toContainEqual(expect.objectContaining({ probe: 1, slip: 0 }));
    // Control: with the filter off the same flush runs (its significance row is written)
    // and no filter row appears. The row itself cannot be the control here — unfiltered,
    // "Modified schema.sql" plus a Bash call is dropped by the write-side noise gate.
    const before = metricRows('episode_input_filter').length;
    const sigBefore = metricRows('episode_significance').length;
    await run('probe-off', { ...metrics, CLAUDE_MEM_EPISODE_INPUT_FILTER: 'off' }, [PROBE]);
    expect(metricRows('episode_significance').length).toBeGreaterThan(sigBefore);
    expect(metricRows('episode_input_filter')).toHaveLength(before);
  });

  it('the span takes the probe\'s RED run too — which, unfiltered, turns the row into a dropped "Error:" title', async () => {
    const on = await run('span', {}, [PROBE, RED]);
    expect(on).toHaveLength(1);
    expect(on[0]).not.toMatch(/mutation landed|vitest run/);
    // Pre-D#69 the intentional RED run named the whole window: the immediate title became
    // "Error: schema.sql: FAIL …", which the write-side noise gate drops — the schema
    // write went unrecorded because a probe went red on purpose.
    const off = await run('span-off', { CLAUDE_MEM_EPISODE_INPUT_FILTER: 'off' }, [PROBE, RED]);
    expect(off).toHaveLength(0);
  });
});
