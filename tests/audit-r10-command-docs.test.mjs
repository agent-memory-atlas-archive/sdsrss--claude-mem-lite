// R10 P2-4 — commands/*.md are read by the MODEL, so a wrong instruction there is a wrong
// behaviour, not a typo. Both files told the agent to purge with no confirmation. That call
// does not purge: an unconfirmed purge_stale is a dry-run PREVIEW that returns normally. So
// the documented flow asks the user for permission, gets it, runs a call that deletes nothing,
// and reports success — the worst of the three possible outcomes, because the user now believes
// the cleanup happened.
//
// The `/mem cleanup Nd` mapping had a second problem: it advertised an arbitrary N while
// the retain days are floored at 7, so `/mem cleanup 3d` is rejected.
//
// Both commands now purge through the CLI (`maintain execute --ops purge_stale`), because
// mem_maintain is hidden from tools/list and the model cannot call it
// (tests/audit-prompts-20261019.test.mjs). So this guard reads the CLI: its confirm flag is
// `--confirm`, and the range is whatever `--retain-days` accepts when probed — not restated
// here, since a guard that hardcodes 7 and 365 goes stale the same way the docs did.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

let testDb;

// Stub EVERY opener mem-cli reaches, not just one: an unstubbed opener silently escapes to
// the REAL store (tests/audit-fixes.test.mjs records a run that purged a live DB that way).
vi.mock('../schema.mjs', async (importOriginal) => {
  const original = await importOriginal();
  const stub = () => new Proxy(testDb, { get: (t, p) => (p === 'close' ? () => {} : t[p]) });
  return { ...original, ensureDb: stub, ensureDbWithWalRecovery: stub };
});

const { run } = await import('../mem-cli.mjs');

/** Runs one CLI command in-process; returns what it printed and whether it failed. */
async function cli(argv) {
  let output = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = process.stderr.write = (s) => {
    output += s;
    return true;
  };
  process.exitCode = undefined;
  try {
    await run(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const failed = Boolean(process.exitCode);
  process.exitCode = undefined;
  return { output, failed };
}

/** The --retain-days bounds, read out of the CLI by probing it. */
async function retainDaysBounds() {
  let min = null;
  let max = null;
  for (let n = 1; n <= 400; n++) {
    const { output, failed } = await cli([
      'maintain',
      'execute',
      '--ops',
      'purge_stale',
      '--retain-days',
      `${n}`,
    ]);
    const previewed = output.includes('purge_stale preview (no --confirm)');
    // Each probe has to land on exactly one side, or it is reading something else.
    expect(previewed !== failed, `--retain-days ${n} neither previewed nor failed: ${output}`).toBe(true);
    if (previewed) {
      if (min === null) min = n;
      max = n;
    }
  }
  return { min, max };
}

/** Inline code spans: the commands the model copies, as opposed to the prose around them. */
const codeSpans = (src) => src.split('\n').flatMap((line) => line.split('`').filter((_, i) => i % 2 === 1));

describe('R10 P2-4 — the purge instruction the model reads actually purges', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it('premise: without --confirm the CLI purge is a preview that deletes nothing, and --confirm deletes', async () => {
    insertSession(testDb, { id: 'r10-sess', memoryId: 'r10-mem' });
    insertObs(testDb, {
      sessionId: 'r10-mem',
      title: 'R10 PURGEABLE',
      importance: 1,
      epochOffset: -60 * 86_400_000,
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const count = () =>
      testDb.prepare("SELECT COUNT(*) c FROM observations WHERE title = 'R10 PURGEABLE'").get().c;

    // It SUCCEEDS — which is exactly why docs that drop the flag could be wrong with nothing failing.
    const preview = await cli(['maintain', 'execute', '--ops', 'purge_stale']);
    expect(preview.failed).toBe(false);
    expect(preview.output).toMatch(/Candidates \(pending-purge, older than 30d\): 1/);
    expect(count()).toBe(1);

    const confirmed = await cli(['maintain', 'execute', '--ops', 'purge_stale', '--confirm']);
    expect(confirmed.output).toMatch(/Purged 1 stale observations/);
    expect(count()).toBe(0);
  });

  for (const rel of ['commands/mem.md', 'commands/update.md']) {
    it(`${rel} pairs every purge_stale command with --confirm`, () => {
      const spans = codeSpans(read(rel)).filter((s) => s.includes('purge_stale'));
      expect(spans.length, `${rel} no longer gives a purge_stale command at all`).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span, `${rel}: purge_stale command without --confirm → silent no-op`).toMatch(
          /(^|\s)--confirm(\s|$)/,
        );
      }
    });
  }

  it('commands/mem.md and commands/update.md state the --retain-days range the CLI actually enforces', async () => {
    const { min, max } = await retainDaysBounds();
    expect(min).toBe(7);
    expect(max).toBe(365);
    for (const rel of ['commands/mem.md', 'commands/update.md']) {
      expect(
        read(rel),
        `${rel}: the --retain-days bounds are not written down where the model reads them`,
      ).toMatch(new RegExp(`--retain-days[^\\n]*${min}[^\\n]*${max}`));
    }
  });
});
