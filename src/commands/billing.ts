import { Command } from 'commander';
import open from 'open';
import { apiClient, isNetworkFailure } from '../api/client.js';
import { output } from '../output/format.js';
import { c } from '../output/color.js';
import { ApiError, NetworkError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import { getEffectiveAppUrl } from '../config/env-profiles.js';
import { getDefaultWorkspaceId, resolveOrgPublicIdForWorkspace } from './_helpers.js';

// program is lazy-imported inside actions because commands/billing.ts is
// loaded by index.ts during program setup — a top-level import would form a
// cycle. Same pattern as other commands that need root-level opts.

// Billing is org-scoped (the workspace-addressed /stripe/subscription and
// /stripe/checkout routes are retired — 410 BILLING_ROUTE_MOVED). The org is
// resolved from the active workspace's row in the /workspaces union via the
// shared resolveOrgPublicIdForWorkspace helper (AIT-263 — one derivation for
// customers + billing, never a bare row[0]).

/** Whole-dollar prices render as `$20`; anything with cents renders 2dp
 *  (`$19.99`) — `Math.round` was dropping cents entirely (1999¢ → "$20"). */
function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function orgBillingUrl(orgPublicId: string): string {
  return `${getEffectiveAppUrl()}/org/${orgPublicId}/billing`;
}

/** `Sep 13, 2026`, matching the dashboard's confirm dialog. Fixed to en-US so
 *  the sentence reads the same everywhere the CLI runs. Null for a missing or
 *  unparseable date — callers drop the clause rather than print "Invalid Date". */
function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type TierPreview = { scheduled: boolean; amountDueCents?: number; currency?: string };

/** The terminal wording of the dashboard's tier-switch dialog (AIT-398). Every
 *  claim comes from the server's preview: an upgrade states the prorated charge
 *  it returned, a downgrade (`scheduled`) states that nothing is charged now.
 *  Clauses that need the period end are dropped when the subscription doesn't
 *  carry one — never guessed. */
function describeTierChange(args: {
  targetName: string;
  currentName: string;
  preview: TierPreview;
  currentPeriodEnd?: string;
}): string {
  const { targetName, currentName, preview } = args;
  const on = formatDate(args.currentPeriodEnd);

  if (preview.scheduled) {
    return (
      `You'll keep ${currentName} and its usage until ${on ?? 'the end of your billing period'}. ` +
      `${targetName} starts then, and nothing is charged now.`
    );
  }

  const nextBill = on
    ? `On ${on} your next bill is the full ${targetName} price.`
    : `Your next bill is the full ${targetName} price.`;
  const due = preview.amountDueCents ?? 0;
  if (due > 0) {
    const through = on ? ` (through ${on})` : '';
    return (
      `You'll switch to ${targetName} right away. We'll charge $${(due / 100).toFixed(2)} today ` +
      `for the rest of this billing period${through}. ${nextBill}`
    );
  }
  return `You'll switch to ${targetName} right away at no extra charge today. ${nextBill}`;
}

const UPGRADE_POLL_INTERVAL_MS = 5_000;
const UPGRADE_POLL_HINT_EVERY_MS = 60_000;

/** Mirrors the `channels connect` wait pattern: poll the org subscription
 *  until the plan leaves `free` with an active status. No hard timeout —
 *  a periodic hint keeps the wait visibly alive; Ctrl+C cancels. ONLY
 *  transient failures (network blips, 5xx) are swallowed; permanent errors
 *  (expired auth, revoked permission, client-outdated) rethrow — polling
 *  forever on those would tell the user to "finish checkout" while the CLI
 *  itself is the thing that's broken. */
async function pollForUpgrade(
  orgPublicId: string,
): Promise<{ plan: { slug: string; name: string; messages: number }; status: string }> {
  const startedAt = Date.now();
  let lastHintAt = startedAt;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, UPGRADE_POLL_INTERVAL_MS));
    let sub: { plan: { slug: string; name: string; messages: number }; status: string } | null;
    try {
      sub = (await apiClient(
        `/organizations/${orgPublicId}/billing/subscription`,
      )) as { plan: { slug: string; name: string; messages: number }; status: string };
    } catch (err) {
      // apiClient wraps raw fetch failures in its own NetworkError before
      // they ever reach here — isNetworkFailure() inspects the *raw* fetch
      // error shape (TypeError / ECONNREFUSED / etc.) and doesn't recognize
      // the wrapper, so a plain network blip was falling through to the
      // rethrow below and aborting the poll. Treat the wrapped NetworkError
      // as transient too.
      const transient =
        err instanceof NetworkError ||
        isNetworkFailure(err) ||
        (err instanceof ApiError && (err.statusCode ?? 0) >= 500);
      if (!transient) throw err;
      sub = null;
    }
    if (sub && sub.plan.slug !== 'free' && ['active', 'trialing'].includes(sub.status)) {
      return sub;
    }
    if (Date.now() - lastHintAt >= UPGRADE_POLL_HINT_EVERY_MS) {
      lastHintAt = Date.now();
      console.log(
        `Still waiting (${Math.round((Date.now() - startedAt) / 60_000)} min) — finish checkout in your browser, or Ctrl+C to cancel.`,
      );
    }
  }
}

