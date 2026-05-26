// `hookmyapp sandbox webhook show/set/clear` — manage the destination webhook
// URL for a sandbox session.
//
// D3/D12 migration: positional [phone] is deprecated for 0.12.2 (emits stderr
// warning, still works). Removed in 0.13.0. Positional + flag → exit 2
// (CONFLICTING_SELECTORS, per E5).

import { input } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
} from '../../api/sandbox-session.js';
import { c, icon } from '../../output/color.js';
import { ValidationError } from '../../output/error.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { sessionIdentifier, sessionLabel } from './helpers.js';
import { pickSession } from './picker.js';

interface BaseOpts {
  positionalPhone?: string;
  phone?: string;
  username?: string;
  session?: string;
  json?: boolean;
}

interface SetOpts extends BaseOpts {
  url?: string;
}

function resolvePhoneFromPositional(opts: BaseOpts): string | undefined {
  if (!opts.positionalPhone) return opts.phone;
  // Positional [phone] is deprecated — see D12.
  if (opts.phone !== undefined || opts.username !== undefined || opts.session !== undefined) {
    throw new ValidationError(
      `Conflicting selectors: positional <phone> and --${
        opts.phone !== undefined ? 'phone' : opts.username !== undefined ? 'username' : 'session'
      } cannot both be provided. Use one selector.`,
      'CONFLICTING_SELECTORS',
    );
  }
  process.stderr.write(
    '[deprecated] positional <phone> on `sandbox webhook` will be removed in 0.13.0. ' +
      'Use --phone, --username, or --session.\n',
  );
  return opts.positionalPhone;
}

async function pickForWebhook(opts: BaseOpts, alwaysShowPicker: boolean) {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const phoneFlag = resolvePhoneFromPositional(opts);
  const isHuman = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    phoneFlag,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman,
    alwaysShowPicker,
  });
  return { workspaceId, session };
}

export async function runSandboxWebhookShow(opts: BaseOpts): Promise<void> {
  const { session } = await pickForWebhook(opts, false);
  const url = session.webhookUrl ?? null;
  const tunnelUrl = session.hostname ? `https://${session.hostname}/webhook` : null;
  const mode: 'cli' | 'custom' = !url || url === tunnelUrl ? 'cli' : 'custom';
  if (opts.json) {
    // Structured shape preserved from pre-0.12.2 sandbox.ts so existing
    // scripts that branch on mode/tunnelUrl/sessionId keep working. `phone`
    // is retained only for WhatsApp rows (the field never existed on IG);
    // new code should prefer `identifier` + `type` for channel-agnostic logic.
    process.stdout.write(
      JSON.stringify(
        {
          sessionId: session.id,
          type: session.type,
          identifier: sessionIdentifier(session),
          phone: session.type === 'whatsapp' ? session.whatsappPhone : null,
          webhookUrl: url,
          mode,
          tunnelUrl,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (!url) {
    console.log(`${sessionLabel(session)}: webhook URL not set (uses HookMyApp CLI tunnel)`);
    return;
  }
  console.log(`${sessionLabel(session)}: ${url}`);
}

export async function runSandboxWebhookSet(opts: SetOpts): Promise<void> {
  const { session } = await pickForWebhook(opts, true);
  if (!opts.url) {
    throw new ValidationError(
      '--url is required. Example: hookmyapp sandbox webhook set --phone +15551234567 --url https://example.com/webhook',
    );
  }
  // Existing backend contract: PATCH /sandbox/sessions/:id/webhook-url with a
  // JSON-stringified body. Matches the old sandbox.ts:614-619 call shape; do
  // NOT change to PUT or to an object body without updating the backend.
  await apiClient(`/sandbox/sessions/${session.id}/webhook-url`, {
    method: 'PATCH',
    body: JSON.stringify({ webhookUrl: opts.url }),
  });
  console.log(`${c.success(icon.success)} Set webhook URL on ${sessionLabel(session)}: ${opts.url}`);
}

export async function runSandboxWebhookClear(opts: BaseOpts): Promise<void> {
  const { session } = await pickForWebhook(opts, true);
  // Existing backend contract: POST /sandbox/sessions/:id/reset-webhook. Matches
  // sandbox.ts:658-660. NOT a DELETE on /webhook-url and NOT a PUT/PATCH with
  // null body — the backend has a separate reset endpoint.
  await apiClient(`/sandbox/sessions/${session.id}/reset-webhook`, {
    method: 'POST',
  });
  console.log(`${c.success(icon.success)} Cleared webhook URL on ${sessionLabel(session)}`);
}
