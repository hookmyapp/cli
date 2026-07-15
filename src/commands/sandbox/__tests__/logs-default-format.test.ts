import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxLogs } from '../logs.js';
import type { DeliveryLog } from '../../channels-logs/api.js';

const ig = {
  id: 'ssn_IG000001',
  type: 'instagram',
  senderInstagramId: '1907',
  accountInstagramId: '1784',
  senderInstagramUsername: 'ordvir',
  accessToken: 'tok',
  hmacSecret: 'hmac',
  verifyToken: 'VT_test',
  status: 'active',
  origin: 'demo_handoff',
};

function deliveryLog(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return {
    publicId: 'wd_u9uElygL',
    receivedAt: '2026-05-26T14:30:01Z',
    sender: '@ordvir',
    messageId: 'mid-001',
    meta: { text: 'Hello from cli' },
    hookmyapp: {
      status: 'delivered',
      statusText: 'Delivered to your webhook',
      destination: { type: 'webhook', url: 'https://n8n.example/webhook' },
      appResponse: { status: 200, durationMs: 150, body: null },
    },
    ...overrides,
  };
}

describe('runSandboxLogs — default is table-by-default (D9)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('prints one-line summary per delivery (timestamp · sender · target · status · latency · preview)', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({
        logs: [
          deliveryLog(),
          deliveryLog({
            receivedAt: '2026-05-26T14:32:15Z',
            messageId: 'mid-002',
            meta: { text: 'test image' },
            hookmyapp: {
              status: 'no_response',
              statusText: 'Webhook timed out',
              destination: { type: 'webhook', url: 'https://n8n.example/webhook' },
              appResponse: { status: null, durationMs: null, body: null },
            },
          }),
        ],
      });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxLogs({ identifierArg: '@ordvir', limit: 5, json: false });
    const combined =
      outSpy.mock.calls.map((c) => c[0]).join('') +
      logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Default = summary lines, NOT verbose dump.
    expect(combined).not.toMatch(/inboundBody:/);
    expect(combined).not.toMatch(/Forward attempt:/);
    // Each summary row contains: sender, target host, status code, latency.
    expect(combined).toContain('@ordvir');
    expect(combined).toContain('n8n.example');
    expect(combined).toContain('200');
    expect(combined).toContain('150ms');
    expect(combined).toContain('Webhook timed out');
    outSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('--verbose returns the pre-flip detailed format', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ logs: [deliveryLog()] });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxLogs({ identifierArg: '@ordvir', limit: 1, verbose: true, json: false });
    const combined =
      outSpy.mock.calls.map((c) => c[0]).join('') +
      logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // --verbose contains the Meta payload and app response block.
    expect(combined).toMatch(/Meta payload/i);
    expect(combined).toMatch(/Hello from cli/);
    outSpy.mockRestore();
    logSpy.mockRestore();
  });
});
