// Whether this process was started by `npx` / `npm exec` — the ephemeral channel whose
// files do not persist after exit. A leaf (node: builtins only) so cli.mjs can ask before
// it loads install.mjs: `npx claude-mem-lite` with no command is the documented install /
// reinstall, and cli.mjs has to route it there even when a database already exists.

/**
 * One predicate for both decisions that ask it: cli.mjs routing a bare command, and
 * install.mjs choosing the npx install mode.
 *
 * - The entry lies in npx's package cache (`~/.npm/_npx/<hash>/…`), or
 * - npx launched THIS package's bin. npm's run-script runs it with event `npx` and the bin name
 *   as the script (`npm_lifecycle_event=npx`, `npm_lifecycle_script='claude-mem-lite'`). With
 *   the package also installed by `npm i -g`, npx runs the global bin, whose path holds no
 *   `_npx` (E2E 2026-10-16 round 3).
 *
 * `npm_command=exec` alone is NOT a test: npm exports it to everything npx starts, so a Claude
 * Code launched with npx hands it to its Bash tool and hooks, where a bare `claude-mem-lite`
 * ran a full install over a plugin-only machine (round 2). Their npm_lifecycle_script names
 * that other bin.
 *
 * @param {string} dir the directory the running entry point lives in
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isNpxRun(dir, env = process.env) {
  return (
    isNpxCachePath(dir) ||
    (env.npm_lifecycle_event === 'npx' &&
      /(?:^|[\s'"/\\])claude-mem-lite(?:@[^\s'"]*)?(?:['"\s]|$)/.test(env.npm_lifecycle_script || ''))
  );
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isNpxCachePath(dir) {
  return dir.includes('_npx') || dir.includes('.npm/_');
}
