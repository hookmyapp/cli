import { Command } from 'commander';
import open from 'open';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { c } from '../output/color.js';
import { ValidationError } from '../output/error.js';
import { getDefaultWorkspaceId } from './_helpers.js';

// program is lazy-imported inside actions because commands/billing.ts is
// loaded by index.ts during program setup — a top-level import would form a
// cycle. Same pattern as other commands that need root-level opts.

export async function billingManage(): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const sub = await apiClient('/stripe/subscription', { workspaceId });

  if (sub.planSlug === 'free' || !sub.stripeSubscriptionId) {
    throw new ValidationError(
      'No active subscription. Run `hookmyapp billing upgrade` to subscribe.',
    );
  }

  const data = await apiClient('/stripe/portal', {
    method: 'POST',
    workspaceId,
    body: JSON.stringify({}),
  });

  console.log('Opening Stripe Customer Portal...');
  await open(data.url);
}

export async function billingStatus(opts: { json?: boolean; human?: boolean } = {}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const [sub, usage] = await Promise.all([
    apiClient('/stripe/subscription', { workspaceId }),
    apiClient('/webhook/usage', { workspaceId }),
  ]);

  // Accept either `json: true` or `human: false` (back-compat with callers
  // and tests that predate the phase-108 opts shape).
  const isJson = opts.json === true || opts.human === false;

  if (isJson) {
    output({ subscription: sub, usage }, { json: true });
    return;
  }

  const plan = sub.plan?.name ?? sub.planSlug;
  const status = sub.status;
  const interval = sub.billingInterval ?? '—';
  const renews = sub.currentPeriodEnd ?? '—';
  const messages = `${usage.totalMessages} / ${usage.limit} (${usage.percentage}%)`;

  output({ plan, status, interval, renews, messages }, { json: false, kind: 'read' });

  if (sub.cancelAtPeriodEnd === true) {
    console.log('\n' + c.warn('Subscription will cancel at period end.'));
  }

  if (usage.percentage >= 100) {
    console.log(
      '\n' +
        c.error(
          `You have exceeded your message limit (${usage.percentage}%). Run \`hookmyapp billing upgrade\` to upgrade.`,
        ),
    );
  } else if (usage.percentage >= 80) {
    console.log(
      '\n' +
        c.warn(
          `You've used ${usage.percentage}% — run \`hookmyapp billing upgrade\` to upgrade.`,
        ),
    );
  }
}

export async function billingUpgrade(): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const sub = await apiClient('/stripe/subscription', { workspaceId });
  const hasActiveSub = Boolean(sub.stripeSubscriptionId) && ['active', 'past_due'].includes(sub.status);

  if (hasActiveSub) {
    const data = await apiClient('/stripe/portal', {
      method: 'POST',
      workspaceId,
      body: JSON.stringify({ flow: 'update' }),
    });
    console.log('Opening Stripe Customer Portal to update your plan...');
    await open(data.url);
    return;
  }

  const { select } = await import('@inquirer/prompts');
  const planSlug = await select({
    message: 'Choose a plan',
    choices: [
      { name: 'Build — 500 messages', value: 'starter' },
      { name: 'Scale — 1,200 messages', value: 'growth', description: 'Most popular' },
      { name: 'Business — 2,500 messages', value: 'pro' },
    ],
  });
  const billingInterval = await select({
    message: 'Billing interval',
    choices: [
      { name: 'Annual (save ~17%)', value: 'annual' },
      { name: 'Monthly', value: 'monthly' },
    ],
  });
  const data = await apiClient('/stripe/checkout', {
    method: 'POST',
    workspaceId,
    body: JSON.stringify({ planSlug, billingInterval }),
  });
  console.log('Opening Stripe Checkout...');
  await open(data.url);
}

export function registerBillingCommand(_program: Command): void {
  const billing = _program.command('billing').description('Manage billing');

  billing
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

  billing
    .command('manage')
    .description('Open Stripe Customer Portal')
    .action(async () => {
      await billingManage();
    });

  billing
    .command('upgrade')
    .description('Upgrade plan (interactive for free users, opens portal for subscribers)')
    .action(async () => {
      await billingUpgrade();
    });
}
