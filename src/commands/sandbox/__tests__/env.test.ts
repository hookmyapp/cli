import { describe, it, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Command } from 'commander';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
// Mock isJsonMode so we can toggle the --json branch without commander
// gymnastics — mirrors the pattern in src/commands/__tests__/env.test.ts.
vi.mock('../../../output/format.js', async (orig) => ({
  ...(await orig<object>()),
  isJsonMode: vi.fn(() => false),
}));

import { apiClient } from '../../../api/client.js';
import { isJsonMode } from '../../../output/format.js';
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
  senderInstagramId: '8745912038476523',
  accountInstagramId: '17841478719287768',
  senderInstagramUsername: 'ordvir',
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

  it('emits the WA block with WEBHOOK_HMAC_SECRET', () => {
    const out = buildEnvBlock(wa);
    expect(out).toBe(
      [
        'WEBHOOK_HMAC_SECRET=HMAC_wa_yyy',
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

  it('emits the IG block with INSTAGRAM_* vars, v25.0 URL, and WEBHOOK_HMAC_SECRET', () => {
    const out = buildEnvBlock(ig);
    expect(out).toBe(
      [
        'WEBHOOK_HMAC_SECRET=HMAC_ig_yyy',
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

describe('runSandboxEnv --json — flat {KEY: VALUE} object', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
    vi.mocked(isJsonMode).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  test('When --json (via threaded Command), then output parses as a flat object with the IG keys including PORT', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    vi.mocked(isJsonMode).mockReturnValue(true);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxEnv({}, {} as Command);
    const parsed = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(parsed).toEqual({
      WEBHOOK_HMAC_SECRET: 'HMAC_ig_yyy',
      PORT: '3000',
      INSTAGRAM_API_URL: 'https://proxy.test/v25.0',
      INSTAGRAM_ACCESS_TOKEN: 'ACT_ig_xxx',
      INSTAGRAM_ACCOUNT_ID: '17841478719287768',
    });
    writeSpy.mockRestore();
  });

  test('When human mode, then output is dotenv text and JSON.parse throws', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    vi.mocked(isJsonMode).mockReturnValue(false);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxEnv({});
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('WHATSAPP_API_URL=');
    expect(() => JSON.parse(out)).toThrow();
    writeSpy.mockRestore();
  });
});
