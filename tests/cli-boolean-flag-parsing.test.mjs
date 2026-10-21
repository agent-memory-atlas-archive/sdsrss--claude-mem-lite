// D#385: a flag that takes no value swallowed the word after it.
//
// parseArgs read every `--key next` as a key with a value, so `save --type bugfix --title X
// --force 'text'` parsed `force: 'text'` and no content: the usage error, while the same call
// with the text first saved. The swallowed word did not even turn the flag on (every reader
// compares against true / 'true'), so `search --or redis` lost both its query and --or, and
// `recent --json 5` printed text for the default count. Same in v6.27.0.
//
// The population is DERIVED from the readers, not listed: every flag the CLI compares against
// `true` (or tests with isTrue / args.includes / hasFlag) takes no value, so a boolean flag a
// command adds later is held to the same rule without anyone remembering this file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { parseArgs, BOOLEAN_CLI_FLAGS } from '../cli/common.mjs';
import { initSchema } from '../schema.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'cli.mjs');

/** Source with comment lines dropped: comments quote reads (`args.includes('--x')`). */
function codeOf(rel) {
  return readFileSync(join(REPO, rel), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/**
 * Every flag some CLI reader treats as on/off. `!== true` is not a marker: a value flag guards
 * its bare form that way (`flags.anchor !== true`), so `--apply`, whose only reader is
 * `flags.apply !== true` ("boolean means boolean", cli/verify-apply.mjs), is added by name.
 */
function booleanReads() {
  const files = [
    'mem-cli.mjs',
    'adopt-cli.mjs',
    ...readdirSync(join(REPO, 'cli'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => `cli/${f}`),
  ];
  const key = String.raw`flags(?:\.([a-z][a-zA-Z0-9]*)|\['([a-z][a-z0-9-]*)'\])`;
  const found = new Set(['apply']);
  for (const f of files) {
    const src = codeOf(f);
    for (const m of src.matchAll(new RegExp(`${key}\\s*===\\s*(?:true\\b|'true')`, 'g')))
      found.add(m[1] ?? m[2]);
    for (const m of src.matchAll(new RegExp(`isTrue\\(${key}\\)`, 'g'))) found.add(m[1] ?? m[2]);
    for (const m of src.matchAll(/(?:\.includes\(|hasFlag\(args,\s*)'--([a-z][a-z0-9-]*)'\)/g))
      found.add(m[1]);
  }
  return found;
}

const READ_AS_BOOLEAN = [...booleanReads()].sort();

describe('parseArgs: a flag that takes no value leaves the next word positional (D#385)', () => {
  it('the scan finds the boolean readers (premise)', () => {
    for (const f of [
      'force',
      'or',
      'confirm',
      'json',
      'deep',
      'execute',
      'run',
      'all',
      'verbose',
      'status',
    ]) {
      expect(READ_AS_BOOLEAN, f).toContain(f);
    }
    expect(READ_AS_BOOLEAN.length).toBeGreaterThan(20);
  });

  it.each(READ_AS_BOOLEAN)('--%s does not consume the word after it', (f) => {
    const { flags, positional } = parseArgs([`--${f}`, 'word'], { track: false });
    expect(flags[f]).toBe(true);
    expect(positional).toEqual(['word']);
  });

  it.each(READ_AS_BOOLEAN)('--%s still takes an explicit true / false', (f) => {
    expect(parseArgs([`--${f}`, 'true'], { track: false })).toEqual({
      positional: [],
      flags: { [f]: 'true' },
    });
    expect(parseArgs([`--${f}`, 'false'], { track: false })).toEqual({
      positional: [],
      flags: { [f]: 'false' },
    });
  });

  it('every flag listed as taking no value is read as a boolean somewhere', () => {
    expect([...BOOLEAN_CLI_FLAGS].filter((f) => !READ_AS_BOOLEAN.includes(f))).toEqual([]);
  });

  it('the reported call: flags first, text last', () => {
    const { flags, positional } = parseArgs(['--type', 'bugfix', '--title', 'X', '--force', 'text'], {
      track: false,
    });
    expect(flags).toEqual({ type: 'bugfix', title: 'X', force: true });
    expect(positional).toEqual(['text']);
  });

  it('control: a flag that takes a value still takes the next word', () => {
    expect(parseArgs(['--title', 'X', '--limit', '5'], { track: false }).flags).toEqual({
      title: 'X',
      limit: '5',
    });
  });
});

describe('the CLI with a boolean flag before its positional (D#385)', () => {
  let root, dataDir, projectDir;
  const run = (...args) => {
    const env = {
      ...process.env,
      HOME: join(root, 'home'),
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      cwd: projectDir,
      env,
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mem-bool-flags-'));
    dataDir = join(root, 'data');
    projectDir = join(root, 'work', 'invoice-app');
    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(join(dataDir, 'claude-mem-lite.db'));
    initSchema(db);
    db.close();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('save --type bugfix --title X --force "text" saves "text"', () => {
    const r = run(
      'save',
      '--type',
      'bugfix',
      '--title',
      'X',
      '--force',
      'pool leak fixed by closing the client',
    );
    expect(r.stderr).not.toMatch(/Usage/);
    expect(r.stdout).toMatch(/Saved #1/);
    expect(r.status).toBe(0);
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const row = db.prepare('SELECT title, narrative FROM observations').get();
    db.close();
    expect(row).toEqual({ title: 'X', narrative: 'pool leak fixed by closing the client' });
  });

  it('search --or <query> searches the query, with --or', () => {
    expect(run('save', 'redis pool leak', '--title', 'redis pool').status).toBe(0);
    const r = run('search', '--or', 'redis', 'kafka');
    expect(r.stderr).not.toMatch(/Usage/);
    expect(r.stdout).toMatch(/redis pool/);
    expect(r.status).toBe(0);
  });

  // A flag that takes no value has no value to misread, so an unknown flag after it is refused
  // like any other the writer does not take, not passed as "maybe --force's value".
  it('save "text" --force --draft refuses --draft and saves nothing', () => {
    const r = run('save', 'pool leak fixed by closing the client', '--force', '--draft');
    expect(r.stderr).not.toMatch(/right after --force/);
    expect(r.stderr).toMatch(/--draft/);
    expect(r.status).toBe(1);
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    db.close();
    expect(n).toBe(0);
  });

  // Pre-tag review 2026-10-17 P2-1: once --dry-run stopped swallowing the next word,
  // `maintain --dry-run execute` (a usage error before) ran the hard delete, and
  // `import-jsonl --dry-run <file>` imported. A writer that does not read --dry-run refuses it,
  // in either position, before it writes.
  const rows = () => {
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    db.close();
    return n;
  };
  it.each([
    [['maintain', '--dry-run', 'execute']],
    [['maintain', 'execute', '--dry-run']],
    [['compress', '--dry-run', '--execute']],
  ])('%j refuses --dry-run and changes nothing', (args) => {
    expect(run('save', 'redis pool leak', '--title', 'redis pool').status).toBe(0);
    const before = rows();
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--dry-run/);
    expect(rows()).toBe(before);
  });

  // Round-2 pre-tag review P3-2: other spellings of a yes still ran the write, and three more writers
  // ignored --dry-run silently.
  it.each([
    [['maintain', 'execute', '--dry-run=1']],
    [['maintain', 'execute', '--dry-run=yes']],
    [['maintain', 'execute', '--dry-run=TRUE']],
    [['fts-check', 'rebuild', '--dry-run']],
  ])('%j refuses --dry-run', (args) => {
    expect(run('save', 'redis pool leak', '--title', 'redis pool').status).toBe(0);
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not read --dry-run/);
  });

  // v6.30.1 pre-tag defects review: the preview was printed as `Preview with: <cli> maintain scan.`,
  // so a copied command ended in the sentence's period, and three previews were prose
  // (`compress without --execute`) after the CLI's path.
  it.each([[['fts-check', 'rebuild', '--dry-run'], 'fts-check check']])(
    '%j names a preview command that runs as printed',
    (args, preview) => {
      expect(run('save', 'redis pool leak', '--title', 'redis pool').status).toBe(0);
      const r = run(...args);
      expect(r.stderr).toContain(`Preview with: \`${CLI_INVOKE} ${preview}\`.`);
    },
  );
  // A writer that writes under a flag previews as the same command without it, so the user's other
  // flags (`--project`) stay; a bare `activity promote` previewed every project (v6.30.1 r2 P3-3).
  // delete and activity delete preview without --confirm; they were told they had no preview
  // (D#514 F1).
  it.each([
    [['compress', '--dry-run', '--execute'], '--execute'],
    [['activity', 'promote', '--execute', '--project', 'x', '--dry-run'], '--execute'],
    [['delete', '1', '--confirm', '--dry-run'], '--confirm'],
    [['activity', 'delete', '1', '--confirm', '--dry-run'], '--confirm'],
  ])('%j says to drop the writing flag', (args, flag) => {
    const r = run(...args);
    expect(r.stderr).toContain(`Run it again without ${flag} to preview.`);
  });
  // `maintain scan` previewed every project for `maintain execute --project x` (D#514 F3).
  it('maintain execute --project x --dry-run says to run scan with the same flags', () => {
    const r = run('maintain', 'execute', '--project', 'x', '--dry-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Run it again with scan in place of execute to preview.');
  });

  // D#514 F4: cmdOptimize split `--run=false` into `--run false` and then looked for `--run`, so
  // the run started, after the dry-run check above had read the same flag as no write.
  const optimize = (...args) => {
    const env = {
      ...process.env,
      HOME: join(root, 'home'),
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_CODE_PATH: join(root, 'no-claude'),
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    return spawnSync(process.execPath, [CLI, 'optimize', ...args], {
      encoding: 'utf8',
      timeout: 20000,
      cwd: projectDir,
      env,
    });
  };
  it.each([[['--run=false']], [['--run-all=false']], [['--run=false', '--dry-run']], [['--run=0']]])(
    'optimize %j previews and does not run',
    (args) => {
      const r = optimize(...args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('LLM Optimization Preview');
      expect(r.stdout).not.toContain('Running LLM optimization');
    },
  );
  it.each([[['--run']], [['--run=true']]])('control: optimize %j runs', (args) => {
    const r = optimize(...args);
    expect(r.stdout).toContain('Running LLM optimization');
  });

  it('defer drop --dry-run refuses and leaves the item open', () => {
    expect(run('defer', 'add', '--title', 'keep me').status).toBe(0);
    const r = run('defer', 'drop', '1', '--dry-run', '--reason', 'x');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not read --dry-run/);
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const status = db.prepare('SELECT status FROM deferred_work WHERE id = 1').get().status;
    db.close();
    expect(status).toBe('open');
  });

  it('--dry-run false still runs the write, as it always parsed', () => {
    expect(run('save', 'redis pool leak', '--title', 'redis pool').status).toBe(0);
    expect(run('maintain', 'execute', '--dry-run=false').status).toBe(0);
  });

  it('restore takes --dry-run=1 as a dry run', () => {
    const file = join(root, 'export.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'discovery',
        title: 'restored row',
        narrative: 'x',
        created_at_epoch: 1760000000000,
      }) + '\n',
    );
    const r = run('restore', file, '--dry-run=1');
    expect(r.status).toBe(0);
    expect(rows()).toBe(0);
  });

  it('import-jsonl --dry-run <file> refuses --dry-run and imports nothing', () => {
    const file = join(root, 't.jsonl');
    writeFileSync(
      file,
      [
        '{"type":"assistant","sessionId":"imp-1","timestamp":"2026-10-16T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/p/total.mjs"}}]}}',
        '{"type":"user","sessionId":"imp-1","timestamp":"2026-10-16T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"rounding happens per line"}]}}',
      ].join('\n') + '\n',
    );
    const r = run('import-jsonl', '--dry-run', file);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--dry-run/);
    expect(rows()).toBe(0);
  });

  it('restore still reads --dry-run', () => {
    const file = join(root, 'export.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'discovery',
        title: 'restored row',
        narrative: 'x',
        created_at_epoch: 1760000000000,
      }) + '\n',
    );
    const r = run('restore', '--dry-run', file);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/dry-run/);
    expect(rows()).toBe(0);
  });

  it('recent --json 5 prints JSON', () => {
    expect(run('save', 'redis pool leak', '--title', 'redis pool').status).toBe(0);
    const r = run('recent', '--json', '5');
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});
