import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
  // pollForUpgrade's transient-error check calls this on every poll failure;
  // default to "not a network blip" so permanent errors (AuthError, etc.)
  // fall through to the `err instanceof ApiError` check and then rethrow.
  isNetworkFailure: vi.fn(() => false),
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
// The paid-tier path (AIT-398) confirms the billing effect before applying it;
// tests queue the y/N answer the same way they queue select answers.
let confirmAnswers: boolean[] = [];
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async (args: { choices: unknown }) => {
    selectCalls.push(args);
    return selectAnswers.shift();
  }),
  confirm: vi.fn(async () => confirmAnswers.shift() ?? false),
}));
function queueSelectAnswers(...answers: unknown[]): void {
  selectAnswers = answers;
}
function queueConfirmAnswers(...answers: boolean[]): void {
  confirmAnswers = answers;
}
function capturedSelectCalls(): Array<{ choices: unknown }> {
  return selectCalls;
}

import open from 'open';
import { apiClient } from '../../api/client.js';
import { AuthError, NetworkError } from '../../output/error.js';
import { billingManage, billingUpgrade } from '../billing.js';

const workspaces = [
  { id: 'ws_other', name: 'Other', organizationPublicId: 'org_other111' },
  { id: 'ws_test', name: 'Acme', organizationPublicId: 'org_abc12345' },
];

/** Advance fake timers in small steps until `settleOn` resolves/rejects (or a
 * generous step cap is hit). A single large `advanceTimersByTimeAsync` jump
 * can race ahead of the pending promise chain before pollForUpgrade's first
 * `setTimeout` is even registered (dynamic `import('@inquirer/prompts')` +
 * several mocked/real awaits) — especially under full-suite load, where
 * scheduling is less predictable than running this file alone. Stepping
 * small and checking settlement each time avoids guessing a fixed total. */
