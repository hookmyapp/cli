// `hookmyapp sandbox send` — send a one-shot test message via the shared
// sandbox-proxy. WA: text message to the test phone. IG: text message to
// the IGSID that originated the session. Both flow through
// buildSandboxSendRequest which encapsulates the URL + body shape per channel.
//
// SESSION_WINDOW_CLOSED 403 from sandbox-proxy is reflected verbatim (the
// proxy's body.message wins; falls back to the hardcoded WA-flavored string
// if absent). Per spec E8.

import { input } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
} from '../../api/sandbox-session.js';
import {
  ApiError,
  SessionWindowError,
} from '../../output/error.js';
import { c, icon } from '../../output/color.js';
import { output } from '../../output/format.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { buildSandboxSendRequest, sessionIdentifier } from './helpers.js';
import { pickSession } from './picker.js';

export async function runSandboxSend(opts: {
  identifierArg?: string;
  phone?: string;
  username?: string;
  session?: string;
  message?: string;
  json?: boolean;
}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const isHuman = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    identifierArg: opts.identifierArg,
    phoneFlag: opts.phone,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman,
    alwaysShowPicker: true,
  });

  const message =
    opts.message ??
    (await input({
      message: 'Message:',
      validate: (v: string) => (v.length > 0 ? true : 'Message cannot be empty'),
    }));

  const { url, body } = buildSandboxSendRequest(session, message);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resBody: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && resBody?.code === 'SESSION_WINDOW_CLOSED') {
      throw new SessionWindowError(
        resBody.message ??
          'Recipient has not sent an inbound message in the last 24 hours.',
      );
    }
    // The API/Meta error body's `message` is not guaranteed to be a string
    // (it can be a nested object). Coerce so ApiError always carries a string
    // userMessage — a non-string crashes the error renderer (HOOKMYAPP-CLI-J).
    const rawMsg = resBody?.error?.message ?? resBody?.message;
    const msg: string =
      typeof rawMsg === 'string'
        ? rawMsg
        : rawMsg != null
          ? JSON.stringify(rawMsg)
          : `Send failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }

  // Shape the output around what the customer needs (the sent message's id +
  // where it went), NOT the raw provider/proxy wire — a verbatim passthrough
  // would republish provider-shaped fields (messaging_product, contacts[].input)
  // as our public --json contract. Public Surface Data Contract.
  const msgId: string =
    resBody?.messages?.[0]?.id ?? resBody?.message_id ?? '?';

  if (opts.json) {
    output({ messageId: msgId, to: sessionIdentifier(session), status: 'sent' }, { json: true });
    return;
  }

  console.log(
    `${c.success(icon.success)} Message sent to ${sessionIdentifier(session)} (id: ${msgId})`,
  );
}
