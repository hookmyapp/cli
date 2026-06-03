import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock isJsonMode so we can toggle per-test without commander gymnastics.
// Path matches how token.ts imports isJsonMode — `../output/format.js`
// relative to `src/commands/token.ts`, so from this test file
// (`src/commands/__tests__/`) the path is `../../output/format.js`.
vi.mock('../../output/format.js', async (orig) => ({
  ...(await orig<object>()),
  isJsonMode: vi.fn(() => true),
}));

// Gateway model: the GET /meta/channels/:id/token no longer returns a real
// token — only { hasActiveKey, keyPrefix, keySuffix }. The command summarises
// key presence and points at `keys create` for a usable key.
vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(async () => ({
    hasActiveKey: true,
    keyPrefix: 'hmp_live_a1b2',
    keySuffix: 'ZZZZ',
  })),
}));

vi.mock('../channels.js', () => ({
  resolveChannel: vi.fn(async () => ({ id: 'ch_TEST0001', type: 'instagram' })),
}));

import type { Command } from 'commander';
import { isJsonMode } from '../../output/format.js';
import { runChannelToken } from '../token.js';

describe('runChannelToken — gateway key summary', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  test('When --json, then output is the wrapped key-summary shape (no token)', async () => {
    vi.mocked(isJsonMode).mockReturnValue(true);
    await runChannelToken('ch_TEST0001', {} as Command);
    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      channelId: 'ch_TEST0001',
      type: 'instagram',
      hasActiveKey: true,
      keyPrefix: 'hmp_live_a1b2',
      keySuffix: 'ZZZZ',
    });
    expect(parsed).not.toHaveProperty('accessToken');
  });

  test('When human mode, then output is a key-presence summary pointing at keys create', async () => {
    vi.mocked(isJsonMode).mockReturnValue(false);
    await runChannelToken('ch_TEST0001', {} as Command);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('key present');
    expect(output).toContain('hmp_live_a1b2');
    expect(output).toContain('ZZZZ');
    expect(output).toContain('hookmyapp keys create ch_TEST0001');
  });
});
