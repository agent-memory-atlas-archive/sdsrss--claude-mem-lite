# D#334 stage 1 — `claude -p --model haiku`: default effort (medium, adaptive thinking) vs `--effort low`

Measured 2026-10-21 05:04–05:28Z. Tree under test: `git archive` of claude-mem-lite HEAD
`5443e879f58cad1e56744d38a5cfb6fc2f302718` (v6.30.1) plus a `node_modules` symlink, at
`<d334>/tree`. Here `<d334>` = `/tmp/claude-1000/-home-ai-dev-claude-mem-lite/c9e45eae-6456-4573-9010-9065054431eb/scratchpad/d334`.
Claude Code: `claude --version` → `2.1.305 (Claude Code)`. The real binary called by the wrapper was
`/home/ai/.local/share/claude/versions/2.1.305` (the target of `/home/ai/.local/bin/claude`).

## Verdict (pre-registered rule, applied as written)

**① fires: `--effort low` rejected.** At rerank, usable(low) = 22 and usable(default) = 24.
22 ≤ 24 − 2, so the rule fires at that site.

| site | usable(default) | usable(low) | low ≤ default − 2 ? |
|---|---|---|---|
| episode | 24/24 | 23/24 | 23 ≤ 22? no |
| rewrite | 24/24 | 23/24 | 23 ≤ 22? no |
| rerank | 24/24 | 22/24 | 22 ≤ 22? **yes** |

Rule ① comes first, so ② and ③ are never reached. For information only (this does not change
the verdict): total output tokens were low 40,322 and default 63,280. 0.75 × 63,280 = 47,460, and
40,322 < 47,460 (ratio 0.637). So ② would not have held either.

**Read the verdict with this mechanism.** Every one of the 4 items the low arm lost was a caller
timeout. No reply failed on its content. Every low-arm reply that arrived before its deadline was
usable: episode 23/23, rerank 22/22, and rewrite 23 of 24 items (item 1 recovered on the
shipped retry). The timeouts came from first-token stalls: `ttft_ms` 21–42 s on replies that
carried 0–312 thinking tokens and 67–352 output tokens. The next-highest unexplained first-token
delay in the run was 8.2 s (measured as `ttft_ms` − 5 ms × thinking tokens, a post-hoc measure). The 5 stalled low-arm calls that the async leg SIGKILLed kept running
(orphaned) and finished with well-formed JSON: 3 × `{"variants": …}` and 2 × `{"ranked": …}`.
The default arm had one stall of the same shape: an episode call with `ttft_ms` 30,592 and
`duration_api_ms` 32,938. The 45 s episode budget absorbed it.

Grouping stalls by time window: the low arm had 4 windows (episode 05:12:46 SIGTERM at 45 s with no
output; rewrite 05:18:27–05:19:14, three consecutive low calls with no default call in between;
rerank 05:24:10; rerank 05:25:04). The default arm had 1 window (episode 05:16:11). If each window
had been a coin flip between arms, 4 or more of 5 landing on one named arm has probability
6/32 = 0.19. **This run does not establish whether the flag causes the stalls.** The rule counts
usable items, and those items were lost.

## Per site and arm

`usable` comes from the ruler's own classification, over the same 24 items in both arms. Token and
latency figures cover calls that completed: the wrapper logged their JSON before the caller's
deadline. `api` = `duration_api_ms`. Medians are the conventional median (mean of the two middle
values when n is even). p90 is nearest-rank. `thinking` = `usage.output_tokens_details.thinking_tokens`,
which is part of `output_tokens`.

| site / arm | items | usable | calls (done / killed) | is_error | out sum | out median | out p90 | thinking sum | api median | api p90 | models |
|---|---|---|---|---|---|---|---|---|---|---|---|
| episode / default | 24 | 24 | 24 / 0 | 0 | 50,990 | 2,019.5 | 2,703 | 36,064 | 10,968.5 ms | 19,606 ms | claude-haiku-5-5 ×24 |
| episode / low | 24 | 23 | 23 / 1 (SIGTERM at 45 s, no output) | 0 | 32,910 | 1,580 | 2,017 | 19,383 | 8,278 ms | 10,990 ms | claude-haiku-5-5 ×23 |
| rewrite / default | 24 | 24 | 24 / 0 | 0 | 3,959 | 104.5 | 391 | 1,445 | 2,441 ms | 3,752 ms | claude-haiku-5-5 ×24 |
| rewrite / low | 24 | 23 | 23 / 3 (SIGKILL at 12 s; 26 calls incl. 2 shipped retries) | 0 | 2,723 | 106 | 153 | 371 | 2,451 ms | 3,197 ms | claude-haiku-5-5 ×23 (+3 orphans, same model) |
| rerank / default | 24 | 24 | 24 / 0 | 0 | 8,331 | 359 | 598 | 7,591 | 3,176 ms | 4,140 ms | claude-haiku-5-5 ×24 |
| rerank / low | 24 | 22 | 22 / 2 (SIGKILL at 20 s) | 0 | 4,689 | 194.5 | 460 | 4,009 | 2,485.5 ms | 3,624 ms | claude-haiku-5-5 ×22 (+2 orphans, same model) |

