/**
 * doctor's hook-interpreter check, extracted from install.mjs.
 *
 * Why it moved, since "it was long" is not one of this repo's `lib/` criteria: the
 * second criterion is a unit carved out of an entry file so COVERAGE reaches it.
 * `install.mjs` is excluded from the coverage population by name (vitest.config.mjs's
 * coverage `exclude`; the population is a denylist, so staying out costs a named entry),
 * so code living in it has no coverage reading at all — not a low one, NONE — while
 * `doctor()` alone is 1025 of
 * its ~3595 lines and holds the criteria a user is shown when their install is broken.
 * Those criteria were graded almost entirely by subprocess E2E, and the 2026-09 audit
 * found two P1s among them.
 *
 * (`vitest.config.mjs` records a spot reading of 11.67% statements from a run that
 * temporarily added the file to the population. That is a STAMP, not a current number:
 * it is dated 2026-09-03 and predates all three caliber breaks CLAUDE.md names — the
 * 2026-09-05 reformat, the vitest 5.0.0 coverage recalibration, and the 2026-09-07
 * `include` inversion. An earlier draft of this docblock quoted it as if it were
 * current, which is the carried-cell shape this repo files as a defect.)
 *
 * What is measured on THIS tree, and is the argument that actually carries: the
 * dispatch below reads 88.88% statements with its own cases, where in `install.mjs` it
 * had no reading to improve on. Joining lib/doctor-modes.mjs, lib/doctor-drift.mjs and
 * lib/doctor-benchmark.mjs, which started this split.
 *
 * A LEAF on purpose — `node:fs` and `node:child_process`, nothing from this project.
 * Doctor is the surface a BROKEN install is diagnosed from, and this repo has already
 * paid for the alternative: one import edge, taken for two path constants, put the
 * signature-verified repair out of reach on exactly the installs it existed to repair.
 * Everything else arrives as an argument.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * How many LIVE hook commands invoke `bash`, and which scripts they are.
 *
 * There are two hook registrations and only one is live per install shape, which is what
 * the first cut of doctor's interpreter check got wrong (pre-ship review P1-1). The plugin
 * shape reads `hooks/hooks.json` out of the plugin cache. The npm / npx / `git clone` shape
 * has no such file — `hooks/hooks.json` is in RELEASE_SIGNED_FILES but NOT in SOURCE_FILES,
 * so nothing deploys it to ~/.claude-mem-lite/ — and registers its hooks in settings.json
 * instead. Reading only the manifest therefore answered "zero bash hooks" on the one shape
 * where two of them are live.
 *
 * Returns THREE outcomes, never two. `count: null` means no registration could be read, and
 * that is deliberately distinct from a count of zero: zero is an answer, null is the absence
 * of one, and a diagnostic that reports them identically tells the reader to stop looking.
 *
 * @param {{manifestPath: string, settingsCommands?: string[], installDir: string}} opts
 * @returns {{count: number|null, source: 'manifest'|'settings'|null, scripts: string[]}}
 */
export function resolveBashHookCount({ manifestPath, settingsCommands = [], installDir }) {
  const basenames = (commands) =>
    commands
      .map((c) => {
        const m = c.match(/([^/"\s]+\.sh)/);
        return m ? m[1] : c;
      })
      .sort();

  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const commands = [];
      for (const matchers of Object.values(parsed?.hooks || {})) {
        for (const m of matchers || []) {
          for (const h of m?.hooks || []) commands.push(String(h?.command || ''));
        }
      }
      const bash = commands.filter((c) => c.startsWith('bash '));
      return { count: bash.length, source: 'manifest', scripts: basenames(bash) };
    } catch {
      // A torn manifest is not evidence of zero bash hooks. Fall through to settings.json,
      // and if that says nothing about us either, the caller gets null.
    }
  }
  // Only OUR entries: settings.json is shared with every other tool the user installs, so a
  // foreign `bash "…"` line is not ours to report on, and — the discriminating half — a
  // settings.json that names nothing of ours is not evidence that no hook needs bash. It is
  // evidence we are reading the wrong registration.
  const ours = settingsCommands.filter((c) => c.includes(installDir));
  if (ours.length === 0) return { count: null, source: null, scripts: [] };
  const bash = ours.filter((c) => c.startsWith('bash '));
  return { count: bash.length, source: 'settings', scripts: basenames(bash) };
}

/**
 * Can bash actually be run? Separated from the dispatch below, and injectable there,
 * because shelling out is the entire reason that dispatch had no unit coverage: one of
 * its four outcomes needs a machine where bash is absent, which no in-process test can
 * arrange without rewriting PATH for the whole worker. The dispatch's outer catch is
 * unreachable through THIS function — it catches everything and returns false — so the
 * real probe never drives it. Other things in that try block can: a non-string entry in
 * `settingsCommands`, or a reporter (`ok` / `dwarn`) that throws. The shipped caller
 * passes only strings, and the tests drive the catch with an injected throwing probe.
 *
 * @returns {boolean}
 */
function probeBash() {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    /* not resolvable, or not runnable — either way the hooks that need it cannot fire */
    return false;
  }
}

