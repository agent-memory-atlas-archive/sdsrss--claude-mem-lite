// The GitHub Release body is this version's CHANGELOG entry (publish.yml), and the release check
// fails a tag without one; that check runs only after the tag is pushed, so a release commit
// without its entry would strand the tag. This file makes the same check on every commit, with
// the same extraction (scripts/changelog-entry.awk), and pins the extraction's edges: a `## ` line
// inside a fenced code block is text (pre-tag review 2026-10-17 P3-3).

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const AWK = join(REPO, 'scripts', 'changelog-entry.awk');
const entry = (tag, file) => execFileSync('awk', ['-v', `t=${tag}`, '-f', AWK, file], { encoding: 'utf8' });

describe('CHANGELOG entry for the release', () => {
  it("has an entry for package.json's version", () => {
    const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(entry(`v${version}`, join(REPO, 'CHANGELOG.md'))).toMatch(/\S/);
  });

  it('publish.yml extracts it with the same awk program, in both places', () => {
    const yml = readFileSync(join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8');
    const uses =
      yml.match(/awk -v t="\$\{GITHUB_REF_NAME\}" -f scripts\/changelog-entry\.awk CHANGELOG\.md/g) || [];
    expect(uses).toHaveLength(2);
    expect(yml).not.toMatch(/generate_release_notes:/);
  });
});

describe('scripts/changelog-entry.awk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-entry-'));
  const file = join(dir, 'CHANGELOG.md');
  writeFileSync(
    file,
    [
      '# Changelog',
      '',
      '## v1.2.10 — later',
      'not this one',
      '## v1.2.1 — the one',
      'first line',
      '```',
      '## not a heading inside code',
      '```',
      'after the fence',
      '## v1.2.0 — earlier',
      'not this one either',
      '',
    ].join('\n'),
  );

  it('takes the lines after the heading up to the next heading, across a fenced block', () => {
    expect(entry('v1.2.1', file)).toBe(
      'first line\n```\n## not a heading inside code\n```\nafter the fence\n',
    );
  });

  it('matches the version exactly, not as a prefix', () => {
    expect(entry('v1.2.10', file)).toBe('not this one\n');
  });

  it('gives nothing for a version without an entry', () => {
    expect(entry('v9.9.9', file)).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });
});