Additional rows for the same run:

- **Every completed call** had `subtype: success`, `stop_reason: end_turn`, `num_turns: 1`,
  `service_tier: standard` and exactly one model, `claude-haiku-5-5`. That holds for 140/140
  completed run calls and for the 5 orphans. No wrapper row was non-JSON.
- **Latency including timeouts.** The table's latency figures are biased in the low arm's favour,
  because its stalled calls are excluded. With the orphans' own `duration_api_ms` included (and the
  SIGTERM call counted as ≥45,000):
  - episode low: median 8,406.5, p90 11,566;
  - rewrite low: median 2,488.5, p90 21,538;
  - rerank low: median 2,680.5, p90 4,400.

  Wall time (`wall_ms`, noisy: the host's load average was 3.7–6.6 on 12 cores while the run was
  going) followed the API time.
- **Episode, paired by item** (23 items with both arms complete): low used fewer output tokens on
  20/23 items and more on 3/23. The median per-item ratio low/default was 0.688.
- **Episode lessons** (the ruler's columns; not part of the rule):
  - default: lesson 16, grounded 16, kept 16, typeOk 24, fenced 0;
  - low: lesson 14, grounded 14, kept 14, typeOk 23, fenced 0.
- **Thinking share of output.**
  - default: 45,100 / 63,280 (71.3%);
  - low: 23,763 / 40,322 (58.9%).
  - Of the 22,958-token difference, thinking accounts for 21,337 (−47.3% thinking) and visible
    output for 1,621 (−8.9%).
  - Rerank output is mostly thinking in both arms: 91.1% default and 85.5% low.
- **Item-matched totals** (only items where every call of both arms completed): episode 23,
  rewrite 22, rerank 22 items.
  - default 60,167, low 40,252, ratio 0.669.
  - Per site: episode 0.674, rewrite 0.700, rerank 0.623.
  - Adding the orphans' 832 tokens to the low arm's completed total gives 41,154 / 63,280 = 0.650.
- **CLI-reported cost** (`total_cost_usd`, list price; a subscription user is charged quota, not
  this): default $0.0583, low $0.0453 over completed calls.
- **Ruler's own SC1 gate** (`usable(candidate) >= usable(baseline) - 1`): episode PASS, rewrite PASS,
  rerank FAIL. The ruler exited 1 on rerank. Control arm (invalid OpenRouter slug, CLI fallback
  blocked): 0/2 usable at each site.

## Population (identical items in both arms)

- **episode:** `episode-flush-replay.mjs` `llmSubs` from this machine's transcripts since
  2026-10-07, computed at 05:07Z. Population 2,743 sub-episodes, 24 evenly spaced by position in
  time order. Each item's prompt user part is in `<d334>/episode-dump.json`, under `items[].context`.
- **rewrite:** the 57 queries of `test-queries.json` + `test-queries-vocab-mismatch.json` +
  `test-queries-cjk.json`, 24 evenly spaced.
- **rerank:** the 30 `test-queries.json` queries with ≥ 2 results on the seed fixture, 24 evenly
  spaced. Rewrite was stubbed off and rerank was on.
- **Arm order:** alternating by item, default first on even items. `matched.mjs` checked this
  against the call log: true on all three sites.

## Premise checks

- **`--effort` exists on 2.1.305.** `claude --help` shows
  `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)`.
- **The arms differ only in effort, on 2.1.305.** A stub probe (`<d334>/scripts/stub.mjs` as
  `ANTHROPIC_BASE_URL`, production args and env, `MAX_THINKING_TOKENS=0`) captured both request
  bodies (`<d334>/stub.jsonl`):
  - default: `model claude-haiku-5-5`, `thinking {type: adaptive, display: omitted}`,
    `output_config.effort "medium"`, `max_tokens 128000`.
  - `--effort low`: identical except `output_config.effort "low"`.
  - The system prompts were 7,339 and 7,286 bytes; the 53-byte difference was not inspected.
- **haiku-client.mjs passes no output-format flag.** Its args are `-p --model haiku
  --no-session-persistence --setting-sources project --strict-mcp-config --disable-slash-commands
  --tools ''`. The wrapper appended `--output-format json` (plus `--effort low` in arm B). Every row
  in `calls-*.jsonl` records the exact args.
- **`--no-session-persistence` was present on every call.**
- **Anomaly in the smoke, outside the run.** The first default-arm smoke call (05:04:53Z, direct
  wrapper call, production args) ran `claude-haiku-4-5-20251001`: `contextWindow` 200,000,
  3,832 uncached input tokens. The next 3 default-arm smoke calls ran `claude-haiku-5-5`, as did
  every run call. The cause was not investigated. Rows are in `<d334>/smoke-calls-default.jsonl`.

## Method as run, and deviations from the brief

1. **The wrapper is installed as `claude` on a PATH prefix, not through `CLAUDE_CODE_PATH`.** The
   ruler's `enterArm` deletes `CLAUDE_CODE_PATH` for every cli arm. A cli arm's binary is therefore
   `getClaudePath()`, which resolves in this order: `$DB_DIR/settings.json` `CLAUDE_CODE_PATH`
   (absent here), then env `CLAUDE_CODE_PATH` (deleted), then `claude` on PATH.

   One script (`<d334>/bin/claude`) serves both arms:
   - Arm A, `default`: the received args unchanged + `--output-format json`.
   - Arm B, `low`: the same + `--effort low`. It is selected by the ruler's existing `cli:low` arm
     option, which sets `CLAUDE_CODE_EFFORT_LEVEL=low`. The wrapper removes that variable before
     exec, so the flag is the only difference.

   A non-`-p` invocation (the ruler's `claude --version`) is passed straight to the real binary.
2. **Both arms ran in one process per site, alternating by item.** This is step 4's first branch,
   through `--arms cli,cli:low`. The three sites ran as three sequential ruler processes, tagged for
   the wrapper with `D334_SITE`: episode 05:07:37–05:18:15Z, rewrite 05:18:17–05:23:05Z,
   rerank 05:23:07–05:28:03Z.
3. **`OPENROUTER_API_KEY` was set to the dummy literal `d334-dummy-not-a-key`, not unset.** The
   ruler's `main()` exits 2 unless the provider mode is openrouter, and it runs its invalid-slug
   control through OpenRouter. The real key was not in the run's environment. The cli arms delete
   the variable before each call, and every run row records `openrouter_key_present: false` and
   `anthropic_key_present: false`.
4. **Environment** (`<d334>/scripts/runenv.sh`, `env -i` with a whitelist):
   - Kept: HOME, USER, LOGNAME, SHELL, LANG, PATH (with the wrapper prefix), and the six proxy
     variables.
   - Added: `CLAUDE_MEM_DIR=<d334>/data`, which keeps product state out of `~/.claude-mem-lite`;
     the spawn cwd was `<d334>/data/runtime/cli-cwd` and the wrapper strips the variable from the
     claude child. Also `D334_SITE`, `D334_ORIG_PATH` and the dummy key.
   - Removed: everything else, including `CLAUDE_EFFORT=xhigh`, `CLAUDE_MEM_METRICS`, `CLAUDECODE`
     and `CLAUDE_CODE_*`.
   - Set by the shipped code / ruler as usual: `CLAUDE_MEM_HOOK_RUNNING`, `DISABLE_CLAUDEMD_HOOKS`,
     `MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_MEM_NO_DELAY=1`. The
     rows confirm `max_thinking_tokens: "0"`.
5. **Timeout handling.** The wrapper runs claude in the background with stdout/stderr going to files.
   - SIGTERM (sync leg, episode): forwarded to claude, as production would kill it. 1 call; no output.
   - SIGKILL (async leg, rewrite/rerank): cannot be forwarded. The 5 orphans finished on their own,
     running concurrently with the next call for up to ~30 s. Their JSON was read afterwards.
6. **More smoke than "one call per wrapper".** 2 direct calls, then 6 more to check the 4.5 anomaly,
   2 stub-probe calls (no API traffic) and a ruler smoke (`--sites rewrite --n 1`, 2 calls). Smoke
   rows are kept apart, in `smoke-calls-*.jsonl` and `smoke-ruler.json`.
7. **`--since 2026-10-07` was passed explicitly.** It equals the ruler's default of 14 days.

Exact commands:

```
mkdir -p <d334>/tree && git -C /home/ai/dev/claude-mem-lite archive HEAD | tar -x -C <d334>/tree
ln -s /home/ai/dev/claude-mem-lite/node_modules <d334>/tree/node_modules
# per site, from <d334>/scripts/run.sh:
cd <d334>/tree && D334_SITE=<site> <d334>/scripts/runenv.sh node benchmark/haiku-model-ab.mjs \
  --sites <site> --n 24 --since 2026-10-07 --arms cli,cli:low --json [--dump <d334>/episode-dump.json] \
  > <d334>/result-<site>.json 2> <d334>/result-<site>.err
node <d334>/scripts/analyze.mjs <d334> > <d334>/analysis.json   # per-site/arm table, rule, episode-outputs.jsonl
node <d334>/scripts/matched.mjs <d334> > <d334>/matched.json    # item-matched totals
```

## Files (all under `<d334>`)

- **Wrapper logs:** `calls-default.jsonl` and `calls-low.jsonl`, one row per completed call.
  `calls/<id>.{in,meta,out,err,rc,killed}` holds the raw stdin, args, JSON and exit code of every
  call, killed calls included.
- **Ruler output:** `result-{episode,rewrite,rerank}.json`.
- **Episode outputs for stage 2:** `episode-dump.json` (the ruler's `--dump`) and
  `episode-outputs.jsonl`. The latter has 48 lines, one per item × arm: prompt sha256, call id, raw
  reply, parsed lesson, type, importance, grounded, kept, output tokens and model. It was saved
  although the verdict did not call for stage 2. The join matched 48/48.
- **Derived tables:**
  - `analysis.json`: per site/arm, totals, the rule, the killed calls;
  - `matched.json`: item-matched totals;
  - `percall.jsonl`: per-call ttft, thinking tokens and API time, orphans included;
  - `timeline.tsv`.
- **Premise and smoke files:** `stub.jsonl`, `smoke-calls-*.jsonl`, `smoke-ruler.json`.

## Residue

- **`~/.claude/projects`** (`find -maxdepth 1 -newer <start stamp>`): nothing new.
- **`/tmp/claude-1000/cache-break-state-c3f7ba75-29aa-4b15-b427-4e575037a48c.json`:** Claude Code
  wrote it during run call `20261021T052244982515503-2901839` (a rewrite/default call; the session
  id inside matches). Copied to `<d334>/residue-cache-break-state-copy.json`, then deleted. Re-listing
  found no `cache-break-state-*` file left.
- **`~/.claude.json`:** modified, but every running session writes this file. It has no project
  entry for the d334 cwd (10 entries; none matches `d334`/`cli-cwd`). Not edited.
- **`~/.claude/backups/.claude.json.backup.*`:** Claude Code's own rotation. Files also appeared
  before the first call (05:00:54, 05:01:57), so they cannot be attributed to this run. Not touched.
- **`~/.claude/telemetry`:** the directory mtime is 05:19:08, but `-maxdepth 1` shows no file newer
  than the start stamp.
- **New `/tmp` entries** (`claudemd-test-*`, `.tmp*`, `code-graph-mcp`, `gh-cli-cache`): they belong
  to other processes.
- **Processes:** after the run, `pgrep` found no leftover `claude -p`, stub or ruler processes.
- **The repo:** no file changed by this task. `git status` shows ` M secret-scrub.mjs`, which is the
  other agent's work.

## Report

**Changes.** No repository file changed. The new files are all under `<d334>`: the wrapper, the
runner, the analysis scripts, the logs and this report. One residue file outside the scratchpad was
deleted (listed above).

**Verification.**

| check | result | detail |
|---|---|---|
| full A/B (3 sites × 2 arms × 24 items) | passed | 146 calls (default 72, low 74): 140 completed and 6 killed; of the killed calls, 5 orphans finished and 1 SIGTERM call had no output |
| model check | passed | 140/140 completed + 5/5 orphans = `claude-haiku-5-5` |
| is_error | passed | 0/140 |
| stub body probe | passed | effort medium vs low, both adaptive thinking |
| ruler control | passed | 0/2 usable per site |
| ruler SC1 | failed at rerank | 22 vs 24 |

**Open items.**

- **Who decides.** The verdict follows the pre-registered rule: ① rejects `--effort low`. Every lost
  item was a first-token-stall timeout, not a bad reply, and this run cannot tell whether the stalls
  come from the flag. Whether to re-test is the user's decision. Options:
  - (a) accept ① and close D#334 with no change;
  - (b) pre-register a stall-aware rule and re-run with a fresh rule. That costs about 20 minutes of
    quota; a larger n, or several time windows, would be needed to separate stall rate by arm.

  My pick: (a) as the recorded verdict. Mention the stall asymmetry (4 vs 1 windows) in D#334's
  close note, so a later re-test starts from it.
- **Unexplained:** the first-call `claude-haiku-4-5-20251001` resolution in the smoke.
