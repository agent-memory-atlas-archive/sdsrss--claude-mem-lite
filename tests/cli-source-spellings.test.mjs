// `search --source` took observations|sessions|prompts|events and `get --source` took
// obs|session|prompt|event, each refusing the other's spelling of the same four record kinds
// (E2E 2026-10-16, cli F11). Both commands now accept both.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
let root, env;

const cli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: join(root, 'w', 'p') });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-source-spell-'));
  mkdirSync(join(root, 'w', 'p'), { recursive: true });
  env = {
    ...process.env,
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_PROJECT_DIR: join(root, 'w', 'p'),
    MEM_NO_AUTO_ADOPT: '1',
    // No LLM provider: save's enrichment and deep search must not reach a real one.
    CLAUDE_CODE_PATH: join(root, 'no-claude'),
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENROUTER_API_KEY;
  expect(
    cli('save', 'Redis pool exhaustion fixed by per-worker pool sizing', '--type', 'bugfix').status,
  ).toBe(0);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('--source accepts both spellings', () => {
  it('search --source obs', () => {
    const r = cli('search', 'redis', '--source', 'obs');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Redis pool exhaustion');
  });
  it('get --source observations', () => {
    const r = cli('get', '1', '--source', 'observations');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Redis pool exhaustion');
  });
  it('a real typo is still refused', () => {
    expect(cli('search', 'redis', '--source', 'obsrv').status).not.toBe(0);
    expect(cli('get', '1', '--source', 'obsrv').status).not.toBe(0);
  });
  // Round 2 (data nit): each refusal still listed one spelling, though both are taken.
  it('the refusal lists both spellings', () => {
    expect(cli('search', 'redis', '--source', 'obsrv').stderr).toMatch(/obs.*observations|observations.*obs/);
    expect(cli('get', '1', '--source', 'obsrv').stderr).toMatch(/obs.*observations|observations.*obs/);
  });
  // Round 2 (data nit): `activity promote --min-importance 2x` was read as 2 (bare parseInt).
  it('activity promote refuses a malformed --min-importance', () => {
    expect(cli('activity', 'promote', '--min-importance', '2x').status).toBe(1);
  });
});

// E2E 2026-10-16 (cli F17): `timeline 1` sent "1" to the query search and answered "No anchor
// found for \"1\"" with #1 right there. A lone positional naming a record is the anchor.
describe('timeline takes a lone id positional as the anchor', () => {
  it('timeline 1 centres on #1', () => {
    const r = cli('timeline', '1', '--json');
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).anchor?.id).toBe(1);
    expect(r.stderr).not.toMatch(/No anchor found/);
  });
  it('a positional that names no record is still a query', () => {
    const r = cli('timeline', 'redis');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Redis pool exhaustion');
  });
});

// Round 2 (data R1): the lone-id anchor looked the id up in every project, so `timeline 1
// --project app-b` centred on another project's #1 and showed app-b rows around it, where it
// used to search app-b for "1". An id outside --project is not the anchor; it stays a query.
describe('a lone id positional outside --project stays a query', () => {
  it('timeline 1 --project app-b centres on an app-b row', () => {
    expect(
      cli('save', 'Beta retries 1 time on HTTP 503 from payments', '--project', 'app-b', '--force').status,
    ).toBe(0);
    const r = cli('timeline', '1', '--project', 'app-b', '--json');
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.anchor?.title).toMatch(/Beta retries/);
    expect(out.anchor?.id).not.toBe(1);
    // Round 3 (data nit): read as a search without a word; it now says so.
    expect(r.stderr).toMatch(/is in another project/);
  });

  // Round 3 (data SB-2): --anchor N --project P centred P's window on another project's #N.
  it('--anchor 1 --project app-b shows app-b around #1, never #1 itself', () => {
    const r = cli('timeline', '--anchor', '1', '--project', 'app-b', '--json');
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.anchor?.id).not.toBe(1);
    expect(out.anchor_note ?? out.anchorNote ?? '').toMatch(/app-b/);
  });
});

