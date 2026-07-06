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
  type DeliveryLog,
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
  instagramProfileName: 'Or',
  instagramProfilePictureUrl: null,
};

const sampleLog: DeliveryLog = {
  receivedAt: '2026-05-26T14:30:01Z',
  sender: '@ordvir',
  messageId: 'mid-001',
  meta: { text: 'hi' },
  hookmyapp: {
    status: 'delivered',
    statusText: 'Delivered',
    destination: { type: 'webhook', url: 'https://n8n.example/webhook' },
    appResponse: { status: 200, durationMs: 150, body: null },
  },
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
    // Snapshot rows are already clean public logs.
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({
      logs: [sampleLog],
      nextCursor: null,
    });
    // SSE yields 2 more deliveries, then stream ends.
    vi.mocked(streamDeliveries).mockReturnValueOnce(
      (async function* () {
        yield { ...sampleLog, messageId: 'mid-002' };
        yield { ...sampleLog, messageId: 'mid-003' };
      })(),
    );

    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await runChannelLogsList('@ordvir', { follow: true, limit: '1' }, false);

    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('@ordvir'); // sender in summary
    expect(combined).toContain('App response: 200 in 150ms');
    expect(streamDeliveries).toHaveBeenCalledWith({
      channelPublicId: 'ch_IGaaaaaa',
      workspaceId: 'ws_TEST0001',
    });
    expect(fetchDeliveryDetail).not.toHaveBeenCalled();
    outSpy.mockRestore();
  });
});
