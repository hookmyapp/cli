import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSentryLazy,
  captureError,
  __resetForTests,
  __isInitializedForTests,
} from '../sentry.js';

describe('Sentry offline transport persists events when network fails', () => {
  let configDir: string;
  let originalDsn: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    __resetForTests();
    originalDsn = process.env.HOOKMYAPP_SENTRY_DSN;
    originalConfigDir = process.env.HOOKMYAPP_CONFIG_DIR;
    // Unroutable address → guarantees transport-level send failure.
    process.env.HOOKMYAPP_SENTRY_DSN = 'https://fake@127.0.0.1:1/1';
    configDir = mkdtempSync(join(tmpdir(), 'sentry-offline-'));
    process.env.HOOKMYAPP_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalDsn !== undefined) process.env.HOOKMYAPP_SENTRY_DSN = originalDsn;
    else delete process.env.HOOKMYAPP_SENTRY_DSN;
    if (originalConfigDir !== undefined) process.env.HOOKMYAPP_CONFIG_DIR = originalConfigDir;
    else delete process.env.HOOKMYAPP_CONFIG_DIR;
    __resetForTests();
  });

  it('writes a queued envelope to <config-dir>/sentry-offline/ when send fails', async () => {
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(true);

    await captureError(new Error('offline-fixture-error'));
    // Allow the transport to flush its async write.
    await new Promise((r) => setTimeout(r, 250));

    const queueDir = join(configDir, 'sentry-offline');
    const entries = readdirSync(queueDir);
    expect(entries.length).toBeGreaterThan(0);
  });
});
