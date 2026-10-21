// R3 I-H1 (HIGH): isMemHook must not over-match a user's own hooks. The old
// `hook.mjs` + event-word clause classified `node ~/.config/hook.mjs session-start`
// (a user's generic hook) as ours → install/uninstall silently deleted it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  isMemHook,
  stripMemHooks,
  pruneDanglingMemHooks,
  ourInstallRoots,
  unconfirmedDeadPrefilters,
} from '../lib/hook-prune.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const mk = (command) => ({ hooks: [{ type: 'command', command }] });

describe('isMemHook classifies real mem hooks (R3 I-H1)', () => {
  it('matches launcher-routed, install-path, and prefilter commands', () => {
    expect(
      isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs session-start')),
    ).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/hook.mjs" session-start'))).toBe(true); // legacy direct (install path)
    expect(isMemHook(mk('bash "/home/me/.claude-mem-lite/scripts/post-tool-use.sh"'))).toBe(true);
    expect(isMemHook(mk('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs stop'))).toBe(true);
  });
});

describe("isMemHook must NOT delete a user's foreign hooks (R3 I-H1)", () => {
  it("does not match a user's own hook.mjs carrying an event arg", () => {
    expect(isMemHook(mk('node /home/me/.config/hook.mjs session-start'))).toBe(false);
    expect(isMemHook(mk('node /home/me/scripts/hook.mjs stop-daemon'))).toBe(false); // \bstop\b false-matched before
    expect(isMemHook(mk('node "/tmp/other-plugin/hook.mjs" user-prompt'))).toBe(false);
  });
  it('does not match an unrelated foreign command', () => {
    expect(isMemHook(mk('/usr/bin/my-linter'))).toBe(false);
    expect(isMemHook(mk('bash "/opt/tools/backup.sh" --daily'))).toBe(false);
  });
});

// E2E round 2026-09-29: the product-name clause was a bare substring and the test ran per
// GROUP, so `uninstall` deleted a user's `SessionEnd` hook that runs `claude-mem-lite export`,
// reinstall deleted a user's `~/tools/claude-mem-lite-prompt-audit.py` group, and a hook the
// user appended into OUR Stop group went with the group. settings.json.bak did not hold them.
describe('isMemHook leaves user hooks that merely mention the product', () => {
  it('does not match a user command that runs or names claude-mem-lite', () => {
    expect(isMemHook(mk('claude-mem-lite export > ~/backups/mem-$(date +%F).jsonl'))).toBe(false);
    expect(isMemHook(mk('python3 ~/tools/claude-mem-lite-prompt-audit.py'))).toBe(false);
    expect(isMemHook(mk('npx claude-mem-lite search "$PROMPT"'))).toBe(false);
  });
  it('still matches every command shape an install has written', () => {
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/hook.mjs" stop'))).toBe(true);
    expect(isMemHook(mk('node /home/me/.claude-mem-lite/hook.mjs post-tool-use'))).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/user-prompt-search.js"'))).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/pre-skill-bridge.js"'))).toBe(true);
    expect(isMemHook(mk('node "/home/me/claude-mem-lite/hook.mjs" session-start'))).toBe(true); // pre-v0.5 dir
    expect(isMemHook(mk('node "/home/me/src/claude-mem-lite-main/hook.mjs" stop'))).toBe(true); // zip checkout
    expect(isMemHook(mk('node "C:\\Users\\me\\.claude-mem-lite\\hook.mjs" stop'))).toBe(true);
    expect(isMemHook(mk('bash "/home/me/.claude-mem-lite/scripts/pre-tool-recall-bash.sh"'))).toBe(true);
  });
});

