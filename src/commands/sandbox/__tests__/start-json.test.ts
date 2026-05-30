import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolated mocks for the --json success path. Kept in a separate file from
// start.test.ts because that file deliberately uses the REAL env-profiles
// (its production test asserts getEffectiveSandboxInstagramUsername throws);
// mocking env-profiles here would break those.
vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
  getBindCode: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('../../../config/env-profiles.js', () => ({
  getEffectiveSandboxWhatsAppNumber: vi.fn().mockReturnValue('15557046276'),
  getEffectiveSandboxInstagramUsername: vi.fn().mockReturnValue('@hookmyappsandboxstaging'),
}));
vi.mock('../../../output/format.js', () => ({
  output: vi.fn(),
}));

import { getBindCode } from '../../../api/client.js';
import { output } from '../../../output/format.js';
import { runSandboxStart } from '../start.js';

const mockedGetBindCode = vi.mocked(getBindCode);
const mockedOutput = vi.mocked(output);

describe('runSandboxStart — --json success path', () => {
  beforeEach(() => {
    mockedGetBindCode.mockReset();
    mockedOutput.mockReset();
  });

  it('emits the minted bind code + deep link as JSON and returns without polling', async () => {
    mockedGetBindCode.mockResolvedValueOnce({
      code: 'hmp3gj54',
      issuedAt: '2026-05-30T00:00:00.000Z',
    } as never);

    await runSandboxStart({ type: 'whatsapp', json: true });

    expect(mockedOutput).toHaveBeenCalledWith(
      {
        code: 'hmp3gj54',
        type: 'whatsapp',
        deepLink: 'https://wa.me/15557046276?text=hmp3gj54',
        issuedAt: '2026-05-30T00:00:00.000Z',
      },
      { json: true },
    );
  });
});
