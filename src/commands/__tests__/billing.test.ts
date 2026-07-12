import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
}));

// getDefaultWorkspaceId is read off the user's local profile; stub to a fixed
// string so the test doesn't depend on profile state.
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn(async () => 'ws_test'),
}));

// billingManage calls `open(url)` after resolving the Billing page URL;
// without this stub, it would try to launch the user's browser.
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

import open from 'open';
import { apiClient } from '../../api/client.js';
import { billingManage, billingUpgrade } from '../billing.js';

const workspaces = [
  { id: 'ws_other', name: 'Other', organizationPublicId: 'org_other111' },
  { id: 'ws_test', name: 'Acme', organizationPublicId: 'org_abc12345' },
];

describe('billingManage — opens the app Billing page (portal retired)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(open).mockClear();
    process.env.HOOKMYAPP_APP_URL = 'https://app.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_APP_URL;
  });

  test('When invoked, then it opens <appUrl>/org/<orgPublicId>/billing for the active workspace and never calls /stripe/portal', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce(workspaces);

    await expect(billingManage()).resolves.toBeUndefined();

    expect(vi.mocked(open)).toHaveBeenCalledWith('https://app.test/org/org_abc12345/billing');
    const paths = vi.mocked(apiClient).mock.calls.map((c) => c[0]);
    expect(paths).not.toContain('/stripe/portal');
  });

  test('When no workspace row carries organizationPublicId, then billingManage throws ValidationError and opens nothing', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([{ id: 'ws_test', name: 'Acme' }]);

    await expect(billingManage()).rejects.toThrow(/no organization/i);

    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  test('When --json, then it emits the billing URL as JSON and opens no browser (AIT-164)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce(workspaces);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await billingManage({ json: true });

    expect(vi.mocked(open)).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    expect(parsed).toEqual({ billingUrl: 'https://app.test/org/org_abc12345/billing' });
    logSpy.mockRestore();
  });
});

describe('billingUpgrade — active subscription path (portal retired)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(open).mockClear();
    process.env.HOOKMYAPP_APP_URL = 'https://app.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_APP_URL;
  });

  test('When paid tier with active status, then billingUpgrade reads the org subscription route, opens the app Billing page, and never calls a /stripe/* route', async () => {
    vi.mocked(apiClient).mockImplementation(async (path: string) => {
      if (path === '/organizations/org_abc12345/billing/subscription') {
        return {
          status: 'active',
          plan: { slug: 'launch', name: 'Launch+', priceInCents: 1900, annualPriceInCents: 19000 },
        };
      }
      if (path === '/workspaces') return workspaces;
      throw new Error(`unexpected path: ${path}`);
    });

    await expect(billingUpgrade()).resolves.toBeUndefined();

    expect(vi.mocked(open)).toHaveBeenCalledWith('https://app.test/org/org_abc12345/billing');
    const paths = vi.mocked(apiClient).mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.startsWith('/stripe/'))).toBe(false);
  });
});
