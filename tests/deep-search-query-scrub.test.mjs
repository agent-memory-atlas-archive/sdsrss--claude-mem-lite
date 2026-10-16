// A secret typed into a search query reached the LLM provider verbatim through deep search's
// rewrite prompt and the rerank prompt, including on the automatic escalation path that is the
// MCP default (E2E 2026-10-16, bg P2-1). Every other LLM input was already scrubbed; the query is
// now scrubbed before both prompts. The local FTS search still runs the query as typed.

import { describe, it, expect } from 'vitest';
import { buildRewritePrompt } from '../deep-search.mjs';
import { llmRerankOrder } from '../rerank.mjs';

// Assembled, so the literal is not a credential-shaped string in the repository.
const KEY = 'sk-ant-api03-' + 'Q7xZ'.repeat(10) + 'AbCd';
const GH = 'ghp_' + 'a1B2c3D4'.repeat(4) + 'zz11';

describe('deep search does not send a secret in the query to the model', () => {
  it('the rewrite prompt carries the query with the key scrubbed', () => {
    const p = buildRewritePrompt(`where did I put ${KEY}`);
    expect(p.user).toContain('where did I put');
    expect(p.user).not.toContain(KEY);
  });

  it('the rerank prompt carries the query with the token scrubbed', async () => {
    let sent = null;
    await llmRerankOrder(
      `rotate leaked token ${GH}`,
      [{ sid: 1, text: 'rotated the token' }],
      async (prompt) => {
        sent = prompt;
        return { ranked: [1] };
      },
    );
    expect(sent.user).toContain('rotate leaked token');
    expect(sent.user).not.toContain(GH);
  });
});
