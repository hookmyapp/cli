// AIT-722 — integration test against the built CLI binary (like
// cli-error-integration.test.ts). MCP clients run `mcp-headers` on every
// connect and give up after 10s, so it must skip the boot extras, and a client
// that already hung up must not turn the late write into a crash.
import { describe, test, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(fileURLToPath(import.meta.url), '../../../bin/hookmyapp.js');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'hookmyapp-ait-722-'));
  writeFileSync(
    join(configDir, 'credentials.json'),
    JSON.stringify({ accessToken: 'hmok_test', refreshToken: '', expiresAt: 0, kind: 'agent', credentialPublicId: 'ac_test' }),
  );
});

function run(args: string[], opts: { closeStdout?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOOKMYAPP_CONFIG_DIR: configDir,
    HOOKMYAPP_API_URL: 'http://127.0.0.1:9', // nothing a stray refresh could reach
    HOOKMYAPP_TELEMETRY: 'off',
  };
  // main() is skipped under VITEST, and CI / the opt-out silence the nudge,
  // which would make the "no nudge" assertion pass for the wrong reason.
  for (const k of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'CI', 'HOOKMYAPP_NO_NOTICES']) delete env[k];
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (opts.closeStdout) child.stdout.destroy();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.on('close', (code) => done({ code, stdout, stderr })),
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

  test('a reader that closed stdout gets a quiet exit 0, not an EPIPE crash', async () => {
    const { code, stderr } = await run(['mcp-headers'], { closeStdout: true });
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});