export async function billingManage(opts: { json?: boolean } = {}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const url = orgBillingUrl(await resolveOrgPublicIdForWorkspace(workspaceId));

  // --json is a machine contract: emit the URL and take NO interactive side
  // effect (no browser open, no human text) so agents/CI get clean JSON.
  if (opts.json) {
    output({ billingUrl: url }, { json: true });
    return;
  }

  console.log('Opening your Billing page...');
  await open(url);
}

export async function billingStatus(opts: { json?: boolean; human?: boolean } = {}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const orgPublicId = await resolveOrgPublicIdForWorkspace(workspaceId);
  const [sub, usage] = await Promise.all([
    apiClient(`/organizations/${orgPublicId}/billing/subscription`),
    apiClient('/webhook/usage', { workspaceId }),
  ]);

  // Accept either `json: true` or `human: false` (back-compat with callers
  // and tests that predate the phase-108 opts shape).
  const isJson = opts.json === true || opts.human === false;

  if (isJson) {
    output({ subscription: sub, usage }, { json: true });
    return;
  }

  const plan = sub.plan.name;
  const status = sub.status;
  const interval = sub.billingInterval ?? 'n/a';
  const renews = sub.currentPeriodEnd ?? 'n/a';
  const messages = `${usage.totalMessages} / ${usage.limit} (${usage.percentage}%)`;

  output({ plan, status, interval, renews, messages }, { json: false, kind: 'read' });

  if (sub.cancelAtPeriodEnd === true) {
    console.log('\n' + c.warn('Subscription will cancel at period end.'));
  }

  if (usage.percentage >= 100) {
    console.log(
      '\n' +
        c.error(
          `You have exceeded your message limit (${usage.percentage}%). Run \`${cliCommandPrefix()} billing upgrade\` to upgrade.`,
        ),
    );
  } else if (usage.percentage >= 80) {
    console.log(
      '\n' +
        c.warn(
          `You've used ${usage.percentage}%. Run \`${cliCommandPrefix()} billing upgrade\` to upgrade.`,
        ),
    );
  }
}

type CatalogPlan = {
  slug: string;
  name: string;
  messages: number;
  priceInCents: number;
  annualPriceInCents: number;
  popular?: true;
};

/** Live catalog — the CLI keeps no copy of plan names, limits, or prices;
 *  hardcoded copies drift and have shipped stale numbers before. A fetch
 *  failure fails the command; there is deliberately no fallback list.
 *  `exceptSlug` drops the plan the org is already on. */
async function fetchPaidPlans(exceptSlug?: string): Promise<CatalogPlan[]> {
  const catalog = (await apiClient('/plans')) as CatalogPlan[];
  const paidPlans = catalog.filter((p) => p.priceInCents > 0 && p.slug !== exceptSlug);
  if (paidPlans.length === 0) {
    throw new ValidationError('No paid plans available. Try again later.', 'PLANS_EMPTY');
  }
  return paidPlans;
}

