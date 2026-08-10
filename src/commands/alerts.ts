import { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { c } from '../output/color.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { cliCommandPrefix } from '../output/cli-self.js';

// AIT-376 — the caller's OWN alert phone: where HookMyApp texts them when
// something breaks. User-scoped, never workspace-scoped, and never settable
// for another member — the /auth/phone routes act on the authenticated user.
//
// Mirrors the MCP tools (get_alert_phone_status / set_alert_phone /
// verify_alert_phone) so an agent and a human reach the same state the same
// way.

interface AlertPhoneStatus {
  phone: string | null;
  verified: boolean;
  consents: { operational: boolean; product: boolean; marketing: boolean };
  channelPreference: string;
}

export async function alertPhoneStatus(opts: { json?: boolean } = {}): Promise<void> {
  const status = (await apiClient('/auth/phone')) as AlertPhoneStatus;

  if (opts.json) {
    output(status, { json: true });
    return;
  }

  if (!status.verified) {
    console.log(
      c.warn('No alert phone verified.') +
        `\nRun \`${cliCommandPrefix()} alerts phone set +14155552671\` so we can reach you when something breaks.`,
    );
    return;
  }

  output(
    {
      phone: status.phone,
      delivery: status.channelPreference,
      'problem alerts': status.consents.operational ? 'on' : 'off',
      'product news': status.consents.product ? 'on' : 'off',
      offers: status.consents.marketing ? 'on' : 'off',
    },
    { json: false, kind: 'read' },
  );
}

/**
 * Consents default to operational-only, matching the MCP tools: problem alerts
 * are the reason the number exists, while product news and offers are opt-in
 * because consent to marketing is not something a CLI flag should assume.
 */
export async function alertPhoneSet(
  phone: string,
  opts: { json?: boolean; product?: boolean; marketing?: boolean; sms?: boolean; code?: string } = {},
): Promise<void> {
  if (!phone?.startsWith('+')) {
    throw new ValidationError(
      `Phone must be in international format, e.g. +14155552671 (got "${phone}").`,
      'ALERT_PHONE_FORMAT',
    );
  }

  const start = (await apiClient('/auth/phone', {
    method: 'POST',
    body: JSON.stringify({
      phone,
      consentOperational: true,
      consentProduct: opts.product === true,
      consentMarketing: opts.marketing === true,
      channelPreference: opts.sms ? 'sms' : 'whatsapp',
    }),
  })) as { delivery?: string };

  if (start.delivery !== 'sent') {
    // The code was NOT delivered — say so instead of asking for a code that
    // never arrived. The challenge stays valid, so `alerts phone verify` still
    // works if it shows up late.
    if (opts.json) {
      output({ delivery: start.delivery ?? 'unavailable', verified: false }, { json: true });
      return;
    }
    console.log(
      c.warn('We could not deliver a code to that number right now.') +
        `\nNothing was sent. Try again in a moment, or check the number.`,
    );
    return;
  }

  // Non-interactive path: a caller who already has the code (or a script that
  // will fetch it) skips the prompt entirely.
  if (opts.code) {
    await alertPhoneVerify(opts.code, { json: opts.json });
    return;
  }

  if (opts.json) {
    // A prompt cannot run under --json. Report that the code is out and let
    // the caller finish with `verify`.
    output({ delivery: 'sent', verified: false, next: 'alerts phone verify <code>' }, { json: true });
    return;
  }

  console.log(`We sent a 6-digit code to ${phone}.`);
  const { input } = await import('@inquirer/prompts');
  const code = await input({
    message: 'Enter the code:',
    validate: (v) => (/^\d{6}$/.test(v.trim()) ? true : 'The code is 6 digits.'),
  });
  await alertPhoneVerify(code.trim(), { json: false });
}

export async function alertPhoneVerify(code: string, opts: { json?: boolean } = {}): Promise<void> {
  if (!/^\d{6}$/.test(code?.trim() ?? '')) {
    throw new ValidationError('The verification code is 6 digits.', 'ALERT_PHONE_CODE_FORMAT');
  }

  const status = (await apiClient('/auth/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ code: code.trim() }),
  })) as AlertPhoneStatus;

  if (opts.json) {
    output(status, { json: true });
    return;
  }
  console.log(c.success(`Verified. Alerts go to ${status.phone}.`));
}

export function registerAlertsCommand(_program: Command): void {
  const alerts = _program.command('alerts').description('Where we reach you when something breaks');
  const phone = alerts.command('phone').description('Your alert phone number');

  const statusCmd = phone
    .command('status', { isDefault: true })
    .description('Show your alert phone and what it receives')
    .action(async () => {
      const { program: rootProgram } = await import('../index.js');
      await alertPhoneStatus({ json: !!rootProgram.opts().json });
    });

  const setCmd = phone
    .command('set <phone>')
    .description('Add or change your alert phone (international format, e.g. +14155552671)')
    .option('--sms', 'Deliver by SMS instead of WhatsApp')
    .option('--product', 'Also receive product news')
    .option('--marketing', 'Also receive offers')
    .option('--code <code>', 'Skip the prompt and verify with this code')
    .action(async (phoneArg: string, cmdOpts: { sms?: boolean; product?: boolean; marketing?: boolean; code?: string }) => {
      const { program: rootProgram } = await import('../index.js');
      await alertPhoneSet(phoneArg, { ...cmdOpts, json: !!rootProgram.opts().json });
    });

  const verifyCmd = phone
    .command('verify <code>')
    .description('Finish verification with the code we sent')
    .action(async (code: string) => {
      const { program: rootProgram } = await import('../index.js');
      await alertPhoneVerify(code, { json: !!rootProgram.opts().json });
    });

  addExamples(
    alerts,
    `
EXAMPLES:
  $ hookmyapp alerts phone status
  $ hookmyapp alerts phone set +14155552671
`,
  );

  addExamples(
    phone,
    `
EXAMPLES:
  $ hookmyapp alerts phone status
  $ hookmyapp alerts phone set +14155552671 --sms
`,
  );

  addExamples(
    statusCmd,
    `
EXAMPLES:
  $ hookmyapp alerts phone status
  $ hookmyapp alerts phone status --json
`,
  );

  addExamples(
    setCmd,
    `
EXAMPLES:
  $ hookmyapp alerts phone set +14155552671
  $ hookmyapp alerts phone set +14155552671 --sms --product
`,
  );

  addExamples(
    verifyCmd,
    `
EXAMPLES:
  $ hookmyapp alerts phone verify 123456
  $ hookmyapp alerts phone verify 123456 --json
`,
  );
}
