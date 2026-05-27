import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
}));

// getDefaultWorkspaceId is read off the user's local profile; stub to a fixed
// string so the test doesn't depend on profile state.
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn(async () => 'ws_test'),
}));

// billingManage calls `open(data.url)` after fetching the portal URL; without
// this stub, the paid-tier branch would try to launch the user's browser.
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

import { apiClient } from '../../api/client.js';
import { billingManage } from '../billing.js';

describe('billingManage — Phase A subscription shape', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  test('When free tier (plan.slug === "free", no stripeSubscriptionId field), then billingManage throws ValidationError + does NOT call /stripe/portal', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({
      status: 'active',
      plan: { slug: 'free', name: 'Launch', priceInCents: 0, annualPriceInCents: 0 },
    });

    await expect(billingManage()).rejects.toThrow(/billing upgrade/i);

    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe('/stripe/subscription');
  });

  test('When paid tier (plan.slug !== "free"), then billingManage calls /stripe/portal', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce({
        status: 'active',
        plan: { slug: 'launch', name: 'Launch+', priceInCents: 1900, annualPriceInCents: 19000 },
      })
      .mockResolvedValueOnce({ url: 'https://stripe.example/portal' });

    await expect(billingManage()).resolves.toBeUndefined();

    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/stripe/portal');
  });
});