function planChoice(p: CatalogPlan): { name: string; value: string; description?: string } {
  return {
    name: `${p.name}: ${p.messages.toLocaleString('en-US')} messages — ${formatPrice(p.priceInCents)}/mo (or ${formatPrice(p.annualPriceInCents)}/yr)`,
    value: p.slug,
    ...(p.popular ? { description: 'Most popular' } : {}),
  };
}

/** Plan change for an org that already pays (AIT-398). Same two endpoints the
 *  dashboard's confirm dialog uses, so the terminal states the billing effect
 *  and applies it — no browser, and no login wall for a CLI-only user. */
async function changePlanInTerminal(
  orgPublicId: string,
  sub: {
    plan: { slug: string; name: string };
    billingInterval: 'monthly' | 'annual';
    currentPeriodEnd?: string;
  },
): Promise<void> {
  const plans = await fetchPaidPlans(sub.plan.slug);

  const { select, confirm } = await import('@inquirer/prompts');
  const planSlug = await select({
    message: 'Choose a plan',
    choices: plans.map(planChoice),
  });
  const target = plans.find((p) => p.slug === planSlug)!;
  // Interval is whatever the subscription already bills on — switching monthly
  // ↔ annual is a separate decision and stays on the Billing page. Never
  // defaulted: guessing `monthly` for an annual customer would move their
  // billing cadence behind a prompt that only mentioned the plan.
  const body = JSON.stringify({ planSlug, billingInterval: sub.billingInterval });

  const preview = (await apiClient(`/organizations/${orgPublicId}/billing/usage-tier/preview`, {
    method: 'POST',
    body,
  })) as TierPreview;
  console.log(
    describeTierChange({
      targetName: target.name,
      currentName: sub.plan.name,
      preview,
      currentPeriodEnd: sub.currentPeriodEnd,
    }),
  );

  const ok = await confirm({ message: `Switch to ${target.name}?`, default: false });
  if (!ok) {
    console.log('No changes made.');
    return;
  }

  const result = (await apiClient(`/organizations/${orgPublicId}/billing/usage-tier`, {
    method: 'POST',
    body,
  })) as { scheduled: boolean; effectiveAt?: string };

  if (result.scheduled) {
    const on = formatDate(result.effectiveAt ?? sub.currentPeriodEnd);
    console.log(
      on
        ? `✓ ${target.name} starts on ${on}.`
        : `✓ ${target.name} starts at the end of your billing period.`,
    );
    return;
  }
  console.log(
    `✓ Switched to ${target.name} (${target.messages.toLocaleString('en-US')} messages/mo).`,
  );
}

