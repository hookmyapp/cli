// Shared sandbox-session helpers. The first two are pure (no side effects).
// buildSandboxSendRequest is explicitly NOT pure: it reads
// getEffectiveSandboxProxyUrl() for the proxy host. We name it Build* rather
// than calling it Target/Get to acknowledge the env-var read; see spec D8.

import { getEffectiveSandboxProxyUrl } from '../../config/env-profiles.js';
import {
  assertNever,
  INSTAGRAM_GRAPH_VERSION,
  type SandboxSession,
} from '../../api/sandbox-session.js';

/**
 * Display identifier for a session. WhatsApp: +<phone>. Instagram: @<handle>,
 * falling back to IGSID when the username is null (backend backfills async).
 */
export function sessionIdentifier(s: SandboxSession): string {
  switch (s.type) {
    case 'whatsapp':
      return `+${s.whatsappPhone.replace(/^\+/, '')}`;
    case 'instagram':
      return s.instagramSenderUsername
        ? `@${s.instagramSenderUsername}`
        : s.instagramSenderId;
    default:
      return assertNever(s, 'sessionIdentifier');
  }
}

/**
 * Picker-row label: "WhatsApp +15551234567 (active)" / "Instagram @ordvir (active)".
 * Used by the unified picker's interactive select prompt + status table.
 */
export function sessionLabel(s: SandboxSession): string {
  switch (s.type) {
    case 'whatsapp':
      return `WhatsApp ${sessionIdentifier(s)} (${s.status})`;
    case 'instagram':
      return `Instagram ${sessionIdentifier(s)} (${s.status})`;
    default:
      return assertNever(s, 'sessionLabel');
  }
}

/**
 * Build the HTTP send request (URL + body) for `sandbox send`. Reads the
 * effective proxy URL via getEffectiveSandboxProxyUrl() — env-var lookup —
 * which is why this helper is not pure.
 *
 * WA:  POST {proxy}/{whatsappApiVersion}/{sandboxPhoneNumberId}/messages
 *      with { messaging_product:'whatsapp', to, type:'text', text:{body} }
 * IG:  POST {proxy}/{INSTAGRAM_GRAPH_VERSION}/{instagramAccountId}/messages
 *      with { recipient:{id:instagramSenderId}, message:{text} }
 */
export function buildSandboxSendRequest(
  s: SandboxSession,
  message: string,
): { url: string; body: unknown } {
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  switch (s.type) {
    case 'whatsapp': {
      const to = s.whatsappPhone.replace(/^\+/, '');
      return {
        url: `${proxyBase}/${s.whatsappApiVersion}/${s.sandboxPhoneNumberId}/messages`,
        body: {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message },
        },
      };
    }
    case 'instagram':
      return {
        url: `${proxyBase}/${INSTAGRAM_GRAPH_VERSION}/${s.instagramAccountId}/messages`,
        body: {
          recipient: { id: s.instagramSenderId },
          message: { text: message },
        },
      };
    default:
      return assertNever(s, 'buildSandboxSendRequest');
  }
}
