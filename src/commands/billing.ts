import { Command } from 'commander';
import open from 'open';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { c } from '../output/color.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import { getEffectiveAppUrl } from '../config/env-profiles.js';
import { getDefaultWorkspaceId } from './_helpers.js';

// program is lazy-imported inside actions because commands/billing.ts is
// loaded by index.ts during program setup — a top-level import would form a
// cycle. Same pattern as other commands that need root-level opts.

/**
 * Billing is org-scoped: the workspace-addressed /stripe/subscription and
 * /stripe/checkout routes are retired (410 BILLING_ROUTE_MOVED), and
 * /stripe/portal before them (410 BILLING_PORTAL_RETIRED). Resolve the org
 * publicId from the /workspaces membership union — every row carries
 * organizationPublicId (same mechanism as customers.ts) — preferring the row
 * for the active workspace.
 */
async function resolveOrgPublicId(workspaceId: string): Promise<string> {
  const all = (await apiClient('/workspaces')) as Array<{
    id: string;
    organizationPublicId?: string;
  }>;
  const orgPublicId = (all.find((w) => w.id === workspaceId) ?? all[0])?.organizationPublicId;
  if (!orgPublicId) {
    throw new ValidationError('No organization found for your account. Log in and try again.');
  }
  return orgPublicId;
}

function orgBillingUrl(orgPublicId: string): string {
  return `${getEffectiveAppUrl()}/org/${orgPublicId}/billing`;
}

export async function billingManage(): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const url = orgBillingUrl(await resolveOrgPublicId(workspaceId));

  console.log('Opening your Billing page...');
  await open(url);
}

export async function billingStatus(opts: { json?: boolean; human?: boolean } = {}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const orgPublicId = await resolveOrgPublicId(workspaceId);
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

export async function billingUpgrade(opts: { json?: boolean } = {}): Promise<void> {
  // `billing upgrade` is interactive end-to-end: the free path prompts for a
  // plan + interval, and both paths open a browser. There is no machine-
  // readable form, so reject --json up front with a clear pointer instead of
  // rendering an inquirer prompt that aborts into a generic error in non-TTY
  // / --json contexts.
  if (opts.json) {
    throw new ValidationError(
      `billing upgrade is interactive (plan selection + browser checkout) and has no --json form. ` +
        `Run it without --json from a terminal, or use \`${cliCommandPrefix()} billing manage\` for an existing subscription.`,
      'UPGRADE_NO_JSON',
    );
  }

  const workspaceId = await getDefaultWorkspaceId();
  const orgPublicId = await resolveOrgPublicId(workspaceId);
  const sub = await apiClient(`/organizations/${orgPublicId}/billing/subscription`);
  // Phase A drops stripeSubscriptionId. Gate on plan.slug for paid-tier
  // detection AND preserve the existing status check so cancelled or
  // incomplete subscriptions still route to the checkout flow.
  const hasActiveSub = sub.plan.slug !== 'free' && ['active', 'past_due'].includes(sub.status);

  if (hasActiveSub) {
    const url = orgBillingUrl(orgPublicId);
    console.log('Opening your Billing page to update your plan...');
    await open(url);
    return;
  }

  // Free tier → interactive plan selection. Requires a TTY (mirrors the
  // `channels connect` / `login` non-TTY guard); without it the @inquirer
  // prompt aborts into a confusing generic error.
  if (process.stdout.isTTY !== true) {
    throw new ValidationError(
      `billing upgrade requires an interactive terminal to choose a plan. Re-run from a TTY, ` +
        `or use \`${cliCommandPrefix()} billing manage\` to manage an existing subscription.`,
      'UPGRADE_REQUIRES_TTY',
    );
  }

  const { select } = await import('@inquirer/prompts');
  const planSlug = await select({
    message: 'Choose a plan',
    choices: [
      { name: 'Build: 500 messages', value: 'starter' },
      { name: 'Scale: 1,200 messages', value: 'growth', description: 'Most popular' },
      { name: 'Business: 2,500 messages', value: 'pro' },
    ],
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
      await billingManage();
    });

  const billingUpgradeCmd = billing
    .command('upgrade')
    .description('Upgrade plan (interactive for free users, opens your Billing page for subscribers)')
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