async function advanceUntilSettled(
  settleOn: Promise<unknown>,
  { stepMs = 100, maxSteps = 500 } = {},
): Promise<void> {
  let settled = false;
  settleOn.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < maxSteps && !settled; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

// billingUpgrade's free-tier path resolves `@inquirer/prompts` via a dynamic
// `import()` at call time. Warm that module resolution once here, outside any
// fake-timer test — the first cold `import()` in this file can take more
// event-loop turns than a fake-timer poll test can reliably interleave with.
// Also warm vi.useFakeTimers() itself: its first-ever call in the process
// lazily loads the underlying timer-faking library, and a poll test that
// enables fake timers for the first time can otherwise register its
// setTimeout against the not-yet-patched real timer.
beforeAll(async () => {
  await import('@inquirer/prompts');
  vi.useFakeTimers();
  vi.useRealTimers();
});

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

const CATALOG = [
  { slug: 'free', name: 'Launch', messages: 2000, priceInCents: 0, annualPriceInCents: 0 },
  { slug: 'starter', name: 'Build', messages: 30000, priceInCents: 1200, annualPriceInCents: 12000 },
  { slug: 'growth', name: 'Scale', messages: 100000, priceInCents: 2400, annualPriceInCents: 24000, popular: true },
  // Non-whole monthly price (AIT-391): $39.99, not the rounded-to-$40 that
  // Math.round(priceInCents / 100) used to render.
  { slug: 'pro', name: 'Business', messages: 250000, priceInCents: 3999, annualPriceInCents: 39000 },
];

describe('billingUpgrade — paid tier changes plan in the terminal (AIT-398)', () => {
  // An org on Build, billed monthly, period ending Sep 13.
  const SUB = {
    status: 'active',
    plan: { slug: 'starter', name: 'Build', priceInCents: 1200, annualPriceInCents: 12000 },
    billingInterval: 'monthly',
    currentPeriodEnd: '2026-09-13T10:45:22.000Z',
  };
  const PREVIEW = '/organizations/org_abc12345/billing/usage-tier/preview';
  const APPLY = '/organizations/org_abc12345/billing/usage-tier';

  /** Routes by path so a test only states the responses it cares about;
   *  `overrides` supplies the preview/apply results under test. */
  function mockApi(
    overrides: Record<string, unknown>,
    sub: Record<string, unknown> = SUB,
  ): void {
    vi.mocked(apiClient).mockImplementation(async (path: string) => {
      if (path in overrides) return overrides[path];
      if (path === '/workspaces') return workspaces;
      if (path === '/organizations/org_abc12345/billing/subscription') return sub;
      if (path === '/plans') return CATALOG;
      throw new Error(`unexpected path: ${path}`);
    });
  }

  let origTTY: typeof process.stdout.isTTY;
  let origStdinTTY: typeof process.stdin.isTTY;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(open).mockClear();
    selectCalls = [];
    selectAnswers = [];
    confirmAnswers = [];
    process.env.HOOKMYAPP_APP_URL = 'https://app.test';
    origTTY = process.stdout.isTTY;
    origStdinTTY = process.stdin.isTTY;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_APP_URL;
    process.stdout.isTTY = origTTY;
    process.stdin.isTTY = origStdinTTY;
    log.mockRestore();
  });

  function printed(): string {
    return log.mock.calls.flat().join('\n');
  }

  test('When upgrading, then the prorated charge is stated and confirming applies the change without a browser', async () => {
    mockApi({
      [PREVIEW]: { scheduled: false, amountDueCents: 1200, currency: 'usd' },
      [APPLY]: { scheduled: false },
    });
    queueSelectAnswers('growth');
    queueConfirmAnswers(true);

    await expect(billingUpgrade()).resolves.toBeUndefined();

    expect(printed()).toContain(
      "You'll switch to Scale right away. We'll charge $12.00 today for the rest of this billing period (through Sep 13, 2026). On Sep 13, 2026 your next bill is the full Scale price.",
    );
    expect(printed()).toContain('✓ Switched to Scale (100,000 messages/mo)');
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  test('When applying, then preview and apply POST the same plan and the inherited interval', async () => {
    mockApi({
      [PREVIEW]: { scheduled: false, amountDueCents: 1200 },
      [APPLY]: { scheduled: false },
    });
    queueSelectAnswers('growth');
    queueConfirmAnswers(true);

    await billingUpgrade();

    const sent = vi
      .mocked(apiClient)
      .mock.calls.filter((c) => c[0] === PREVIEW || c[0] === APPLY)
      .map((c) => ({ path: c[0], ...(c[1] as { method: string; body: string }) }));
    expect(sent.map((s) => s.path)).toEqual([PREVIEW, APPLY]);
    for (const call of sent) {
      expect(call.method).toBe('POST');
      expect(JSON.parse(call.body)).toEqual({ planSlug: 'growth', billingInterval: 'monthly' });
    }
  });

  test('When the plan list is offered, then the current plan is excluded and the interval is not asked', async () => {
    mockApi({
      [PREVIEW]: { scheduled: false, amountDueCents: 1200 },
      [APPLY]: { scheduled: false },
    });
    queueSelectAnswers('growth');
    queueConfirmAnswers(true);

    await billingUpgrade();

    const choices = capturedSelectCalls()[0].choices as Array<{ value: string }>;
    expect(choices.map((c) => c.value)).toEqual(['growth', 'pro']);
    expect(capturedSelectCalls()).toHaveLength(1);
  });

  test('When the change is a downgrade, then it is described as scheduled and charges nothing now', async () => {
    mockApi({
      [PREVIEW]: { scheduled: true },
      [APPLY]: { scheduled: true, effectiveAt: '2026-09-13T10:45:22.000Z' },
    });
    queueSelectAnswers('pro');
    queueConfirmAnswers(true);

    await billingUpgrade();

    expect(printed()).toContain(
      "You'll keep Build and its usage until Sep 13, 2026. Business starts then, and nothing is charged now.",
    );
    expect(printed()).toContain('✓ Business starts on Sep 13, 2026.');
  });

  test('When the confirmation is declined, then nothing is applied', async () => {
    mockApi({ [PREVIEW]: { scheduled: false, amountDueCents: 1200 } });
    queueSelectAnswers('growth');
    queueConfirmAnswers(false);

    await expect(billingUpgrade()).resolves.toBeUndefined();

    const paths = vi.mocked(apiClient).mock.calls.map((c) => String(c[0]));
    expect(paths).not.toContain(APPLY);
    expect(printed()).toContain('No changes made.');
  });

  test('When a cancel is already pending, then the Billing page opens instead of promising an immediate switch', async () => {
    mockApi({}, { ...SUB, cancelAtPeriodEnd: true });

    await billingUpgrade();

    expect(vi.mocked(open)).toHaveBeenCalledWith('https://app.test/org/org_abc12345/billing');
    const paths = vi.mocked(apiClient).mock.calls.map((c) => String(c[0]));
    expect(paths).not.toContain(PREVIEW);
  });

  test('When the subscription bills annually, then the change is sent as annual', async () => {
    mockApi(
      { [PREVIEW]: { scheduled: false, amountDueCents: 0 }, [APPLY]: { scheduled: false } },
      { ...SUB, billingInterval: 'annual' },
    );
    queueSelectAnswers('growth');
    queueConfirmAnswers(true);

    await billingUpgrade();

    const applyCall = vi.mocked(apiClient).mock.calls.find((c) => c[0] === APPLY)!;
    expect(JSON.parse(String((applyCall[1] as { body: string }).body)).billingInterval).toBe('annual');
  });

  test('When the subscription carries no billing interval, then the Billing page opens rather than assuming monthly', async () => {
    const { billingInterval: _dropped, ...noInterval } = SUB;
    mockApi({}, noInterval);

    await billingUpgrade();

    expect(vi.mocked(open)).toHaveBeenCalledWith('https://app.test/org/org_abc12345/billing');
    const bodies = vi.mocked(apiClient).mock.calls.map((c) => JSON.stringify(c[1] ?? ''));
    expect(bodies.some((b) => b.includes('monthly'))).toBe(false);
  });

  test('When the org is on a Custom plan, then the Billing page opens (not in the tier catalog)', async () => {
    mockApi({}, { ...SUB, plan: { slug: 'custom', name: 'Custom' } });

    await billingUpgrade();

    expect(vi.mocked(open)).toHaveBeenCalledWith('https://app.test/org/org_abc12345/billing');
  });

  test('When no TTY, then it fails with UPGRADE_REQUIRES_TTY and applies nothing', async () => {
    process.stdout.isTTY = false;
    mockApi({});

    await expect(billingUpgrade()).rejects.toThrow(/interactive terminal/i);

    const paths = vi.mocked(apiClient).mock.calls.map((c) => String(c[0]));
    expect(paths).not.toContain(APPLY);
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  test('When stdin is redirected, then it refuses rather than prompting into a pipe', async () => {
    // stdout can be a terminal while stdin is a pipe (`billing upgrade < /dev/null`).
    // The prompt would render and then have nothing to read the answer from.
    process.stdin.isTTY = false;
    mockApi({});

    await expect(billingUpgrade()).rejects.toMatchObject({ code: 'UPGRADE_REQUIRES_TTY' });

    expect(capturedSelectCalls()).toHaveLength(0);
  });
});

describe('billingUpgrade — free tier plan prompt (GET /plans)', () => {
  let origTTY: typeof process.stdout.isTTY;
  let origStdinTTY: typeof process.stdin.isTTY;
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(open).mockClear();
    selectCalls = [];
    selectAnswers = [];
    process.env.HOOKMYAPP_APP_URL = 'https://app.test';
    origTTY = process.stdout.isTTY;
    origStdinTTY = process.stdin.isTTY;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_APP_URL;
    process.stdout.isTTY = origTTY;
    process.stdin.isTTY = origStdinTTY;
    // Fake timers are per-test opt-in (three tests below poll under
    // vi.useFakeTimers()) — restore real timers here rather than at the end
    // of each test body, so a thrown assertion between `await run` and
    // cleanup can't leak fake timers into later tests (no other afterEach
    // resets them).
    vi.useRealTimers();
  });

  test('When on free tier, then plan choices come from GET /plans with limits and prices, free excluded', async () => {
    // apiClient queue: workspaces union → subscription (free) → /plans → checkout → poll (upgraded)
    // billingUpgrade polls after checkout, so fake timers + a poll response are
    // needed to let the command resolve instead of waiting on a real 5s timer.
    vi.useFakeTimers();
    vi.mocked(apiClient)
      .mockResolvedValueOnce(workspaces)
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockResolvedValueOnce(CATALOG)
      .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/c/pay_123' })
      .mockResolvedValueOnce({ plan: { slug: 'growth', name: 'Scale', messages: 100000 }, status: 'active' });
    queueSelectAnswers('growth', 'monthly'); // helper on the @inquirer/prompts mock

    const run = billingUpgrade();
    await advanceUntilSettled(run);
    await run;

    expect(vi.mocked(apiClient)).toHaveBeenCalledWith('/plans');
    const planChoices = capturedSelectCalls()[0].choices as Array<{ value: string; name: string; description?: string }>;
    expect(planChoices.map((c) => c.value)).toEqual(['starter', 'growth', 'pro']);
    expect(planChoices[1].name).toBe('Scale: 100,000 messages — $24/mo (or $240/yr)');
    expect(planChoices[1].description).toBe('Most popular');
    // Non-whole price renders 2dp instead of Math.round dropping the cents
    // (1999¢ used to render as "$20").
    expect(planChoices[2].name).toBe('Business: 250,000 messages — $39.99/mo (or $390/yr)');
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

  test('When checkout opens, then upgrade polls the subscription and confirms once the plan flips', async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient)
      .mockResolvedValueOnce(workspaces)
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockResolvedValueOnce(CATALOG)
      .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/c/pay_123' })
      // poll #1: still free; poll #2: upgraded
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockResolvedValueOnce({ plan: { slug: 'growth', name: 'Scale', messages: 100000 }, status: 'active' });
    queueSelectAnswers('growth', 'monthly');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const run = billingUpgrade();
    await advanceUntilSettled(run);
    await run;

    expect(log.mock.calls.flat().join('\n')).toContain('Upgraded to Scale');
  });

  test('When a poll tick hits a network blip (apiClient throws NetworkError), then it is swallowed and polling continues to success', async () => {
    // apiClient wraps a raw fetch failure in its own NetworkError before it
    // ever reaches pollForUpgrade — isNetworkFailure() (mocked false in this
    // file) inspects the raw fetch-error shape and doesn't recognize the
    // wrapper. pollForUpgrade must still treat NetworkError itself as
    // transient, or a single blip aborts the wait instead of riding it out.
    vi.useFakeTimers();
    vi.mocked(apiClient)
      .mockResolvedValueOnce(workspaces)
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockResolvedValueOnce(CATALOG)
      .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/c/pay_123' })
      // poll #1: transient network blip; poll #2: upgraded
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce({ plan: { slug: 'growth', name: 'Scale', messages: 100000 }, status: 'active' });
    queueSelectAnswers('growth', 'monthly');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const run = billingUpgrade();
    await advanceUntilSettled(run);
    await run;

    expect(log.mock.calls.flat().join('\n')).toContain('Upgraded to Scale');
  });

  test('When polling hits a permanent error (expired auth), then upgrade aborts instead of waiting forever', async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient)
      .mockResolvedValueOnce(workspaces)
      .mockResolvedValueOnce({ plan: { slug: 'free' }, status: 'active' })
      .mockResolvedValueOnce(CATALOG)
      .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/c/pay_123' })
      .mockRejectedValueOnce(new AuthError()); // poll #1: token expired
    queueSelectAnswers('growth', 'monthly');

    const run = billingUpgrade();
    const assertion = expect(run).rejects.toBeInstanceOf(AuthError);
    await advanceUntilSettled(run);
    await assertion;
  });
});
