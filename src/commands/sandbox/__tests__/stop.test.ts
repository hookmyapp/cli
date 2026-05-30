import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
// confirm must never be reached in the non-interactive cases below.
// vi.hoisted so the mock var exists before the hoisted vi.mock factory runs.
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ confirm: confirmMock }));

import { apiClient } from '../../../api/client.js';
import { runSandboxStop } from '../stop.js';
import { ValidationError } from '../../../output/error.js';
import type { WhatsAppSandboxSession } from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

describe('runSandboxStop — non-interactive confirmation gate', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    confirmMock.mockReset();
  });

  it('refuses to DELETE in --json mode without --yes (ValidationError, no prompt, no DELETE)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]); // sessions list only
    await expect(
      runSandboxStop({ session: 'ssn_WA000001', json: true }),
    ).rejects.toThrow(ValidationError);
    expect(confirmMock).not.toHaveBeenCalled();
    // Only the sessions list was fetched — no DELETE was issued.
    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(1);
  });

  it('proceeds with the DELETE in --json mode when --yes is passed', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa]) // sessions list
      .mockResolvedValueOnce(undefined); // DELETE
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSandboxStop({ session: 'ssn_WA000001', json: true, yes: true });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(vi.mocked(apiClient).mock.calls[1][0]).toContain('ssn_WA000001');
    expect(vi.mocked(apiClient).mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    logSpy.mockRestore();
  });
});