// Round 2 (data N4): `get E#N --fields body` checked the names against the observation fields
// and failed "No valid fields specified", though Body is what the event prints.
describe('get --fields on events', () => {
  it('get E#N --fields body prints the event and notes --fields is for observations', () => {
    expect(cli('activity', 'save', '--type', 'bug', 'Cron overlap', '--body', 'use flock').status).toBe(0);
    const r = cli('get', 'E#1', '--fields', 'body');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Cron overlap');
    expect(r.stderr).toMatch(/--fields .*observation/);
  });
  // Round 3 (data nit): a mixed request printed the event in full without a word.
  it('get 1,E#1 --fields title notes that the event prints in full', () => {
    const r = cli('get', '1,E#1', '--fields', 'title');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/--fields .*observation/);
  });
});

// Round 2 (data S7): a flag VALUE that starts with `--` parses as a flag of its own, and the
// refusal gave no way out; only the `=` form works.
describe('a value that starts with --', () => {
  it('the bare-flag refusal names the --flag="…" form', () => {
    const r = cli('update', '1', '--lesson', '--no-verify skips hooks');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--lesson="/);
  });
  it('the = form works', () => {
    const r = cli('update', '1', '--lesson=--no-verify skips hooks');
    expect(r.status, r.stderr).toBe(0);
  });
});

// Round 3 (data SB-3): 41f00b7a fixed the zero-width title on save only; update, defer add and
// activity save still stored one, and U+00AD (soft hyphen) was not in the stripped set.
describe('an invisible title is refused or replaced on every writer', () => {
  const ZW = '\u200b';
  it('update --title <zero width> is refused', () => {
    const r = cli('update', '1', '--title', ZW);
    expect(r.status).toBe(1);
  });
  it('defer add <zero width> is refused', () => {
    expect(cli('defer', 'add', ZW).status).toBe(1);
  });
  it('activity save --title <zero width> is refused', () => {
    expect(cli('activity', 'save', '--title', ZW, '--body', 'zw body').status).toBe(1);
  });
  it('save --title <soft hyphen> takes the title from the content', () => {
    const r = cli('save', 'Soft hyphen probe body about lighthouses', '--title', '\u00ad', '--force');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Soft hyphen probe body/);
  });
});

// Round 3 (data nits): three CLI messages that said the wrong thing.
describe('round-3 CLI wording', () => {
  it('a value starting with -- gets the hint, not "Unknown flag … ignored"', () => {
    const r = cli('update', '1', '--lesson', '--no-verify skips hooks');
    expect(r.stderr).not.toMatch(/Unknown flag/);
    expect(r.stderr).toMatch(/--lesson="/);
  });
  it('text starting with -- points at the bare -- form', () => {
    const r = cli('save', '--no-verify skips the pre-commit hooks');
    expect(r.stderr).not.toMatch(/Unknown flag/);
    expect(r.stderr).toMatch(/save -- "/);
  });
  it('the activity promote refusal names --min-importance', () => {
    const r = cli('activity', 'promote', '--execute', '--importance', '2');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--min-importance/);
  });
  it('deep search on an operator-only query says it has no searchable terms', () => {
    const r = cli('search', '***', '--deep');
    expect(r.stdout + r.stderr).toMatch(/no searchable terms/);
  });
});

// E2E 2026-10-16 (cli F16): `--` parsed as an empty-named flag, so text starting with `--` could
// not be saved positionally.
describe('a bare -- ends the options', () => {
  it('save -- "--dry-run …" saves the text', () => {
    const r = cli('save', '--force', '--', '--dry-run is ignored by deploy.sh');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Saved #\d+/);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    expect(cli('search', 'deploy.sh').stdout).toContain('--dry-run is ignored by deploy.sh');
  });
});
