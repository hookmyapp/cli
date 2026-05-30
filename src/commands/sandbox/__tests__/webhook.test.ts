import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import {
  runSandboxWebhookSet,
  runSandboxWebhookShow,
  runSandboxWebhookClear,
} from '../webhook.js';
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
  senderInstagramId: '8745912038476523',
  accountInstagramId: '17841478719287768',
  senderInstagramUsername: 'ordvir',
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
        identifierArg: '+15551234567',
        username: '@ordvir',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws CONFLICTING_SELECTORS when positional + --session are both provided', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    await expect(
      runSandboxWebhookSet({
        identifierArg: '+15551234567',
        session: 'ssn_WA000001',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });

  it('throws CONFLICTING_SELECTORS when positional + --phone are both provided', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    await expect(
      runSandboxWebhookSet({
        identifierArg: '+15551234567',
        phone: '+15551234567',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });
});

describe('runSandboxWebhookShow — JSON shape preserved from pre-0.12.2 sandbox.ts', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('WA via positional +phone → mode:"cli" with sessionId/identifier/phone/tunnelUrl', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([
      { ...wa, hostname: 'wa-abc.cloudflare.example', webhookUrl: null },
    ]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxWebhookShow({ identifierArg: '+15551234567', json: true });
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toEqual({
      sessionId: 'ssn_WA000001',
      type: 'whatsapp',
      identifier: '+15551234567',
      phone: '15551234567',
      webhookUrl: null,
      mode: 'cli',
      tunnelUrl: 'https://wa-abc.cloudflare.example/webhook',
    });
    outSpy.mockRestore();
  });

  it('IG via positional @handle → mode:"custom", phone:null (channel-agnostic identifier wins)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([
      { ...ig, hostname: 'ig-xyz.cloudflare.example', webhookUrl: 'https://my.example/hook' },
    ]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxWebhookShow({ identifierArg: '@ordvir', json: true });
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toEqual({
      sessionId: 'ssn_IG000001',
      type: 'instagram',
      identifier: '@ordvir',
      phone: null,
      webhookUrl: 'https://my.example/hook',
      mode: 'custom',
      tunnelUrl: 'https://ig-xyz.cloudflare.example/webhook',
    });
    outSpy.mockRestore();
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

describe('runSandboxWebhookSet/Clear — mutations honor --json', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('set --json emits a structured status envelope, not human text', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]); // sessions list
    vi.mocked(apiClient).mockResolvedValueOnce(undefined); // PATCH
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSandboxWebhookSet({
      session: 'ssn_WA000001',
      url: 'https://my.example/hook',
      json: true,
    });

    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      status: 'set',
      sessionId: 'ssn_WA000001',
      type: 'whatsapp',
      webhookUrl: 'https://my.example/hook',
    });
    expect(logSpy).not.toHaveBeenCalled();
    outSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('clear --json emits a structured status envelope', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]); // sessions list
    vi.mocked(apiClient).mockResolvedValueOnce(undefined); // reset
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runSandboxWebhookClear({ session: 'ssn_WA000001', json: true });

    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      status: 'cleared',
      sessionId: 'ssn_WA000001',
      type: 'whatsapp',
    });
    outSpy.mockRestore();
  });
});
