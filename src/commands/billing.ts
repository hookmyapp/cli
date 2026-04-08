import { Command } from 'commander';
import open from 'open';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { CliError } from '../output/error.js';
import { getDefaultWorkspaceId } from './_helpers.js';

export async function billingManage(): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const sub = await apiClient('/stripe/subscription', { workspaceId });

  if (sub.planSlug === 'free' || !sub.stripeSubscriptionId) {
    throw new CliError(
      'No active subscription. Run `hookmyapp billing upgrade` to subscribe.',
      'NO_SUBSCRIPTION',
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

export async function billingStatus(opts: { human?: boolean }): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const [sub, usage] = await Promise.all([
    apiClient('/stripe/subscription', { workspaceId }),
    apiClient('/webhook/usage', { workspaceId }),
  ]);

  if (opts.human === false || opts.human === undefined) {
    output({ subscription: sub, usage }, { human: false });
    return;
  }

  const plan = sub.plan?.name ?? sub.planSlug;
  const status = sub.status;
  const interval = sub.billingInterval ?? '—';
  const renews = sub.currentPeriodEnd ?? '—';
  const messages = `${usage.totalMessages} / ${usage.limit} (${usage.percentage}%)`;

  output({ plan, status, interval, renews, messages }, { human: true });

  if (sub.cancelAtPeriodEnd === true) {
    console.log('\n⚠  Subscription will cancel at period end.');
  }

  if (usage.percentage >= 100) {
    console.log(
      `\n\u001b[31mYou have exceeded your message limit (${usage.percentage}%). Run \`hookmyapp billing upgrade\` to upgrade.\u001b[0m`,
    );
  } else if (usage.percentage >= 80) {
    console.log(
      `\n\u001b[33mYou've used ${usage.percentage}% — run \`hookmyapp billing upgrade\` to upgrade.\u001b[0m`,
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

export function registerBillingCommand(program: Command): void {
  const billing = program.command('billing').description('Manage billing');

  billing
    .command('status')
    .description('Show subscription status')
    .action(async function (this: Command) {
      const human = this.parent?.parent?.opts().human ?? false;
      await billingStatus({ human });
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
