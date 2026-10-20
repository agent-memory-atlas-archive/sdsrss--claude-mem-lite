// Re-running `adopt` on an adopted project printed "→ unchanged" and still rewrote
// .claude/.plugin_claude_mem_lite_state.json with a fresh writtenAt — a file adopt describes
// as safe to commit for the team, so every re-run left a diff (E2E 2026-10-16, install P2-11).
// Nothing reads writtenAt; the sidecar is now written only when what it records changed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { writeManaged } from '../claudemd.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-adopt-rerun-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STATE = () => join(dir, '.claude', '.plugin_claude_mem_lite_state.json');
const args = (block = 'block v1', doc = 'doc v1') => ({ slug: 'claude-mem-lite', version: 'v1', block, doc });

describe('writeManaged leaves an unchanged state sidecar byte-identical', () => {
  it('a second identical write does not touch the sidecar', async () => {
    writeManaged(dir, args());
    const before = readFileSync(STATE(), 'utf8');
    await new Promise((r) => setTimeout(r, 5)); // a fresh timestamp would differ
    expect(writeManaged(dir, args()).action).toBe('unchanged');
    expect(readFileSync(STATE(), 'utf8')).toBe(before);
  });

  it('a changed block still updates it', () => {
    writeManaged(dir, args());
    const before = readFileSync(STATE(), 'utf8');
    writeManaged(dir, args('block v2'));
    expect(readFileSync(STATE(), 'utf8')).not.toBe(before);
  });

  it('a sidecar that is not valid JSON is rewritten', () => {
    writeManaged(dir, args());
    writeFileSync(STATE(), '{ torn');
    writeManaged(dir, args());
    expect(() => JSON.parse(readFileSync(STATE(), 'utf8'))).not.toThrow();
  });
});

// Triage 2026-10-20 (D#470): writeManaged reported the block alone, so an `adopt` that rewrote a
// stale detail doc printed "→ unchanged".
describe('adopt reports a detail doc it rewrote', () => {
  it('writeManaged says what it did to the doc', () => {
    expect(writeManaged(dir, args()).docAction).toBe('created');
    expect(writeManaged(dir, args()).docAction).toBe('unchanged');
    const r = writeManaged(dir, args('block v1', 'doc v2'));
    expect(r.action).toBe('unchanged');
    expect(r.docAction).toBe('updated');
  });

  it('the adopt line names the doc refresh', () => {
    const home = mkdtempSync(join(tmpdir(), 'mem-adopt-rerun-home-'));
    try {
      const env = { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(home, 'data'), MEM_NO_AUTO_ADOPT: '1' };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CLAUDE_PROJECT_DIR;
      const adopt = () =>
        execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'adopt'], { cwd: dir, env, encoding: 'utf8' });
      adopt();
      expect(adopt(), 'premise: a re-run with nothing to do').toMatch(/→ unchanged$/m);
      const doc = join(dir, '.claude', 'plugin_claude_mem_lite.md');
      writeFileSync(doc, readFileSync(doc, 'utf8') + '\nstale line\n');
      expect(adopt()).toMatch(/→ unchanged \(\+refreshed detail doc\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
