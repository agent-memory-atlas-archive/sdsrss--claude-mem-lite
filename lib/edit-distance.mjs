// lib/edit-distance.mjs — Levenshtein distance with an early exit, for "did you mean" lists.
//
// A leaf (no imports): the CLI's unknown-flag suggester (cli/common.mjs) and the project-name
// suggester (project-utils.mjs) both ask it, and project-utils sits on the hook path, which must
// not import the CLI layer to reach one function.

/** Levenshtein distance, early-exit past `max` (returns max + 1 then). */
export function editDistance(a, b, max = 2) {
  const m = a.length,
    n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1; // whole row already past budget → give up
    prev = cur;
  }
  return prev[n];
}
