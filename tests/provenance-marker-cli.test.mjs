// CLI half of tests/provenance-marker.test.mjs. Separate file because mem-cli needs
// schema.mjs mocked onto an in-memory DB, and server.mjs exits at import under that mock.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { AUTO_HEADER, AUTO_LEGEND, AUTO_MARK } from '../format-utils.mjs';

let testDb;

vi.mock('../schema.mjs', async (importOriginal) => {
  const original = await importOriginal();
  const stub = () =>
    new Proxy(testDb, {
      get(target, prop) {
        if (prop === 'close') return () => {};
        return target[prop];
      },
    });
  return { ...original, ensureDb: stub, ensureDbWithWalRecovery: stub };
});

vi.mock('../utils.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, inferProject: () => 'prov' };
});

const { run } = await import('../mem-cli.mjs');

async function captureStdout(fn) {
  let output = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => ((output += s), true);
  process.stderr.write = (s) => ((output += s), true);
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return output;
}

const lineOf = (text, id) => text.split('\n').find((l) => l.startsWith(`#${id} `)) || '';

describe('CLI search and get mark machine-written observations', () => {
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

  it('CLI search marks only the machine-written row and explains the mark', async () => {
    const text = await captureStdout(() => run(['search', 'gizmo', '--project', 'prov']));
    expect(lineOf(text, autoId)).toContain(` ${AUTO_MARK} `);
    expect(lineOf(text, manualId)).not.toContain(AUTO_MARK);
    expect(text).toContain(AUTO_LEGEND);
  });

  it('CLI get names a machine-written row in its header and leaves a save unmarked', async () => {
    const text = await captureStdout(() => run(['get', `${manualId},${autoId}`]));
    const header = (id) => text.split('\n').find((l) => l.startsWith(`#${id} [`)) || '';
    expect(header(autoId).endsWith(` · ${AUTO_HEADER}`)).toBe(true);
    expect(header(manualId)).toMatch(new RegExp(`^#${manualId} \\[discovery\\] \\S+$`));
  });
});
