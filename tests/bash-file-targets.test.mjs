// lib/bash-file-targets.mjs — which files a Bash command reads / writes.
// The shapes under "real edit shapes" are copied from this repo's own transcripts
// (docs/audits/20260926-154904-session-history-analysis-r2.md §4.1): the extractor that
// preceded this module recovered the target file for 1 of these 6.
import { describe, it, expect } from 'vitest';
import { bashFileTargets, isScratchCommandPath, isTransientPath } from '../lib/bash-file-targets.mjs';

const REPO = '/home/u/dev/proj';
const t = (cmd, cwd = REPO) => bashFileTargets(cmd, { cwd });

describe('bashFileTargets — real edit shapes (R2 §4.1)', () => {
  it('python heredoc assigning a double-quoted absolute path, then writing it', () => {
    const cmd = `python3 - <<'EOF'\np = "${REPO}/hook.mjs"\ns = open(p).read()\nopen(p, 'w').write(s.replace('a', 'b'))\nEOF`;
    expect(t(cmd).writes).toEqual([`${REPO}/hook.mjs`]);
  });

  it('python heredoc with a single-quoted path and write_text', () => {
    const cmd = `python3 - <<'EOF'\nfrom pathlib import Path\np = Path('${REPO}/hook.mjs')\np.write_text(p.read_text().replace('x', 'y'))\nEOF`;
    expect(t(cmd).writes).toEqual([`${REPO}/hook.mjs`]);
  });

  it('sed -i on a relative path resolves against cwd', () => {
    expect(t('sed -i "s/a/b/" lib/fast-summary.mjs').writes).toEqual([`${REPO}/lib/fast-summary.mjs`]);
  });

  it('cat >> file <<EOF appends: the target is written, the body is not scanned', () => {
    const cmd = `cat >> tests/fast-summary.test.mjs <<'EOF'\nimport { x } from '../lib/other.mjs';\nEOF`;
    const r = t(cmd);
    expect(r.writes).toEqual([`${REPO}/tests/fast-summary.test.mjs`]);
    expect([...r.reads, ...r.mentions]).toEqual([]);
  });

  it('cd <repo> && sed -i … file: the file, not the repo root', () => {
    const r = t(`cd ${REPO} && sed -i 's/x/y/' hook-llm.mjs`, '/elsewhere');
    expect(r.writes).toEqual([`${REPO}/hook-llm.mjs`]);
    expect([...r.reads, ...r.mentions]).not.toContain(REPO);
  });

  it('perl -0pi -e on an absolute path', () => {
    expect(t(`perl -0pi -e "s/x/y/" ${REPO}/cli.mjs`).writes).toEqual([`${REPO}/cli.mjs`]);
  });
});

