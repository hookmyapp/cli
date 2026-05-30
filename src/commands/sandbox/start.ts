// `hookmyapp sandbox start` — bind-code flow with --type chooser (D1).
// WA path: shows the existing wa.me QR + deep link, polls bind code,
// announces the consumed session. IG path: shows the ig.me/m/{handle}
// QR + deep link (handle stripped of @, code URL-encoded), same polling
// loop. Production with --type=instagram throws ConfigurationError per D10.

import { select } from '@inquirer/prompts';
import qrcode from 'qrcode-terminal';
import ora from 'ora';
import pc from 'picocolors';
import { apiClient, getBindCode } from '../../api/client.js';
import {
  AuthError,
  ConfigurationError,
  ConflictError,
  ValidationError,
} from '../../output/error.js';
import { c } from '../../output/color.js';
import { output } from '../../output/format.js';
import {
  getEffectiveSandboxInstagramUsername,
  getEffectiveSandboxWhatsAppNumber,
} from '../../config/env-profiles.js';
import { parseSandboxSession } from '../../api/sandbox-session.js';
import { getDefaultWorkspaceId } from '../_helpers.js';

export function buildInstagramDeepLink(handle: string, code: string): string {
  const stripped = handle.replace(/^@/, '');
  return `https://ig.me/m/${stripped}?text=${encodeURIComponent(code)}`;
}

