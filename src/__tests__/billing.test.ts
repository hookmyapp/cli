import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock apiClient
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
  // pollForUpgrade's transient-error check calls this on every poll failure;
  // default to "not a network blip" so it never masks a real error.
  isNetworkFailure: vi.fn(() => false),
  getBillingEligibility: vi.fn(),
}));

// Mock open
vi.mock('open', () => ({
  default: vi.fn(),
}));

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({ select: vi.fn(), confirm: vi.fn() }));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: 'ws_TEST0070' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as any);

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient, getBillingEligibility } from '../api/client.js';
import openDefault from 'open';

const mockedApiClient = vi.mocked(apiClient);
const mockedOpen = vi.mocked(openDefault);
const mockedGetBillingEligibility = vi.mocked(getBillingEligibility);

const WORKSPACE_ID = 'ws_TEST0070';
const ORG_PUBLIC_ID = 'org_abc12345';
const SUBSCRIPTION_PATH = `/organizations/${ORG_PUBLIC_ID}/billing/subscription`;
const CHECKOUT_PATH = `/organizations/${ORG_PUBLIC_ID}/billing/checkout`;
const BILLING_BASE = `/organizations/${ORG_PUBLIC_ID}/billing`;
const WORKSPACES = [{ id: WORKSPACE_ID, name: 'Acme', organizationPublicId: ORG_PUBLIC_ID }];

// Phase A backend DTO cleanup: planSlug + stripeSubscriptionId removed.
// plan.slug is the single source of truth for tier; conditional fields
// (currentPeriodEnd, billingInterval, cancelAtPeriodEnd) are optional.
const activeSub = {
  status: 'active',
  currentPeriodEnd: '2026-05-01T00:00:00.000Z',
  billingInterval: 'annual',
  cancelAtPeriodEnd: false,
  plan: { slug: 'growth', name: 'Scale', messages: 1200, priceInCents: 2400, annualPriceInCents: 24000 },
};

const freeSub = {
  status: 'active',
  plan: { slug: 'free', name: 'Free', messages: 50, priceInCents: 0, annualPriceInCents: 0 },
};

/** Advance fake timers in small steps until `settleOn` resolves/rejects. A
 * single large `advanceTimersByTimeAsync` jump
 * can race ahead of the pending promise chain before pollForUpgrade's first
 * `setTimeout` is even registered (this suite's beforeEach calls
 * vi.resetModules() every test, forcing a cold re-import of
 * '@inquirer/prompts' each time) — especially under full-suite load, where
 * scheduling is less predictable than running this file alone. */
async function advanceUntilSettled(settleOn: Promise<unknown>): Promise<void> {
  let settled = false;
  settleOn.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // No fake-step cap: exhausting it freezes the only clock driver and
  // deadlocks settleOn. Vitest's real test timeout is the watchdog.
  while (!settled) {
    await vi.advanceTimersByTimeAsync(50);
  }
}

// AIT-436: `usageUnit` is part of the /webhook/usage contract, so a fixture
// without it is a payload the backend never sends (CodeRabbit, PR #62). It
// defaults to the legacy meter, which is what every one of these cases is.
function mockSubAndUsage(
  sub: any,
  usage: { total: number; limit: number; percentage: number; usageUnit?: 'messages' | 'actions' },
) {
  const withUnit = { usageUnit: 'messages' as const, ...usage };
  mockedApiClient.mockImplementation(async (path: string) => {
    if (path === '/workspaces') return WORKSPACES;
    if (path === SUBSCRIPTION_PATH) return sub;
    if (path === '/webhook/usage') return withUnit;
    throw new Error(`unexpected path: ${path}`);
  });
}

