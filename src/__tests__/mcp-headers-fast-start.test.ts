// AIT-722 — integration test against the built CLI binary (like
// cli-error-integration.test.ts). MCP clients run `mcp-headers` on every
// connect and give up after 10s, so it must skip the boot extras, and a client
// that already hung up must not turn the late write into a crash. Its usage
// telemetry goes out after the header, capped at ~1s.
import { describe, test, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const BIN = join(ROOT, 'bin/hookmyapp.js');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'hookmyapp-ait-722-'));
  writeFileSync(
    join(configDir, 'credentials.json'),
    JSON.stringify({ accessToken: 'hmok_test', refreshToken: '', expiresAt: 0, kind: 'agent', credentialPublicId: 'ac_test' }),
  );
});

function run(
  args: string[],
  opts: { closeStdout?: boolean; env?: NodeJS.ProcessEnv; fromSource?: boolean } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOOKMYAPP_CONFIG_DIR: configDir,
    HOOKMYAPP_API_URL: 'http://127.0.0.1:9', // nothing a stray refresh could reach
    HOOKMYAPP_TELEMETRY: 'off',
    ...opts.env,
  };
  // main() is skipped under VITEST, and CI / the opt-out silence the nudge,
  // which would make the "no nudge" assertion pass for the wrong reason.
  for (const k of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'CI', 'HOOKMYAPP_NO_NOTICES']) delete env[k];
  // The PostHog token is baked into dist at build time, so the telemetry test
  // runs the source, where it is read from the environment.
  const entry = opts.fromSource ? ['--import', 'tsx', join(ROOT, 'src/index.ts')] : [BIN];
  const child = spawn(process.execPath, [...entry, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (opts.closeStdout) child.stdout.destroy();
  let stdout = '';
  let stderr = '';
  let stdoutAt = 0;
  child.stdout.on('data', (d) => {
    stdoutAt ||= Date.now();
    stdout += d;
  });
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string; stdoutAt: number; exitAt: number }>(
    (done) => child.on('close', (code) => done({ code, stdout, stderr, stdoutAt, exitAt: Date.now() })),
  );
}

const nudgeFiles = () => readdirSync(configDir).filter((f) => f.startsWith('notifications-nudge-'));

describe('mcp-headers fast start (AIT-722)', () => {
  test('prints the header without running the notifications nudge', async () => {
    const { code, stdout } = await run(['mcp-headers']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ Authorization: 'Bearer hmok_test' });
    expect(nudgeFiles()).toEqual([]);
  });

  test('other commands still run it (so the assertion above is not vacuous)', async () => {
    await run(['--version']);
    expect(nudgeFiles()).not.toEqual([]);
  });

  test('usage telemetry goes out after the header, and a hung endpoint costs ~1s, not the 10s budget', async () => {
    let firstHitAt = 0;
    const server = createServer(() => {
      firstHitAt ||= Date.now(); // never answers
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await run(['mcp-headers'], {
        fromSource: true,
        env: { HOOKMYAPP_TELEMETRY: 'on', HOOKMYAPP_POSTHOG_TOKEN: 'phc_test', HOOKMYAPP_POSTHOG_HOST: host },
      });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ Authorization: 'Bearer hmok_test' });
      expect(firstHitAt).toBeGreaterThan(0); // events were sent...
      expect(firstHitAt).toBeGreaterThanOrEqual(res.stdoutAt); // ...after the header
      expect(res.exitAt - res.stdoutAt).toBeLessThan(2_500); // 1s cap + CI slack
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 20_000);

  test('a reader that closed stdout gets a quiet exit 0, not an EPIPE crash', async () => {
    const { code, stderr } = await run(['mcp-headers'], { closeStdout: true });
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});
