import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));

// getDefaultWorkspaceId is read off the user's local profile; stub to a fixed
// string so the test doesn't depend on profile state. resolveOrgPublicIdForWorkspace
// stays REAL (via importOriginal) so it exercises the actual active-workspace
// org derivation against the mocked apiClient union (AIT-263).
vi.mock('../_helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_helpers.js')>();
  return {
    ...actual,
    getDefaultWorkspaceId: vi.fn(async () => 'ws_test'),
  };
});

// billingManage calls `open(url)` after resolving the Billing page URL;
// without this stub, it would try to launch the user's browser.
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

// billingUpgrade's free-tier path prompts via @inquirer/prompts. Record each
// call's `choices` argument (capturedSelectCalls) and let tests queue the
// answers a user would pick (queueSelectAnswers) instead of asserting against
// a hardcoded plan list.
let selectCalls: Array<{ choices: unknown }> = [];
let selectAnswers: unknown[] = [];
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async (args: { choices: unknown }) => {
    selectCalls.push(args);
    return selectAnswers.shift();
  }),
}));
function queueSelectAnswers(...answers: unknown[]): void {
  selectAnswers = answers;
}
function capturedSelectCalls(): Array<{ choices: unknown }> {
  return selectCalls;
}

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

describe('billingUpgrade — free tier plan prompt (GET /plans)', () => {
  const CATALOG = [
    { slug: 'free', name: 'Launch', messages: 2000, priceInCents: 0, annualPriceInCents: 0 },
    { slug: 'starter', name: 'Build', messages: 30000, priceInCents: 1200, annualPriceInCents: 12000 },
    { slug: 'growth', name: 'Scale', messages: 100000, priceInCents: 2400, annualPriceInCents: 24000, popular: true },
    { slug: 'pro', name: 'Business', messages: 250000, priceInCents: 3900, annualPriceInCents: 39000 },
  ];

  let origTTY: typeof process.stdout.isTTY;
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(open).mockClear();
    selectCalls = [];
    selectAnswers = [];
    process.env.HOOKMYAPP_APP_URL = 'https://app.test';
    origTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_APP_URL;
    process.stdout.isTTY = origTTY;
  });

  test('When on free tier, then plan choices come from GET /plans with limits and prices, free excluded', async () => {
    // apiClient queue: workspaces union → subscription (free) → /plans → checkout
    vi.mocked(apiClient)
      .mockResolvedValueOnce(workspaces)
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockResolvedValueOnce(CATALOG)
      .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/c/pay_123' });
    queueSelectAnswers('growth', 'monthly'); // helper on the @inquirer/prompts mock

    await billingUpgrade();

    expect(vi.mocked(apiClient)).toHaveBeenCalledWith('/plans');
    const planChoices = capturedSelectCalls()[0].choices as Array<{ value: string; name: string; description?: string }>;
    expect(planChoices.map((c) => c.value)).toEqual(['starter', 'growth', 'pro']);
    expect(planChoices[1].name).toBe('Scale: 100,000 messages — $24/mo (or $240/yr)');
    expect(planChoices[1].description).toBe('Most popular');
  });

  test('When GET /plans fails, then upgrade fails with that error and no checkout is minted', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce(workspaces)
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockRejectedValueOnce(new Error('service unavailable'));

    await expect(billingUpgrade()).rejects.toThrow();
    const paths = vi.mocked(apiClient).mock.calls.map((c) => c[0]);
    expect(paths).not.toContain('/organizations/org_abc12345/billing/checkout');
  });
});
