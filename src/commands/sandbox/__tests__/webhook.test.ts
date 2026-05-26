import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxWebhookSet } from '../webhook.js';
import { ValidationError } from '../../../output/error.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

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

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxWebhookSet — positional + flag conflict (E5)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('throws CONFLICTING_SELECTORS when positional + --username are both provided', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    await expect(
      runSandboxWebhookSet({
        positionalPhone: '+15551234567',
        username: '@ordvir',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws CONFLICTING_SELECTORS when positional + --session are both provided', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    await expect(
      runSandboxWebhookSet({
        positionalPhone: '+15551234567',
        session: 'ssn_WA000001',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });
});

describe('runSandboxWebhookSet — positional alone emits deprecation warning (D12)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('writes a deprecation warning to stderr and proceeds', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(undefined);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runSandboxWebhookSet({
      positionalPhone: '+15551234567',
      url: 'https://my.example/hook',
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[deprecated]'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--phone'));
    errSpy.mockRestore();
  });
});

describe('runSandboxWebhookSet — --username selects IG session', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('selects the IG session and sends the PUT', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa, ig])
      .mockResolvedValueOnce(undefined);
    await runSandboxWebhookSet({
      username: '@ordvir',
      url: 'https://my.example/hook',
    });
    // Second apiClient call should be the PATCH to /sandbox/sessions/ssn_IG000001/webhook-url
    expect(vi.mocked(apiClient).mock.calls[1][0]).toContain('ssn_IG000001');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toContain('/webhook-url');
    expect(vi.mocked(apiClient).mock.calls[1][1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ webhookUrl: 'https://my.example/hook' }),
    });
  });
});