// E2E round 2026-10-16 (install P1-2): three of the clauses were bare substrings —
// `hook-launcher.mjs`, `scripts/post-tool-use.sh` and the two other prefilter names — so a
// user's own formatter at ~/.claude/scripts/post-tool-use.sh or a Bash guard run through
// their own hook-launcher.mjs was deleted by install, uninstall and cleanup-hooks, and by the
// auto-update's dangling-hook prune, on a machine that had never installed the product.
describe('isMemHook leaves user hooks that share a script NAME with ours', () => {
  it('does not match a generic post-tool-use.sh or hook-launcher.mjs of the user', () => {
    // The user's scripts exist, as a working hook's do (a missing one is a dead hook, below).
    const home = mkdtempSync(join(tmpdir(), 'cml-userhooks-'));
    try {
      for (const d of ['dotfiles/scripts', 'bin/scripts']) mkdirSync(join(home, d), { recursive: true });
      writeFileSync(join(home, 'dotfiles/scripts/pre-tool-recall-bash.sh'), '# mine');
      writeFileSync(join(home, 'bin/scripts/pre-agent-inject.sh'), '# mine');
      expect(isMemHook(mk('bash ~/.claude/scripts/post-tool-use.sh'))).toBe(false);
      expect(isMemHook(mk(`bash "${join(home, 'dotfiles/scripts/pre-tool-recall-bash.sh')}"`))).toBe(false);
      expect(isMemHook(mk(`bash ${join(home, 'bin/scripts/pre-agent-inject.sh')} --strict`))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(isMemHook(mk('node ~/.claude/hooks/hook-launcher.mjs guard-bash'))).toBe(false);
    expect(isMemHook(mk('node "/opt/x/scripts/hook-launcher.mjs" lint --fix'))).toBe(false);
  });

  // E2E round 2 (install B3): a relative prefilter path was checked for a launcher beside it
  // against the installer's cwd, so installing from the git clone (README's clone install runs
  // it there, and the clone has scripts/hook-launcher.mjs) deleted `bash scripts/post-tool-use.sh
  // --fmt`. Our installs write absolute paths or ${CLAUDE_PLUGIN_ROOT}.
  it('a relative prefilter path is never ours, whatever the cwd holds', () => {
    const prev = process.cwd();
    try {
      process.chdir(REPO); // holds scripts/hook-launcher.mjs and scripts/post-tool-use.sh
      expect(isMemHook(mk('bash scripts/post-tool-use.sh --fmt'))).toBe(false);
      expect(isMemHook(mk('bash ./scripts/pre-agent-inject.sh'))).toBe(false);
      // Nor is a relative launcher's root the repo the installer stands in (round 2, B16).
      expect(isMemHook(mk('node scripts/hook-launcher.mjs scripts/prettier.js'))).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  // Round 2 (install B6): an install relocated by an older release whose directory was later
  // removed left three prefilter hooks that were no longer recognised (no launcher beside them
  // to confirm), so install kept them beside its own — each failing "No such file or directory"
  // on every fire — and doctor reported no orphans. A dead prefilter is ours when the same
  // settings route one of OUR launcher commands through that directory (every install writes
  // both), or the directory is CLAUDE_MEM_DIR.
  const deadReloc = {
    hooks: {
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'bash "/home/me/old-reloc/scripts/post-tool-use.sh"' }] },
      ],
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'node "/home/me/old-reloc/scripts/hook-launcher.mjs" hook.mjs stop' },
          ],
        },
      ],
    },
  };
  it('a dead prefilter beside our dead launcher command is ours to remove', () => {
    const roots = ourInstallRoots(deadReloc);
    expect(isMemHook(mk('bash "/home/me/old-reloc/scripts/post-tool-use.sh"'), roots)).toBe(true);
    expect(isMemHook(mk('bash "/home/me/old-reloc/scripts/pre-tool-recall-bash.sh"'), roots)).toBe(true);
    expect(stripMemHooks(deadReloc.hooks.PostToolUse, roots).removed).toBe(1);
    expect(ourInstallRoots({ hooks: {} }, { CLAUDE_MEM_DIR: '/data/mem' }).has('/data/mem')).toBe(true);
  });
  // Round 4 (install NEW-1): with no launcher entry left to vouch for the root, a dead
  // relocated install's prefilters are not removed (a user's own hook could look the same), and
  // doctor said "all hook targets present". They are now listed for the user to decide.
  it('unconfirmed dead prefilters are listed, not removed', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'bash "/home/me/old-reloc/scripts/post-tool-use.sh"' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /usr/bin/true' }] }],
      },
    };
    expect(unconfirmedDeadPrefilters(settings, {})).toEqual(['/home/me/old-reloc/scripts/post-tool-use.sh']);
    expect(unconfirmedDeadPrefilters(deadReloc, {})).toEqual([]); // confirmed: ours, cleaned up instead
  });

  // Round 3 (install NEW-2): "a dead script is ours" alone deleted a user's own hook whose script
  // was briefly missing (a dotfiles checkout on an unmounted drive), on a machine that never
  // installed the product.
  it("a user's briefly missing hook with one of our names is not ours", () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              { type: 'command', command: 'bash /mnt/dotfiles/claude/scripts/post-tool-use.sh --prettier' },
            ],
          },
        ],
      },
    };
    const roots = ourInstallRoots(settings, {});
    expect(isMemHook(settings.hooks.PostToolUse[0], roots)).toBe(false);
    expect(stripMemHooks(settings.hooks.PostToolUse, roots).removed).toBe(0);
    expect(pruneDanglingMemHooks(settings, '/nonexistent-install').removed).toEqual([]);
  });
  it('the dangling-hook prune keeps them too', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node ~/.claude/hooks/hook-launcher.mjs guard-bash' }],
          },
        ],
      },
    };
    const { settings: after, removed } = pruneDanglingMemHooks(settings, '/nonexistent-install');
    expect(removed).toEqual([]);
    expect(after.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });
  // Round 2 (install B2): ownership was asked of the GROUP, so a user's launcher-shaped hook
  // appended into one of OUR groups (the natural hand-edit) was dropped with a dead target, by
  // the auto-update, though install and uninstall keep it.
  it("the dangling-hook prune keeps a user's hook inside one of our groups", () => {
    const ours = 'node "/home/me/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop';
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: ours },
              { type: 'command', command: 'node ~/.claude/hooks/hook-launcher.mjs notify --sound' },
            ],
          },
        ],
      },
    };
    const { settings: after } = pruneDanglingMemHooks(settings, '/nonexistent-install');
    expect(after.hooks.Stop[0].hooks.map((h) => h.command)).toContain(
      'node ~/.claude/hooks/hook-launcher.mjs notify --sound',
    );
  });
  it('still matches an install outside a claude-mem-lite directory', () => {
    // Launcher commands running one of our entries are ours whatever the directory is called.
    expect(isMemHook(mk('node "/data/mem/scripts/hook-launcher.mjs" hook.mjs session-start'))).toBe(true);
    expect(isMemHook(mk('node "/data/mem/scripts/hook-launcher.mjs" scripts/pre-tool-recall.js'))).toBe(true);
    // A prefilter is ours in a root that carries the product: every install root has our
    // package.json beside the launcher (round 2, B16: a launcher alone is the user's too).
    const root = mkdtempSync(join(tmpdir(), 'cml-reloc-'));
    try {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'package.json'), '{"name":"claude-mem-lite"}');
      writeFileSync(join(root, 'scripts', 'hook-launcher.mjs'), '// stub');
      writeFileSync(join(root, 'scripts', 'post-tool-use.sh'), '# stub');
      expect(isMemHook(mk(`bash "${join(root, 'scripts', 'post-tool-use.sh')}"`))).toBe(true);
      expect(isMemHook(mk(`bash "${join(root, 'scripts', 'pre-agent-inject.sh')}"`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(isMemHook(mk('bash "${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.sh"'))).toBe(true);
  });
});

