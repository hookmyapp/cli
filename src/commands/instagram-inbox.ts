import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

// Thread and participant ids are Meta's opaque keys, not numeric Graph ids, so
// the numeric guard used for media would reject every real one. Constrain to the
// unreserved URL alphabet instead — enough to stop a smuggled path segment.
const IG_OPAQUE_ID_RE = /^[A-Za-z0-9_-]+$/;
const CONVERSATION_FIELDS = 'id,updated_time,participants,unread_count';
const MESSAGE_FIELDS = 'id,message,from,to,created_time,reply_to';
const PARTICIPANT_FIELDS = 'id,name,username,profile_pic';

function assertOpaqueId(id: string, flag: string): void {
  if (!IG_OPAQUE_ID_RE.test(id)) {
    throw new ValidationError(`${flag} is not in the expected format (got: ${id}).`, 'BAD_THREAD_ID');
  }
}

function pageSize(limit?: string): string {
  if (limit === undefined) return '25';
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`--limit must be a whole number of 1 or more (got: ${limit}).`, 'BAD_LIMIT');
  }
  return String(Math.min(n, 100));
}

export interface IgThreadsOpts {
  channel?: string;
  thread?: string;
  participant?: string;
  limit?: string;
  after?: string;
}

export async function runInstagramThreads(opts: IgThreadsOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const json = Boolean(cmd && isJsonMode(cmd));

  if (opts.participant) {
    assertOpaqueId(opts.participant, '--participant');
    const person = await gatewayRequest({
      channel,
      method: 'GET',
      path: `/${opts.participant}?fields=${encodeURIComponent(PARTICIPANT_FIELDS)}`,
    });
    process.stdout.write((json ? JSON.stringify(person) : JSON.stringify(person, null, 2)) + '\n');
    return;
  }

  if (opts.thread) {
    assertOpaqueId(opts.thread, '--thread');
    const params = new URLSearchParams({
      fields: MESSAGE_FIELDS,
      limit: pageSize(opts.limit),
      ...(opts.after ? { after: opts.after } : {}),
    });
    const res = await gatewayRequest({
      channel, method: 'GET', path: `/${opts.thread}/messages?${params.toString()}`,
    });
    const rows = (res?.data ?? []) as Array<Record<string, unknown>>;
    if (json) {
      process.stdout.write(
        JSON.stringify({ messages: rows, nextCursor: res?.paging?.cursors?.after ?? null }) + '\n',
      );
      return;
    }
    for (const row of rows) {
      const who = (row.from as { username?: string } | undefined)?.username ?? '';
      const text = typeof row.message === 'string' ? row.message.replace(/\s+/g, ' ').slice(0, 70) : '';
      process.stdout.write(`${String(row.created_time ?? '')}\t@${who}\t${text}\n`);
    }
    if (rows.length === 0) process.stdout.write('No messages in this thread.\n');
    return;
  }

  // `platform` matters on an account linked to a Page — without it the edge can
  // answer with the Messenger inbox instead.
  const params = new URLSearchParams({
    fields: CONVERSATION_FIELDS,
    platform: 'instagram',
    limit: pageSize(opts.limit),
    ...(opts.after ? { after: opts.after } : {}),
  });
  const res = await gatewayRequest({ channel, method: 'GET', path: `/{ig_id}/conversations?${params.toString()}` });
  const rows = (res?.data ?? []) as Array<Record<string, unknown>>;

  if (json) {
    process.stdout.write(
      JSON.stringify({ conversations: rows, nextCursor: res?.paging?.cursors?.after ?? null }) + '\n',
    );
    return;
  }
  for (const row of rows) {
    const people = ((row.participants as { data?: Array<{ username?: string }> } | undefined)?.data ?? [])
      .map((p) => `@${p.username ?? ''}`)
      .join(',');
    process.stdout.write(`${String(row.id ?? '')}\t${String(row.updated_time ?? '')}\t${people}\n`);
  }
  if (rows.length === 0) process.stdout.write('No conversations found.\n');
  const next = res?.paging?.cursors?.after;
  if (next) process.stdout.write(`More: --after ${next}\n`);
}

/** Registers `instagram threads`. */
export function registerInstagramInbox(instagram: Command): void {
  const threads = instagram
    .command('threads')
    .description('List DM threads, read one thread, or look up who you are talking to')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--thread <id>', 'Read the messages in this thread')
    .option('--participant <igsid>', 'Read that person’s public profile')
    .option('--limit <n>', 'Page size, 1-100 (default 25)')
    .option('--after <cursor>', 'Continue from a previous page')
    .action(async function (this: Command, opts: IgThreadsOpts) {
      await runInstagramThreads(opts, this);
    });

  addExamples(
    threads,
    `
EXAMPLES:
  $ hookmyapp instagram threads --channel @acme
  $ hookmyapp instagram threads --channel @acme --thread <thread-id>
  $ hookmyapp instagram threads --channel @acme --participant <igsid> --json
`,
  );
}
