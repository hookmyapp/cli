import type { Command } from 'commander';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { output } from '../output/format.js';
import { AuthError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { readCredentials } from '../auth/store.js';
import open from 'open';

async function fetchAppConfig(): Promise<{ metaAppId: string; metaConfigId: string }> {
  return apiClient('/config');
}

/** Pick only customer-facing fields for CLI display output */
function pickDisplayFields(account: any): any {
  const { id, workspaceId, qualityRating, ...display } = account;
  if (account.connectionType !== 'coexistence' && qualityRating) {
    display.qualityRating = qualityRating;
  }
  return display;
}

/** Resolve a WABA ID to the full account object with workspaceId */
export async function resolveAccount(wabaId: string): Promise<any> {
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();
  const accounts = await apiClient('/meta/accounts', { workspaceId });
  const account = accounts.find((a: any) => a.metaWabaId === wabaId);
  if (!account) {
    throw new ValidationError(`account not found for WABA ID ${wabaId}`);
  }
  return account;
}

/**
 * Exported helper: drive the Embedded Signup flow end-to-end.
 *
 * Called directly by the post-login wizard (src/auth/login.ts) and by the
 * `accounts connect` subcommand action below. Never subprocess-spawned.
 */
export async function runAccountsConnect(): Promise<void> {
  // Force a fresh 15-min token right before opening signup
  await forceTokenRefresh();
  const creds = readCredentials();
  if (!creds?.accessToken) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }

  const config = await fetchAppConfig();
  const appUrl = process.env.HOOKMYAPP_APP_URL ?? 'https://app.hookmyapp.com';
  const redirectUri = `${appUrl}/cli/callback`;

  const extras = JSON.stringify({
    featureType: 'whatsapp_business_app_onboarding',
    sessionInfoVersion: '3',
    version: 'v4',
  });

  const u = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  u.searchParams.set('client_id', config.metaAppId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('config_id', config.metaConfigId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('override_default_response_type', 'true');
  u.searchParams.set('extras', extras);
  u.searchParams.set('state', `cli:${creds.accessToken}`);

  // Snapshot existing accounts before signup
  const existingAccounts = await apiClient('/meta/accounts');
  console.log('\nOpening Embedded Signup in browser...\nComplete the signup, then return here.\n');
  await open(u.toString());
  console.log('Waiting for account...');

  // Poll for new account (check every 5s, timeout after 15 min)
  const maxWait = 15 * 60 * 1000;
  const pollInterval = 5000;
  const start = Date.now();
  let newAccount: any = null;
  const baseUrl = process.env.HOOKMYAPP_API_URL ?? 'https://api.hookmyapp.com';

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));
    try {
      await forceTokenRefresh();
      const freshCreds = readCredentials();
      if (!freshCreds) continue;

      const res = await fetch(`${baseUrl}/meta/accounts`, {
        headers: { Authorization: `Bearer ${freshCreds.accessToken}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) continue;

      const current = await res.json();
      newAccount = current.find((a: any) =>
        !existingAccounts.some((e: any) => e.id === a.id)
      );
      if (newAccount) break;
    } catch {
      // Network error — keep trying
    }
  }

  if (!newAccount) {
    console.log('\nTimed out waiting for account.\nRun "hookmyapp accounts list" to check.\n');
    return;
  }

  const name = newAccount.phoneVerifiedName ?? newAccount.wabaName ?? '';
  console.log(`\n✓ Account connected`);
  console.log(`  waba:  ${newAccount.metaWabaId}`);
  console.log(`  phone: ${newAccount.displayPhoneNumber}`);
  if (name) console.log(`  name:  ${name}`);

  // Check if webhook is configured
  if (!newAccount.webhookUrl) {
    console.log(`\n→ Next, configure your webhook to receive WhatsApp messages.`);
    console.log(`  The webhook URL should be a publicly accessible HTTPS`);
    console.log(`  endpoint that returns 200 OK.\n`);
    console.log(`  hookmyapp webhook set ${newAccount.metaWabaId} --url <your-webhook-url>\n`);
    console.log(`→ Then get your credentials:`);
    console.log(`  hookmyapp env ${newAccount.metaWabaId}\n`);
  } else {
    console.log(`\n✓ Webhook configured: ${newAccount.webhookUrl}`);
    console.log(`\n→ Get your credentials:`);
    console.log(`  hookmyapp env ${newAccount.metaWabaId}\n`);
  }
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Manage WhatsApp accounts');

  const accountsList = accounts
    .command('list')
    .description('List all accounts')
    .action(async () => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const data = await apiClient('/meta/accounts', { workspaceId });
      const connectedAccounts = data.filter((a: any) => a.metaConnected !== false);
      output(connectedAccounts.map(pickDisplayFields), { human: !program.opts().json });
    });

  const accountsShow = accounts
    .command('show')
    .description('Show account details')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const detail = await apiClient(`/meta/accounts/${account.id}`);
      output(pickDisplayFields(detail), { human: !program.opts().json });
    });

  const accountsConnect = accounts
    .command('connect')
    .description('Connect a WhatsApp account via Embedded Signup')
    .action(async () => {
      await runAccountsConnect();
    });

  const accountsDisconnect = accounts
    .command('disconnect')
    .description('Disconnect an account')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const result = await apiClient(`/meta/accounts/${account.id}/disconnect`, {
        method: 'POST',
        workspaceId: account.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  const accountsEnable = accounts
    .command('enable')
    .description('Enable forwarding for an account')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const result = await apiClient(`/meta/accounts/${account.id}/enable`, {
        method: 'POST',
        workspaceId: account.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  const accountsDisable = accounts
    .command('disable')
    .description('Disable forwarding for an account')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const result = await apiClient(`/meta/accounts/${account.id}/disable`, {
        method: 'POST',
        workspaceId: account.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  addExamples(
    accounts,
    `
EXAMPLES:
  $ hookmyapp accounts list
  $ hookmyapp accounts connect
  $ hookmyapp accounts disconnect 1234567890
`,
  );

  addExamples(
    accountsList,
    `
EXAMPLES:
  $ hookmyapp accounts list
  $ hookmyapp accounts list --json
`,
  );

  addExamples(
    accountsShow,
    `
EXAMPLES:
  $ hookmyapp accounts show 1234567890
  $ hookmyapp accounts show 1234567890 --json
`,
  );

  addExamples(
    accountsConnect,
    `
EXAMPLES:
  $ hookmyapp accounts connect
  $ hookmyapp accounts connect --workspace acme-corp
`,
  );

  addExamples(
    accountsDisconnect,
    `
EXAMPLES:
  $ hookmyapp accounts disconnect 1234567890
  $ hookmyapp accounts disconnect 1234567890 --workspace acme-corp
`,
  );

  addExamples(
    accountsEnable,
    `
EXAMPLES:
  $ hookmyapp accounts enable 1234567890
  $ hookmyapp accounts enable 1234567890 --workspace acme-corp
`,
  );

  addExamples(
    accountsDisable,
    `
EXAMPLES:
  $ hookmyapp accounts disable 1234567890
  $ hookmyapp accounts disable 1234567890 --workspace acme-corp
`,
  );
}
