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
import { fetchDeliveriesPage, fetchDeliveryDetail, type DeliveryLog } from '../api.js';

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

function deliveryLog(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return {
    publicId: 'wd_u9uElygL',
    receivedAt: '2026-05-26T14:30:01Z',
    sender: '@ordvir',
    messageId: 'mid-001',
    meta: { object: 'instagram' },
    hookmyapp: {
      status: 'delivered',
      statusText: 'Delivered',
      destination: { type: 'webhook', url: 'https://customer.app/webhook' },
      appResponse: { status: 200, durationMs: 50, body: null },
    },
    ...overrides,
  };
}

describe('channels logs list --json emits a clean JSON array', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(fetchDeliveriesPage).mockReset();
    vi.mocked(fetchDeliveryDetail).mockReset();
  });

  it('emits a single JSON array of public delivery logs', async () => {
    // resolveChannel hits /meta/channels.
    vi.mocked(apiClient).mockResolvedValueOnce([igDto]);
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({
      logs: [
        deliveryLog({ messageId: 'mid-001' }),
        deliveryLog({
          messageId: 'mid-002',
          receivedAt: '2026-05-26T14:30:05Z',
          hookmyapp: {
            status: 'rejected',
            statusText: 'Rejected',
            destination: { type: 'webhook', url: 'https://customer.app/webhook' },
            appResponse: { status: 500, durationMs: 80, body: null },
          },
        }),
      ],
      nextCursor: null,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runChannelLogsList('@ordvir', {}, true);

    // Exactly one write, and it parses as a JSON array of the two DTOs.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arr = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);
    for (const dto of arr) {
      expect(dto.humanStatusTooltip).toBeUndefined();
      expect(dto.humanStatusColor).toBeUndefined();
      expect(dto.routingDecision).toBeUndefined();
      expect(dto.requestId).toBeUndefined();
      // The wd_ handle for `logs show <id>` carries through.
      expect(dto.publicId).toBe('wd_u9uElygL');
      // Sender chain carries through.
      expect(dto.sender).toBe('@ordvir');
    }
    expect(fetchDeliveryDetail).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('emits [] (not empty output) when the channel has no deliveries', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([igDto]);
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({
      logs: [],
      nextCursor: null,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runChannelLogsList('@ordvir', {}, true);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual([]);
    expect(fetchDeliveryDetail).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
