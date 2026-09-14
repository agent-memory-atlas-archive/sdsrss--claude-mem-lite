// The README must not claim the FTS index stems, because it does not.
//
// `observations_fts` is created with no `tokenize=` clause, so FTS5 uses `unicode61`: a
// query term matches the word forms actually stored. README.md carried the opposite — "PRF
// terms are now stemmed with the same Porter algorithm used by FTS5, ensuring PRF expansion
// terms match the search index" — which inverts both halves. FTS5 here does not stem, and
// `extractPRFTerms` deliberately emits SURFACE forms *because* it does not; emitting a stem
// would match nothing.
//
// That claim had already been retracted once, in `tfidf.mjs`'s own docblock ("the 'porter
// tokenizer' claim the old docblock made here is NOT true"), and the README copy survived
// the retraction — the recurring failure this repo keeps paying for. So the guard is
// two-sided rather than a spelling check: it asserts the tokenizer's real behaviour against
// a live schema, and asserts the prose does not contradict it. Adding a porter tokenizer
// later is a legitimate change — it just has to take the README with it, which is the point.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession } from './test-helpers.mjs';

// D#207: join() rather than new URL('../README.md', import.meta.url).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('FTS tokenizer: behaviour and the README agree', () => {
  it('the observations index does not stem — a stem matches nothing, the surface form matches', () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'p' });
    const now = Date.now();
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, text, narrative, importance, created_at, created_at_epoch)
       VALUES ('s', 'p', 'bugfix', 'caching layer crashes on empty input', 'caching layer crashes on empty input', '', 2, ?, ?)`,
    ).run(new Date(now).toISOString(), now);
    // `observations_fts` is external-content (`content='observations'`), so a row in the base
    // table is not in the index until a writer puts it there. Use the product's own populate
    // command — the one schema.mjs and `fts-check rebuild` issue — so what is indexed here is
    // what the product would index, rather than a hand-built row that could disagree.
    db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");

    const match = (q) =>
      db.prepare('SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH ?').get(q).c;

    // Premise: the row is indexed at all. Without this, every zero below reads as "unstemmed"
    // when it might just be "not in the index".
    expect(match('caching')).toBe(1);

    // The property itself, stated in both directions so it cannot pass vacuously.
    expect(match('cach')).toBe(0); // bare porter stem
    expect(match('crash')).toBe(0); // singular of a stored plural
    expect(match('crashes')).toBe(1);

    // And it is the DEFAULT tokenizer that produces this, not an explicit choice — the
    // sentence a future porter migration would have to change.
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'observations_fts'").get().sql;
    expect(sql).not.toMatch(/tokenize/i);
    db.close();
  });

  it('README does not claim FTS5 stems', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    // Guard the guard: the file has to be the one carrying the search-quality prose, or the
    // assertion below passes because it is reading something else.
    expect(readme).toMatch(/Pseudo-relevance feedback/i);

    const offenders = readme
      .split('\n')
      .filter((line) => /porter/i.test(line) && /fts5?/i.test(line))
      .filter((line) => !/not stemmed|does not stem|unicode61/i.test(line));

    expect(offenders, `README lines tying Porter to FTS5:\n${offenders.join('\n')}`).toEqual([]);
  });
});
