import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1. Make open() fail so we exercise the try/catch degrade-to-text path.
vi.mock('open', () => ({ default: vi.fn(async () => { throw new Error('no browser'); }) }));
// 2. Ported verbatim from src/__tests__/channels-connect.test.ts: the mocks that
//    let runChannelsConnect resolve WITHOUT network. apiClient is sequenced so
//    the first call (the /meta/channels snapshot) returns [] and the second
//    (the OAuth-start) returns { redirectUrl }. forceTokenRefresh resolves.
//    getDefaultWorkspaceId resolves to a publicId. pollForNewChannels resolves
//    to [] quickly so the poll doesn't block.
vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));
vi.mock('../channels-connect-poll.js', () => ({
  pollForNewChannels: vi.fn().mockResolvedValue([]),
}));

import { runChannelsConnect } from '../channels.js';
import { apiClient } from '../../api/client.js';

describe('channels connect — headless URL courier', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let write: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let log: any;
  beforeEach(() => {
    write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(apiClient).mockReset();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([]) // snapshot
      .mockResolvedValueOnce({ redirectUrl: 'https://example.com/oauth' }); // OAuth start
  });
  afterEach(() => { write.mockRestore(); log.mockRestore(); });

  it('prints the URL and does not throw CONNECT_REQUIRES_TTY when stdout is not a TTY', async () => {
    const prev = process.stdout.isTTY; (process.stdout as any).isTTY = false;
    await runChannelsConnect({ type: 'whatsapp' });
    (process.stdout as any).isTTY = prev;
    // Non-TTY human mode prints the URL as text via console.log.
    const out = log.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toMatch(/https:\/\//);
  });

  it('emits a connectUrl field in --json mode', async () => {
    await runChannelsConnect({ type: 'whatsapp', json: true });
    // JSON mode emits exactly one { connectUrl } object on stdout.
    const out = write.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(JSON.parse(out)).toHaveProperty('connectUrl');
  });
});
