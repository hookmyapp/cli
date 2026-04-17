import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock apiClient
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

// Mock open
vi.mock('open', () => ({
  default: vi.fn(),
}));

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({ select: vi.fn() }));

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

import { apiClient } from '../api/client.js';
import openDefault from 'open';

const mockedApiClient = vi.mocked(apiClient);
const mockedOpen = vi.mocked(openDefault);

const WORKSPACE_ID = 'ws_TEST0070';

const activeSub = {
  planSlug: 'growth',
  status: 'active',
  currentPeriodEnd: '2026-05-01T00:00:00.000Z',
  stripeSubscriptionId: 'sub_123',
  billingInterval: 'annual',
  cancelAtPeriodEnd: false,
  plan: { slug: 'growth', name: 'Scale', messages: 1200, priceInCents: 2400, annualPriceInCents: 24000 },
};

const freeSub = {
  planSlug: 'free',
  status: 'active',
  currentPeriodEnd: null,
  stripeSubscriptionId: null,
  billingInterval: null,
  cancelAtPeriodEnd: false,
  plan: { slug: 'free', name: 'Free', messages: 50, priceInCents: 0, annualPriceInCents: 0 },
};

function mockSubAndUsage(sub: any, usage: { totalMessages: number; limit: number; percentage: number }) {
  mockedApiClient.mockImplementation(async (path: string) => {
    if (path === '/stripe/subscription') return sub;
    if (path === '/webhook/usage') return usage;
    throw new Error(`unexpected path: ${path}`);
  });
}

