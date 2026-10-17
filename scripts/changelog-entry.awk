# This version's CHANGELOG.md entry, without its heading: the lines after `## <t> …` up to the next
# `## ` heading. A `## ` line inside a fenced code block is text, not a heading. Used by
# .github/workflows/publish.yml (the entry check and the GitHub Release body) and
# tests/changelog-entry.test.mjs. Usage: awk -v t=v1.2.3 -f scripts/changelog-entry.awk CHANGELOG.md
/^```/ { fence = !fence }
!fence && $1 == "##" && $2 == t { f = 1; next }
f && !fence && /^## / { exit }
f
