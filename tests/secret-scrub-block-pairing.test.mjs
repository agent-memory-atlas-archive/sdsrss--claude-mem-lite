// D#155: the complete-block pattern erased everything from a private-key BEGIN to the next END, so
// prose or code that names both markers lost the text between them ("Keys start with <BEGIN> and
// end with <END>" lost "and end with"; the `cryptography` package's serialization/ssh.py lost the
// line of code between its two marker constants). A block is now kept when the text between its
// markers is short text naming them (isMarkerProse). Both directions are judged here:
//   - the leak arm: keys between the markers in every form measured, each must still go whole;
//   - the prose arm: short text naming both markers keeps its text;
//   - each clause of the rule, at its threshold from both sides.
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

let seed = 155;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (n) => Array.from({ length: n }, () => B64[Math.floor(rnd() * 64)]).join('');
const bytes = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 256));
const hex2 = (b) => b.toString(16).padStart(2, '0');

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';
const block = (body) => `${BEGIN}${body}${END}`;
const kept = (body) => scrubSecrets(`k: ${block(body)} ok`) === `k: ${block(body)} ok`;

describe('D#155 complete blocks: every key still goes', () => {
  const SEPARATORS = ['\n', '\r\n', '\r', '\\n', '\\\\n', '<br>', ' ', '\t', ' | '];
  const PREFIXES = ['', '> ', '     2\t', '2→', 'id_rsa:'];
  const HEADERS = [
    [],
    ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,3F2A9C1E', ''],
    ["Comment: ['work', 'home']"],
  ];

  it('leaves no 16-character window of any key line, in 135 line shapes', () => {
    const leaks = [];
    for (const sep of SEPARATORS) {
      for (const pre of PREFIXES) {
        for (const headers of HEADERS) {
          const body = [b64(64), b64(64), b64(64), b64(24)];
          const key = [BEGIN, ...headers, ...body, END].map((l) => pre + l).join(sep);
          const out = scrubSecrets(`Here's the key: ${key} Don't share it.`);
          if (body.some((l) => out.includes(l.slice(4, 20))))
            leaks.push(JSON.stringify([sep, pre, headers[0]]));
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  // No line of these is a 16-character run, so the run clause alone would keep them (pre-tag
  // review of this change).
  it('takes a key re-wrapped to lines under 16 characters, under a line prefix', () => {
    const leaks = [];
    const body = 'MII' + b64(1597);
    for (const width of [8, 12, 15]) {
      const lines = body.match(new RegExp(`.{1,${width}}`, 'g'));
      for (const pre of ['', '     2\t', '> ']) {
        const out = scrubSecrets([BEGIN, ...lines, END].map((l) => pre + l).join('\n'));
        if (lines.slice(1, -1).some((l) => out.includes(l))) leaks.push(`${width} ${JSON.stringify(pre)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('takes a decoded key between the markers: a hex dump, a C byte array, `\\x` escapes', () => {
    const secret = bytes(32);
    const dumpLines = [secret.slice(0, 15), secret.slice(15, 30), secret.slice(30)].map(
      (row) => `    ${row.map(hex2).join(':')}:`,
    );
    const shapes = {
      // `head -1 k.pem; openssl pkey -noout -text -in k.pem; tail -1 k.pem`
      pkeyText: [
        '-----BEGIN PRIVATE KEY-----',
        'ED25519 Private-Key:',
        'priv:',
        ...dumpLines,
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      pkeyTextOneLine: `-----BEGIN PRIVATE KEY----- priv: ${secret.map(hex2).join(':')} -----END PRIVATE KEY-----`,
      cArray: `/* ${BEGIN} */ static const uint8_t k[] = { ${secret.map((b) => `0x${hex2(b)}`).join(', ')} }; /* ${END} */`,
      pyBytes: `"${BEGIN}" + b"${secret.map((b) => `\\x${hex2(b)}`).join('')}" + "${END}"`,
    };
    const hexWindows = [secret.slice(4, 10), secret.slice(20, 26)].map((row) => row.map(hex2));
    for (const [name, text] of Object.entries(shapes)) {
      const out = scrubSecrets(text).toLowerCase();
      for (const w of hexWindows) {
        expect(
          out.includes(w.join(':')) || out.includes(w.join(', 0x')) || out.includes(w.join('\\x')),
          name,
        ).toBe(false);
      }
      expect(out, name).toContain('***pem_key***');
    }
  });

  it('still takes a placeholder body with no spaces in it', () => {
    for (const body of ['MIIEabc', 'MIIFDjBA...secret...', 'YOUR-ORGS-VALIDATION-KEY-HERE', '']) {
      expect(scrubSecrets(`k: ${BEGIN}\n${body}\n${END} ok`)).toBe('k: ***PEM_KEY*** ok');
    }
  });
});

describe('D#155 complete blocks: text naming both markers keeps its text', () => {
  const CASES = {
    sentence: `Keys start with ${BEGIN} and end with ${END} in PEM files.`,
    // The shape of the `cryptography` package's serialization/ssh.py.
    pythonConstants: `_SK_MAGIC = b"openssh-key-v1\\0"\n_SK_START = b"-----BEGIN OPENSSH PRIVATE KEY-----"\n_SK_END = b"-----END OPENSSH PRIVATE KEY-----"\n_BCRYPT = b"bcrypt"`,
    jsCheck: `if (pem.startsWith('-----BEGIN PRIVATE KEY-----') && pem.trimEnd().endsWith('-----END PRIVATE KEY-----')) return parse(pem);`,
    // A 14-letter word: the run clause counts 16.
    longWord: `Keys start with ${BEGIN} (authentication) and end with ${END}.`,
  };
  for (const [name, text] of Object.entries(CASES)) {
    it(name, () => {
      expect(scrubSecrets(text)).toBe(text);
    });
    it(`${name}, JSON-escaped`, () => {
      const json = JSON.stringify({ stdout: text });
      expect(scrubSecrets(json)).toBe(json);
    });
  }

  it('a real key after the prose still goes', () => {
    const body = [b64(64), b64(64), b64(20)];
    const text = `${CASES.sentence}\n${BEGIN}\n${body.join('\n')}\n${END}\nafter`;
    expect(scrubSecrets(text)).toBe(`${CASES.sentence}\n***PEM_KEY***\nafter`);
  });
});

// Each clause of isMarkerProse on both sides of its threshold, with the other clauses satisfied.
describe('D#155 the keep rule, clause by clause', () => {
  it('length: 256 characters are kept, 257 go', () => {
    expect(kept(` a b${' '.repeat(252)}`)).toBe(true);
    expect(kept(` a b${' '.repeat(253)}`)).toBe(false);
  });

  it('lines: one break is kept, two go', () => {
    expect(kept(' and end\nwith it ')).toBe(true);
    expect(kept(' and end\nwith\nit ')).toBe(false);
    expect(kept(' and end\\nwith\\nit ')).toBe(false);
    expect(kept(' and end<br>with<br>it ')).toBe(false);
  });

  it('base64-class characters: 39 are kept, 40 go', () => {
    const words = (n) =>
      ` ${'abcd efgh ijkl mnop qrst uvwx yz01 2345 6789 +/=a'
        .replace(/ /g, '')
        .slice(0, n)
        .match(/.{1,4}/g)
        .join(' ')} `;
    expect(kept(words(39))).toBe(true);
    expect(kept(words(40))).toBe(false);
  });

  it('runs: 15 in a row are kept, 16 go', () => {
    expect(kept(' see MIIEpAIBAAKCAQE here ')).toBe(true);
    expect(kept(' see MIIEpAIBAAKCAQEA here ')).toBe(false);
  });

  it('words: a space between two non-space characters', () => {
    expect(kept(' see-here ')).toBe(false);
    expect(kept(' see here ')).toBe(true);
  });
});
