import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock('../../api/client.js', () => ({ apiClient: mocks.apiClient }));

import {
  fetchDeliveriesPage,
  fetchDeliveryDetail,
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
