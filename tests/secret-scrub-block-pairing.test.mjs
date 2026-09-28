// D#155: the complete-block pattern erased everything from a private-key BEGIN to the next END, so
// prose or code that names both markers lost the text between them ("Keys start with <BEGIN> and
// end with <END>" lost "and end with"; the `cryptography` package's serialization/ssh.py lost the
// line of code between its two marker constants). A block is now kept when its body holds no key
// line. Both directions are judged here:
//   - the leak arm: complete keys in every line shape, each must still go whole;
//   - the prose arm: text naming both markers keeps its text.
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

let seed = 155;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (n) => Array.from({ length: n }, () => B64[Math.floor(rnd() * 64)]).join('');

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';

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

  it('still takes a placeholder body with no spaces in it', () => {
    for (const body of ['MIIEabc', 'MIIFDjBA...secret...', 'YOUR-ORGS-VALIDATION-KEY-HERE', '']) {
      expect(scrubSecrets(`k: ${BEGIN}\n${body}\n${END} ok`)).toBe('k: ***PEM_KEY*** ok');
    }
  });

  // The rule reads base64 alone, so a 16+ letter word in the prose counts as a key line and takes
  // the block, as every block did before. A leak costs more than this prose.
  it('still takes a block whose prose has a 16+ letter word', () => {
    expect(scrubSecrets(`Keys start with ${BEGIN} (see Internationalization) and end with ${END}.`)).toBe(
      'Keys start with ***PEM_KEY***.',
    );
  });
});

describe('D#155 complete blocks: text naming both markers keeps its text', () => {
  const CASES = {
    sentence: `Keys start with ${BEGIN} and end with ${END} in PEM files.`,
    // The shape of the `cryptography` package's serialization/ssh.py.
    pythonConstants: `_SK_MAGIC = b"openssh-key-v1\\0"\n_SK_START = b"-----BEGIN OPENSSH PRIVATE KEY-----"\n_SK_END = b"-----END OPENSSH PRIVATE KEY-----"\n_BCRYPT = b"bcrypt"`,
    jsCheck: `if (pem.startsWith('-----BEGIN PRIVATE KEY-----') && pem.trimEnd().endsWith('-----END PRIVATE KEY-----')) return parse(pem);`,
    armorOnly: `${BEGIN}\nProc-Type: 4,ENCRYPTED\n${END}`,
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
