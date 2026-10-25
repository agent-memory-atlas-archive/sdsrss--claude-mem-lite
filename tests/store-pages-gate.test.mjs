// D#591: an index rebuild frees pages and allocates new ones, so on a store whose freelist lists a
// page a table still uses, the rebuild writes the new index over that table's rows. v6.30.8's
// doctor rebuilt the FTS5 indexes whenever FTS5's own check failed, and `fts-check rebuild` /
// `mem_fts_check rebuild` rebuild every index, without looking at the pages first; on the D#546
// regression set that garbled rows (docs/audits/20261025-v6.30.9-pretag-r1-defects.md). Every
// rebuild now checks the pages first and writes nothing when they are damaged.
//
// SQLite's integrity check cannot be that check on its own: in SQLite 3.53.4 it skips the freelist
// and the unused-page scan whenever a virtual table comes first in its schema walk, which is the
// case on a VACUUMed store and on every VACUUM INTO snapshot (the 'vacuum' fixtures below read
// 'ok' there).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as schema from '../schema.mjs';
import { handleMemFtsCheck } from '../server/fts-check.mjs';
import { checkSnapshot, dataDirCopyCommand } from '../lib/db-unusable.mjs';
import { pathWithClaudeStub } from './claude-stub.mjs';
import {
  intactObservations,
  makeFixtureTracker,
  writeCrossLinkedStore,
  writeStoreSnapshot,
} from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BSQ_URL = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href;
const SCHEMA_URL = pathToFileURL(join(REPO, 'schema.mjs')).href;

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-pagegate-')));
const storeIn = (dir) => join(dir, 'claude-mem-lite.db');
const sha = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');
/** The product's opener, once, on the store at `path` (named claude-mem-lite.db), in a child. */
const openedByProduct = (path) => {
  execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(SCHEMA_URL)}).then((m) => m.ensureDbWithWalRecovery().close())`],
    { env: { ...process.env, CLAUDE_MEM_DIR: dirname(path) }, timeout: 60_000 },
  );
};

/** The rows SQLite's own integrity check returns, from a copy. */
const integrityRows = (path) => {
  const dir = dataDir();
  const copy = join(dir, 'premise.db');
  copyFileSync(path, copy);
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
  const db = new Database(copy);
  try {
    return db.prepare('PRAGMA integrity_check(10)').pluck().all();
  } finally {
    db.close();
  }
};

/** checkStorePages on a fresh read-write handle to `path`. */
const gate = (path) => {
  const db = new Database(path);
  try {
    return schema.checkStorePages(db);
  } finally {
    db.close();
  }
};

/** Rewrites the store's file image, after the last handle on it has closed. */
const editImage = (path, edit) => {
  const image = readFileSync(path);
  const pageSize = image.readUInt16BE(16);
  edit(image, { pageSize, trunkAt: (image.readUInt32BE(32) - 1) * pageSize });
  writeFileSync(path, image);
};

describe('checkStorePages passes the stores a rebuild may write into', () => {
  it('a live store with a freelist', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  it('a VACUUMed store with a freelist', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false, vacuum: true });
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  it('a VACUUM INTO snapshot', () => {
    const path = writeStoreSnapshot(join(dataDir(), 'snap.db'), { observations: 40 });
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  it('a store whose only damage is an ordinary index, which REINDEX repairs', () => {
    const path = writeStoreSnapshot(join(dataDir(), 'snap.db'), { damage: 'index' });
    expect(integrityRows(path).join('\n'), 'premise: integrity_check fails').toMatch(/missing from index/);
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  it('a store whose only damage is the search index', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0 });
    const db = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(db).healthy, 'premise: FTS5 check fails').toBe(false);
      expect(schema.checkStorePages(db)).toMatchObject({ state: 'ok' });
    } finally {
      db.close();
    }
  });

  // The pages the gate reads come from the log, not the main file, for everything another
  // connection committed after the last checkpoint: here, a freelist made and partly reused.
  it('a store whose log holds pages another connection has not checkpointed', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    const writer = new Database(path);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec('CREATE TABLE junk2 (x)');
      const put = writer.prepare('INSERT INTO junk2 VALUES (?)');
      writer.transaction(() => {
        for (let i = 0; i < 80; i++) put.run('j'.repeat(1000));
      })();
      writer.exec('DROP TABLE junk2');
      writer.prepare('DELETE FROM observations WHERE id % 3 = 0').run();
      expect(readFileSync(`${path}-wal`).length, 'premise: the log holds frames').toBeGreaterThan(100_000);
      const reader = new Database(path);
      try {
        expect(schema.checkStorePages(reader)).toMatchObject({ state: 'ok' });
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
  });
});

describe('checkStorePages finds page-level damage', () => {
  it('a VACUUMed store whose freelist lists a live leaf, which the integrity check reads as ok', () => {
    const { path, linked } = writeCrossLinkedStore(storeIn(dataDir()), { vacuum: true, ftsDamage: false });
    expect(integrityRows(path), 'premise: the integrity check misses it').toEqual(['ok']);
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(new RegExp(`page ${linked[0]}: in the freelist and in observations`));
  });

  it('the same on a store never VACUUMed, where the integrity check sees it too', () => {
    const { path, linked } = writeCrossLinkedStore(storeIn(dataDir()));
    expect(integrityRows(path).join('\n'), 'premise').toMatch(
      new RegExp(`2nd reference to page ${linked[0]}`),
    );
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(new RegExp(`page ${linked[0]}: in the freelist and in observations`));
  });

  it("a leaf page whose cell pointers are garbled (SQLite's own check)", () => {
    const path = writeStoreSnapshot(join(dataDir(), 'snap.db'), { damage: 'page' });
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^Tree \d+ page \d+/m);
  });

  // SQLite's check throws here instead of returning its rows: the throw is the finding.
  it('a leaf whose page type is garbled, where the check throws', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    const db = new Database(path);
    const leaf = db
      .prepare(
        "SELECT pageno FROM dbstat WHERE name = 'observations' AND pagetype = 'leaf' ORDER BY pageno LIMIT 1",
      )
      .pluck()
      .get();
    db.close();
    editImage(path, (image, { pageSize }) => {
      image[(leaf - 1) * pageSize] = 0;
    });
    expect(gate(path)).toMatchObject({ state: 'damaged', lines: ['database disk image is malformed'] });
  });

  it('a page that nothing uses', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    let dropped;
    editImage(path, (image, { trunkAt }) => {
      const n = image.readUInt32BE(trunkAt + 4);
      dropped = image.readUInt32BE(trunkAt + 8 + 4 * (n - 1));
      image.writeUInt32BE(n - 1, trunkAt + 4);
      image.writeUInt32BE(image.readUInt32BE(36) - 1, 36);
    });
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines).toEqual([`page ${dropped}: never used`]);
  });

  it('a freelist that holds fewer pages than the header says', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    editImage(path, (image) => image.writeUInt32BE(image.readUInt32BE(36) + 1, 36));
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^the freelist: \d+ pages listed, the header says \d+$/m);
  });

  it('a freelist that lists a page past the end of the file', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    editImage(path, (image, { pageSize, trunkAt }) => {
      image.writeUInt32BE(image.length / pageSize + 5, trunkAt + 8);
    });
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^the freelist: invalid page number \d+$/m);
  });

  it('a freelist trunk page that lists more pages than a page can hold', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    let trunk;
    editImage(path, (image, { trunkAt }) => {
      trunk = image.readUInt32BE(32);
      image.writeUInt32BE(0x00ffffff, trunkAt + 4);
    });
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toContain(`the freelist: trunk page ${trunk} lists 16777215 pages`);
  });

  // Two trees on the same pages: SQLite checks one table at a time here, so only the gate's own
  // count of every page sees it.
  it('two tables on the same pages', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    const db = new Database(path);
    try {
      db.exec('CREATE TABLE twin_a (x); CREATE TABLE twin_b (x)');
      db.prepare('INSERT INTO twin_a VALUES (?)').run('a'.repeat(5000));
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.exec(
        "UPDATE sqlite_master SET rootpage = (SELECT rootpage FROM sqlite_master WHERE name = 'twin_a') WHERE name = 'twin_b'",
      );
    } finally {
      db.close();
    }
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^page \d+: in twin_a and in twin_b$/m);
  });

  // The freelist comes from serialize and the trees from dbstat, two reads: a commit between them
  // that moves pages from the freelist into a new table reads as both, unless one transaction
  // holds them to one state of the store.
  it('reads the freelist and the trees from one state of the store while another connection writes', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    const db = new Database(path);
    const writer = new Database(path);
    try {
      const serialize = db.serialize.bind(db);
      let wrote = false;
      db.serialize = (...args) => {
        const image = serialize(...args);
        writer.exec('CREATE TABLE late (x); INSERT INTO late VALUES (randomblob(20000))');
        wrote = true;
        return image;
      };
      expect(schema.checkStorePages(db)).toMatchObject({ state: 'ok' });
      expect(wrote, 'premise: the write landed between the two reads').toBe(true);
      expect(db.inTransaction, 'the check ends its transaction').toBe(false);
    } finally {
      writer.close();
      db.close();
    }
  });

  it('says it could not check, rather than passing, when a step of the check fails', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });
    const db = new Database(path);
    try {
      db.serialize = () => {
        throw new Error('Out of memory');
      };
      expect(schema.checkStorePages(db)).toMatchObject({ state: 'unchecked', error: 'Out of memory' });
    } finally {
      db.close();
    }
  });
});

describe('rebuildFTS and rebuildIndexes write nothing on page-level damage', () => {
  for (const name of ['rebuildFTS', 'rebuildIndexes']) {
    for (const vacuum of [false, true]) {
      it(`${name}${vacuum ? ' on a VACUUMed store' : ''}`, () => {
        const { path, truth } = writeCrossLinkedStore(storeIn(dataDir()), { vacuum });
        expect(intactObservations(path, truth), 'premise').toBe(truth.length);
        const before = sha(path);
        const db = new Database(path);
        let r;
        try {
          r = schema[name](db);
        } finally {
          db.close();
        }
        expect(intactObservations(path, truth), 'rows the rebuild overwrote').toBe(truth.length);
        expect(sha(path), 'the store was written').toBe(before);
        expect(r.rebuilt).toEqual([]);
        expect(r.pages?.state).toBe('damaged');
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^not rebuilt: the database's pages are damaged/);
      });
    }
  }

  it('still rebuilds a store whose only damage is the search index', () => {
    const { path, truth } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0 });
    const db = new Database(path);
    try {
      const r = schema.rebuildIndexes(db);
      expect(r.errors).toEqual([]);
      expect(r.pages?.state).toBe('ok');
    } finally {
      db.close();
    }
    // A fresh handle: what the rebuild committed, not what its own transaction sees.
    const after = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(after).healthy).toBe(true);
    } finally {
      after.close();
    }
    expect(intactObservations(path, truth)).toBe(truth.length);
  });
});

describe('the copy command doctor and fts-check print', () => {
  it('copies the data directory beside itself, and a second run takes a new name', () => {
    const dir = join(dataDir(), 'data dir');
    mkdirSync(dir);
    const { path } = writeCrossLinkedStore(storeIn(dir), { links: 0, ftsDamage: false });
    const nowMs = Date.parse('2026-10-25T12:00:00Z');
    const first = dataDirCopyCommand(path, { nowMs });
    expect(spawnSync('sh', ['-c', first]).status, first).toBe(0);
    expect(sha(storeIn(`${dir}.copy-2026-10-25`))).toBe(sha(path));
    const second = dataDirCopyCommand(path, { nowMs });
    expect(second).toContain(`${dir}.copy-2026-10-25-1'`);
    expect(spawnSync('sh', ['-c', second]).status, second).toBe(0);
    expect(sha(storeIn(`${dir}.copy-2026-10-25-1`))).toBe(sha(path));
  });

  it('stops before copying into a copy made after it was printed', () => {
    const dir = join(dataDir(), 'data');
    mkdirSync(dir);
    const { path } = writeCrossLinkedStore(storeIn(dir), { links: 0, ftsDamage: false });
    const command = dataDirCopyCommand(path, { nowMs: Date.parse('2026-10-25T12:00:00Z') });
    mkdirSync(`${dir}.copy-2026-10-25`);
    expect(spawnSync('sh', ['-c', command]).status).not.toBe(0);
    expect(existsSync(join(`${dir}.copy-2026-10-25`, dirname(path).split('/').pop()))).toBe(false);
  });
});