describe('billing commands', () => {
  let billingStatus: (opts: { human?: boolean }) => Promise<void>;
  let billingUpgrade: () => Promise<void>;
  let billingManage: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOpen.mockReset();
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
    it('calls apiClient with GET /stripe/subscription and /webhook/usage in parallel', async () => {
      mockSubAndUsage(activeSub, { totalMessages: 100, limit: 1200, percentage: 8 });

      await billingStatus({ human: false });

      expect(mockedApiClient).toHaveBeenCalledWith('/stripe/subscription', { workspaceId: WORKSPACE_ID });
      expect(mockedApiClient).toHaveBeenCalledWith('/webhook/usage', { workspaceId: WORKSPACE_ID });
    });
  });

  describe('billingStatus json', () => {
    it('emits structured { subscription, usage } when human=false', async () => {
      const usage = { totalMessages: 100, limit: 1200, percentage: 8 };
      mockSubAndUsage(activeSub, usage);

      await billingStatus({ human: false });

      const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
      const jsonCall = calls.find((c) => typeof c === 'string' && c.includes('"subscription"'));
      expect(jsonCall).toBeDefined();
      const parsed = JSON.parse(jsonCall as string);
      expect(parsed.subscription.planSlug).toBe('growth');
      expect(parsed.usage).toEqual(usage);
    });
  });

  describe('billingStatus human', () => {
    it('renders plan/status/interval/renews/messages with no nudge under 80%', async () => {
      mockSubAndUsage(activeSub, { totalMessages: 600, limit: 1200, percentage: 50 });

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

  describe('billingStatus cancel warning', () => {
    it('prints cancel warning when cancelAtPeriodEnd is true', async () => {
      mockSubAndUsage({ ...activeSub, cancelAtPeriodEnd: true }, {
        totalMessages: 100,
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
      mockSubAndUsage(activeSub, { totalMessages: 1020, limit: 1200, percentage: 85 });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('85%');
      expect(logged).toContain('billing upgrade');
    });
  });

  describe('billingStatus 100% over limit', () => {
    it('prints red exceeded line at 105%', async () => {
      mockSubAndUsage(activeSub, { totalMessages: 1260, limit: 1200, percentage: 105 });

      await billingStatus({ human: true });

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('exceeded');
      expect(logged).toContain('105%');
    });
  });

  describe('billingManage', () => {
    it('happy path: POSTs /stripe/portal and opens returned url', async () => {
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === '/stripe/subscription') return activeSub;
        if (path === '/stripe/portal') return { url: 'https://billing.stripe.com/p/x' };
        throw new Error(`unexpected path: ${path}`);
      });

      await billingManage();

      expect(mockedApiClient).toHaveBeenCalledWith('/stripe/portal', {
        method: 'POST',
        workspaceId: WORKSPACE_ID,
        body: JSON.stringify({}),
      });
      expect(mockedOpen).toHaveBeenCalledWith('https://billing.stripe.com/p/x');
    });

    it('free preflight: throws CliError NO_SUBSCRIPTION and does not open', async () => {
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === '/stripe/subscription') return freeSub;
        throw new Error(`unexpected path: ${path}`);
      });

      await expect(billingManage()).rejects.toThrow(/No active subscription/);
      expect(mockedOpen).not.toHaveBeenCalled();
    });

    it('free preflight error is a ValidationError with exit code 2', async () => {
      mockedApiClient.mockImplementation(async (path: string) => {
        if (path === '/stripe/subscription') return freeSub;
        throw new Error(`unexpected path: ${path}`);
      });

      let caught: any;
      try {
        await billingManage();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // Post-phase-108 every command throws a CliError subclass; the specific
      // old 'NO_SUBSCRIPTION' code was replaced by ValidationError (exit 2).
      expect(caught.code).toBe('VALIDATION_ERROR');
      expect(caught.exitCode).toBe(2);
    });
  });

  describe('billingUpgrade', () => {
    it('opens Stripe Portal in update flow when user has active subscription', async () => {
      mockedApiClient
        .mockResolvedValueOnce({ planSlug: 'growth', status: 'active', stripeSubscriptionId: 'sub_123' })
        .mockResolvedValueOnce({ url: 'https://billing.stripe.com/p/upd' });

      await billingUpgrade();

      expect(mockedApiClient).toHaveBeenNthCalledWith(2, '/stripe/portal', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ flow: 'update' }),
      }));
      expect(mockedOpen).toHaveBeenCalledWith('https://billing.stripe.com/p/upd');
    });

    it('treats past_due with stripeSubscriptionId as a subscriber', async () => {
      mockedApiClient
        .mockResolvedValueOnce({ planSlug: 'growth', status: 'past_due', stripeSubscriptionId: 'sub_456' })
        .mockResolvedValueOnce({ url: 'https://billing.stripe.com/p/x' });

      await billingUpgrade();

      expect(mockedApiClient).toHaveBeenNthCalledWith(2, '/stripe/portal', expect.objectContaining({
        body: JSON.stringify({ flow: 'update' }),
      }));
    });

    it('prompts free user for plan + interval and opens checkout', async () => {
      const inq = await import('@inquirer/prompts');
      vi.mocked(inq.select)
        .mockResolvedValueOnce('growth' as never)
        .mockResolvedValueOnce('annual' as never);
      mockedApiClient
        .mockResolvedValueOnce({ planSlug: 'free', status: 'active', stripeSubscriptionId: null })
        .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/x' });

      await billingUpgrade();

      expect(inq.select).toHaveBeenCalledTimes(2);
      expect(mockedApiClient).toHaveBeenNthCalledWith(2, '/stripe/checkout', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ planSlug: 'growth', billingInterval: 'annual' }),
      }));
      expect(mockedOpen).toHaveBeenCalledWith('https://checkout.stripe.com/x');
    });
  });
});

describe('billing commands — npx prefix roll-out (cliCommandPrefix)', () => {
  let billingStatus: (opts: { human?: boolean }) => Promise<void>;
  let billingManage: () => Promise<void>;

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
    billingManage = mod.billingManage;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('billingManage (free) throws with "npx hookmyapp billing upgrade" in the message', async () => {
    mockedApiClient.mockImplementation(async (path: string) => {
      if (path === '/stripe/subscription') return freeSub;
      throw new Error(`unexpected path: ${path}`);
    });

    await expect(billingManage()).rejects.toThrow(/npx hookmyapp billing upgrade/);
  });

  it('billingStatus 80% nudge prints "npx hookmyapp billing upgrade" under npm_command=exec', async () => {
    mockSubAndUsage(activeSub, { totalMessages: 1020, limit: 1200, percentage: 85 });

    await billingStatus({ human: true });

    const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('npx hookmyapp billing upgrade');
  });

  it('billingStatus 100% over-limit prints "npx hookmyapp billing upgrade"', async () => {
    mockSubAndUsage(activeSub, { totalMessages: 1260, limit: 1200, percentage: 105 });

    await billingStatus({ human: true });

    const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('npx hookmyapp billing upgrade');
  });
});