describe('billing commands', () => {
  let billingStatus: (opts: { json?: boolean; human?: boolean }) => Promise<void>;
  let billingUpgrade: (opts?: { json?: boolean }) => Promise<void>;
  let billingManage: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOpen.mockReset();
    mockedGetBillingEligibility.mockReset();
    mockExit.mockClear();
    mockConsoleError.mockClear();
    mockConsoleLog.mockClear();

    const inq = await import('@inquirer/prompts');
    vi.mocked(inq.select).mockReset();

    const mod = await import('../commands/billing.js');
    billingStatus = mod.billingStatus;
    billingUpgrade = mod.billingUpgrade;
    billingManage = mod.billingManage;
  });

  describe('billingStatus', () => {
    it('calls apiClient with GET the org subscription route and /webhook/usage', async () => {
      mockSubAndUsage(activeSub, { total: 100, limit: 1200, percentage: 8 });

      await billingStatus({ human: false });

      expect(mockedApiClient).toHaveBeenCalledWith(SUBSCRIPTION_PATH);
      expect(mockedApiClient).toHaveBeenCalledWith('/webhook/usage', { workspaceId: WORKSPACE_ID });
      const paths = mockedApiClient.mock.calls.map((c) => c[0]);
      expect(paths).not.toContain('/stripe/subscription');
    });
  });

  describe('billingStatus json', () => {
    it('emits structured { subscription, usage } when human=false', async () => {
      const usage = { total: 100, limit: 1200, percentage: 8, usageUnit: 'messages' as const };
      mockSubAndUsage(activeSub, usage);

      await billingStatus({ human: false });

      const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
      const jsonCall = calls.find((c) => typeof c === 'string' && c.includes('"subscription"'));
      expect(jsonCall).toBeDefined();
      const parsed = JSON.parse(jsonCall as string);
      expect(parsed.subscription.plan.slug).toBe('growth');
      expect(parsed.usage).toEqual(usage);
    });
  });

  describe('billingStatus human', () => {
    it('renders plan/status/interval/renews/messages with no nudge under 80%', async () => {
      mockSubAndUsage(activeSub, { total: 600, limit: 1200, percentage: 50 });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('plan: Scale');
      expect(logged).toContain('status: active');
      expect(logged).toContain('interval: annual');
      expect(logged).toContain('renews:');
      expect(logged).toContain('600 / 1200 (50%)');
      expect(logged).not.toContain("You've used");
      expect(logged).not.toContain('exceeded');
    });
  });

  describe('billingStatus human — free tier', () => {
    it('renders interval/renews as "n/a" (not an em-dash) when the subscription has no billing fields', async () => {
      mockSubAndUsage(freeSub, { total: 10, limit: 50, percentage: 20 });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('interval: n/a');
      expect(logged).toContain('renews: n/a');
      expect(logged).not.toContain('—');
    });
  });

  describe('billingStatus cancel warning', () => {
    it('prints cancel warning when cancelAtPeriodEnd is true', async () => {
      mockSubAndUsage({ ...activeSub, cancelAtPeriodEnd: true }, {
        total: 100,
        limit: 1200,
        percentage: 8,
      });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged.toLowerCase()).toContain('cancel at period end');
    });
  });

  describe('billingStatus 80% nudge', () => {
    it('prints yellow nudge with billing upgrade reference at 85%', async () => {
      mockSubAndUsage(activeSub, { total: 1020, limit: 1200, percentage: 85 });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('85%');
      expect(logged).toContain('billing upgrade');
    });
  });

  describe('billingStatus 100% over limit', () => {
    it('prints red exceeded line at 105%', async () => {
      mockSubAndUsage(activeSub, { total: 1260, limit: 1200, percentage: 105 });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('exceeded');
      expect(logged).toContain('105%');
    });
  });

  describe('billingStatus — money model v2 (trial + action plans)', () => {
    beforeEach(() => {
      vi.stubEnv('HOOKMYAPP_APP_URL', 'https://app.test');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const BILLING_URL = `https://app.test/org/${ORG_PUBLIC_ID}/billing`;

    it('trial not started: exact copy, no false channel-connect claim', async () => {
      mockSubAndUsage(
        {
          status: 'trialing',
          plan: { slug: 'build', name: 'Build', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 0,
          actionsQuota: null,
          unlimited: true,
          trial: { status: 'not_started', endsAt: null, daysLeft: null },
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toBe('Plan: Free trial, not started yet.');
      expect(mockedGetBillingEligibility).not.toHaveBeenCalled();
    });

    it('trial active: days left, actions of quota from the API, add-card hint', async () => {
      mockSubAndUsage(
        {
          status: 'trialing',
          plan: { slug: 'business', name: 'Business', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 37,
          actionsQuota: 100000,
          unlimited: false,
          trial: { status: 'active', endsAt: '2026-08-22T00:00:00.000Z', daysLeft: 4 },
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Free trial: 4 days left · 37 of 100,000 actions');
      expect(logged).toContain(`Add a credit card so nothing stops when the trial ends: ${BILLING_URL}`);
    });

    // Codex, PR #61: usageUnit 'messages' is a valid variant. Such an org has
    // actionsUsed/actionsQuota 0, so routing it to the action renderer printed
    // "0 of 0 actions" in place of its real message usage.
    it('v2-flagged org still on the MESSAGE meter keeps the message output', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'starter', name: 'Build', messages: 30000 },
          usageUnit: 'messages',
          actionsUsed: 0,
          actionsQuota: 0,
          unlimited: false,
        },
        { total: 1234, limit: 30000, percentage: 4 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('plan: Build');
      expect(logged).not.toContain('actions this period');
    });

    // Codex, PR #61: the action renderer returned before the shared warning, so
    // a scheduled cancellation was silently hidden from these organizations.
    it('action org with a scheduled cancellation still says so', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'scale', name: 'Scale', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 900,
          actionsQuota: 15000,
          unlimited: false,
          trial: null,
          cancelAtPeriodEnd: true,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('cancel at period end');
    });

    // Codex, PR #61: every action-metered subscription reaches this renderer,
    // so a canceled or past_due plan was printing exactly like a live one.
    it('past_due action org: says the subscription is not running', async () => {
      mockSubAndUsage(
        {
          status: 'past_due',
          plan: { slug: 'scale', name: 'Scale', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 900,
          actionsQuota: 15000,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('past_due');
    });

    // `null` means unlimited in the published JSON contract, so an ABSENT quota
    // must not be coerced to null (Codex, PR #61).
    it('--json omits actionsQuota entirely when the API did not send one', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'scale', name: 'Scale', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 900,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ json: true });

      const payload = JSON.parse(mockConsoleLog.mock.calls.map((c) => String(c[0])).join(''));
      expect(payload).not.toHaveProperty('actionsQuota');
    });

    // Codex, PR #61: only a real null means unlimited. An absent quota printed
    // as "unlimited" falsely promised an uncapped plan.
    it('human output says unknown, not unlimited, when the API sent no quota', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'scale', name: 'Scale', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 900,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('unknown');
      expect(logged).not.toContain('unlimited');
    });

    it('trial expired: paused copy + resume line from eligibility plan/price', async () => {
      mockSubAndUsage(
        {
          status: 'trialing',
          plan: { slug: 'business', name: 'Business', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 12,
          actionsQuota: 100000,
          unlimited: false,
          trial: { status: 'expired', endsAt: '2026-08-10T00:00:00.000Z', daysLeft: 0 },
        },
        { total: 0, limit: 0, percentage: 0 },
      );
      mockedGetBillingEligibility.mockResolvedValueOnce({
        eligiblePlan: 'build',
        trialActions: 12,
        trialStatus: 'expired',
      });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Your trial ended. Channels are paused.');
      expect(logged).toContain(`Add a credit card to resume on Build ($1/month): ${BILLING_URL}`);
      expect(mockedGetBillingEligibility).toHaveBeenCalledWith(ORG_PUBLIC_ID);
    });

    it('build org under 75% usage: plan line only, no upsell', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'build', name: 'Build', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 137,
          actionsQuota: 200,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toBe('Plan: Build — 137/200 actions this period');
    });

    it('build org at/above 75% usage: shows Scale upsell hint', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'build', name: 'Build', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 180,
          actionsQuota: 200,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Plan: Build — 180/200 actions this period');
      expect(logged).toContain('Running hot? Scale gives you 15,000 actions for $24/month.');
    });

    it('business org: plan line with comma-formatted quota, no upsell (top tier)', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'business', name: 'Business', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 90123,
          actionsQuota: 100000,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toBe('Plan: Business — 90,123/100,000 actions this period');
    });

    it('scale org running hot: upsell hint points at Business', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'scale', name: 'Scale', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 12406,
          actionsQuota: 15000,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Plan: Scale — 12,406/15,000 actions this period');
      expect(logged).toContain('Running hot? Business gives you 100,000 actions for $97/month.');
    });

    it('legacy org (no usageUnit) is untouched: no eligibility call, existing output shape', async () => {
      mockSubAndUsage(activeSub, { total: 600, limit: 1200, percentage: 50 });

      await billingStatus({ human: true });

      expect(mockedGetBillingEligibility).not.toHaveBeenCalled();
      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('plan: Scale');
      expect(logged).not.toContain('actions this period');
    });

    it('--json is additive: adds plan/actionsUsed/actionsQuota/trial for a money-model-v2 org', async () => {
      mockSubAndUsage(
        {
          status: 'active',
          plan: { slug: 'build', name: 'Build', messages: 0 },
          usageUnit: 'actions',
          actionsUsed: 137,
          actionsQuota: 200,
          unlimited: false,
          trial: null,
        },
        { total: 0, limit: 0, percentage: 0 },
      );

      await billingStatus({ human: false });

      const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
      const jsonCall = calls.find((c) => typeof c === 'string' && c.includes('"subscription"'));
      expect(jsonCall).toBeDefined();
      const parsed = JSON.parse(jsonCall as string);
      expect(parsed.plan).toBe('Build');
      expect(parsed.actionsUsed).toBe(137);
      expect(parsed.actionsQuota).toBe(200);
      expect(parsed.trial).toBeNull();
    });
  });

  describe('billingManage', () => {
    // /stripe/portal is retired (410 BILLING_PORTAL_RETIRED). `billing manage`
    // now opens the app's org Billing page, resolving the org publicId from
    // the /workspaces membership union.
    beforeEach(() => {
      vi.stubEnv('HOOKMYAPP_APP_URL', 'https://app.test');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('happy path: resolves the org publicId from /workspaces and opens the app Billing page', async () => {
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === '/workspaces') return WORKSPACES;
        throw new Error(`unexpected path: ${path}`);
      });

      await billingManage();

      expect(mockedOpen).toHaveBeenCalledWith('https://app.test/org/org_abc12345/billing');
      const paths = mockedApiClient.mock.calls.map((c) => c[0]);
      expect(paths).not.toContain('/stripe/portal');
    });

    it('missing organizationPublicId is a ValidationError with exit code 2 and does not open', async () => {
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === '/workspaces') return [{ id: WORKSPACE_ID, name: 'Acme' }];
        throw new Error(`unexpected path: ${path}`);
      });

      let caught: any;
      try {
        await billingManage();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe('VALIDATION_ERROR');
      expect(caught.exitCode).toBe(2);
      expect(mockedOpen).not.toHaveBeenCalled();
    });
  });

  describe('billingUpgrade', () => {
    beforeEach(() => {
      vi.stubEnv('HOOKMYAPP_APP_URL', 'https://app.test');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const PLANS_CATALOG = [
      { slug: 'free', name: 'Launch', messages: 2000, priceInCents: 0, annualPriceInCents: 0 },
      // A second paid plan so the paid-tier path (which drops the plan the org
      // is already on) still has something to offer.
      { slug: 'starter', name: 'Build', messages: 600, priceInCents: 1200, annualPriceInCents: 12000 },
      { slug: 'growth', name: 'Scale', messages: 1200, priceInCents: 2400, annualPriceInCents: 24000 },
    ];

    function mockSubAndWorkspaces(sub: any, checkoutUrl?: string) {
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) return sub;
        if (path === '/workspaces') return WORKSPACES;
        if (path === '/plans') return PLANS_CATALOG;
        if (path === CHECKOUT_PATH && checkoutUrl) return { url: checkoutUrl };
        throw new Error(`unexpected path: ${path}`);
      });
    }

    /** Paid tiers change plan in the terminal (AIT-398): preview → confirm →
     *  apply, no browser. Declines the confirmation so the assertion is about
     *  which path ran, not about applying a change. */
    async function runPaidPathDeclining(status: string): Promise<void> {
      const origTTY = process.stdout.isTTY;
      const origStdinTTY = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      const inq = await import('@inquirer/prompts');
      vi.mocked(inq.select).mockResolvedValueOnce('starter' as never);
      vi.mocked(inq.confirm).mockResolvedValueOnce(false as never);
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) {
          return { status, plan: { slug: 'growth', name: 'Scale' }, billingInterval: 'monthly' };
        }
        if (path === '/workspaces') return WORKSPACES;
        if (path === '/plans') return PLANS_CATALOG;
        if (path === `${BILLING_BASE}/usage-tier/preview`) return { scheduled: true };
        throw new Error(`unexpected path: ${path}`);
      });

      try {
        await billingUpgrade();
      } finally {
        process.stdout.isTTY = origTTY;
        process.stdin.isTTY = origStdinTTY;
      }
    }

    it('changes plan in the terminal when the user has an active subscription (no browser)', async () => {
      await runPaidPathDeclining('active');

      expect(mockedOpen).not.toHaveBeenCalled();
      const paths = mockedApiClient.mock.calls.map((c) => c[0]);
      expect(paths).toContain(`${BILLING_BASE}/usage-tier/preview`);
      expect(paths).not.toContain('/stripe/portal');
    });

    it('treats past_due on a paid plan as a subscriber', async () => {
      await runPaidPathDeclining('past_due');

      const paths = mockedApiClient.mock.calls.map((c) => c[0]);
      expect(paths).toContain(`${BILLING_BASE}/usage-tier/preview`);
    });

    it('rejects --json with UPGRADE_NO_JSON (no machine-readable form)', async () => {
      // Throws before any backend call, so no apiClient mock is needed.
      await expect(billingUpgrade({ json: true })).rejects.toMatchObject({
        code: 'UPGRADE_NO_JSON',
      });
      expect(mockedApiClient).not.toHaveBeenCalled();
    });

    it('rejects the free-tier prompt path in a non-TTY with UPGRADE_REQUIRES_TTY', async () => {
      const origTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;
      mockSubAndWorkspaces({ status: 'active', plan: { slug: 'free', name: 'Free' } });

      try {
        await expect(billingUpgrade()).rejects.toMatchObject({
          code: 'UPGRADE_REQUIRES_TTY',
        });
      } finally {
        process.stdout.isTTY = origTTY;
      }
    });

    it('prompts free user for plan + interval and opens checkout', async () => {
      // Free-tier path is interactive: guarded by a TTY check on both streams.
      // Stub them so the prompt branch runs instead of the non-TTY rejection.
      const origTTY = process.stdout.isTTY;
      const origStdinTTY = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      const inq = await import('@inquirer/prompts');
      vi.mocked(inq.select)
        .mockResolvedValueOnce('growth' as never)
        .mockResolvedValueOnce('annual' as never);

      // billingUpgrade polls the subscription after checkout opens until the
      // plan leaves free — flip the mocked subscription response to upgraded
      // once the checkout call has minted a URL, so the first poll tick
      // resolves instead of looping forever on the persistent apiClient
      // mockImplementation.
      let checkoutMinted = false;
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) {
          return checkoutMinted
            ? { status: 'active', plan: { slug: 'growth', name: 'Scale', messages: 1200 } }
            : { status: 'active', plan: { slug: 'free', name: 'Free' } };
        }
        if (path === '/workspaces') return WORKSPACES;
        if (path === '/plans') return PLANS_CATALOG;
        if (path === CHECKOUT_PATH) {
          checkoutMinted = true;
          return { url: 'https://checkout.stripe.com/x' };
        }
        throw new Error(`unexpected path: ${path}`);
      });

      vi.useFakeTimers();
      try {
        const run = billingUpgrade();
        await advanceUntilSettled(run);
        await run;
      } finally {
        process.stdout.isTTY = origTTY;
        process.stdin.isTTY = origStdinTTY;
        vi.useRealTimers();
      }

      expect(inq.select).toHaveBeenCalledTimes(2);
      expect(mockedApiClient).toHaveBeenCalledWith(CHECKOUT_PATH, expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ planSlug: 'growth', billingInterval: 'annual' }),
      }));
      expect(mockedOpen).toHaveBeenCalledWith('https://checkout.stripe.com/x');
    });

    it('expired trial org: suppresses the plan picker and checks out only the eligible plan', async () => {
      const origTTY = process.stdout.isTTY;
      const origStdinTTY = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      const inq = await import('@inquirer/prompts');
      // Only ONE select call expected: billing interval. No "Choose a plan"
      // prompt — the eligible plan is not user-selectable.
      vi.mocked(inq.select).mockResolvedValueOnce('monthly' as never);
      mockedGetBillingEligibility.mockResolvedValueOnce({
        eligiblePlan: 'build',
        trialActions: 12,
        trialStatus: 'expired',
      });

      let checkoutMinted = false;
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) {
          return checkoutMinted
            ? {
                status: 'active',
                usageUnit: 'actions',
                actionsUsed: 0,
                actionsQuota: 200,
                plan: { slug: 'build', name: 'Build', messages: 0 },
              }
            : {
                status: 'trialing',
                usageUnit: 'actions',
                actionsUsed: 12,
                actionsQuota: null,
                plan: { slug: 'build', name: 'Build', messages: 0 },
                trial: { status: 'expired', endsAt: '2026-08-10T00:00:00.000Z', daysLeft: 0 },
              };
        }
        if (path === '/workspaces') return WORKSPACES;
        // The plan catalog must never be fetched on this path — the picker
        // is suppressed entirely, so nothing should ask for it.
        if (path === '/plans') throw new Error('unexpected /plans fetch on eligibility-locked path');
        if (path === CHECKOUT_PATH) {
          checkoutMinted = true;
          return { url: 'https://checkout.stripe.com/x' };
        }
        throw new Error(`unexpected path: ${path}`);
      });

      vi.useFakeTimers();
      try {
        const run = billingUpgrade();
        await advanceUntilSettled(run);
        await run;
      } finally {
        process.stdout.isTTY = origTTY;
        process.stdin.isTTY = origStdinTTY;
        vi.useRealTimers();
      }

      expect(inq.select).toHaveBeenCalledTimes(1);
      expect(mockedGetBillingEligibility).toHaveBeenCalledWith(ORG_PUBLIC_ID);
      expect(mockedApiClient).toHaveBeenCalledWith(CHECKOUT_PATH, expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ planSlug: 'build', billingInterval: 'monthly' }),
      }));
      expect(mockedOpen).toHaveBeenCalledWith('https://checkout.stripe.com/x');
    });

    // Codex + CodeRabbit, PR #61: an ACTIVE trial already reads
    // plan.slug 'business' / status 'trialing' BEFORE checkout, so the old
    // "not free and live" poll predicate matched on its first tick and printed
    // the upgrade line ~5s after opening the browser, whether or not the user
    // paid. Completion now requires the trial to actually clear.
    it('active trial org: does NOT confirm the upgrade while the trial is still open', async () => {
      const origTTY = process.stdout.isTTY;
      const origStdinTTY = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      const inq = await import('@inquirer/prompts');
      vi.mocked(inq.select).mockResolvedValueOnce('monthly' as never);
      mockedGetBillingEligibility.mockResolvedValueOnce({
        eligiblePlan: 'scale',
        trialActions: 900,
        trialStatus: 'active',
      });

      // The subscription NEVER changes: the user abandoned Stripe Checkout.
      // A trialing v2 org looks "upgraded" to the naive predicate the whole time.
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) {
          return {
            status: 'trialing',
            usageUnit: 'actions',
            actionsUsed: 900,
            actionsQuota: 100000,
            plan: { slug: 'business', name: 'Business', messages: 0 },
            trial: { status: 'active', endsAt: '2026-08-22T00:00:00.000Z', daysLeft: 4 },
          };
        }
        if (path === '/workspaces') return WORKSPACES;
        if (path === '/plans') throw new Error('unexpected /plans fetch on eligibility-locked path');
        if (path === CHECKOUT_PATH) return { url: 'https://checkout.stripe.com/x' };
        throw new Error(`unexpected path: ${path}`);
      });

      await import('../index.js');

      vi.useFakeTimers();
      try {
        const run = billingUpgrade();
        run.catch(() => {}); // never settles here; keep the rejection handled
        // Small steps, same reason advanceUntilSettled uses them: one big jump
        // races ahead of the pending chain before the first poll timer exists.
        // 600 x 50ms is well past several poll intervals — the old predicate
        // returned on the FIRST one.
        for (let i = 0; i < 600; i++) await vi.advanceTimersByTimeAsync(50);

        const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('Waiting for payment confirmation');
        expect(logged).not.toContain('Upgraded to');
      } finally {
        process.stdout.isTTY = origTTY;
        process.stdin.isTTY = origStdinTTY;
        vi.useRealTimers();
      }
    });

    // Codex, PR #61: /plans serves the LEGACY catalog only, so a paid v2 org
    // reaching the terminal picker would be offered starter/growth/pro at
    // legacy prices and then attempt a cross-generation plan change.
    it('paid action-metered org: opens Billing instead of the legacy plan picker', async () => {
      const origTTY = process.stdout.isTTY;
      const origStdinTTY = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      const inq = await import('@inquirer/prompts');
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) {
          return {
            status: 'active',
            billingInterval: 'monthly',
            usageUnit: 'actions',
            actionsUsed: 900,
            actionsQuota: 15000,
            unlimited: false,
            trial: null,
            plan: { slug: 'scale', name: 'Scale', messages: 0 },
          };
        }
        if (path === '/workspaces') return WORKSPACES;
        if (path === '/plans') throw new Error('unexpected /plans fetch for an action-metered org');
        throw new Error(`unexpected path: ${path}`);
      });

      try {
        await billingUpgrade();
      } finally {
        process.stdout.isTTY = origTTY;
        process.stdin.isTTY = origStdinTTY;
      }

      expect(mockedOpen).toHaveBeenCalledWith(expect.stringContaining('billing'));
      expect(inq.select).not.toHaveBeenCalled();
    });

    // Codex, PR #61 round 2: the first fix guarded only the ACTIVE case, so a
    // canceled/incomplete/unpaid action org still reached the legacy picker.
    it('CANCELED action-metered org: still opens Billing, never the legacy picker', async () => {
      const origTTY = process.stdout.isTTY;
      const origStdinTTY = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      const inq = await import('@inquirer/prompts');
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === SUBSCRIPTION_PATH) {
          return {
            status: 'canceled',
            billingInterval: 'monthly',
            usageUnit: 'actions',
            actionsUsed: 40,
            actionsQuota: 200,
            unlimited: false,
            trial: null,
            plan: { slug: 'build', name: 'Build', messages: 0 },
          };
        }
        if (path === '/workspaces') return WORKSPACES;
        if (path === '/plans') throw new Error('unexpected /plans fetch for an action-metered org');
        throw new Error(`unexpected path: ${path}`);
      });

      try {
        await billingUpgrade();
      } finally {
        process.stdout.isTTY = origTTY;
        process.stdin.isTTY = origStdinTTY;
      }

      expect(mockedOpen).toHaveBeenCalledWith(expect.stringContaining('billing'));
      expect(inq.select).not.toHaveBeenCalled();
    });

    it('legacy active org still gets the plan picker (unchanged)', async () => {
      await runPaidPathDeclining('active');

      expect(mockedGetBillingEligibility).not.toHaveBeenCalled();
    });
  });
});

describe('billing commands — npx prefix roll-out (cliCommandPrefix)', () => {
  let billingStatus: (opts: { json?: boolean; human?: boolean }) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOpen.mockReset();
    mockExit.mockClear();
    mockConsoleError.mockClear();
    mockConsoleLog.mockClear();
    vi.stubEnv('npm_command', 'exec');

    const mod = await import('../commands/billing.js');
    billingStatus = mod.billingStatus;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('billingStatus 80% nudge prints "npx hookmyapp billing upgrade" under npm_command=exec', async () => {
    mockSubAndUsage(activeSub, { total: 1020, limit: 1200, percentage: 85 });

    await billingStatus({ human: true });

    const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('npx hookmyapp billing upgrade');
  });

  it('billingStatus 100% over-limit prints "npx hookmyapp billing upgrade"', async () => {
    mockSubAndUsage(activeSub, { total: 1260, limit: 1200, percentage: 105 });

    await billingStatus({ human: true });

    const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('npx hookmyapp billing upgrade');
  });
});