function buildWhatsAppDeepLink(number: string, code: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(code)}`;
}

export async function runSandboxStart(opts: {
  type?: 'whatsapp' | 'instagram';
  workspace?: string;
  listen?: boolean;
  json?: boolean;
}): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const isHuman = !opts.json && isTty;

  // Commander's .option() doesn't enforce enum values — explicit validation
  // is required so `--type=foo` doesn't fall through into the IG branch by
  // virtue of "not whatsapp" later in the if-else.
  if (
    opts.type !== undefined &&
    opts.type !== 'whatsapp' &&
    opts.type !== 'instagram'
  ) {
    throw new ValidationError(
      `Invalid --type value: ${String(opts.type)}. Must be 'whatsapp' or 'instagram'.`,
      'INVALID_TYPE',
    );
  }

  let channelType: 'whatsapp' | 'instagram';
  if (opts.type) {
    channelType = opts.type;
  } else if (opts.json) {
    throw new ValidationError(
      '--type is required in --json mode (use --type=whatsapp or --type=instagram).',
      'TYPE_REQUIRED_IN_JSON',
    );
  } else if (isHuman) {
    channelType = await select<'whatsapp' | 'instagram'>({
      message: 'Which channel?',
      choices: [
        { name: 'WhatsApp', value: 'whatsapp' },
        { name: 'Instagram', value: 'instagram' },
      ],
    });
  } else {
    // Non-TTY, no --type, no --json: refuse rather than guess.
    throw new ValidationError(
      '--type is required in non-interactive mode.',
      'TYPE_REQUIRED_IN_JSON',
    );
  }

  // IG path fails fast in production before any backend call.
  if (channelType === 'instagram') {
    // Throws ConfigurationError in production (D10); returns the staging/local handle otherwise.
    getEffectiveSandboxInstagramUsername();
  }

  const workspaceId = await getDefaultWorkspaceId();
  const bindRes = await getBindCode(workspaceId);
  const bindCode = bindRes.code;

  let deepLink: string;
  let headerHint: string;
  if (channelType === 'whatsapp') {
    const waNumber = getEffectiveSandboxWhatsAppNumber();
    deepLink = buildWhatsAppDeepLink(waNumber, bindCode);
    headerHint = 'Send this code to the sandbox WhatsApp number from the phone you want to bind.';
  } else {
    const igHandle = getEffectiveSandboxInstagramUsername();
    deepLink = buildInstagramDeepLink(igHandle, bindCode);
    headerHint = `DM the sandbox Instagram account (${igHandle}) from the account you want to bind.`;
  }

  // --json: emit the minted bind code + deep link and exit immediately. A
  // machine consumer arranges delivery of the code out-of-band and polls
  // `sandbox status`; blocking on the human "send the code" poll loop below
  // would hang CI forever, and the human prints + spinner are not
  // machine-readable.
  if (opts.json) {
    output({ code: bindCode, type: channelType, deepLink, issuedAt: bindRes.issuedAt }, { json: true });
    return;
  }

  console.log();
  console.log(isTty ? pc.bold('Start a sandbox testing session') : 'Start a sandbox testing session');
  console.log(isTty ? c.dim(headerHint) : headerHint);
  console.log();
  console.log(isTty ? `  ${pc.bold(pc.cyan(bindCode))}` : `  ${bindCode}`);
  console.log();
  if (isTty) {
    qrcode.generate(deepLink, { small: true });
    console.log();
  }
  console.log(isTty ? c.dim(`Or open: ${deepLink}`) : `Or open: ${deepLink}`);
  console.log();

  // Poll loop with spinner + Ctrl+C trap + 5-minute soft warning.
  const waitingMsg =
    channelType === 'whatsapp'
      ? 'Waiting for your WhatsApp message…'
      : 'Waiting for your Instagram DM…';
  // discardStdin:false keeps stdin out of raw mode so Ctrl+C raises SIGINT and
  // the onSigint handler below can cancel the poll. ora's default (raw mode)
  // swallows the Ctrl+C byte and traps the user in the spinner.
  const spinner = isTty ? ora({ text: waitingMsg, discardStdin: false }) : null;
  spinner?.start();

  const onSigint = (): void => {
    spinner?.stop();
    console.log();
    console.log(
      isTty
        ? c.dim('Cancelled. Your bind code is still valid. Run `hookmyapp sandbox start` again to resume.')
        : 'Cancelled. Your bind code is still valid. Run `hookmyapp sandbox start` again to resume.',
    );
    process.exit(0);
  };
  process.once('SIGINT', onSigint);

  const started = Date.now();
  let warned = false;
  try {
    while (true) {
      try {
        const latest = await getBindCode(workspaceId);
        if (latest.consumedSessionId) {
          const dto = await apiClient(
            `/sandbox/sessions/${latest.consumedSessionId}`,
            { workspaceId },
          );
          const session = parseSandboxSession(dto);
          const ident =
            session.type === 'whatsapp'
              ? `+${session.whatsappPhone}`
              : session.type === 'instagram' && session.senderInstagramUsername
                ? `@${session.senderInstagramUsername}`
                : (session as { senderInstagramId?: string }).senderInstagramId ?? '(unknown)';
          spinner?.succeed(`Session created. ${ident}. Token: ${session.accessToken}`);
          if (!isTty) {
            console.log(`Session created. ${ident}. Token: ${session.accessToken}`);
          }
          if (opts.listen) {
            const { runSandboxListenFlow } = await import('../sandbox-listen/index.js');
            await runSandboxListenFlow({ ...session, workspaceId });
          }
          return;
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          spinner?.fail('This account is already bound to another workspace. Remove the existing binding first.');
          throw err;
        }
        if (err instanceof AuthError) {
          spinner?.fail("You're not logged in. Run `hookmyapp login` first.");
          throw err;
        }
        // Retry only on known-transient failures (network + 5xx). Anything
        // else — parser failures (UnexpectedError/MALFORMED_SANDBOX_SESSION),
        // 4xx, programming errors — must NOT be swallowed silently in the
        // poll loop; that would hide real bugs forever behind the spinner.
        const { NetworkError, ApiError } = await import('../../output/error.js');
        const isTransient =
          err instanceof NetworkError ||
          (err instanceof ApiError && err.statusCode !== undefined && err.statusCode >= 500);
        if (!isTransient) {
          spinner?.fail(
            err instanceof Error ? err.message : 'Unexpected error while polling for bind code',
          );
          throw err;
        }
        // Transient — retry next tick.
      }
      if (!warned && Date.now() - started > 5 * 60 * 1000) {
        spinner?.warn('Still waiting. Press Ctrl+C to cancel, or leave this running.');
        spinner?.start(waitingMsg);
        warned = true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
