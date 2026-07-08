import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock('../../api/client.js', () => ({ apiClient: mocks.apiClient }));

import {
  fetchDeliveriesPage,
  fetchDeliveryDetail,
  fetchAllDeliveries,
  ALL_ROW_CAP,
  type DeliveryLog,
} from '../../commands/channels-logs/api.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchDeliveriesPage', () => {
  it('builds a channel-scoped query and forwards the workspace id', async () => {
    mocks.apiClient.mockResolvedValue({
      logs: [],
      nextCursor: null,
    });

    await fetchDeliveriesPage({
      channelPublicId: 'ch_abc12345',
      workspaceId: 'ws_w1',
      limit: 50,
      since: '2026-05-19T00:00:00.000Z',
    });

    const [path, opts] = mocks.apiClient.mock.calls[0];
    expect(path).toMatch(/^\/deliveries\?/);
    expect(path).toContain('scope=channel%3Ach_abc12345');
    expect(path).toContain('limit=50');
    expect(path).toContain('since=2026-05-19T00%3A00%3A00.000Z');
    expect(opts).toEqual({ workspaceId: 'ws_w1' });
  });

  it('omits since/until/cursor when not provided', async () => {
    mocks.apiClient.mockResolvedValue({
      logs: [],
      nextCursor: null,
    });

    await fetchDeliveriesPage({
      channelPublicId: 'ch_abc12345',
      workspaceId: 'ws_w1',
      limit: 25,
    });

    const [path] = mocks.apiClient.mock.calls[0];
    expect(path).not.toContain('since=');
    expect(path).not.toContain('until=');
    expect(path).not.toContain('cursor=');
  });

  it('keeps the wd_ publicId on cleaned rows (logs show handle)', async () => {
    mocks.apiClient.mockResolvedValue({
      logs: [row({ publicId: 'wd_abc12345' })],
      nextCursor: null,
    });

    const page = await fetchDeliveriesPage({
      channelPublicId: 'ch_abc12345',
      workspaceId: 'ws_w1',
      limit: 50,
    });

    expect(page.logs[0].publicId).toBe('wd_abc12345');
  });
});

describe('fetchDeliveryDetail', () => {
  it('GETs the workspace-scoped detail endpoint by id', async () => {
    mocks.apiClient.mockResolvedValue(row());

    await fetchDeliveryDetail(
      '9b1f2e3d-4c5a-6789-0abc-def012345678',
      'ws_w1',
    );

    expect(mocks.apiClient).toHaveBeenCalledWith(
      '/deliveries/9b1f2e3d-4c5a-6789-0abc-def012345678',
      { workspaceId: 'ws_w1' },
    );
  });
});

function row(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return {
    publicId: 'wd_u9uElygL',
    receivedAt: '2026-05-20T11:58:00.000Z',
    sender: '15551234567',
    messageId: 'wamid.test',
    meta: { text: 'hi' },
    hookmyapp: {
      status: 'delivered',
      statusText: 'Delivered to your app',
      destination: { type: 'webhook', url: 'https://customer.app/webhook' },
      appResponse: { status: 200, durationMs: 42, body: { ok: true } },
    },
    ...overrides,
  };
}

function rows(n: number, prefix: string): DeliveryLog[] {
  return Array.from({ length: n }, (_, i) => row({ messageId: `${prefix}-${i}` }));
}

describe('fetchAllDeliveries', () => {
  const base = { channelPublicId: 'ch_abc12345', workspaceId: 'ws_w1', limit: 50 };

  it('follows nextCursor and concatenates every page', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({ logs: rows(50, 'a'), nextCursor: 'c1' })
      .mockResolvedValueOnce({ logs: rows(50, 'b'), nextCursor: 'c2' })
      .mockResolvedValueOnce({ logs: rows(10, 'c'), nextCursor: null });

    const page = await fetchAllDeliveries(base);

    expect(page.logs).toHaveLength(110);
    expect(page.nextCursor).toBeNull();
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
  });

  it('stops at ALL_ROW_CAP and keeps a non-null nextCursor as the truncation signal', async () => {
    mocks.apiClient.mockResolvedValue({
      logs: rows(100, 'p'),
      nextCursor: 'more',
    });

    const page = await fetchAllDeliveries({ ...base, limit: 100 });

    expect(page.logs).toHaveLength(ALL_ROW_CAP);
    expect(page.nextCursor).toBe('more');
    expect(mocks.apiClient).toHaveBeenCalledTimes(10);
  });

  it('stops on an empty-logs page even when nextCursor is non-null', async () => {
    mocks.apiClient.mockResolvedValue({
      logs: [],
      nextCursor: 'still-more',
    });

    const page = await fetchAllDeliveries(base);

    expect(page.logs).toHaveLength(0);
    expect(page.nextCursor).toBe('still-more');
    expect(mocks.apiClient).toHaveBeenCalledTimes(1);
  });

  it('passes the initial cursor through to the first request', async () => {
    mocks.apiClient.mockResolvedValue({ logs: [], nextCursor: null });

    await fetchAllDeliveries({ ...base, cursor: 'start-here' });

    const [path] = mocks.apiClient.mock.calls[0];
    expect(path).toContain('cursor=start-here');
  });
});
