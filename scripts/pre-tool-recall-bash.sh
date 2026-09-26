#!/usr/bin/env bash
# claude-mem-lite: PreToolUse:Bash prefilter for file recall.
#
# Why this hook exists (docs/audits/20260926-154904-session-history-analysis-r2.md, N1):
# pre-tool-recall.js fires on Edit|Write|NotebookEdit|Read, and on Opus 5.5 only 18.0% of
# file edits and 14.7% of file reads went through those tools — the rest were `sed -i`,
# `cat > f <<EOF`, python patches and `sed -n`/`cat`. The face with the highest measured
# cite rate (41.7%) fell to ~1/9 of its former firing rate without a single error.
#
# Why a bash prefilter: Bash is most tool calls, and most of them (git, npm, vitest, gh,
# grep) read or write no single file. Starting Node for each costs ~55 ms; this script
# costs a bash start and two regex tests, and hands off only commands that LOOK like they
# view or write a file. It is deliberately loose — pre-tool-recall.js parses the command
# properly (lib/bash-file-targets.mjs) and exits silently when there is no target.
#
# The file name must contain `pre-tool-recall`: lib/citation-tracker.mjs attributes a
# transcript's hook attachment to the pretool face by that substring of the hook COMMAND,
# and this command line is the only one the transcript records for a Bash firing.

[[ -n "$CLAUDE_MEM_HOOK_RUNNING" ]] && exit 0

input=$(head -c 262144)

# The command string, still JSON-escaped (`\n`, `\"`) — the tests below do not need it
# decoded. `\"command\"` also appears inside other fields only as escaped text (`\\\"`),
# which this anchored form does not match first: tool_input precedes tool_use_id/cwd.
if [[ "$input" =~ \"command\"[[:space:]]*:[[:space:]]*\"(([^\"\\]|\\.)*)\" ]]; then
  cmd="${BASH_REMATCH[1]}"
else
  exit 0
fi

# fd plumbing is never a file target.
cmd="${cmd//[0-9]>&[0-9]/}"
cmd="${cmd//>&[0-9]/}"
cmd="${cmd//>\/dev\/null/}"

# Tokens the node side never recalls, dropped before the tests below: /tmp paths (session
# scratch; kept when the project itself lives under /tmp) and `$VAR…` expansions. Measured
# on this repo's transcripts, they were the bulk of the commands that started Node for
# nothing.
scan="$cmd"
_n=0
if [[ "${CLAUDE_PROJECT_DIR:-}" != /tmp/* ]]; then
  # Anchored at a token start: `<repo>/tmp/x.mjs` is a project file, not /tmp.
  while [[ $_n -lt 20 && "$scan" =~ (^|[[:space:]\"\'=])(/tmp/[^[:space:]\"\']*) ]]; do
    scan="${scan/"${BASH_REMATCH[2]}"/}"
    _n=$((_n + 1))
  done
fi
while [[ $_n -lt 40 && "$scan" =~ (\$[A-Za-z_{][^[:space:]\"\']*) ]]; do
  scan="${scan/"${BASH_REMATCH[1]}"/}"
  _n=$((_n + 1))
done

# A file-shaped token must appear somewhere (`lib/x.mjs`, `"/abs/y.json"`).
[[ "$scan" =~ \.[A-Za-z][A-Za-z0-9_-]{0,9}([^A-Za-z0-9_-]|$) ]] || exit 0

# …and one of: a view/write verb at the START of a command (after `;`, `&&`, `||`, `(`
# or a newline — NOT after a single `|`, where `| head` / `| sed -n` read stdin, which
# is most Bash tails), a pipe into `tee`, an inline or heredoc program (`python3 -c`,
# `node -e`, `python3 - <<`; a plain `node x.mjs` runs a file, it does not edit one),
# or an output redirection.
start='(^|;|&&|\|\||\(|\\n)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(sudo[[:space:]]+)?'
verb_re="${start}(cat|head|tail|nl|less|more|bat|sed|perl|tee|cp|mv|touch|install)[[:space:]]"
prog_re="${start}(python|python3|node)([[:space:]]+--?[A-Za-z0-9_=.-]+)*[[:space:]]+(-[a-zA-Z]*[cep]|-|<<)([[:space:]]|$|')"
tee_re='\|[[:space:]]*tee[[:space:]]'
redir_re='>[[:space:]]*[^[:space:]&|;>]'
if [[ "$cmd" =~ $verb_re ]] || [[ "$cmd" =~ $prog_re ]] || [[ "$cmd" =~ $tee_re ]] || [[ "$scan" =~ $redir_re ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 0
  printf '%s' "$input" | node "${SCRIPT_DIR}/scripts/hook-launcher.mjs" scripts/pre-tool-recall.js
fi
exit 0
