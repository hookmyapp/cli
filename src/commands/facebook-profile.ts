import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';

const PAGE_FIELDS = 'id,name,category,followers_count,link,picture{url}';

export async function runFacebookProfile(opts: { channel?: string }, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({ channel, method: 'GET', path: `/{page_id}?fields=${encodeURIComponent(PAGE_FIELDS)}` });
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }
  process.stdout.write(`Page: ${res?.name ?? '(unnamed)'} (${res?.id ?? channel.metaResourceId})\n`);
  process.stdout.write(`Category: ${res?.category ?? '(none)'}\n`);
  process.stdout.write(`Followers: ${res?.followers_count ?? '(unknown)'}\n`);
  process.stdout.write(`Link: ${res?.link ?? '(none)'}\n`);
}

/** Registers `facebook profile`. */
export function registerFacebookProfile(facebook: Command): void {
  const profile = facebook
    .command('profile')
    .description('Read the Page profile: name, category, followers, link, picture')
    .option('--channel <ref>', 'Channel: Page name or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .action(async function (this: Command, opts: { channel?: string }) {
      await runFacebookProfile(opts, this);
    });

  addExamples(
    profile,
    `
EXAMPLES:
  $ hookmyapp facebook profile --channel ch_XXXXXXXX
  $ hookmyapp facebook profile --channel ch_XXXXXXXX --json
`,
  );
}
