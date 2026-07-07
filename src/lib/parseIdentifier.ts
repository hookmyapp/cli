import { ValidationError } from '../output/error.js';

export type IdentifierKind = 'phone' | 'username' | 'sessionId' | 'channelId';

export interface ParsedIdentifier {
  kind: IdentifierKind;
  /**
   * Normalized value — for `phone` this is digits-only (no leading +);
   * for `username` this is the handle without leading @; for `sessionId`
   * and `channelId` this is the full publicId including prefix.
   */
  value: string;
}

const PHONE_RE = /^\+?\d{7,15}$/;
const USERNAME_RE = /^@[A-Za-z0-9._]{1,32}$/;
const SESSION_ID_RE = /^ssn_[A-Za-z0-9]{8}$/;
const CHANNEL_ID_RE = /^ch_[A-Za-z0-9]{8}$/;
const BARE_LETTERS_RE = /^[A-Za-z0-9._]{2,32}$/;

/**
 * Shape-detect an identifier supplied as a CLI positional argument.
 *
 * Recognized shapes (D3 of the channels-IG spec):
 *   phone          → phone (WA), with or without leading +
 *   @handle        → username (IG)
 *   ssn_XXXXXXXX   → sandbox session publicId
 *   ch_XXXXXXXX    → channel publicId
 *
 * Bare letters trigger sharp suggestions; everything else
 * throws ValidationError with the full recognized-shape list.
 */
export function parseIdentifier(raw: string): ParsedIdentifier {
  if (!raw || raw.length === 0) {
    throw new ValidationError(
      'Identifier is required. Provide a phone number, @username, ssn_XXXXXXXX, or ch_XXXXXXXX.',
      'IDENTIFIER_REQUIRED',
    );
  }
  if (PHONE_RE.test(raw)) {
    return { kind: 'phone', value: raw.replace(/^\+/, '') };
  }
  if (USERNAME_RE.test(raw)) {
    return { kind: 'username', value: raw.slice(1) };
  }
  if (SESSION_ID_RE.test(raw)) {
    return { kind: 'sessionId', value: raw };
  }
  if (CHANNEL_ID_RE.test(raw)) {
    return { kind: 'channelId', value: raw };
  }
  if (BARE_LETTERS_RE.test(raw)) {
    throw new ValidationError(
      `"${raw}" is not a recognized identifier shape. Did you mean @${raw} (Instagram handle)?`,
      'IDENTIFIER_UNRECOGNIZED_SHAPE',
    );
  }
  throw new ValidationError(
    `"${raw}" is not a recognized identifier shape. Use one of: <phone>, @<username>, ssn_XXXXXXXX, ch_XXXXXXXX.`,
    'IDENTIFIER_UNRECOGNIZED_SHAPE',
  );
}
