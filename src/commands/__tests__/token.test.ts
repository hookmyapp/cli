import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock isJsonMode so we can toggle per-test without commander gymnastics.
// Path matches how token.ts imports isJsonMode — `../output/format.js`
// relative to `src/commands/token.ts`, so from this test file
// (`src/commands/__tests__/`) the path is `../../output/format.js`.
vi.mock('../../output/format.js', async (orig) => ({
  ...(await orig<object>()),
  isJsonMode: vi.fn(() => true),
}));

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(async () => ({ accessToken: 'TOKEN_VALUE' })),
}));

vi.mock('../channels.js', () => ({
  resolveChannel: vi.fn(async () => ({ id: 'ch_TEST0001', type: 'instagram' })),
}));

import type { Command } from 'commander';
import { isJsonMode } from '../../output/format.js';
import { runChannelToken } from '../token.js';

describe('runChannelToken --json (D6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  test('When --json, then output is the wrapped JSON shape', async () => {
    vi.mocked(isJsonMode).mockReturnValue(true);
    await runChannelToken('ch_TEST0001', {} as Command);
    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      channelId: 'ch_TEST0001',
      type: 'instagram',
      accessToken: 'TOKEN_VALUE',
    });
  });

  test('When human mode, then output is the raw token (unchanged)', async () => {
    vi.mocked(isJsonMode).mockReturnValue(false);
    await runChannelToken('ch_TEST0001', {} as Command);
    expect(stdoutSpy).toHaveBeenCalledWith('TOKEN_VALUE\n');
  });
});
