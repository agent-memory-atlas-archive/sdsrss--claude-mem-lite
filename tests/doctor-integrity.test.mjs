// D#541, D#550: doctor runs SQLite's integrity check read-only, before its FTS check (which opens
// the store read-write), and under a failure names the README's recovery steps and the newest
// backup snapshot, with no command that moves or replaces the store.
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initSchema } from '../schema.mjs';
import { insertObs, insertSession, makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'claude-mem-lite.db';
const DOC = 'https://github.com/sdsrss/claude-mem-lite#damaged-database';
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const newDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-doctor-integrity-')));
const sha = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');

function doctor(dataDir, args = []) {
  const home = newDir();
  return spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor', ...args], {
    cwd: home,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: home,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      MEM_NO_AUTO_ADOPT: '1',
      MEM_QUIET_HOOKS: '1',
    },
  }).stdout;
}

function buildStore(dir, rows = 300) {
  const p = join(dir, DB);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'sess-1' });
  for (let i = 0; i < rows; i++)
    insertObs(db, { title: `obs ${i} alpha`, narrative: `${'n'.repeat(300)} word${i}`, epochOffset: i });
  db.close();
  return p;
}

function pages(p, name) {
  const db = new Database(p, { readonly: true });
  try {
    return db
      .prepare(`SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY pageno`)
      .pluck()
      .all(name);
  } finally {
    db.close();
  }
}

function plant(p, pageno, offset, bytes) {
  const fd = openSync(p, 'r+');
  try {
    writeSync(fd, Buffer.from(bytes), 0, bytes.length, (pageno - 1) * 4096 + offset);
  } finally {
    closeSync(fd);
  }
}

function walChecksum(buf, s0, s1, be) {
  for (let i = 0; i + 7 < buf.length; i += 8) {
    const a = be ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const b = be ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + a + s1) >>> 0;
    s1 = (s1 + b + s0) >>> 0;
  }
  return [s0, s1];
}

/** 200 rows checkpointed, 40 more in the log, and the log's newest frame of an index leaf garbled, re-signed. */
function damagedLog(dir) {
  const p = buildStore(dir, 200);
  const db = new Database(p);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const keep = readFileSync(p);
  db.pragma('wal_autocheckpoint = 0');
  for (let i = 0; i < 40; i++)
    insertObs(db, { title: `late ${i}`, narrative: 'm'.repeat(300), epochOffset: 500 + i });
  const wal = Buffer.from(readFileSync(`${p}-wal`));
  db.close();
  writeFileSync(p, keep);
  const be = wal.readUInt32BE(0) === 0x377f0683;
  const frames = [];
  for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) frames.push({ o, pg: wal.readUInt32BE(o) });
  writeFileSync(`${p}-wal`, wal);
  rmSync(`${p}-shm`, { force: true });
  const inLog = new Set(frames.map((f) => f.pg));
  const leaf = pages(p, 'idx_obs_project_live').find((pg) => inLog.has(pg));
  expect(leaf, 'premise: an index leaf in the log').toBeDefined();
  const target = frames.filter((f) => f.pg === leaf).at(-1);
  wal.fill(0x41, target.o + 24 + 1000, target.o + 24 + 1064);
  let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, be);
  for (const f of frames) {
    [s0, s1] = walChecksum(wal.subarray(f.o, f.o + 8), s0, s1, be);
    [s0, s1] = walChecksum(wal.subarray(f.o + 24, f.o + 24 + 4096), s0, s1, be);
    wal.writeUInt32BE(s0, f.o + 16);
    wal.writeUInt32BE(s1, f.o + 20);
  }
  writeFileSync(`${p}-wal`, wal);
  rmSync(`${p}-shm`, { force: true });
  return p;
}

describe('doctor: database integrity', () => {
  it('passes a sound store, then checks its search indexes', () => {
    const dir = newDir();
    buildStore(dir, 20);
    const out = doctor(dir);
    expect(out).toMatch(/✓ Database integrity: ok/);
    expect(out).toMatch(/✓ FTS5 integrity: all indexes healthy/);
  });

  it('fails a damaged store, points at the recovery steps, and moves nothing', () => {
    const dir = newDir();
    const p = buildStore(dir);
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    const before = sha(p);
    const out = doctor(dir);
    expect(out).toMatch(/✗ Database integrity: /);
    expect(out).toContain(DOC);
    expect(out).toMatch(/FTS5 integrity: not checked — it writes to the database, which did not pass/);
    expect(out).not.toMatch(/Or restore a backup snapshot/);
    expect(out).not.toMatch(/\b(mv|cp|rm) /);
    expect(sha(p)).toBe(before);
  });

  // A read-write close (the FTS check's) would fold the damaged frame into the main file, over the
  // older copy of that page the main file holds.
  it('writes nothing to a store whose log holds a damaged frame', () => {
    const dir = newDir();
    const p = damagedLog(dir);
    const before = { main: sha(p), wal: sha(`${p}-wal`) };
    const out = doctor(dir);
    expect(out).toMatch(/✗ Database integrity: /);
    expect({ main: sha(p), wal: sha(`${p}-wal`) }).toEqual(before);
  });

  // The v6.31.0 round-3 claims review F2: a read-only integrity_check evaluates no CHECK constraint.
  it('fails a store holding a value outside a CHECK list', () => {
    const dir = newDir();
    const p = buildStore(dir, 20);
    const db = new Database(p);
    db.prepare(`UPDATE observations SET type = 'decision' WHERE id = 7`).run();
    db.close();
    const buf = readFileSync(p);
    const at = buf.indexOf(Buffer.from('decisionobs 6'));
    expect(at, 'premise: the row is in the main file').toBeGreaterThan(0);
    buf[at + 7] = 0x5a;
    writeFileSync(p, buf);
    expect(doctor(dir)).toMatch(/✗ Database integrity: CHECK constraint failed in observations \(1 row\)/);
  });

  it('names the newest backup snapshot and its time', () => {
    const dir = newDir();
    const p = buildStore(dir);
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    let t = 1_790_000_000;
    for (const stamp of ['2026-09-01T00-00-00-000Z', '2026-09-06T00-00-00-000Z']) {
      const snap = join(dir, `${DB}.pre-maintain-${stamp}-1-1.bak`);
      writeFileSync(snap, 'snap');
      utimesSync(snap, t, t);
      t += 3600;
    }
    const out = doctor(dir);
    expect(out).toContain(
      `the newest of 2 is ${join(dir, `${DB}.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak`)}`,
    );
    expect(out).toContain(`from ${new Date((t - 3600) * 1000).toISOString()}`);
  });

  it('carries the recovery pointer in --json', () => {
    const dir = newDir();
    const p = buildStore(dir);
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    const out = doctor(dir, ['--json']);
    const report = JSON.parse(out.slice(out.indexOf('{')));
    const check = report.checks.find((c) => /^Database integrity:/.test(c.message || ''));
    expect(check, JSON.stringify(report.checks, null, 1)).toBeTruthy();
    expect((check.details ?? []).join('\n')).toContain(DOC);
  });
});
