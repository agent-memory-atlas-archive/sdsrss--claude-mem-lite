// Whether this process was started by `npx` / `npm exec` — the ephemeral channel whose
// files do not persist after exit. A leaf (node: builtins only) so cli.mjs can ask before
// it loads install.mjs: `npx claude-mem-lite` with no command is the documented install /
// reinstall, and cli.mjs has to route it there even when a database already exists.

/**
 * @param {string} dir the directory the running entry point lives in
 * @returns {boolean}
 */
export function isNpxRun(dir) {
  return process.env.npm_command === 'exec' || isNpxCachePath(dir);
}

/**
 * Whether `dir` lies in npx's package cache (`~/.npm/_npx/<hash>/…`). The path alone, for a
 * decision that must not follow `npm_command`: npm exports that variable to everything npx
 * starts, so a Claude Code launched with npx hands it to its Bash tool and hooks, and a bare
 * `claude-mem-lite` there ran a full install over a plugin-only machine (E2E round 2, B5).
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isNpxCachePath(dir) {
  return dir.includes('_npx') || dir.includes('.npm/_');
}