export async function billingUpgrade(opts: { json?: boolean } = {}): Promise<void> {
  // `billing upgrade` is interactive end-to-end: both paths prompt for a plan
  // and confirm before anything is charged. There is no machine-readable form,
  // so reject --json up front with a clear pointer instead of rendering an
  // inquirer prompt that aborts into a generic error in non-TTY / --json
  // contexts.
  if (opts.json) {
    throw new ValidationError(
      `billing upgrade is interactive (plan selection + confirmation) and has no --json form. ` +
        `Run it without --json from a terminal, or use \`${cliCommandPrefix()} billing manage\` to open the Billing page.`,
      'UPGRADE_NO_JSON',
    );
  }

  const workspaceId = await getDefaultWorkspaceId();
  const orgPublicId = await resolveOrgPublicIdForWorkspace(workspaceId);
  const sub = await apiClient(`/organizations/${orgPublicId}/billing/subscription`);
  // Phase A drops stripeSubscriptionId. Gate on plan.slug for paid-tier
  // detection AND preserve the existing status check so cancelled or
  // incomplete subscriptions still route to the checkout flow.
  const hasActiveSub = sub.plan.slug !== 'free' && ['active', 'past_due'].includes(sub.status);

  // Both paths prompt, so the TTY guard covers both (mirrors the
  // `channels connect` / `login` non-TTY guard); without it the @inquirer
  // prompt aborts into a confusing generic error. stdin matters as much as
  // stdout — a redirected stdin renders the prompt and then can't read the
  // answer, which is the same dead end with a worse error.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new ValidationError(
      `billing upgrade requires an interactive terminal to choose a plan. Re-run from a TTY, ` +
        `or use \`${cliCommandPrefix()} billing manage\` to manage an existing subscription.`,
      'UPGRADE_REQUIRES_TTY',
    );
  }

  if (hasActiveSub) {
    // States the terminal can't describe honestly stay on the Billing page,
    // which surfaces them: a Custom plan isn't in the tier catalog at all, and
    // a pending cancel or scheduled plan change would make "you'll switch right
    // away" a lie about what the subscription is already doing. A missing
    // billingInterval (the read model leaves it undefined when Stripe can't be
    // reached) belongs here too — applying a change needs an interval, and
    // assuming one could move an annual customer to monthly billing.
    if (
      sub.plan.slug === 'custom' ||
      sub.cancelAtPeriodEnd === true ||
      sub.pendingPlanChange ||
      (sub.billingInterval !== 'monthly' && sub.billingInterval !== 'annual')
    ) {
      console.log('Opening your Billing page to update your plan...');
      await open(orgBillingUrl(orgPublicId));
      return;
    }
    await changePlanInTerminal(orgPublicId, sub);
    return;
  }

  const paidPlans = await fetchPaidPlans();
  const { select } = await import('@inquirer/prompts');
  const planSlug = await select({
    message: 'Choose a plan',
    choices: paidPlans.map(planChoice),
  });
  const billingInterval = await select({
    message: 'Billing interval',
    choices: [
      { name: 'Annual (save ~17%)', value: 'annual' },
      { name: 'Monthly', value: 'monthly' },
    ],
  });
  const data = await apiClient(`/organizations/${orgPublicId}/billing/checkout`, {
    method: 'POST',
    body: JSON.stringify({ planSlug, billingInterval }),
  });
  console.log('Opening Stripe Checkout...');
  await open(data.url);

  console.log('Waiting for payment confirmation... (Ctrl+C to cancel)');
  const upgraded = await pollForUpgrade(orgPublicId);
  console.log(
    `✓ Upgraded to ${upgraded.plan.name} (${upgraded.plan.messages.toLocaleString('en-US')} messages/mo).`,
  );
}

export function registerBillingCommand(_program: Command): void {
  const billing = _program.command('billing').description('Manage billing');

  const billingStatusCmd = billing
    .command('status')
    .description('Show subscription status')
    .action(async () => {
      // Human mode is the default; scripts/CI opt into machine output with --json.
      // (Previously read the --human flag off a traversed parent chain, which
      // defaulted to false and forced JSON for every interactive user — that
      // flag was never advertised on the root command.)
      const { program: rootProgram } = await import('../index.js');
      const isJson = !!rootProgram.opts().json;
      await billingStatus({ json: isJson });
    });

  const billingManageCmd = billing
    .command('manage')
    .description('Open your Billing page in the app')
    .action(async () => {
      const { program: rootProgram } = await import('../index.js');
      await billingManage({ json: !!rootProgram.opts().json });
    });

  const billingUpgradeCmd = billing
    .command('upgrade')
    .description('Change your plan (interactive)')
    .action(async () => {
      const { program: rootProgram } = await import('../index.js');
      await billingUpgrade({ json: !!rootProgram.opts().json });
    });

  addExamples(
    billing,
    `
EXAMPLES:
  $ hookmyapp billing status
  $ hookmyapp billing upgrade
  $ hookmyapp billing manage
`,
  );

  addExamples(
    billingStatusCmd,
    `
EXAMPLES:
  $ hookmyapp billing status
  $ hookmyapp billing status --json
`,
  );

  addExamples(
    billingManageCmd,
    `
EXAMPLES:
  $ hookmyapp billing manage
  $ hookmyapp billing manage --workspace acme-corp
`,
  );

  addExamples(
    billingUpgradeCmd,
    `
EXAMPLES:
  $ hookmyapp billing upgrade
  $ hookmyapp billing upgrade --workspace acme-corp
`,
  );
}
