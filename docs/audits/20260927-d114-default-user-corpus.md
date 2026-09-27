# D#114 — a default-user corpus: what Stop sees, and what Last Session could say

Measured 2026-09-27 (15:00–16:00Z) on Claude Code 2.1.283, default model, repo `main` @
v6.17.1. Follows `20260927-d114-last-session-inputs.md`, which found that no local population
lacks the maintainer's four-section report convention.

## Method

- **Population.** 30 headless sessions (`claude -p`), 8 of them with a second turn
  (`--resume`), on sandbox copies (`git archive HEAD`) of four local repos: gsd-lite (js),
  llm_wiki (mjs), daagu (python), claude-mem-lite. Task mix: fix, add test, explain,
  refactor, review, small feature, docs, commit. 18 sessions changed the repo, 12 only
  answered (ground truth: `git status` / `git log` of each sandbox, not tool calls — the
  default agent delegated most edits to subagents, whose calls are not in the main transcript).
- **Isolation.** `--setting-sources project`: no user settings, plugins, hooks or user
  CLAUDE.md. Ruler check, same question to both arms ("does your context include
  AI-CODING-SPEC; which hooks/plugins do you see"): isolated arm NO / NONE, control arm YES
  and all eight plugins. Tools were allow-listed (read/edit, git, local test runners; no
  `npx` downloads), so some sessions report being unable to run a command.
- **Report extraction.** `lib/summary-extractor.mjs` `extractStructuredSummary` over the last
  assistant text at EVERY turn end, the condition Stop uses (`done || notDone`). Positive
  control: the same script on 3 of the maintainer's own transcripts found a report in 3/3.
- **Candidates** for the Last Session "Completed" line (rendered at 120 chars by
  `buildSummaryLines`), from the final assistant message with code blocks and markdown
  punctuation flattened: `head` = first 120 chars; `lead` = first sentence (≤120); `tail` =
  last 120 chars.
- **Labels.** One fresh subagent, blind to which letter was which candidate (order shuffled
  per session), scored each candidate against the ground truth: 2 = states the outcome
  correctly, 1 = true but vague, 0 = uninformative (preamble, offer, question), -1 = wrong or
  misleading.

## Results

| | value |
|---|---|
| Sessions where Stop's extractor finds a report, any turn end | **0 / 30** |
| … at the final turn | 0 / 30 |
| Final message ends with `?` | 7 / 30 |
| Final message length, median | 1533 chars |

| Candidate | mean | 2 | 1 | 0 | -1 |
|---|---|---|---|---|---|
| `head` | **1.73** | 22 | 8 | 0 | 0 |
| `lead` | 1.30 | 11 | 17 | 2 | 0 |
| `tail` | 0.03 | 0 | 1 | 29 | 0 |

`head` ≥ 1 in 18/18 changed and 12/12 answer sessions. Paired against `lead`: head better in
13, equal in 17, worse in 0. `tail` is almost always an offer or a question ("Should I go
ahead…?"). Today's fallback shows the first prompt as Request and nothing as Completed (19 of
20 recent sessions in the first audit).

Examples (score in brackets):
- t04, "Run the test suite and tell me what's failing" — head [2]: "I fixed the failures, and the
  full suite now passes: 1510 tests pass, 0 fail…"; tail [0]: "…It never copies node modules,
  so I left it alone."
- t17, "Find where JWT tokens are validated… are expired tokens rejected" — head [2]: "Yes, the
  backend rejects expired tokens and returns a 401…"; tail [0]: "…I can add the require
  option and a test… if you'd like."
- t30, second turn "commit that" — head [1]: "There's nothing to commit yet. The worker made no
  changes…" (true; says what did not happen rather than what did).

## What this supports, and what it does not

- Supports: for a user without a report convention, Stop never gets a report, so Last
  Session's Completed is empty; the first 120 characters of the final assistant message would
  fill it with a line that is correct and informative in 22/30 and correct but vague in 8/30,
  with no wrong line in 30. The last 120 characters would not.
- Does not support: other models, long interactive sessions whose last turn is a one-word
  reply ("thanks"), non-English users, or whether a filled line changes what the next session
  does. One labeler, no inter-rater check. Sessions ran under a restricted tool list.
- The final message is model output that can quote untrusted file or tool text: a floor built
  from it must be scrubbed on write and defanged on render like any stored text.

Cost: $21.71 of model usage for the 30 sessions, $0.30 for the isolation probes.