/**
 * Grade the hook interpreter, reporting through doctor's own helpers.
 *
 * Some hook commands are `bash "<script>"` (the PostToolUse and Agent prefilters, plus
 * setup.sh in the plugin manifest) — the rest are `node`. If bash cannot run, those
 * commands fail and nothing says so; the file-presence check grades whether the FILES are
 * there, which they are.
 *
 * Keyed on whether bash RUNS, not on `process.platform === 'win32'`. A Windows user with
 * Git for Windows on PATH — the normal case, since Claude Code shells out to bash for its
 * own Bash tool — has a working configuration and must not be warned; a stripped container
 * with no bash has a broken one and must be, whatever its platform. This is also what issue
 * #28's P3-19 intent asked for: `os: [darwin, linux]` was added so a Windows user "should be
 * told rather than handed a string of silent catch blocks", and blocking the install told
 * them nothing. This is the telling.
 *
 * @param {{ok: (m: string) => void, dwarn: (m: string) => void}} report doctor's helpers
 * @param {object} ctx
 * @param {string} ctx.manifestPath    plugin-shape registration (hooks/hooks.json)
 * @param {string} ctx.settingsPath    npm-shape registration, named in the unknown message
 * @param {string[]} ctx.settingsCommands
 * @param {string} ctx.installDir
 * @param {() => boolean} [ctx.bashPresent]
 */
export function checkHookInterpreter(
  { ok, dwarn },
  { manifestPath, settingsPath, settingsCommands = [], installDir, bashPresent = probeBash },
) {
  try {
    const {
      count: bashCommands,
      source: countSource,
      scripts: bashScripts,
    } = resolveBashHookCount({ manifestPath, settingsCommands, installDir });
    if (bashCommands === null) {
      // NOT `ok`. Pre-ship review (P1-1) found the first cut printing "no hook command needs
      // bash" here, on a shape where two of them are registered — a green line that ends the
      // reader's search is worse than the silence this check exists to remove.
      dwarn(
        'Hook interpreter: could not read either hook registration — neither ' +
          `${manifestPath} nor a claude-mem-lite entry in ` +
          `${settingsPath} — so whether any hook needs bash is unknown.`,
      );
    } else if (bashCommands === 0) {
      ok(`Hook interpreter: no hook command needs bash (per the ${countSource})`);
    } else if (bashPresent()) {
      ok(`Hook interpreter: bash present (${bashCommands} hook command(s) need it)`);
    } else {
      // dwarn, not an issue: everything else works. Saying "broken" about an install
      // whose MCP server and node hooks are fine would be the mirror of the defect that
      // sent this round's reporter looking at their disk and their network.
      // The scripts are NAMED from the live registration rather than described from
      // memory — the first cut wrote "(episode Read-tracking and the subagent prefilter)",
      // a two-item gloss on a count of three (P3-1).
      dwarn(
        `Hook interpreter: bash not found on PATH — the ${bashCommands} hook command(s) that ` +
          `invoke it cannot fire (${bashScripts.join(', ')}). The MCP server and the node ` +
          'hooks are unaffected. On Windows, install Git for Windows or use WSL; elsewhere ' +
          'this means a stripped PATH.',
      );
    }
  } catch (e) {
    dwarn('Hook interpreter: check failed — ' + e.message);
  }
}
