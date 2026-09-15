import { ValidationError } from '../output/error.js';

// One grammar per Facebook object kind, mirroring the backend's
// `assertFbObjectId`: posts are `{pageId}_{postId}`, a comment is
// `{postId}_{commentId}` or the bare numeric id, a Messenger thread is `t_…`,
// a person is a numeric PSID. Anything else could smuggle a path segment.
const GRAMMAR = {
  post: /^\d+_\d+$/,
  comment: /^\d+(_\d+)?$/,
  conversation: /^t_[\w.-]+$/,
  psid: /^\d+$/,
} as const;

export function assertFbId(id: string | undefined, kind: keyof typeof GRAMMAR, flag: string): string {
  if (!id) throw new ValidationError(`${flag} is required.`, 'MISSING_' + kind.toUpperCase());
  if (!GRAMMAR[kind].test(id)) {
    throw new ValidationError(`${flag} is not a valid Facebook ${kind} id (got: ${id}).`, 'BAD_FB_ID');
  }
  return id;
}

/** Bare GET/DELETE on a composite id is refused upstream; those shapes take the numeric comment id. */
export function numericCommentId(id: string): string {
  return id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
}

export function pageSize(limit?: string): string {
  if (limit === undefined) return '25';
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`--limit must be a whole number of 1 or more (got: ${limit}).`, 'BAD_LIMIT');
  }
  return String(Math.min(n, 100));
}

const CURSOR_RE = /^[A-Za-z0-9_=-]+$/;
export function assertCursor(after?: string): string | undefined {
  if (after !== undefined && !CURSOR_RE.test(after)) {
    throw new ValidationError(`--after is not in the expected format (got: ${after}).`, 'BAD_CURSOR');
  }
  return after;
}
