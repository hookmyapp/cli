import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';

/**
 * AIT-370 — `hookmyapp phone`: the calling user's PRIVATE alert phone
 * (breakdown/product/marketing notifications over WhatsApp/SMS). Thin wrapper
 * over POST/GET /auth/phone + /auth/phone/verify + PATCH /auth/phone/consents.
 *
 * Agent etiquette: the number and the code come from the HUMAN. Never invent,
 * guess, or reuse either; a decline is a normal outcome — skip and continue.
 */

interface PhoneStatus {
  phone: string | null;
  verified: boolean;
  consents: { operational: boolean; product: boolean; marketing: boolean };
  channelPreference: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;

function printStatus(status: PhoneStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  output(
    [
      {
        PHONE: status.phone ?? '(none)',
        VERIFIED: status.verified ? 'yes' : 'no',
        OPERATIONAL: status.consents.operational ? 'on' : 'off',
        PRODUCT: status.consents.product ? 'on' : 'off',
        MARKETING: status.consents.marketing ? 'on' : 'off',
        PREFERENCE: status.channelPreference,
      },
    ],
    { human: true },
  );
}

export function registerPhoneCommand(program: Command): void {
  const phone = program
    .command('phone')
    .description(
      'Your personal alert phone — HookMyApp texts it (WhatsApp/SMS) when your integration ' +
        'breaks. Ask the human for THEIR number and the code they receive; never invent either. ' +
        'Declining is fine — nothing else depends on it.',
    );
  addExamples(
    phone,
    `
EXAMPLES:
  $ hookmyapp phone status
  $ hookmyapp phone set +14155552671 --product
  $ hookmyapp phone verify 123456
`,
  );

  const status = phone
    .command('status', { isDefault: true })
    .description('Show the verified alert phone (masked) and notification consents')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = (await apiClient('/auth/phone')) as PhoneStatus;
      printStatus(res, Boolean(opts.json || program.opts().json));
    });
  addExamples(status, `\nEXAMPLES:\n  $ hookmyapp phone status\n  $ hookmyapp phone status --json\n`);

  const set = phone
    .command('set')
    .description('Start verification: sends a 6-digit code to the number (international format)')
    .argument('<number>', 'The phone number in international format, e.g. +14155552671')
    .option('--no-operational', 'Opt out of breakdown alerts (on by default)')
    .option('--product', 'Opt in to feature announcements')
    .option('--marketing', 'Opt in to offers/promotions')
    .option('--prefer <channel>', 'Delivery channel: whatsapp | sms | both', 'whatsapp')
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (
        number: string,
        opts: { operational?: boolean; product?: boolean; marketing?: boolean; prefer?: string; json?: boolean },
      ) => {
        const cleaned = number.replace(/[\s\-().]/g, '');
        if (!E164.test(cleaned)) {
          throw new ValidationError(
            `Invalid phone "${number}" — use international format, e.g. +14155552671.`,
          );
        }
        if (!['whatsapp', 'sms', 'both'].includes(opts.prefer ?? 'whatsapp')) {
          throw new ValidationError('--prefer must be whatsapp, sms, or both');
        }
        const res = (await apiClient('/auth/phone', {
          method: 'POST',
          body: JSON.stringify({
            phone: cleaned,
            consentOperational: opts.operational ?? true,
            consentProduct: opts.product ?? false,
            consentMarketing: opts.marketing ?? false,
            channelPreference: opts.prefer ?? 'whatsapp',
          }),
        })) as { delivery: 'sent' | 'unavailable' };
        if (opts.json || program.opts().json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.delivery === 'sent') {
          console.log('Code sent. Ask the human for the 6-digit code, then run: hookmyapp phone verify <code>');
        } else {
          console.log('Code delivery is unavailable in this environment. Verify later from the web app.');
        }
      },
    );
  addExamples(set, `\nEXAMPLES:\n  $ hookmyapp phone set +14155552671\n  $ hookmyapp phone set +14155552671 --product --prefer both\n`);

  const verify = phone
    .command('verify')
    .description('Complete verification with the 6-digit code the human received')
    .argument('<code>', 'The 6-digit code from the phone')
    .option('--json', 'Output machine-readable JSON')
    .action(async (code: string, opts: { json?: boolean }) => {
      if (!/^\d{6}$/.test(code)) {
        throw new ValidationError(`Invalid code "${code}" — expected 6 digits.`);
      }
      const res = (await apiClient('/auth/phone/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })) as PhoneStatus;
      printStatus(res, Boolean(opts.json || program.opts().json));
    });
  addExamples(verify, `\nEXAMPLES:\n  $ hookmyapp phone verify 123456\n  $ hookmyapp phone verify 654321 --json\n`);

  const consents = phone
    .command('consents')
    .description('Update notification consents / delivery preference without re-verifying')
    .option('--operational <on|off>', 'Breakdown alerts')
    .option('--product <on|off>', 'Feature announcements')
    .option('--marketing <on|off>', 'Offers/promotions')
    .option('--prefer <channel>', 'Delivery channel: whatsapp | sms | both')
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (opts: { operational?: string; product?: string; marketing?: string; prefer?: string; json?: boolean }) => {
        const toBool = (v: string | undefined, flag: string): boolean | undefined => {
          if (v === undefined) return undefined;
          if (v !== 'on' && v !== 'off') throw new ValidationError(`${flag} must be "on" or "off"`);
          return v === 'on';
        };
        const body: Record<string, unknown> = {};
        const operational = toBool(opts.operational, '--operational');
        const product = toBool(opts.product, '--product');
        const marketing = toBool(opts.marketing, '--marketing');
        if (operational !== undefined) body.operational = operational;
        if (product !== undefined) body.product = product;
        if (marketing !== undefined) body.marketing = marketing;
        if (opts.prefer !== undefined) {
          if (!['whatsapp', 'sms', 'both'].includes(opts.prefer)) {
            throw new ValidationError('--prefer must be whatsapp, sms, or both');
          }
          body.channelPreference = opts.prefer;
        }
        if (Object.keys(body).length === 0) {
          throw new ValidationError('Nothing to update — pass at least one of --operational/--product/--marketing/--prefer');
        }
        const res = (await apiClient('/auth/phone/consents', { method: 'PATCH', body: JSON.stringify(body) })) as PhoneStatus;
        printStatus(res, Boolean(opts.json || program.opts().json));
      },
    );
  addExamples(consents, `\nEXAMPLES:\n  $ hookmyapp phone consents --marketing on\n  $ hookmyapp phone consents --operational off --prefer sms\n`);
}
