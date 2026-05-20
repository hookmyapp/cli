import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock('../../api/client.js', () => ({ apiClient: mocks.apiClient }));

import {
  fetchDeliveriesPage,
  fetchDeliveryDetail,
  fetchAllDeliveries,
  ALL_ROW_CAP,
} from '../../commands/channels-logs/api.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchDeliveriesPage', () => {
  it('builds a channel-scoped query and forwards the workspace id', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [],
      nextCursor: null,
      floorHours: 24,
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
      deliveries: [],
      nextCursor: null,
      floorHours: 24,
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
});

describe('fetchDeliveryDetail', () => {
  it('GETs the workspace-scoped detail endpoint by id', async () => {
    mocks.apiClient.mockResolvedValue({ id: 'd1' });

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

function rows(n: number, prefix: string): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

describe('fetchAllDeliveries', () => {
  const base = { channelPublicId: 'ch_abc12345', workspaceId: 'ws_w1', limit: 50 };

  it('follows nextCursor and concatenates every page', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({ deliveries: rows(50, 'a'), nextCursor: 'c1', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: rows(50, 'b'), nextCursor: 'c2', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: rows(10, 'c'), nextCursor: null, floorHours: 168 });

    const page = await fetchAllDeliveries(base);

    expect(page.deliveries).toHaveLength(110);
    expect(page.nextCursor).toBeNull();
    expect(page.floorHours).toBe(168);
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
  });

  it('stops at ALL_ROW_CAP and keeps a non-null nextCursor as the truncation signal', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: rows(100, 'p'),
      nextCursor: 'more',
      floorHours: 168,
    });

    const page = await fetchAllDeliveries({ ...base, limit: 100 });

    expect(page.deliveries).toHaveLength(ALL_ROW_CAP);
    expect(page.nextCursor).toBe('more');
  });

  it('passes the initial cursor through to the first request', async () => {
    mocks.apiClient.mockResolvedValue({ deliveries: [], nextCursor: null, floorHours: 24 });

    await fetchAllDeliveries({ ...base, cursor: 'start-here' });

    const [path] = mocks.apiClient.mock.calls[0];
    expect(path).toContain('cursor=start-here');
  });
});
