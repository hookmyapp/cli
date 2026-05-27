import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxStatus } from '../status.js';

// Raw wire payload that the backend returns — includes sensitive fields
// (hmacSecret, accessToken, cloudflareTunnelToken) plus backend metadata
// (origin, createdAt, etc). The CLI MUST whitelist; never pass-through.
const rawWaWire = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'wa-secret-token',
  hmacSecret: 'wa-hmac-secret',
  status: 'active',
  origin: 'manual',
  webhookUrl: null,
  hostname: null,
  cloudflareTunnelId: 'tunnel-abc',
  cloudflareTunnelToken: 'TUNNEL_SECRET_TOKEN',
  workspaceName: 'My Workspace',
  createdAt: '2026-05-25T11:00:00.000Z',
  updatedAt: '2026-05-25T12:00:00.000Z',
};

const rawIgWire = {
  id: 'ssn_IG000001',
  type: 'instagram',
  senderInstagramId: '1907363356636806',
  accountInstagramId: '17841435835498884',
  senderInstagramUsername: 'ordvir',
  accessToken: 'ig-secret-token',
  hmacSecret: 'ig-hmac-secret',
  status: 'active',
  origin: 'demo_handoff',
  webhookUrl: 'https://my.example/hook',
  hostname: null,
  cloudflareTunnelId: null,
  cloudflareTunnelToken: null,
  workspaceName: 'My Workspace',
  activatedAt: '2026-05-25T11:30:00.000Z',
  lastDemoRefreshPromptAt: null,
  claimTokenHash: null,
};

describe('runSandboxStatus --json — minimal hand-picked shape', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('IG row: identifier @handle + IG wire ids; NO WA fields, NO secrets, NO backend metadata', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([rawIgWire]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxStatus({ json: true });
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toEqual([
      {
        id: 'ssn_IG000001',
        type: 'instagram',
        identifier: '@ordvir',
        status: 'active',
        webhookUrl: 'https://my.example/hook',
        senderInstagramUsername: 'ordvir',
        senderInstagramId: '1907363356636806',
        accountInstagramId: '17841435835498884',
      },
    ]);
    outSpy.mockRestore();
  });

  it('WA row: identifier +phone + WA wire ids; NO IG fields, NO secrets', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([rawWaWire]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxStatus({ json: true });
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toEqual([
      {
        id: 'ssn_WA000001',
        type: 'whatsapp',
        identifier: '+15551234567',
        status: 'active',
        webhookUrl: null,
        whatsappPhone: '15551234567',
        whatsappPhoneNumberId: '1080996501762047',
      },
    ]);
    outSpy.mockRestore();
  });

  it('NEVER leaks hmacSecret / accessToken / cloudflareTunnelToken / origin / workspaceName', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([rawWaWire, rawIgWire]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxStatus({ json: true });
    const raw = outSpy.mock.calls[0][0] as string;
    // String-level assertions catch leaks via any field name or alias.
    expect(raw).not.toContain('hmacSecret');
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('cloudflareTunnelToken');
    expect(raw).not.toContain('TUNNEL_SECRET_TOKEN');
    expect(raw).not.toContain('wa-hmac-secret');
    expect(raw).not.toContain('ig-hmac-secret');
    expect(raw).not.toContain('wa-secret-token');
    expect(raw).not.toContain('ig-secret-token');
    expect(raw).not.toContain('origin');
    expect(raw).not.toContain('workspaceName');
    expect(raw).not.toContain('createdAt');
    expect(raw).not.toContain('lastDemoRefreshPromptAt');
    outSpy.mockRestore();
  });
});
