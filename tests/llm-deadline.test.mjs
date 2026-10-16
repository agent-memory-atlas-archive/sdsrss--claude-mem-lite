// E2E 2026-10-16 P2-6: a caller's timeout is a deadline for the WHOLE model call. Every
// dispatcher tries the keyed provider and then degrades to the `claude -p` CLI, and the CLI used
// to get a fresh full `timeout` of its own — so the opt-in lesson bridge (2.5 s budget on a 3 s
// PreToolUse hook) ran 5.1 s with the provider and the CLI both hanging, and was killed by the
// host. Real processes, a real loopback gateway that never finishes its body, and a CLI that
// never answers: nothing here is mocked.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

function runChild(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('lesson bridge under a hung provider and a hung CLI', () => {
  it('returns inside its 2.5 s budget instead of spending it twice', async () => {
    const root = fixtures.track(join(tmpdir(), `mem-deadline-${randomUUID().slice(0, 8)}`));
    mkdirSync(join(root, 'home'), { recursive: true });
    // A CLI that never answers, and records that it was started at all.
    const cli = join(root, 'claude');
    const started = join(root, 'cli-started');
    writeFileSync(cli, `#!/bin/sh\n: > '${started}'\nexec sleep 30\n`);
    chmodSync(cli, 0o755);
    // A keyed provider that sends its headers and never finishes the body.
    const gw = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"content":');
    });
    await new Promise((r) => gw.listen(0, '127.0.0.1', r));
    try {
      const env = {
        ...process.env,
        HOME: join(root, 'home'),
        CLAUDE_MEM_DIR: join(root, 'data'),
        ANTHROPIC_API_KEY: 'sk-test-deadline',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${gw.address().port}`,
        OPENROUTER_API_KEY: '',
        CLAUDE_CODE_PATH: cli,
      };
      const script = `
        const { bridgeLesson } = await import(${JSON.stringify(join(REPO, 'lib/lesson-bridge.mjs'))});
        const t = Date.now();
        const res = await bridgeLesson({ lesson: 'guard totalCents before rounding', hunk: 'totalCents(x)' });
        process.stdout.write(JSON.stringify({ ms: Date.now() - t, res }));`;
      const r = await runChild(script, env);
      expect(r.code, r.err).toBe(0);
      const { ms, res } = JSON.parse(r.out);
      expect(res).toEqual({ ok: false });
      // The hook's own timeout is 3 s; two 2.5 s legs back to back took 5.1 s.
      expect(ms).toBeLessThan(3000);
      expect(existsSync(started), 'the CLI was started with no budget left').toBe(false);
    } finally {
      gw.closeAllConnections();
      await new Promise((r) => gw.close(r));
    }
  });
});
