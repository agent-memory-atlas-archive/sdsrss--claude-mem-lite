// Whether this process was started by `npx` / `npm exec` — the ephemeral channel whose
// files do not persist after exit. A leaf (node: builtins only) so cli.mjs can ask before
// it loads install.mjs: `npx claude-mem-lite` with no command is the documented install /
// reinstall, and cli.mjs has to route it there even when a database already exists.

/**
 * @param {string} dir the directory the running entry point lives in
 * @returns {boolean}
 */
export function isNpxRun(dir) {
  return process.env.npm_command === 'exec' || dir.includes('_npx') || dir.includes('.npm/_');
}
