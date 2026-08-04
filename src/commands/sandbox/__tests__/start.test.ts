import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Single combined mock — vi.mock collapses to the LAST declaration for a given
// path, so splitting apiClient + getBindCode across two vi.mock('../../../api/client.js')
// blocks would lose `apiClient` entirely. Define both in one block.
vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
  getBindCode: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { ValidationError } from '../../../output/error.js';
import { runSandboxStart } from '../start.js';

describe('runSandboxStart — flag validation', () => {
  it('throws ValidationError exit 2 in --json mode without --type (E3)', async () => {
    await expect(runSandboxStart({ json: true })).rejects.toThrow(ValidationError);
    await expect(runSandboxStart({ json: true })).rejects.toThrow(/--type is required/);
  });

  it('throws ValidationError on invalid --type value (Commander does not enforce enum)', async () => {
    await expect(
      runSandboxStart({ type: 'messenger' as never, json: true }),
    ).rejects.toThrow(ValidationError);
    await expect(
      runSandboxStart({ type: 'messenger' as never, json: true }),
    ).rejects.toThrow(/Invalid --type value/);
  });
});

describe('runSandboxStart — Instagram in production', () => {
  const originalEnv = process.env.HOOKMYAPP_ENV;
  beforeEach(() => {
    process.env.HOOKMYAPP_ENV = 'production';
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = originalEnv;
  });

  it('builds the prod ig.me deep link for @hookmyappsandbox', async () => {
    const { buildInstagramDeepLink } = await import('../start.js');
    const { getEffectiveSandboxInstagramUsername } = await import(
      '../../../config/env-profiles.js'
    );
    const url = buildInstagramDeepLink(getEffectiveSandboxInstagramUsername(), 'hmp3gj54');
    expect(url).toBe('https://ig.me/m/hookmyappsandbox?text=hmp3gj54');
  });
});

describe('runSandboxStart — Instagram in staging', () => {
  const originalEnv = process.env.HOOKMYAPP_ENV;
  beforeEach(() => {
    process.env.HOOKMYAPP_ENV = 'staging';
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = originalEnv;
  });

  it('builds the correct ig.me deep link (no @ in path, code encoded)', async () => {
    const { buildInstagramDeepLink } = await import('../start.js');
    const url = buildInstagramDeepLink('@hookmyappsandboxstaging', 'hmp3gj54');
    expect(url).toBe('https://ig.me/m/hookmyappsandboxstaging?text=hmp3gj54');
  });

  it('URL-encodes the bind code', async () => {
    const { buildInstagramDeepLink } = await import('../start.js');
    const url = buildInstagramDeepLink('@hookmyappsandboxstaging', 'a b+c');
    expect(url).toBe('https://ig.me/m/hookmyappsandboxstaging?text=a%20b%2Bc');
  });
});
