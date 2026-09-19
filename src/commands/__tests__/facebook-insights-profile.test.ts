import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ data: [] })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_fb', type: 'facebook', metaResourceId: '100000000000001', metaWabaId: null, workspaceId: 'ws_1' })) }));
import { runFacebookInsights } from '../facebook-insights.js';
import { runFacebookProfile } from '../facebook-profile.js';
import { gatewayRequest } from '../../api/gateway.js';

describe('facebook insights and profile', () => {
  beforeEach(() => vi.mocked(gatewayRequest).mockClear());

  it('insights defaults to the Page metrics with period=day', async () => {
    await runFacebookInsights({});
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: '/{page_id}/insights?metric=page_post_engagements%2Cpage_follows%2Cpage_views_total%2Cpage_daily_follows_unique&period=day',
    }));
  });

  it('insights --post uses the post defaults and no period', async () => {
    await runFacebookInsights({ post: '100000000000001_5' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: '/100000000000001_5/insights?metric=post_clicks%2Cpost_reactions_by_type_total%2Cpost_activity_by_action_type',
    }));
  });

  it('insights --metric and --period are honoured, bad period rejected', async () => {
    await runFacebookInsights({ metric: ['page_follows'], period: 'week' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ path: '/{page_id}/insights?metric=page_follows&period=week' }));
    await expect(runFacebookInsights({ period: 'month' })).rejects.toMatchObject({ code: 'INSIGHTS_BAD_PERIOD' });
  });

  it('profile GETs the Page node with the profile fields', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFacebookProfile({});
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: '/{page_id}?fields=id%2Cname%2Ccategory%2Cfollowers_count%2Clink%2Cpicture%7Burl%7D',
    }));
    out.mockRestore();
  });
});
