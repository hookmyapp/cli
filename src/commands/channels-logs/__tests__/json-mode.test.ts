import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('../api.js', async () => {
  const actual = await vi.importActual<typeof import('../api.js')>('../api.js');
  return {
    ...actual,
    fetchDeliveriesPage: vi.fn(),
    fetchDeliveryDetail: vi.fn(),
  };
});

import { apiClient } from '../../../api/client.js';
import { runChannelLogsList } from '../index.js';
import { fetchDeliveriesPage, fetchDeliveryDetail } from '../api.js';

const igDto = {
  id: 'ch_IGaaaaaa',
  type: 'instagram',
  workspaceId: 'ws_TEST0001',
  metaWabaId: '',
  metaResourceId: '17841',
  connectionType: 'instagram_login',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: null,
  verifyToken: null,
  instagramUsername: 'ordvir',
  instagramName: 'Or',
  instagramProfilePictureUrl: null,
};

/** Build a DeliveryDetail wire fixture; minimal but covers the JSONL contract. */
function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'wph_001',
    workspaceId: 'ws_TEST0001',
    scopeKind: 'channel',
    channelId: 'chan-uuid',
    sandboxSessionId: null,
    providerObject: 'instagram',
    providerResourceId: '17841',
    metaMessageId: null,
    inboundBody: '{}',
    inboundBodySha256: 'sha',
    inboundBodyTruncated: false,
    inboundHeaders: null,
    signatureOk: true,
    routingDecision: 'forward',
    isSandbox: false,
    requestId: 'req',
    fromPhone: null,
    senderId: '1907',
    senderDisplay: '@ordvir',
    receivedAt: '2026-05-26T14:30:01Z',
    humanStatus: 'delivered',
    humanStatusCopy: 'Delivered',
    humanStatusTooltip: 'shown on hover',
    humanStatusColor: 'green' as const,
    outcome: 'delivered' as const,
    outcomeReason: null,
    forwardUrl: 'https://customer.app/webhook',
    forwardRequestHeaders: null,
    forwardRequestBody: null,
    forwardStatus: 200,
    forwardDurationMs: 50,
    forwardResponseHeaders: null,
    forwardResponseBody: null,
    forwardResponseBodySha256: null,
    forwardResponseBodyTruncated: false,
    attemptedAt: '2026-05-26T14:30:01.050Z',
    relatedDeliveries: [],
    ...over,
  };
}

describe('channels logs list --json emits JSONL with GUI fields stripped', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(fetchDeliveriesPage).mockReset();
    vi.mocked(fetchDeliveryDetail).mockReset();
  });

  it('emits one JSON object per line; humanStatusTooltip + humanStatusColor stripped', async () => {
    // resolveChannel hits /meta/channels.
    vi.mocked(apiClient).mockResolvedValueOnce([igDto]);
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({
      deliveries: [
        { id: 'wph_001' } as unknown as never,
        { id: 'wph_002' } as unknown as never,
      ],
      nextCursor: null,
      floorHours: 168,
    });
    vi.mocked(fetchDeliveryDetail)
      .mockResolvedValueOnce(detail({ id: 'wph_001' }))
      .mockResolvedValueOnce(
        detail({
          id: 'wph_002',
          receivedAt: '2026-05-26T14:30:05Z',
          humanStatus: 'failed',
          humanStatusCopy: 'Failed',
          humanStatusColor: 'red' as const,
        }),
      );

    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await runChannelLogsList('@ordvir', {}, true);

    const writes = outSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.startsWith('{'));
    expect(writes).toHaveLength(2);
    for (const line of writes) {
      const dto = JSON.parse(line);
      expect(dto.humanStatusTooltip).toBeUndefined();
      expect(dto.humanStatusColor).toBeUndefined();
      expect(dto.id).toMatch(/^wph_/);
      // Sender chain carries through.
      expect(dto.senderDisplay).toBe('@ordvir');
    }
    outSpy.mockRestore();
  });
});
