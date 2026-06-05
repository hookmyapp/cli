import { ValidationError } from '../output/error.js';

/** Read a --body value: inline JSON | @file | '-' (stdin). Returns the parsed object.
 *  Note: '-' reads stdin to EOF — intended for piped input (`… --body -` with a heredoc
 *  or a pipe). Run interactively without piped input it will block on stdin (expected). */
export async function readBodyFlag(body: string): Promise<unknown> {
  let raw = body;
  if (body === '-') {
    raw = await new Promise<string>((res, rej) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => res(buf));
      process.stdin.on('error', rej);
    });
  } else if (body.startsWith('@')) {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(body.slice(1), 'utf8');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('--body is not valid JSON.', 'BAD_BODY_JSON');
  }
}

/** Enforce D2 mutual-exclusivity: exactly one of (builder flags) or --body.
 *  Generic message — this helper is shared across send and profile update. */
export function assertBodyXorFlags(hasBuilderFlags: boolean, hasBody: boolean): void {
  if (hasBuilderFlags && hasBody)
    throw new ValidationError('Use either the builder flags or --body, not both.', 'BODY_AND_FLAGS');
  if (!hasBuilderFlags && !hasBody)
    throw new ValidationError('Provide either builder flags or --body.', 'NO_PAYLOAD');
}
