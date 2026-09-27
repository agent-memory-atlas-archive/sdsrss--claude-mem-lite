// D#130 — scrubSecrets must stay linear on crafted input. Every stored field goes through it
// on a synchronous hook path, and Stop's timeout is 5 s. Three patterns were super-linear
// (growth per doubling of the input, 2026-09-27: JSON vendor key 3.8x, quoted key 4.0x, JWT
// 3.4x; every other pattern ~2x):
//   - `"\w*(?:password|…)\w*"` and `['"]\w*(?:…)\w*['"]`: from ONE quote, `\w*` runs to the end
//     of a word run, then backtracks through every keyword position, each rescanning the run;
//   - the JWT pattern: every `-eyJ` inside one dotless run is a new start that scans to the
//     run's end.
// The v6.18.0 security re-check drove the first two through a report Done to 27,970 ms.
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { writeStopSummary, FAST_SUMMARY_LIMITS } from '../lib/fast-summary.mjs';
import { insertSession } from './test-helpers.mjs';

const N = 200_000;
const ms = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

// 40 alternating labelled values drive scrubSecrets to its 32-pass cap, so every pass rescans
// whatever follows them.
const CHAIN = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'secret: abcdefgh' : 'token: abcdefgh')).join(
  ' ',
);

describe('scrubSecrets stays linear on crafted input (D#130)', () => {
  const shapes = {
    jsonVendorKey: '"' + 'secret'.repeat(N / 6),
    quotedKey: "'" + 'passwd'.repeat(N / 6),
    quotedKeyDouble: '"' + 'password'.repeat(N / 8),
    jwtDashRun: 'eyJ-'.repeat(N / 4),
    // Every BEGIN with no END scanned to the end of the text, on each of the 32 passes.
    pemHeadersNoEnd: CHAIN + ' ' + '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(N / 32),
    // Linear but slow: D#128's code-label branch ran a 40-char lookbehind at every position
    // until a lookahead gated it (500k chars: 407 ms → 3,387 ms → 428 ms).
    chainedWordRun: CHAIN + " '" + 'secret'.repeat(N / 6),
  };
  // Timed against benign prose of the same length and pass count, not a wall-clock bound: a
  // 500 ms bound held locally (335 ms) and failed on CI under coverage (555 ms). Measured
  // 2026-09-27, crafted / benign: fixed patterns <= 3.4x; the pre-D#130 patterns >= 31.7x
  // (chainedWordRun 1689x). The pre-lookahead code-label branch was ~8x slower than now.
  const benign =
    CHAIN + ' ' + 'the quick brown fox jumps over a lazy dog '.repeat(Math.ceil(N / 43)).slice(0, N);
  let benignMs;
  beforeAll(() => {
    scrubSecrets(benign);
    benignMs = Math.max(5, Math.min(...[0, 1, 2].map(() => ms(() => scrubSecrets(benign)))));
  });
  for (const [name, text] of Object.entries(shapes)) {
    it(`${name}: 200k chars within 10x of benign text of the same length`, () => {
      expect(ms(() => scrubSecrets(text)) / benignMs).toBeLessThan(10);
    });
  }

  it('the re-check shape through a report Done stays inside Stop’s budget', () => {
    const db = new Database(':memory:');
    initSchema(db);
    insertSession(db, { id: 's', project: 'p' });
    const done = CHAIN + ' "' + 'password'.repeat(12_500);
    const took = ms(() =>
      writeStopSummary(db, {
        sessionId: 's',
        project: 'p',
        report: { done, notDone: '', lines: '' },
        source: { request: 'r', completed: '' },
        now: new Date('2026-09-27T00:00:00Z'),
        limits: FAST_SUMMARY_LIMITS.stop,
      }),
    );
    expect(db.prepare('SELECT completed FROM session_summaries').get().completed).toContain('token: ***');
    expect(took).toBeLessThan(1500);
    db.close();
  });
});

describe('the linear rewrites still scrub what the old patterns did', () => {
  const jwt =
    'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fw';
  it.each([
    [
      'JSON vendor-prefixed key',
      '{"aws_secret_access_key": "wJalrXUtnFEMI-K7MDENG"}',
      '{"aws_secret_access_key": "***"}',
    ],
    ['single-quoted dict key', "{'my_password': 'hunter2Zq9x'}", "{'my_password': '***'}"],
    ['mixed quotes', `{"x_api_key": 'abcdef123456'}`, `{"x_api_key": '***'}`],
    ['JWT after a space', `auth ${jwt} ok`, 'auth *** ok'],
    ['JWT after =', `jwt=${jwt}`, 'jwt=***'],
    ['JWT after a quote', `"${jwt}"`, '"***"'],
    [
      'PEM block',
      'k: -----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY----- ok',
      'k: ***PEM_KEY*** ok',
    ],
    [
      'a later complete PEM block after a stray header',
      '-----BEGIN EC PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----\nMIIEabc\n-----END EC PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----\n***PEM_KEY***',
    ],
  ])('%s', (_name, input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });
});
