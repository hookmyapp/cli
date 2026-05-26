// Wire boundary for /sandbox/sessions* responses. Parses untrusted JSON into
// a discriminated union (WhatsApp | Instagram). Every CLI sandbox subcommand
// + the login wizard + sandbox-listen route their wire fetches through this
// parser; the `as SandboxSession[]` casts that used to live at sandbox.ts:96,
// sandbox.ts:145, auth/login.ts:383, and sandbox-listen/index.ts:323 are
// deleted in this release.
//
// Per spec D7: shared base fields validated on every session except
// workspaceId (stripped from list responses by the backend per
// sandbox.service.ts:72-83). sandboxPhoneNumberId + whatsappApiVersion are
// required on WA variant only — IG consumers never read them and requiring
// them on IG rows would couple Instagram to WhatsApp sandbox config.
//
// Per spec D2: INSTAGRAM_GRAPH_VERSION is a single constant — bumping IG's
// Graph API version is a one-line change here, imported by both buildEnvBlock
// and buildSandboxSendRequest.

import { UnexpectedError } from '../output/error.js';

export const INSTAGRAM_GRAPH_VERSION = 'v25.0';

interface SandboxSessionBase {
  id: string;
  accessToken: string;
  hmacSecret: string;
  status: 'pending_activation' | 'active' | 'replaced' | 'expired';
  origin: string;
  // Optional fields tolerated when present (not required for parser success):
  workspaceId?: string;
  workspaceName?: string | null;
  webhookUrl?: string | null;
  hostname?: string | null;
  lastHeartbeatAt?: string | null;
  cloudflareTunnelId?: string | null;
  cloudflareTunnelToken?: string | null;
  activatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  // Legacy field still present on some wire rows; not consumed by the new helpers.
  phone?: string | null;
}

export interface WhatsAppSandboxSession extends SandboxSessionBase {
  type: 'whatsapp';
  whatsappPhone: string;
  whatsappPhoneNumberId: string;
  sandboxPhoneNumberId: string;
  whatsappApiVersion: string;
  // Channel-specific narrow: never populated on WA rows.
  instagramSenderId?: null;
  instagramAccountId?: null;
  instagramSenderUsername?: null;
}

export interface InstagramSandboxSession extends SandboxSessionBase {
  type: 'instagram';
  instagramSenderId: string;
  instagramAccountId: string;
  instagramSenderUsername: string | null;
  // Channel-specific narrow: never populated on IG rows.
  whatsappPhone?: null;
  whatsappPhoneNumberId?: null;
}

export type SandboxSession = WhatsAppSandboxSession | InstagramSandboxSession;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function malformed(id: string, reason: string): never {
  throw new UnexpectedError(
    `Backend returned malformed sandbox session ${id}: ${reason}. ` +
      `Report at https://github.com/hookmyapp/cli/issues`,
    'MALFORMED_SANDBOX_SESSION',
  );
}

export function parseSandboxSession(dto: unknown): SandboxSession {
  if (typeof dto !== 'object' || dto === null) {
    throw new UnexpectedError(
      `Backend returned malformed sandbox session: expected an object, got ${typeof dto}. ` +
        `Report at https://github.com/hookmyapp/cli/issues`,
      'MALFORMED_SANDBOX_SESSION',
    );
  }
  const d = dto as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id : '<unknown>';

  if (!isNonEmptyString(d.id)) malformed(id, 'id missing');
  if (!isNonEmptyString(d.accessToken)) malformed(id, 'accessToken missing');
  if (!isNonEmptyString(d.hmacSecret)) malformed(id, 'hmacSecret missing');
  if (!isNonEmptyString(d.status)) malformed(id, 'status missing');
  // Validate status against the closed union declared on SandboxSessionBase.
  // A typo like 'pending_activision' would otherwise pass through and lie to
  // every downstream `switch (status)`.
  const ALLOWED_STATUS = ['pending_activation', 'active', 'replaced', 'expired'] as const;
  if (!ALLOWED_STATUS.includes(d.status as (typeof ALLOWED_STATUS)[number])) {
    malformed(id, `status must be one of ${ALLOWED_STATUS.join('|')}, got "${d.status}"`);
  }
  if (!isNonEmptyString(d.origin)) malformed(id, 'origin missing');

  if (d.type === 'whatsapp') {
    if (!isNonEmptyString(d.whatsappPhone))
      malformed(id, 'WhatsApp session missing whatsappPhone');
    if (!isNonEmptyString(d.whatsappPhoneNumberId))
      malformed(id, 'WhatsApp session missing whatsappPhoneNumberId');
    if (!isNonEmptyString(d.sandboxPhoneNumberId))
      malformed(id, 'WhatsApp session missing sandboxPhoneNumberId');
    if (!isNonEmptyString(d.whatsappApiVersion))
      malformed(id, 'WhatsApp session missing whatsappApiVersion');
    return d as unknown as WhatsAppSandboxSession;
  }

  if (d.type === 'instagram') {
    if (!isNonEmptyString(d.instagramSenderId))
      malformed(id, 'Instagram session missing instagramSenderId');
    if (!isNonEmptyString(d.instagramAccountId))
      malformed(id, 'Instagram session missing instagramAccountId');
    // instagramSenderUsername may be null (backend backfills async).
    if (
      d.instagramSenderUsername !== null &&
      d.instagramSenderUsername !== undefined &&
      typeof d.instagramSenderUsername !== 'string'
    )
      malformed(id, 'instagramSenderUsername must be string or null');
    return d as unknown as InstagramSandboxSession;
  }

  throw new UnexpectedError(
    `Backend returned malformed sandbox session ${id}: unknown type "${String(
      d.type,
    )}". Report at https://github.com/hookmyapp/cli/issues`,
    'MALFORMED_SANDBOX_SESSION',
  );
}

export function parseSandboxSessions(dto: unknown): SandboxSession[] {
  if (!Array.isArray(dto)) {
    throw new UnexpectedError(
      `Backend returned malformed sandbox sessions list: expected array, got ${typeof dto}. ` +
        `Report at https://github.com/hookmyapp/cli/issues`,
      'MALFORMED_SANDBOX_SESSION',
    );
  }
  return dto.map(parseSandboxSession);
}

// Exhaustiveness helper. Switching on session.type and passing the default
// branch through assertNever() catches missing channels at compile time when
// a third variant joins the union. The runtime throw is defense-in-depth.
export function assertNever(value: never, ctx: string): never {
  throw new UnexpectedError(
    `Unsupported sandbox session variant in ${ctx}: ${String(value)}`,
    'UNSUPPORTED_SESSION_VARIANT',
  );
}
