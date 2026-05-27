// Task A3 — end-to-end test for `sandbox send` positional `[identifier]`.
//
// Proves that `runSandboxSend({ identifierArg: '@ordvir' })` shape-detects the
// username, routes through pickSession's positional path, and lands on the IG
// session — verified by asserting the outbound fetch URL contains the IG
// account id segment `/{accountInstagramId}/messages`.
//
// runSandboxSend uses fetch (not apiClient) for the actual send; only the
// sessions list is fetched via apiClient. The existing send.test.ts uses the
// same vi.spyOn(globalThis, 'fetch') pattern.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxSend } from '../send.js';
import type { InstagramSandboxSession } from '../../../api/sandbox-session.js';

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  senderInstagramId: '1907',
  accountInstagramId: '1784',
  senderInstagramUsername: 'ordvir',
  accessToken: 'tok',
  hmacSecret: 'hmac',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxSend — positional identifier (D3)', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
    vi.restoreAllMocks();
  });

  it('positional @ordvir narrows to IG session', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: 'mid.test' }), { status: 200 }),
    );

    await runSandboxSend({
      identifierArg: '@ordvir',
      message: 'hi',
      json: false,
    });

    const [calledUrl] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain('1784/messages');
  });
});
