import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxLogs } from '../logs.js';

const ig = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '1907',
  instagramAccountId: '1784',
  instagramSenderUsername: 'ordvir',
  accessToken: 'tok',
  hmacSecret: 'hmac',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxLogs — default is table-by-default (D9)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('prints one-line summary per delivery (timestamp · sender · target · status · latency · preview)', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({
        deliveries: [
          { id: 'wph_001', receivedAt: '2026-05-26T14:30:01Z' },
          { id: 'wph_002', receivedAt: '2026-05-26T14:32:15Z' },
        ],
      })
      .mockResolvedValueOnce({
        id: 'wph_001',
        routingDecision: 'forward',
        inboundBody: '{"text":"Hello from cli"}',
        fromPhone: null,
        senderDisplay: '@ordvir',
        senderId: '1907',
        receivedAt: '2026-05-26T14:30:01Z',
        humanStatus: 'delivered',
        humanStatusCopy: 'Delivered to your webhook',
        attempts: [
          {
            id: 'a1', attemptNumber: 1,
            forwardUrl: 'https://n8n.example/webhook',
            forwardRequestBody: '',
            forwardStatus: 200,
            forwardDurationMs: 150,
            forwardResponseBody: null,
            outcome: 'success',
            attemptedAt: '2026-05-26T14:30:01.150Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'wph_002',
        routingDecision: 'forward',
        inboundBody: '{"text":"test image"}',
        fromPhone: null,
        senderDisplay: '@ordvir',
        senderId: '1907',
        receivedAt: '2026-05-26T14:32:15Z',
        humanStatus: 'failed',
        humanStatusCopy: 'Webhook timed out',
        attempts: [
          {
            id: 'a2', attemptNumber: 1,
            forwardUrl: 'https://n8n.example/webhook',
            forwardRequestBody: '',
            forwardStatus: null,
            forwardDurationMs: null,
            forwardResponseBody: null,
            outcome: 'timeout',
            attemptedAt: '2026-05-26T14:32:15.500Z',
          },
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
    expect(combined).toContain('timeout');
    outSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('--verbose returns the pre-flip detailed format', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ deliveries: [{ id: 'wph_001', receivedAt: '...' }] })
      .mockResolvedValueOnce({
        id: 'wph_001',
        routingDecision: 'forward',
        inboundBody: '{"text":"Hello from cli"}',
        fromPhone: null,
        senderDisplay: '@ordvir',
        senderId: '1907',
        receivedAt: '2026-05-26T14:30:01Z',
        humanStatus: 'delivered',
        humanStatusCopy: 'Delivered',
        attempts: [{
          id: 'a1', attemptNumber: 1,
          forwardUrl: 'https://n8n.example/webhook',
          forwardRequestBody: '',
          forwardStatus: 200,
          forwardDurationMs: 150,
          forwardResponseBody: null,
          outcome: 'success',
          attemptedAt: '2026-05-26T14:30:01.150Z',
        }],
      });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxLogs({ identifierArg: '@ordvir', limit: 1, verbose: true, json: false });
    const combined =
      outSpy.mock.calls.map((c) => c[0]).join('') +
      logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // --verbose contains inbound body + forward attempt block.
    expect(combined).toMatch(/inbound/i);
    expect(combined).toMatch(/Hello from cli/);
    outSpy.mockRestore();
    logSpy.mockRestore();
  });
});