describe('bashFileTargets — reads', () => {
  it.each([
    ["sed -n '1,50p' lib/a.mjs", 'lib/a.mjs'],
    ['cat lib/a.mjs', 'lib/a.mjs'],
    ['head -n 40 lib/a.mjs', 'lib/a.mjs'],
    ['tail -20 lib/a.mjs', 'lib/a.mjs'],
    ['nl -ba lib/a.mjs | sed -n 10,20p', 'lib/a.mjs'],
    ['grep -n "foo" lib/a.mjs', 'lib/a.mjs'],
    ["awk 'NR<5' lib/a.mjs", 'lib/a.mjs'],
    ['wc -l lib/a.mjs', 'lib/a.mjs'],
  ])('%s → reads %s', (cmd, rel) => {
    const r = t(cmd);
    expect(r.reads).toEqual([`${REPO}/${rel}`]);
    expect(r.writes).toEqual([]);
  });

  it('grep -e PATTERN: the first operand is a file', () => {
    expect(t('grep -e foo lib/a.mjs lib/b.mjs').reads).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  it('the grep pattern itself is not a file even when it looks like one', () => {
    expect(t('grep -rn "foo.mjs" lib/a.mjs').reads).toEqual([`${REPO}/lib/a.mjs`]);
  });

  it('a directory search yields no file', () => {
    const r = t('grep -rn foo .');
    expect([...r.reads, ...r.writes]).toEqual([]);
  });
});

describe('bashFileTargets — writes', () => {
  it.each([
    ['echo hi > out.json', 'out.json'],
    ['printf x >> notes.md', 'notes.md'],
    ['npm test 2>&1 | tee run.log', 'run.log'],
    ['cp lib/a.mjs lib/b.mjs', 'lib/b.mjs'],
    ['sed -i.bak "s/a/b/" lib/a.mjs', 'lib/a.mjs'],
    ['perl -pi -e "s/a/b/" lib/a.mjs', 'lib/a.mjs'],
    ["node -e \"require('fs').writeFileSync('lib/a.mjs', 'x')\"", 'lib/a.mjs'],
    ['touch lib/new.mjs', 'lib/new.mjs'],
  ])('%s → writes %s', (cmd, rel) => {
    expect(t(cmd).writes).toEqual([`${REPO}/${rel}`]);
  });

  it('an fd duplication does not end the command', () => {
    expect(t('cat lib/a.mjs 2>&1 lib/b.mjs').reads).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  it('2>&1 and >/dev/null are fd plumbing, not files', () => {
    const r = t('npm run build >/dev/null 2>&1');
    expect(r.writes).toEqual(['/dev/null']); // exclusion of /dev/ is the caller's rule
  });
});

describe('bashFileTargets — what it must not claim', () => {
  it.each([
    'git status',
    'npx vitest run',
    'echo "see lib/a.mjs"',
    'echo lib/a.mjs',
    'ls',
    'cd lib',
    'npm run format',
    'gh run list --limit 1',
  ])('%s → no file read, written or mentioned', (cmd) => {
    const r = t(cmd);
    expect([...r.reads, ...r.writes, ...r.mentions]).toEqual([]);
  });

  it('an expansion is skipped rather than guessed', () => {
    expect(t('sed -i "s/a/b/" "$F"').writes).toEqual([]);
    expect(t('cat lib/*.mjs').reads).toEqual([]);
  });

  it('relative paths without a known cwd are dropped', () => {
    expect(bashFileTargets('cat lib/a.mjs').reads).toEqual([]);
    expect(bashFileTargets(`cat ${REPO}/lib/a.mjs`).reads).toEqual([`${REPO}/lib/a.mjs`]);
  });

  it('cd to an unknowable place forgets the cwd', () => {
    expect(t('cd "$DIR" && cat lib/a.mjs').reads).toEqual([]);
  });

  it('a runner operand is a mention, not a read', () => {
    const r = t('npx vitest run tests/foo.test.mjs');
    expect(r.mentions).toEqual([`${REPO}/tests/foo.test.mjs`]);
    expect([...r.reads, ...r.writes]).toEqual([]);
  });

  it('git -C resolves pathspecs against its own directory', () => {
    expect(t('git -C /other/repo add lib/a.mjs').mentions).toEqual(['/other/repo/lib/a.mjs']);
  });

  it('never throws on garbage', () => {
    for (const cmd of ['', '"', "'", '<<', 'a <<EOF', '$(', '`', '> ', null, 42]) {
      expect(() => bashFileTargets(cmd, { cwd: REPO })).not.toThrow();
    }
  });
});

describe('bashFileTargets — views (what PreToolUse recall fires on)', () => {
  it('cat / sed -n / head / tail view a file; grep / wc / awk only read it', () => {
    for (const cmd of ['cat lib/a.mjs', "sed -n '1,9p' lib/a.mjs", 'head lib/a.mjs', 'tail -5 lib/a.mjs']) {
      expect(t(cmd).views, cmd).toEqual([`${REPO}/lib/a.mjs`]);
    }
    for (const cmd of ['grep -n x lib/a.mjs', 'wc -l lib/a.mjs', "awk '{print}' lib/a.mjs"]) {
      expect(t(cmd).views, cmd).toEqual([]);
      expect(t(cmd).reads, cmd).toEqual([`${REPO}/lib/a.mjs`]);
    }
  });

  it('a file that is written is not also a view', () => {
    expect(t('sed -i s/a/b/ lib/a.mjs').views).toEqual([]);
  });
});

describe('isScratchCommandPath / isTransientPath', () => {
  it('/tmp is scratch unless it is inside the project', () => {
    expect(isScratchCommandPath('/tmp/x/a.mjs')).toBe(true);
    expect(isScratchCommandPath('/tmp/x/a.mjs', '/tmp/x')).toBe(false);
    expect(isScratchCommandPath('/tmp/x/a.mjs', '/tmp/x/')).toBe(false);
    expect(isScratchCommandPath('/tmp/xy/a.mjs', '/tmp/x')).toBe(true); // prefix is not containment
    expect(isScratchCommandPath('/dev/null', '/')).toBe(true);
    expect(isScratchCommandPath('/home/u/p/a.mjs')).toBe(false);
  });

  it('harness scratch, tool-results and node_modules are transient wherever they are', () => {
    expect(isTransientPath('/tmp/claude-1000/-p/s/scratchpad/a.md')).toBe(true);
    expect(isTransientPath('/home/u/p/node_modules/x/i.js')).toBe(true);
    expect(isTransientPath('/home/u/.claude/projects/p/s/tool-results/b.txt')).toBe(true);
    expect(isTransientPath('/home/u/p/lib/node_modules.mjs')).toBe(false);
  });
});