// E2E 2026-10-16 round 2 (install B16): the launcher clause was a shape test with no product
// anchor, so on a machine that never installed the product cleanup-hooks removed a user's own
// launcher-routed formatter and notifier, and a formatter sitting beside their own launcher.
describe('a hook is ours only when the product or one of OUR entries anchors it', () => {
  const withRoot = (fn) => {
    const root = mkdtempSync(join(tmpdir(), 'cml-anchor-'));
    try {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts', 'hook-launcher.mjs'), '// a launcher');
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const ourPackage = (root) => writeFileSync(join(root, 'package.json'), '{"name":"claude-mem-lite"}');

  it("a user's launcher of our layout running the user's own entry is not ours", () => {
    expect(isMemHook(mk('node "$HOME/.claude/hooks/scripts/hook-launcher.mjs" scripts/prettier.js'))).toBe(
      false,
    );
    expect(isMemHook(mk('node ~/.claude/hooks/scripts/hook-launcher.mjs hook.mjs notify'))).toBe(false);
    withRoot((root) => {
      writeFileSync(join(root, 'scripts', 'prettier.js'), '// mine');
      const cmd = `node "${join(root, 'scripts', 'hook-launcher.mjs')}" scripts/prettier.js`;
      expect(isMemHook(mk(cmd))).toBe(false);
      // Nor does a settings file holding it vouch for that root.
      expect(ourInstallRoots({ hooks: { Stop: [mk(cmd)] } }, {}).has(root)).toBe(false);
    });
  });

  it('a launcher whose root carries our package is ours, whatever entry it runs', () => {
    withRoot((root) => {
      const cmd = `node "${join(root, 'scripts', 'hook-launcher.mjs')}" scripts/a-later-entry.js`;
      writeFileSync(join(root, 'package.json'), '{"name":"someone-elses-tool"}');
      expect(isMemHook(mk(cmd)), 'another package is not ours').toBe(false);
      ourPackage(root);
      expect(isMemHook(mk(cmd))).toBe(true);
    });
  });

  it("a prefilter-named script beside the user's own launcher is not ours", () => {
    withRoot((root) => {
      writeFileSync(join(root, 'scripts', 'post-tool-use.sh'), '# mine');
      const cmd = `bash "${join(root, 'scripts', 'post-tool-use.sh')}"`;
      expect(isMemHook(mk(cmd))).toBe(false);
      ourPackage(root);
      expect(isMemHook(mk(cmd)), 'the same file in a root carrying our package').toBe(true);
    });
  });

  // v6.28.0 pre-tag review, install P3-1: the entry names alone made a user's launcher ours when
  // it ran `hook.mjs <one of our events>` or `scripts/<one of our scripts>`, wherever it lived, so
  // install, uninstall, cleanup-hooks and the update prune deleted it, and it vouched for its own
  // root, which took a dead prefilter-named hook beside it as well. The names anchor only a
  // launcher that is gone (the relocated, deleted install they exist for).
  it("a user's existing launcher running one of our entry names is not ours", () => {
    withRoot((root) => {
      const launcher = join(root, 'scripts', 'hook-launcher.mjs');
      const stop = `node "${launcher}" hook.mjs stop`;
      const recall = `node "${launcher}" scripts/pre-tool-recall.js`;
      const deadPrefilter = `bash ${join(root, 'scripts', 'post-tool-use.sh')} --notify`;
      expect(isMemHook(mk(stop))).toBe(false);
      expect(isMemHook(mk(recall))).toBe(false);
      const settings = { hooks: { Stop: [mk(stop)], PostToolUse: [mk(deadPrefilter)] } };
      const roots = ourInstallRoots(settings, {});
      expect(roots.has(root), 'it vouches for its own root').toBe(false);
      expect(isMemHook(mk(deadPrefilter), roots)).toBe(false);
      // The update prune: an entry of ours the launcher's root lacks.
      const skill = `node "${launcher}" scripts/pre-skill-bridge.js`;
      const pruned = pruneDanglingMemHooks({ hooks: { PreToolUse: [mk(skill)] } }, '/nonexistent-install');
      expect(pruned.removed).toEqual([]);
      // The same launcher in a root that carries our package stays ours.
      ourPackage(root);
      expect(isMemHook(mk(stop))).toBe(true);
    });
    // "Gone" is asked of an absolute path only: a relative one is missing or present depending
    // on where the installer runs, and installs write absolute paths.
    const elsewhere = mkdtempSync(join(tmpdir(), 'cml-anchor-cwd-'));
    const prev = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(isMemHook(mk('node scripts/hook-launcher.mjs hook.mjs stop'))).toBe(false);
    } finally {
      process.chdir(prev);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // D#479: the product name in a directory name was enough, so install, uninstall and
  // cleanup-hooks deleted a user's `node ~/claude-mem-lite-notes/scripts/fmt.js`. Such a path is
  // ours when its root carries our package, or when it names one of our entries and is gone.
  it("a user's existing script under a claude-mem-lite* directory is not ours", () => {
    const home = mkdtempSync(join(tmpdir(), 'cml-entry-'));
    try {
      const notes = join(home, 'claude-mem-lite-notes');
      mkdirSync(join(notes, 'scripts'), { recursive: true });
      for (const f of ['scripts/fmt.js', 'scripts/post-tool-use.sh', 'hook.mjs'])
        writeFileSync(join(notes, f), '// mine');
      expect(isMemHook(mk(`node "${join(notes, 'scripts', 'fmt.js')}"`))).toBe(false);
      expect(isMemHook(mk(`node ${join(notes, 'scripts', 'fmt.js')} --check`))).toBe(false);
      expect(isMemHook(mk(`bash "${join(notes, 'scripts', 'post-tool-use.sh')}"`))).toBe(false);
      expect(isMemHook(mk(`node "${join(notes, 'hook.mjs')}" stop`))).toBe(false);
      // A missing script that is not one of our entries is a dead hook of the user's.
      expect(isMemHook(mk(`node "${join(notes, 'scripts', 'gone.js')}"`))).toBe(false);
      expect(isMemHook(mk(`node "${join(notes, 'hook.mjs-old', 'hook.mjs')}" notify`))).toBe(false);
      // Controls: one of our entries that is gone, and any entry in a root carrying our package.
      expect(isMemHook(mk(`node "${join(notes, 'scripts', 'user-prompt-search.js')}"`))).toBe(true);
      expect(isMemHook(mk(`node "${join(home, 'claude-mem-lite-old', 'hook.mjs')}" stop`))).toBe(true);
      ourPackage(notes);
      expect(isMemHook(mk(`node "${join(notes, 'scripts', 'fmt.js')}"`))).toBe(true);
      expect(isMemHook(mk(`node "${join(notes, 'hook.mjs')}" stop`))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The entry list is what recognises a relocated install whose directory is gone, so every
  // entry a release writes must be on it — read from the plugin manifest, whose entries
  // install.mjs writes too (tests/audit-silent-20260814.test.mjs diffs the two).
  it('every hooks/hooks.json launcher entry is ours under a root that is gone', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8'));
    const cmds = Object.values(manifest.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command))
      .filter((c) => c.includes('hook-launcher.mjs'))
      .map((c) => c.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/gone/relocated-install'));
    expect(cmds.length, 'premise: the manifest routes entries through the launcher').toBeGreaterThan(5);
    for (const c of cmds) expect(isMemHook(mk(c)), c).toBe(true);
  });
});

describe('stripMemHooks removes our entries, not the groups they sit in', () => {
  const ours = {
    type: 'command',
    command: 'node "/h/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop',
  };
  const user = { type: 'command', command: '/home/u/bin/log-stop.sh' };
  it("keeps a user's hook appended into our group", () => {
    const { kept, removed } = stripMemHooks([{ matcher: '*', hooks: [ours, user] }]);
    expect(kept).toEqual([{ matcher: '*', hooks: [user] }]);
    expect(removed).toBe(1);
  });
  it('drops a group that held only our hooks and counts hook entries, not groups', () => {
    const { kept, removed } = stripMemHooks([
      { matcher: '*', hooks: [ours, ours] },
      { hooks: [{ type: 'command', command: 'claude-mem-lite export > /tmp/x' }] },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].hooks[0].command).toMatch(/export/);
    expect(removed).toBe(2);
  });
  it('passes malformed entries through untouched', () => {
    const { kept, removed } = stripMemHooks([null, { matcher: 'x' }]);
    expect(kept).toEqual([null, { matcher: 'x' }]);
    expect(removed).toBe(0);
  });
});

// Wiring: the settings.json writer shared by `uninstall` and `cleanup-hooks` goes through
// stripMemHooks. Sandboxed HOME; no `claude` call is made by cleanup-hooks.
describe('cleanup-hooks keeps user hooks in and around our groups', () => {
  it('removes only our entries from a real settings.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-hookprune-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, '.claude'), { recursive: true });
      const p = join(home, '.claude', 'settings.json');
      const ours = 'node "/h/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop';
      writeFileSync(
        p,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: '*',
                hooks: [
                  { type: 'command', command: ours },
                  { type: 'command', command: '/u/log.sh' },
                ],
              },
            ],
            SessionEnd: [{ hooks: [{ type: 'command', command: 'claude-mem-lite export > ~/b.jsonl' }] }],
          },
        }),
      );
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup-hooks'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(root, 'data'), MEM_NO_AUTO_ADOPT: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Removed 1 claude-mem-lite hook configuration from/);
      // Round 2 (install B16): the count alone left a wrongly removed user hook unnoticed.
      expect(r.stdout).toContain(`Stop: ${ours}`);
      expect(r.stdout).not.toContain('/u/log.sh');
      const after = JSON.parse(readFileSync(p, 'utf8'));
      expect(after.hooks.Stop).toEqual([
        { matcher: '*', hooks: [{ type: 'command', command: '/u/log.sh' }] },
      ]);
      expect(after.hooks.SessionEnd[0].hooks[0].command).toMatch(/export/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Round 2 (install B16), the tester's three hooks on a machine that never installed the product.
  it('leaves user hooks that mirror our layout on a machine without the product', () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-hookprune-b16-'));
    try {
      const home = join(root, 'home');
      for (const d of ['.claude/hooks/scripts', 'dotfiles/scripts'])
        mkdirSync(join(home, d), { recursive: true });
      for (const f of ['.claude/hooks/scripts/hook-launcher.mjs', 'dotfiles/scripts/hook-launcher.mjs'])
        writeFileSync(join(home, f), '// the user launcher');
      writeFileSync(join(home, '.claude/hooks/scripts/prettier.js'), '// mine');
      writeFileSync(join(home, 'dotfiles/scripts/post-tool-use.sh'), '# mine');
      const commands = [
        `node "${home}/.claude/hooks/scripts/hook-launcher.mjs" scripts/prettier.js`,
        `node ${home}/.claude/hooks/scripts/hook-launcher.mjs hook.mjs notify`,
        `bash "${home}/dotfiles/scripts/post-tool-use.sh"`,
      ];
      const p = join(home, '.claude', 'settings.json');
      const before = JSON.stringify({
        hooks: { PostToolUse: commands.map((command) => ({ hooks: [{ type: 'command', command }] })) },
      });
      writeFileSync(p, before);
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup-hooks'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(root, 'data'), MEM_NO_AUTO_ADOPT: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/No claude-mem-lite hooks found/);
      expect(readFileSync(p, 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // v6.28.0 pre-tag review, install P3-1, home B: a user's launcher running `hook.mjs stop` and a
  // missing post-tool-use.sh beside it were both removed on a machine without the product.
  it("leaves a user's launcher that runs one of our entry names, and the dead hook beside it", () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-hookprune-p31-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, 'tools', 'scripts'), { recursive: true });
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, 'tools/scripts/hook-launcher.mjs'), '// the user launcher');
      const commands = [
        `node "${home}/tools/scripts/hook-launcher.mjs" hook.mjs stop`,
        `bash ${home}/tools/scripts/post-tool-use.sh --notify`,
      ];
      const p = join(home, '.claude', 'settings.json');
      const before = JSON.stringify({
        hooks: { Stop: commands.map((command) => ({ hooks: [{ type: 'command', command }] })) },
      });
      writeFileSync(p, before);
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup-hooks'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(root, 'data'), MEM_NO_AUTO_ADOPT: '1' },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/No claude-mem-lite hooks found/);
      expect(readFileSync(p, 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// E2E round 2026-09-29 (install P1-8): with the plugin installed AND a direct install, the
// direct `install` empties the plugin's hooks.json so hooks do not fire twice. A later
// `cleanup-hooks` then removed the settings.json copy too, printed "Removed N …", and left
// the enabled plugin with no hooks at all — capture silently stopped. It now says so.
describe('cleanup-hooks warns when it leaves an enabled plugin with no hooks', () => {
  function pluginHome({ manifestHooks }) {
    const root = mkdtempSync(join(tmpdir(), 'cml-hookprune-plugin-'));
    const home = join(root, 'home');
    const cache = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '6.20.0');
    mkdirSync(join(cache, 'hooks'), { recursive: true });
    mkdirSync(join(cache, 'scripts'), { recursive: true });
    writeFileSync(join(cache, 'scripts', 'launch.mjs'), '// stub'); // what marks a cache dir startable
    writeFileSync(join(cache, 'package.json'), '{"name":"claude-mem-lite","version":"6.20.0"}');
    writeFileSync(join(cache, 'hooks', 'hooks.json'), JSON.stringify({ hooks: manifestHooks }));
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'claude-mem-lite@sdsrss': [{ installPath: cache, version: '6.20.0' }] },
      }),
    );
    const ours = 'node "/h/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop';
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'claude-mem-lite@sdsrss': true },
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: ours }] }] },
      }),
    );
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup-hooks'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(root, 'data'), MEM_NO_AUTO_ADOPT: '1' },
    });
    rmSync(root, { recursive: true, force: true });
    return r;
  }

  it('an emptied plugin manifest gets a warning and the repair', () => {
    const r = pluginHome({ manifestHooks: {} });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Removed 1 claude-mem-lite hook configuration/);
    expect(r.stdout).toMatch(/plugin's hooks\/hooks\.json registers none — every hook is now unregistered/);
    expect(r.stdout).toMatch(/reinstall the plugin|cp /);
  });

  it('a working plugin manifest needs no warning', () => {
    const r = pluginHome({ manifestHooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    expect(r.stdout).toMatch(/Removed 1/);
    expect(r.stdout).not.toMatch(/every hook is now unregistered/);
  });
});
