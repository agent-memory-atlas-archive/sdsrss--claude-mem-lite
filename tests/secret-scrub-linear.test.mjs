// D#130 — scrubSecrets must stay linear on crafted input. Every stored field goes through it
// on a synchronous hook path, and Stop's timeout is 5 s. Four patterns were super-linear
// (growth per doubling of the input, 40k -> 80k chars on the pre-fix code, 2026-09-27: 3.9-4.0x
// each; every other pattern ~2x):
//   - `"\w*(?:password|…)\w*"` and `['"]\w*(?:…)\w*['"]`: from ONE quote, `\w*` runs to the end
//     of a word run, then backtracks through every keyword position, each rescanning the run;
//   - the JWT pattern: every `-eyJ` inside one dotless run is a new start that scans to the
//     run's end;
//   - the PEM pattern: every BEGIN with no END scanned to the end of the text.
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
    // A word-hyphen start is allowed once per word, never inside a hyphen run.
    jwtWordDashRun: ('sess-eyJ' + 'A'.repeat(20) + ' ').repeat(N / 29),
    // Every BEGIN with no END scanned to the end of the text, on each of the 32 passes.
    pemHeadersNoEnd: CHAIN + ' ' + '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(N / 32),
    // Linear but slow: D#128's code-label branch ran a 40-char lookbehind at every position
    // until a lookahead gated it (500k chars: 407 ms → 3,387 ms → 428 ms).
    chainedWordRun: CHAIN + " '" + 'secret'.repeat(N / 6),
  };
  // Timed against benign prose of the same length, not a wall-clock bound: a 500 ms bound
  // passed locally (335 ms) and failed on CI under coverage (555 ms). The benign text runs
  // scrubSecrets' 32 passes (the CHAIN prefix), as do pemHeadersNoEnd and chainedWordRun; the
  // other shapes run one, so their budget is ~32x looser than a same-pass comparison, which
  // still separates them (pre-D#130: 55-227x). Measured 2026-09-27 on two machines, crafted /
  // benign: fixed patterns 2.2-3.4x; pre-D#130 pemHeadersNoEnd 20.7-31.7x, chainedWordRun
  // 1,100-1,700x; with the code-label lookaheads removed, chainedWordRun 15.7-16.2x.
  const benign =
    CHAIN + ' ' + 'the quick brown fox jumps over a lazy dog '.repeat(Math.ceil(N / 42)).slice(0, N);
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
    // v6.19.0 pre-tag review P3-2: `(?<![\w-])` alone stopped these; `\b` had caught them.
    ['JWT glued to a word by a hyphen', `cookie: sess-${jwt}`, 'cookie: sess-***'],
    ['the same at the start of the text', `auth-${jwt} ok`, 'auth-*** ok'],
    [
      'PEM block',
      'k: -----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY----- ok',
      'k: ***PEM_KEY*** ok',
    ],
    [
      'a later complete PEM block after a stray header',
      '-----BEGIN EC PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----\nMIIEabc\n-----END EC PRIVATE KEY-----',
      '***PEM_KEY******PEM_KEY***',
    ],
    // v6.19.0 pre-tag review P2-1: a body that stopped at the next BEGIN failed to match at
    // all when its own END was missing, so the cut-off key's body was stored.
    [
      'a cut-off key body before a later complete block',
      '$ head -c 80 id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\n$ cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      '$ head -c 80 id_rsa\n***PEM_KEY******PEM_KEY***',
    ],
    [
      'a key body, then a certificate, then another key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----\n-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEabc\n-----END OPENSSH PRIVATE KEY-----',
      '***PEM_KEY***-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----\n***PEM_KEY***',
    ],
  ])('%s', (_name, input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });
});