describe('every face that rebuilds refuses on page-level damage', () => {
  const env = (dir, home) => ({
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: dir,
    PATH: pathWithClaudeStub(home),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    MEM_QUIET_HOOKS: '1',
  });

  for (const json of [true, false]) {
    it(`doctor${json ? ' --json' : ''}: ✗ not run, the copy command, and every row as it was`, () => {
      const dir = dataDir();
      const home = dataDir();
      mkdirSync(join(home, '.claude'), { recursive: true });
      const { path, truth, linked } = writeCrossLinkedStore(storeIn(dir), { prepare: openedByProduct });
      const r = spawnSync(
        process.execPath,
        [join(REPO, 'install.mjs'), 'doctor', ...(json ? ['--json'] : [])],
        {
          encoding: 'utf8',
          env: env(dir, home),
          timeout: 120_000,
        },
      );
      expect(intactObservations(path, truth), 'rows doctor overwrote').toBe(truth.length);
      if (json) {
        const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
        const check = report.checks.find((c) => /^FTS5 rebuild/.test(c.message));
        expect(check, r.stdout).toMatchObject({ level: 'fail' });
        expect(check.message).toMatch(/^FTS5 rebuild: not run — /);
        expect(check.details.join('\n')).toContain(`page ${linked[0]}: in the freelist and in observations`);
        expect(check.details.join('\n')).toContain(`cp -a ${dir} ${dir}.copy-`);
      } else {
        expect(r.stdout).toMatch(/✗ FTS5 rebuild: not run — /);
        expect(r.stdout).toContain(`page ${linked[0]}: in the freelist and in observations`);
      }
      expect(r.status, 'doctor counts it as an issue').toBe(1);
    }, 150_000);
  }

  it('fts-check rebuild: exit 1, the copy command, and every row as it was', () => {
    const dir = dataDir();
    const home = dataDir();
    const { path, truth, linked } = writeCrossLinkedStore(storeIn(dir), { prepare: openedByProduct });
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'fts-check', 'rebuild'], {
      encoding: 'utf8',
      env: env(dir, home),
    });
    expect(intactObservations(path, truth), 'rows fts-check rebuild overwrote').toBe(truth.length);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/^\[mem\] Not rebuilt: /);
    expect(r.stdout).toContain(`page ${linked[0]}: in the freelist and in observations`);
    expect(r.stdout).toContain(`cp -a ${dir} ${dir}.copy-`);
  });

  it('mem_fts_check rebuild: says not rebuilt, gives the model no command, writes nothing', () => {
    const { path, truth } = writeCrossLinkedStore(storeIn(dataDir()));
    const db = new Database(path);
    let text;
    try {
      text = handleMemFtsCheck(db, { action: 'rebuild' }).content[0].text;
    } finally {
      db.close();
    }
    expect(intactObservations(path, truth), 'rows mem_fts_check overwrote').toBe(truth.length);
    expect(text).toMatch(/^Not rebuilt: /);
    expect(text).not.toMatch(/cp -a/);
  });

  // The opener every face uses rebuilds the FTS5 indexes when the open fails with
  // SQLITE_CORRUPT_VTAB; the fault is injected once, as tests/wal-recovery.test.mjs does.
  it('the opener: an open that meets SQLITE_CORRUPT_VTAB does not rebuild over damaged pages', () => {
    const control = writeCrossLinkedStore(storeIn(dataDir()), { prepare: openedByProduct });
    openedByProduct(control.path);
    expect(intactObservations(control.path, control.truth), 'premise: an open alone writes over no row').toBe(
      control.truth.length,
    );
    const dir = dataDir();
    const { path, truth } = writeCrossLinkedStore(storeIn(dir), { prepare: openedByProduct });
    const src = `
      Promise.all([import(${JSON.stringify(BSQ_URL)}), import(${JSON.stringify(SCHEMA_URL)})]).then(([{ default: Database }, m]) => {
        let thrown = 0;
        const orig = Database.prototype.pragma;
        Database.prototype.pragma = function (sql, ...rest) {
          if (thrown === 0 && /^\\s*journal_mode\\s*=\\s*WAL/i.test(sql)) {
            thrown++;
            throw new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT_VTAB');
          }
          return orig.call(this, sql, ...rest);
        };
        const msgs = [];
        try { m.ensureDbWithWalRecovery({ warn: (x) => msgs.push(x), info: (x) => msgs.push(x) }).close(); } catch {}
        console.log(JSON.stringify({ thrown, msgs }));
      });`;
    const out = execFileSync(process.execPath, ['-e', src], {
      env: { ...process.env, CLAUDE_MEM_DIR: dir },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.thrown, 'the injected fault must have fired').toBe(1);
    expect(r.msgs.join('\n')).toContain('FTS index corruption detected');
    expect(intactObservations(path, truth), 'rows the opener overwrote').toBe(truth.length);
    expect(r.msgs.join('\n')).toMatch(/FTS rebuild reported: not rebuilt: the database's pages are damaged/);
  });

  // The restore command ends with `fts-check rebuild`, which refuses on this snapshot, so the
  // check that vouches for the command must refuse it too.
  it('the snapshot check: a snapshot with page-level damage does not restore', () => {
    const dir = dataDir();
    const { path } = writeCrossLinkedStore(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), {
      vacuum: true,
    });
    const r = checkSnapshot(path);
    expect(r).toMatchObject({ verdict: 'bad', why: 'rebuild' });
    expect(r.reason).toMatch(/^not rebuilt: the database's pages are damaged/);
  });
});
