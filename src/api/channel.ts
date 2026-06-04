import { UnexpectedError } from '../output/error.js';

interface ChannelBase {
  id: string;
  workspaceId: string;
  /**
   * Phase A backend cleanup: WhatsApp channels carry the WABA id; Instagram &
   * Messenger emit `null`. Older backends emitted `''` for non-WA; consumers
   * still treat empty-string as "no WABA".
   */
  metaWabaId: string | null;
  metaResourceId: string;
  connectionType: string | null;
  metaConnected: boolean;
  forwardingEnabled: boolean;
  webhookUrl: string | null;
  verifyToken: string | null;
  /**
   * ISO timestamp. Drives `channels connect` re-auth detection: the poll
   * snapshots {id -> updatedAt} pre-OAuth and treats an existing id whose
   * updatedAt advanced as "interesting" alongside truly-new ids. Absent on
   * older backends — poll falls back to id-diff only.
   */
  updatedAt?: string;
  /**
   * Meta-connection publicId (`conn_<8>`). Surfaced by Plan 1 backend DTOs so
   * the CLI can build the gateway API-key path `/api-keys/connections/:connId`.
   * Absent on older backends / channels with no Meta connection yet.
   */
  connectionPublicId?: string;
}

export interface WhatsAppChannel extends ChannelBase {
  type: 'whatsapp';
  wabaName: string | null;
  displayPhoneNumber: string | null;
  phoneNumberId: string | null;
  /**
   * Phone-number-verified sender display name. Independent of `wabaName`:
   * the WABA may carry the parent business name while phoneVerifiedName
   * is the customer-facing sender display. Backends < restore-commit may
   * still emit this absent; parser tolerates that.
   */
  phoneVerifiedName: string | null;
  qualityRating: string | null;
}

export interface InstagramChannel extends ChannelBase {
  type: 'instagram';
  instagramUsername: string | null;
  instagramName: string | null;
  instagramProfilePictureUrl: string | null;
}

export interface MessengerChannel extends ChannelBase {
  type: 'messenger';
}

export type Channel = WhatsAppChannel | InstagramChannel | MessengerChannel;

/** Detail-only fields returned by GET /meta/channels/:id (not on list endpoint). */
interface DetailExtras {
  accessToken?: string;
  businessName?: string;
  metaBusinessId?: string;
}

export type ChannelDetail = Channel & DetailExtras;

function malformed(id: string, reason: string): never {
  throw new UnexpectedError(
    `[MALFORMED_CHANNEL] Backend returned malformed channel ${id}: ${reason}. ` +
      `Report at https://github.com/hookmyapp/cli/issues`,
    'MALFORMED_CHANNEL',
  );
}

function isStringOrNull(v: unknown): v is string | null {
  return typeof v === 'string' || v === null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function parseBase(d: Record<string, unknown>, id: string): ChannelBase {
  if (!isNonEmptyString(d.id)) malformed(id, 'id missing');
  if (!isNonEmptyString(d.workspaceId)) malformed(id, 'workspaceId missing');
  if (!isStringOrNull(d.metaWabaId)) malformed(id, 'metaWabaId must be string or null');
  if (!isNonEmptyString(d.metaResourceId)) malformed(id, 'metaResourceId missing');
  if (typeof d.connectionType !== 'string' && d.connectionType !== null)
    malformed(id, 'connectionType must be string or null');
  if (typeof d.metaConnected !== 'boolean') malformed(id, 'metaConnected must be a boolean');
  if (typeof d.forwardingEnabled !== 'boolean')
    malformed(id, 'forwardingEnabled must be a boolean');
  if (!isStringOrNull(d.webhookUrl)) malformed(id, 'webhookUrl must be string or null');
  if (!isStringOrNull(d.verifyToken)) malformed(id, 'verifyToken must be string or null');
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    metaWabaId: d.metaWabaId,
    metaResourceId: d.metaResourceId,
    connectionType: d.connectionType,
    metaConnected: d.metaConnected,
    forwardingEnabled: d.forwardingEnabled,
    webhookUrl: d.webhookUrl,
    verifyToken: d.verifyToken,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : undefined,
    connectionPublicId: typeof d.connectionPublicId === 'string' ? d.connectionPublicId : undefined,
  };
}

export function parseChannelListItem(dto: unknown): Channel {
  if (typeof dto !== 'object' || dto === null) {
    throw new UnexpectedError(
      `[MALFORMED_CHANNEL] Backend returned malformed channel: expected an object, got ${typeof dto}.`,
      'MALFORMED_CHANNEL',
    );
  }
  const d = dto as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id : '<unknown>';
  const base = parseBase(d, id);
  if (!isNonEmptyString(d.type)) malformed(id, 'type missing');
  switch (d.type) {
    case 'whatsapp': {
      if (!isStringOrNull(d.wabaName)) malformed(id, 'WA channel: wabaName must be string or null');
      if (!isStringOrNull(d.displayPhoneNumber))
        malformed(id, 'WA channel: displayPhoneNumber must be string or null');
      if (!isStringOrNull(d.phoneNumberId))
        malformed(id, 'WA channel: phoneNumberId must be string or null');
      // Tolerate absent phoneVerifiedName for backends predating the restore
      // commit — they simply omit the key. When present, must be string or null.
      if (d.phoneVerifiedName !== undefined && !isStringOrNull(d.phoneVerifiedName))
        malformed(id, 'WA channel: phoneVerifiedName must be string or null');
      if (!isStringOrNull(d.qualityRating))
        malformed(id, 'WA channel: qualityRating must be string or null');
      return {
        ...base,
        type: 'whatsapp',
        wabaName: d.wabaName,
        displayPhoneNumber: d.displayPhoneNumber,
        phoneNumberId: d.phoneNumberId,
        phoneVerifiedName:
          d.phoneVerifiedName === undefined ? null : (d.phoneVerifiedName as string | null),
        qualityRating: d.qualityRating,
      };
    }
    case 'instagram': {
      if (!isStringOrNull(d.instagramUsername))
        malformed(id, 'IG channel: instagramUsername must be string or null');
      if (!isStringOrNull(d.instagramName))
        malformed(id, 'IG channel: instagramName must be string or null');
      if (!isStringOrNull(d.instagramProfilePictureUrl))
        malformed(id, 'IG channel: instagramProfilePictureUrl must be string or null');
      return {
        ...base,
        type: 'instagram',
        instagramUsername: d.instagramUsername,
        instagramName: d.instagramName,
        instagramProfilePictureUrl: d.instagramProfilePictureUrl,
      };
    }
    case 'messenger': {
      return { ...base, type: 'messenger' };
    }
    default:
      malformed(id, `unknown type "${d.type}"`);
  }
}

export function parseChannelDetail(dto: unknown): ChannelDetail {
  const base = parseChannelListItem(dto);
  if (typeof dto !== 'object' || dto === null) return base; // already threw above
  const d = dto as Record<string, unknown>;
  return {
    ...base,
    accessToken: typeof d.accessToken === 'string' ? d.accessToken : undefined,
    businessName: typeof d.businessName === 'string' ? d.businessName : undefined,
    metaBusinessId: typeof d.metaBusinessId === 'string' ? d.metaBusinessId : undefined,
  };
}

/** Parse an array response from GET /meta/channels (or anywhere that returns Channel[]). */
export function parseChannels(dtos: unknown[]): Channel[] {
  return dtos.map(parseChannelListItem);
}
