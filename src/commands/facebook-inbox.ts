import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { assertCursor, assertFbId, pageSize } from './facebook-ids.js';

const CONVERSATION_FIELDS = 'id,participants,updated_time,unread_count,snippet';
const MESSAGE_FIELDS = 'id,message,from,to,created_time';

export interface FbThreadsOpts {
  channel?: string;
  thread?: string;
  limit?: string;
  after?: string;
}

export async function runFacebookThreads(opts: FbThreadsOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const json = Boolean(cmd && isJsonMode(cmd));
  const after = assertCursor(opts.after);

  if (opts.thread) {
    const thread = assertFbId(opts.thread, 'conversation', '--thread');
    // Messages ride as a field expansion on the thread node; paging modifiers
    // go inside the expansion so the cursor pages the messages, not the thread.
    const mods = `.limit(${pageSize(opts.limit)})${after ? `.after(${after})` : ''}`;
    const params = new URLSearchParams({ fields: `messages${mods}{${MESSAGE_FIELDS}}` });
    const res = await gatewayRequest({ channel, method: 'GET', path: `/${thread}?${params.toString()}` });
    const rows = (res?.messages?.data ?? []) as Array<Record<string, unknown>>;
    const next = res?.messages?.paging?.cursors?.after ?? null;
    if (json) {
      process.stdout.write(JSON.stringify({ messages: rows, nextCursor: next }) + '\n');
      return;
    }
    for (const row of rows) {
      const who = (row.from as { name?: string; id?: string } | undefined)?.name ?? (row.from as { id?: string } | undefined)?.id ?? '';
      const text = typeof row.message === 'string' ? row.message.replace(/\s+/g, ' ').slice(0, 70) : '';
      process.stdout.write(`${String(row.created_time ?? '')}\t${who}\t${text}\n`);
    }
    if (rows.length === 0) process.stdout.write('No messages in this thread.\n');
    if (next) process.stdout.write(`More: --after ${next}\n`);
    return;
  }

  const params = new URLSearchParams({
    platform: 'messenger',
    fields: CONVERSATION_FIELDS,
    limit: pageSize(opts.limit),
    ...(after ? { after } : {}),
  });
  const res = await gatewayRequest({ channel, method: 'GET', path: `/{page_id}/conversations?${params.toString()}` });
  const rows = (res?.data ?? []) as Array<Record<string, unknown>>;
  const next = res?.paging?.cursors?.after ?? null;
  if (json) {
    process.stdout.write(JSON.stringify({ conversations: rows, nextCursor: next }) + '\n');
    return;
  }
  for (const row of rows) {
    const people = ((row.participants as { data?: Array<{ name?: string; id?: string }> } | undefined)?.data ?? [])
      .filter((p) => p.id !== channel.metaResourceId)
      .map((p) => p.name ?? p.id ?? '')
      .join(',');
    const snippet = typeof row.snippet === 'string' ? row.snippet.replace(/\s+/g, ' ').slice(0, 50) : '';
    process.stdout.write(`${String(row.id ?? '')}\t${String(row.updated_time ?? '')}\t${people}\t${snippet}\n`);
  }
  if (rows.length === 0) process.stdout.write('No conversations found.\n');
  if (next) process.stdout.write(`More: --after ${next}\n`);
}

/** Registers `facebook threads`. */
export function registerFacebookInbox(facebook: Command): void {
  const threads = facebook
    .command('threads')
    .description('List Messenger threads or read one thread')
    .option('--channel <ref>', 'Channel: ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--thread <id>', 'Read the messages in this thread (t_…)')
    .option('--limit <n>', 'Page size, 1-100 (default 25)')
    .option('--after <cursor>', 'Continue from a previous page')
    .action(async function (this: Command, opts: FbThreadsOpts) {
      await runFacebookThreads(opts, this);
    });

  addExamples(
    threads,
    `
EXAMPLES:
  $ hookmyapp facebook threads --channel ch_XXXXXXXX
  $ hookmyapp facebook threads --channel ch_XXXXXXXX --thread t_123456 --json
`,
  );
}
