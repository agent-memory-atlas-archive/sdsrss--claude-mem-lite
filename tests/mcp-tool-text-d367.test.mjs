// D#367 (E2E 2026-10-16 MCP report §6/§8/§10/§20): five places where the tool surface told the
// model something the server does not do. The model follows the description, gets a wrong or
// empty answer, and nothing says why. These pin the corrected text and the two argument aliases;
// the real-model A/B behind each change is tasks/specs/d367-tool-descriptions.md.
import { describe, it, expect } from 'vitest';
import { memSearchSchema } from '../tool-schemas.mjs';

describe('mem_search query (P2-8)', () => {
  it('does not claim FTS5 syntax, and names what the sanitiser drops', () => {
    const text = memSearchSchema.query.description;
    expect(text).not.toMatch(/FTS5 syntax/);
    for (const op of ['NOT', '-term', 'prefix*', 'column:', '"phrase"']) expect(text).toContain(op);
  });
});
