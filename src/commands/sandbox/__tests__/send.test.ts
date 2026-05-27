import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxSend } from '../send.js';
import { ApiError, SessionWindowError } from '../../../output/error.js';
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

describe('runSandboxSend — WhatsApp', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
    vi.restoreAllMocks();
  });

  it('posts to the WA endpoint with the WA body shape', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 }),
    );

    await runSandboxSend({ phone: '+15551234567', message: 'hi' });

    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://proxy.test/v24.0/1080996501762047/messages');
    expect(JSON.parse(String(calledInit?.body))).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi' },
    });
  });
});

describe('runSandboxSend — Instagram', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
    vi.restoreAllMocks();
  });

  it('posts to the IG endpoint with the IG body shape', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ recipient_id: '8745912038476523', message_id: 'mid.IGSTANDARD_xxx' }),
        { status: 201 },
      ),
    );

    await runSandboxSend({ username: '@ordvir', message: 'hello' });

    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://proxy.test/v25.0/17841478719287768/messages');
    expect(JSON.parse(String(calledInit?.body))).toEqual({
      recipient: { id: '8745912038476523' },
      message: { text: 'hello' },
    });
  });

  it('extracts message_id from the flat IG response shape', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ recipient_id: '8745912038476523', message_id: 'mid.IGSTANDARD_xxx' }),
        { status: 201 },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxSend({ username: '@ordvir', message: 'hi' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mid.IGSTANDARD_xxx'));
  });

  it('surfaces SESSION_WINDOW_CLOSED 403 from sandbox-proxy verbatim (E8)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'SESSION_WINDOW_CLOSED',
          message: 'Reply window is closed. Customer must message you again first.',
        }),
        { status: 403 },
      ),
    );

    // Single run; both assertions share the same caught error so the one-shot
    // mocks aren't consumed twice.
    let caught: unknown;
    try {
      await runSandboxSend({ username: '@ordvir', message: 'late reply' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionWindowError);
    expect((caught as Error).message).toMatch(/Reply window is closed/);
  });
});
