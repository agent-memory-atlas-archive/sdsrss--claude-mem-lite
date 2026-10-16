// E2E 2026-10-16 (cli F15): a row maintenance hid (compressed_into = COMPRESSED_AUTO) could not be
// brought back from the CLI: `update 2 --importance 3 --lesson "…"` wrote both fields and the row
// stayed out of every search. A person setting importance or writing a lesson on it has said the
// row is worth keeping, so the shared update core shows it again and says so.

import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { applyObsUpdate } from '../lib/observation-write.mjs';
import { COMPRESSED_AUTO } from '../utils.mjs';

function hiddenRow(db) {
  const id = Number(
    insertObs(db, { title: 'Turbo cache lives in ~/.cache/turbo', importance: 1 }).lastInsertRowid,
  );
  db.prepare('UPDATE observations SET compressed_into = ?, hidden_at = ? WHERE id = ?').run(
    COMPRESSED_AUTO,
    Date.now(),
    id,
  );
  return id;
}
const state = (db, id) =>
  db.prepare('SELECT compressed_into, hidden_at FROM observations WHERE id = ?').get(id);

describe('update on a row maintenance hid', () => {
  it('importance brings it back, and the result says so', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const id = hiddenRow(db);
    const cols = applyObsUpdate(db, id, { importance: 3 });
    expect(state(db, id)).toEqual({ compressed_into: 0, hidden_at: null });
    expect(cols.join(', ')).toMatch(/visible again/);
  });
  it('a lesson brings it back', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const id = hiddenRow(db);
    applyObsUpdate(db, id, { lesson_learned: 'Clear ~/.cache/turbo when builds go stale' });
    expect(state(db, id).compressed_into).toBe(0);
  });
  it('a title edit alone leaves it hidden', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const id = hiddenRow(db);
    const cols = applyObsUpdate(db, id, { title: 'Turbo cache dir' });
    expect(state(db, id).compressed_into).toBe(COMPRESSED_AUTO);
    expect(cols.join(', ')).not.toMatch(/visible again/);
  });
  it('a merged row (positive keeper id) is not touched', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const keeper = Number(insertObs(db, { title: 'keeper' }).lastInsertRowid);
    const member = Number(insertObs(db, { title: 'member' }).lastInsertRowid);
    db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ?').run(keeper, member);
    applyObsUpdate(db, member, { importance: 3 });
    expect(state(db, member).compressed_into).toBe(keeper);
  });
});
