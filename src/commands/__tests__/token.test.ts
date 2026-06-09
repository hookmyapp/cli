import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock isJsonMode so we can toggle per-test without commander gymnastics.
// Path matches how token.ts imports isJsonMode — `../output/format.js`
// relative to `src/commands/token.ts`, so from this test file
// (`src/commands/__tests__/`) the path is `../../output/format.js`.
vi.mock('../../output/format.js', async (orig) => ({
  ...(await orig<object>()),
  isJsonMode: vi.fn(() => true),
}));

// Gateway model: GET /meta/channels/:id/token returns the customer's gateway
// access token in FULL — { token, tokenPrefix, tokenSuffix } — never the real
// Meta token. Every connected channel has one, so the command always prints it.
vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(async () => ({
    token: 'hmat_live_a1b2REVEALZZZZ',
    tokenPrefix: 'hmat_live_a1b2',
    tokenSuffix: 'ZZZZ',
  })),
}));

vi.mock('../channels.js', () => ({
  resolveChannel: vi.fn(async () => ({ id: 'ch_TEST0001', type: 'instagram' })),
}));

import type { Command } from 'commander';
import { apiClient } from '../../api/client.js';
import { isJsonMode } from '../../output/format.js';
import { runChannelToken } from '../token.js';

describe('runChannelToken — gateway access-token summary', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  beforeEach(() => {
    vi.mocked(apiClient).mockClear();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  test('When --json, then output is the wrapped shape carrying the full token', async () => {
    vi.mocked(isJsonMode).mockReturnValue(true);
    await runChannelToken('ch_TEST0001', {} as Command);
    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      channelId: 'ch_TEST0001',
      type: 'instagram',
      token: 'hmat_live_a1b2REVEALZZZZ',
      tokenPrefix: 'hmat_live_a1b2',
      tokenSuffix: 'ZZZZ',
    });
    expect(parsed).not.toHaveProperty('accessToken');
  });

  test('When human mode, then the full access token is printed', async () => {
    vi.mocked(isJsonMode).mockReturnValue(false);
    await runChannelToken('ch_TEST0001', {} as Command);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output.trim()).toBe('hmat_live_a1b2REVEALZZZZ');
  });

  test('When no --rotate, then it GETs the read endpoint (existing behaviour)', async () => {
    vi.mocked(isJsonMode).mockReturnValue(false);
    await runChannelToken('ch_TEST0001', {} as Command);
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe('/meta/channels/ch_TEST0001/token');
    expect(vi.mocked(apiClient).mock.calls[0][1]).toBeUndefined();
  });

  test('When --rotate, then it POSTs the rotate endpoint and prints the NEW token', async () => {
    vi.mocked(isJsonMode).mockReturnValue(false);
    vi.mocked(apiClient).mockResolvedValueOnce({
      token: 'hmat_live_ROTATEDxyz9',
      tokenPrefix: 'hmat_live_ROTA',
      tokenSuffix: 'edz9',
    });
    await runChannelToken('ch_TEST0001', {} as Command, true);
    expect(vi.mocked(apiClient).mock.calls[0]).toEqual([
      '/meta/channels/ch_TEST0001/token/rotate',
      { method: 'POST' },
    ]);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output.trim()).toBe('hmat_live_ROTATEDxyz9');
  });
});
