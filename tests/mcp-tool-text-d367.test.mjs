// D#367 (E2E 2026-10-16 MCP report §6/§8/§10/§20): five places where the tool surface told the
// model something the server does not do. The model follows the description, gets a wrong or
// empty answer, and nothing says why. These pin the corrected text and the two argument aliases;
// the real-model A/B behind each change is tasks/specs/d367-tool-descriptions.md.
import { describe, it, expect } from 'vitest';
import { tools, memSearchSchema } from '../tool-schemas.mjs';

const descriptionOf = (name) => tools.find((t) => t.name === name).description;

describe('mem_search query (P2-8)', () => {
  it('does not claim FTS5 syntax, and names what the sanitiser drops', () => {
    const text = memSearchSchema.query.description;
    expect(text).not.toMatch(/FTS5 syntax/);
    for (const op of ['NOT', '-term', 'prefix*', 'column:', '"phrase"']) expect(text).toContain(op);
  });
});

describe('mem_get (P2-10)', () => {
  it('no longer tells the model to pass source for S#/P# hits', () => {
    expect(descriptionOf('mem_get')).not.toMatch(/pass source=/);
    expect(descriptionOf('mem_get')).toMatch(/each prefix routes itself/);
  });
});

describe('mem_recent (P2-20)', () => {
  it('does not say it does no filtering', () => {
    expect(descriptionOf('mem_recent')).not.toMatch(/does no filtering/);
    expect(descriptionOf('mem_recent')).toMatch(/filters by type and date, not by words/);
  });
});

describe('mem_defer_list (P2-20)', () => {
  it('points a single item at mem_get D#N', () => {
    expect(descriptionOf('mem_defer_list')).not.toMatch(/look up the row directly/);
    expect(descriptionOf('mem_defer_list')).toContain('mem_get ids=["D#N"]');
  });
});
