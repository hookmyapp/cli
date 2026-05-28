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
    streamDeliveries: vi.fn(),
    fetchDeliveriesPage: vi.fn(),
    fetchDeliveryDetail: vi.fn(),
  };
});

import { apiClient } from '../../../api/client.js';
import { runChannelLogsList } from '../index.js';
import {
  streamDeliveries,
  fetchDeliveriesPage,
  fetchDeliveryDetail,
} from '../api.js';

// Wire-mirror dto fed into resolveChannel → parseChannelListItem. Fields match
// the InstagramChannel branch in src/api/channel.ts (parseChannelListItem,
// 'instagram' case).
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

// Sample DeliveryDetail used by both the snapshot fetch and the SSE yields.
// Carries IG-aware sender fields (senderDisplay/senderId) per D8.
const sampleDetail = {
  id: 'wph_001',
  workspaceId: 'ws_TEST0001',
  scopeKind: 'channel',
  channelId: 'chan-uuid',
  sandboxSessionId: null,
  providerObject: 'instagram',
  providerResourceId: '17841',
  metaMessageId: null,
  inboundBody: '{"text":"hi"}',
  inboundBodySha256: 'sha',
  inboundBodyTruncated: false,
  inboundHeaders: null,
  signatureOk: true,
  routingDecision: 'forward',
  isSandbox: false,
  requestId: 'req-001',
  fromPhone: null,
  senderId: '1907',
  senderDisplay: '@ordvir',
  receivedAt: '2026-05-26T14:30:01Z',
  humanStatus: 'delivered',
  humanStatusCopy: 'Delivered',
  humanStatusTooltip: null,
  humanStatusColor: 'green' as const,
  outcome: 'delivered' as const,
  outcomeReason: null,
  forwardUrl: 'https://n8n.example/webhook',
  forwardRequestHeaders: null,
  forwardRequestBody: '',
  forwardStatus: 200,
  forwardDurationMs: 150,
  forwardResponseHeaders: null,
  forwardResponseBody: null,
  forwardResponseBodySha256: null,
  forwardResponseBodyTruncated: false,
  attemptedAt: '2026-05-26T14:30:01.150Z',
  relatedDeliveries: [],
};

describe('channels logs list --follow streams deliveries', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(streamDeliveries).mockReset();
    vi.mocked(fetchDeliveriesPage).mockReset();
    vi.mocked(fetchDeliveryDetail).mockReset();
  });

  it('emits the initial snapshot + each streamed delivery as summary rows', async () => {
    // resolveChannel hits /meta/channels — one apiClient call.
    vi.mocked(apiClient).mockResolvedValueOnce([igDto]);
    // Snapshot: 1 summary + 1 detail fetch.
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({
      deliveries: [{ id: 'wph_001' } as unknown as never],
      nextCursor: null,
      floorHours: 168,
    });
    vi.mocked(fetchDeliveryDetail).mockResolvedValueOnce(sampleDetail);
    // SSE yields 2 more deliveries, then stream ends.
    vi.mocked(streamDeliveries).mockReturnValueOnce(
      (async function* () {
        yield { ...sampleDetail, id: 'wph_002' };
        yield { ...sampleDetail, id: 'wph_003' };
      })(),
    );

    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await runChannelLogsList('@ordvir', { follow: true, limit: '1' }, false);

    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('@ordvir'); // sender in summary
    expect(combined).toContain('n8n.example'); // target host parsed from forwardUrl
    expect(streamDeliveries).toHaveBeenCalledWith({
      channelPublicId: 'ch_IGaaaaaa',
      workspaceId: 'ws_TEST0001',
    });
    outSpy.mockRestore();
  });
});
