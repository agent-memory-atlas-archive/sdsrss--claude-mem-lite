// Search and get mark an observation that was machine-written rather than saved explicitly.
// Explicit saves are the large majority of a typical store, so they stay unmarked and the
// machine-written minority carries the mark. isAutoWritten is the single read-side test of
// the session-id namespace saveObservation writes under.

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { isAutoWritten, saveObservation } from '../lib/save-observation.mjs';
import { snippetAddsInfo } from '../search-engine.mjs';
import { AUTO_LEGEND, AUTO_MARK } from '../format-utils.mjs';
import { handleSearchForTest } from '../server.mjs';

let testDb;

const lineOf = (text, id) => text.split('\n').find((l) => l.startsWith(`#${id} `)) || '';

describe('isAutoWritten', () => {
  it('is false for an explicit save', () => {
    expect(isAutoWritten('manual-prov')).toBe(false);
  });

  it('is true for every machine writer', () => {
    expect(isAutoWritten('hook-prov-1a2b3c4d')).toBe(true);
    expect(isAutoWritten('import-8e0fba1e-1100-4c5e-9d1a-000000000000')).toBe(true);
    expect(isAutoWritten('compress-prov')).toBe(true);
    // Rows imported from older stores carry a bare session uuid.
    expect(isAutoWritten('8e0fba1e-1100-4c5e-9d1a-000000000000')).toBe(true);
  });

  it('is false when the id is missing, so an unselected column never mislabels a save', () => {
    expect(isAutoWritten(null)).toBe(false);
    expect(isAutoWritten(undefined)).toBe(false);
    expect(isAutoWritten('')).toBe(false);
  });

  it('agrees with the namespace saveObservation actually writes', () => {
    testDb = createTestDb();
    saveObservation(testDb, { content: 'a deliberate note about the gizmo', project: 'prov' });
    const row = testDb.prepare('SELECT memory_session_id FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(isAutoWritten(row.memory_session_id)).toBe(false);
  });
});

describe('snippetAddsInfo', () => {
  it('is false when the excerpt is the title with highlight markers', () => {
    expect(
      snippetAddsInfo('»gizmo« calibration drifts after reboot', 'gizmo calibration drifts after reboot'),
    ).toBe(false);
  });

  it('is true when the excerpt says something the title does not', () => {
    expect(snippetAddsInfo('…the »gizmo« loses its offset on cold boot…', 'Gizmo calibration')).toBe(true);
  });

  it('is false for a missing or trivially short excerpt', () => {
    expect(snippetAddsInfo('', 'x')).toBe(false);
    expect(snippetAddsInfo(null, 'x')).toBe(false);
    expect(snippetAddsInfo('»gizmo«', 'y')).toBe(false);
  });
});

describe('search and get mark machine-written observations', () => {
  let manualId, autoId;

  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 'manual-prov', project: 'prov' });
    insertSession(testDb, { id: 'hook-prov-1a2b3c4d', project: 'prov' });
    manualId = Number(
      insertObs(testDb, {
        sessionId: 'manual-prov',
        project: 'prov',
        title: 'gizmo calibration drifts after reboot',
        narrative: 'gizmo calibration drifts after reboot',
      }).lastInsertRowid,
    );
    autoId = Number(
      insertObs(testDb, {
        sessionId: 'hook-prov-1a2b3c4d',
        project: 'prov',
        title: 'Recalibrated gizmo offsets',
        narrative: 'Ran the gizmo offset script against the bench rig and stored the new offsets',
      }).lastInsertRowid,
    );
  });

  it('MCP search marks only the machine-written row and explains the mark', async () => {
    const out = await handleSearchForTest(testDb, { query: 'gizmo', project: 'prov' }, {});
    const text = out.content[0].text;
    expect(lineOf(text, autoId)).toContain(`] ${AUTO_MARK} `);
    expect(lineOf(text, manualId)).not.toContain(AUTO_MARK);
    expect(text.split('\n')[0]).toContain(AUTO_LEGEND);
  });

  it('MCP search omits the legend when every row is an explicit save', async () => {
    testDb.prepare('DELETE FROM observations WHERE id = ?').run(autoId);
    const out = await handleSearchForTest(testDb, { query: 'gizmo', project: 'prov' }, {});
    const text = out.content[0].text;
    expect(text).toContain(`#${manualId} `);
    expect(text).not.toContain(AUTO_MARK);
  });

  it('MCP search does not repeat a short save title as its snippet', async () => {
    const out = await handleSearchForTest(testDb, { query: 'gizmo', project: 'prov' }, {});
    const lines = out.content[0].text.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`#${manualId} `));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).not.toMatch(/calibration drifts after reboot/);
  });

  it('MCP search still shows a snippet that adds to the title', async () => {
    const out = await handleSearchForTest(testDb, { query: 'gizmo', project: 'prov' }, {});
    const lines = out.content[0].text.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`#${autoId} `));
    expect(lines[at + 1]).toMatch(/offset script against the bench rig/);
  });
});
