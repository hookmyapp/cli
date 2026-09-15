import { UnexpectedError } from '../output/error.js';

interface ChannelBase {
  id: string;
  workspaceId: string;
  /**
   * Phase A backend cleanup: WhatsApp channels carry the WABA id; Instagram &
   * Facebook emit `null`. Older backends emitted `''` for non-WA; consumers
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
}

export interface WhatsAppChannel extends ChannelBase {
  type: 'whatsapp';
  whatsappWabaName: string | null;
  whatsappDisplayPhoneNumber: string | null;
  whatsappPhoneNumberId: string | null;
  /**
   * Phone-number-verified sender display name. Independent of `whatsappWabaName`:
   * the WABA may carry the parent business name while whatsappVerifiedName
   * is the customer-facing sender display. Backends < restore-commit may
   * still emit this absent; parser tolerates that.
   */
  whatsappVerifiedName: string | null;
  whatsappQualityRating: string | null;
  /**
   * Signed gateway /media URL for the phone number's profile picture (the
   * backend never puts the raw provider CDN URL on the wire). Absent on
   * older backends — parser normalizes to null.
   */
  whatsappProfilePictureUrl: string | null;
}

export interface InstagramChannel extends ChannelBase {
  type: 'instagram';
  instagramUsername: string | null;
  instagramProfileName: string | null;
  instagramProfilePictureUrl: string | null;
  /** The Facebook Page an account connected through a Page is linked to; null otherwise. */
  metaPageId: string | null;
}

/**
 * A Facebook Page (Messenger DMs, Page posts, comments, insights). Older
 * backends emitted this row as `type: 'messenger'`; the parser maps that alias
 * here with null Page fields.
 */
export interface FacebookChannel extends ChannelBase {
  type: 'facebook';
  facebookPageName: string | null;
  facebookPagePictureUrl: string | null;
}

export type Channel = WhatsAppChannel | InstagramChannel | FacebookChannel;

/** Detail-only fields returned by GET /meta/channels/:id (not on list endpoint). */
interface DetailExtras {
  whatsappBusinessName?: string;
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
      if (!isStringOrNull(d.whatsappWabaName))
        malformed(id, 'WA channel: whatsappWabaName must be string or null');
      if (!isStringOrNull(d.whatsappDisplayPhoneNumber))
        malformed(id, 'WA channel: whatsappDisplayPhoneNumber must be string or null');
      if (!isStringOrNull(d.whatsappPhoneNumberId))
        malformed(id, 'WA channel: whatsappPhoneNumberId must be string or null');
      // Tolerate absent whatsappVerifiedName for backends predating the restore
      // commit — they simply omit the key. When present, must be string or null.
      if (d.whatsappVerifiedName !== undefined && !isStringOrNull(d.whatsappVerifiedName))
        malformed(id, 'WA channel: whatsappVerifiedName must be string or null');
      if (!isStringOrNull(d.whatsappQualityRating))
        malformed(id, 'WA channel: whatsappQualityRating must be string or null');
      // Tolerate absent whatsappProfilePictureUrl (older backends omit it).
      if (d.whatsappProfilePictureUrl !== undefined && !isStringOrNull(d.whatsappProfilePictureUrl))
        malformed(id, 'WA channel: whatsappProfilePictureUrl must be string or null');
      return {
        ...base,
        type: 'whatsapp',
        whatsappWabaName: d.whatsappWabaName,
        whatsappDisplayPhoneNumber: d.whatsappDisplayPhoneNumber,
        whatsappPhoneNumberId: d.whatsappPhoneNumberId,
        whatsappVerifiedName:
          d.whatsappVerifiedName === undefined ? null : (d.whatsappVerifiedName as string | null),
        whatsappQualityRating: d.whatsappQualityRating,
        whatsappProfilePictureUrl:
          d.whatsappProfilePictureUrl === undefined
            ? null
            : (d.whatsappProfilePictureUrl as string | null),
      };
    }
    case 'instagram': {
      if (!isStringOrNull(d.instagramUsername))
        malformed(id, 'IG channel: instagramUsername must be string or null');
      if (!isStringOrNull(d.instagramProfileName))
        malformed(id, 'IG channel: instagramProfileName must be string or null');
      if (!isStringOrNull(d.instagramProfilePictureUrl))
        malformed(id, 'IG channel: instagramProfilePictureUrl must be string or null');
      // Tolerate absent metaPageId (backends predating the Facebook channel omit it).
      if (d.metaPageId !== undefined && !isStringOrNull(d.metaPageId))
        malformed(id, 'IG channel: metaPageId must be string or null');
      return {
        ...base,
        type: 'instagram',
        instagramUsername: d.instagramUsername,
        instagramProfileName: d.instagramProfileName,
        instagramProfilePictureUrl: d.instagramProfilePictureUrl,
        metaPageId: typeof d.metaPageId === 'string' ? d.metaPageId : null,
      };
    }
    case 'facebook':
    case 'messenger': {
      if (d.facebookPageName !== undefined && !isStringOrNull(d.facebookPageName))
        malformed(id, 'FB channel: facebookPageName must be string or null');
      if (d.facebookPagePictureUrl !== undefined && !isStringOrNull(d.facebookPagePictureUrl))
        malformed(id, 'FB channel: facebookPagePictureUrl must be string or null');
      return {
        ...base,
        type: 'facebook',
        facebookPageName: (d.facebookPageName as string | null | undefined) ?? null,
        facebookPagePictureUrl: (d.facebookPagePictureUrl as string | null | undefined) ?? null,
      };
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
    whatsappBusinessName:
      typeof d.whatsappBusinessName === 'string' ? d.whatsappBusinessName : undefined,
    metaBusinessId: typeof d.metaBusinessId === 'string' ? d.metaBusinessId : undefined,
  };
}

/** Parse an array response from GET /meta/channels (or anywhere that returns Channel[]). */
export function parseChannels(dtos: unknown[]): Channel[] {
  return dtos.map(parseChannelListItem);
}
