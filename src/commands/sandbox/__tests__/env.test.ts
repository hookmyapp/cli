import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxEnv, buildEnvBlock } from '../env.js';
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
  accessToken: 'ACT_wa_xxx',
  hmacSecret: 'HMAC_wa_yyy',
  status: 'active',
  origin: 'manual',
};

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig_xxx',
  hmacSecret: 'HMAC_ig_yyy',
  status: 'active',
  origin: 'demo_handoff',
};

describe('buildEnvBlock — WhatsApp regression', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('emits the existing 5-line WA block', () => {
    const out = buildEnvBlock(wa);
    expect(out).toBe(
      [
        'VERIFY_TOKEN=HMAC_wa_yyy',
        'PORT=3000',
        'WHATSAPP_API_URL=https://proxy.test/v24.0',
        'WHATSAPP_ACCESS_TOKEN=ACT_wa_xxx',
        'WHATSAPP_PHONE_NUMBER_ID=15551234567',
        '',
      ].join('\n'),
    );
  });
});

describe('buildEnvBlock — Instagram (D2)', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('emits the 5-line IG block with INSTAGRAM_* vars and v25.0 URL', () => {
    const out = buildEnvBlock(ig);
    expect(out).toBe(
      [
        'VERIFY_TOKEN=HMAC_ig_yyy',
        'PORT=3000',
        'INSTAGRAM_API_URL=https://proxy.test/v25.0',
        'INSTAGRAM_ACCESS_TOKEN=ACT_ig_xxx',
        'INSTAGRAM_ACCOUNT_ID=17841478719287768',
        '',
      ].join('\n'),
    );
  });
});

describe('runSandboxEnv — happy path', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('prints WA block to stdout when --write is not set', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxEnv({});
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('WHATSAPP_API_URL='));
    writeSpy.mockRestore();
  });

  it('prints IG block when the only session is IG', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxEnv({});
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('INSTAGRAM_API_URL='));
    writeSpy.mockRestore();
  });
});
