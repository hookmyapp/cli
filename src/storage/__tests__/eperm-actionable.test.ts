import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPersistedTelemetry } from '../../observability/telemetry.js';
import { ConfigWriteForbiddenError } from '../errors.js';

// POSIX-only: `chmodSync(dir, 0o500)` does not make a directory read-only on
// Windows, so the EPERM this suite exists to trigger never happens there.
describe.skipIf(process.platform === 'win32')('config writers translate EPERM to ConfigWriteForbiddenError', () => {
  let dir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eperm-test-'));
    chmodSync(dir, 0o500);
    originalConfigDir = process.env.HOOKMYAPP_CONFIG_DIR;
    process.env.HOOKMYAPP_CONFIG_DIR = dir;
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    if (originalConfigDir !== undefined) process.env.HOOKMYAPP_CONFIG_DIR = originalConfigDir;
    else delete process.env.HOOKMYAPP_CONFIG_DIR;
  });

  it('setPersistedTelemetry throws ConfigWriteForbiddenError on read-only config dir', () => {
    expect(() => setPersistedTelemetry('off')).toThrow(ConfigWriteForbiddenError);
  });
});
