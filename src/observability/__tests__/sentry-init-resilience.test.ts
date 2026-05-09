import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSentryLazy,
  __resetForTests,
  __isInitializedForTests,
} from '../sentry.js';

describe('initSentryLazy resilience to filesystem failures', () => {
  let readonlyDir: string;
  let originalDsn: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    __resetForTests();
    originalDsn = process.env.HOOKMYAPP_SENTRY_DSN;
    originalConfigDir = process.env.HOOKMYAPP_CONFIG_DIR;
    process.env.HOOKMYAPP_SENTRY_DSN = 'https://fake@example.ingest.sentry.io/1';
    readonlyDir = mkdtempSync(join(tmpdir(), 'sentry-init-readonly-'));
    chmodSync(readonlyDir, 0o500);
    process.env.HOOKMYAPP_CONFIG_DIR = readonlyDir;
  });

  afterEach(() => {
    chmodSync(readonlyDir, 0o700);
    rmSync(readonlyDir, { recursive: true, force: true });
    if (originalDsn !== undefined) process.env.HOOKMYAPP_SENTRY_DSN = originalDsn;
    else delete process.env.HOOKMYAPP_SENTRY_DSN;
    if (originalConfigDir !== undefined) process.env.HOOKMYAPP_CONFIG_DIR = originalConfigDir;
    else delete process.env.HOOKMYAPP_CONFIG_DIR;
    __resetForTests();
  });

  it('completes initialization successfully even when config-dir writes EPERM', async () => {
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(true);
  });
});
