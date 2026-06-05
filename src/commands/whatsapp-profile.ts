import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { readBodyFlag, assertBodyXorFlags } from './whatsapp.js';

const DEFAULT_FIELDS = 'about,address,description,email,profile_picture_url,websites,vertical';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export interface WaProfileGetOpts {
  channel?: string;
  fields?: string;
}

export async function runWhatsappProfileGet(opts: WaProfileGetOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const qs = new URLSearchParams({ fields });
  const res = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/{phone_number_id}/whatsapp_business_profile?${qs.toString()}`,
  });
  process.stdout.write(JSON.stringify(res, null, cmd && isJsonMode(cmd) ? 0 : 2) + '\n');
}

export interface WaProfileUpdateOpts {
  channel?: string;
  about?: string;
  description?: string;
  address?: string;
  email?: string;
  vertical?: string;
  website?: string[];
  body?: string;
  data?: string;
}

export async function runWhatsappProfileUpdate(opts: WaProfileUpdateOpts, cmd?: Command): Promise<void> {
  const bodyRaw = opts.body ?? opts.data; // -d/--data alias of --body (D2)
  const websites = opts.website ?? [];
  const hasBuilderFlags = Boolean(
    opts.about || opts.description || opts.address || opts.email || opts.vertical || websites.length > 0,
  );
  assertBodyXorFlags(hasBuilderFlags, Boolean(bodyRaw));

  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');

  let body: unknown;
  if (bodyRaw) {
    body = await readBodyFlag(bodyRaw);
  } else {
    if (websites.length > 2) {
      throw new ValidationError('WhatsApp business profile allows at most 2 websites.', 'TOO_MANY_WEBSITES');
    }
    const fields: Record<string, unknown> = { messaging_product: 'whatsapp' };
    if (opts.about) fields.about = opts.about;
    if (opts.description) fields.description = opts.description;
    if (opts.address) fields.address = opts.address;
    if (opts.email) fields.email = opts.email;
    if (opts.vertical) fields.vertical = opts.vertical;
    if (websites.length > 0) fields.websites = websites;
    body = fields;
  }

  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: `/{phone_number_id}/whatsapp_business_profile`,
    body,
  });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Profile updated.') + '\n');
}

/** Registers `whatsapp profile get|update`. */
export function registerWhatsappProfile(whatsapp: Command): void {
  const profile = whatsapp.command('profile').description('View and update the WhatsApp business profile');

  addExamples(
    profile,
    `
EXAMPLES:
  $ hookmyapp whatsapp profile get --channel +1555
  $ hookmyapp whatsapp profile update --channel +1555 --about "We ship fast"
`,
  );

  const get = profile
    .command('get')
    .description('Get the business profile')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
    .option('--fields <list>', `Comma-separated fields (default: ${DEFAULT_FIELDS})`)
    .action(async function (this: Command, opts: WaProfileGetOpts) {
      await runWhatsappProfileGet(opts, this);
    });

  const update = profile
    .command('update')
    .description('Update the business profile (builder flags, or complete --body)')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
    .option('--about <text>', 'About text')
    .option('--description <text>', 'Description')
    .option('--address <text>', 'Address')
    .option('--email <email>', 'Contact email')
    .option('--vertical <vertical>', 'Business vertical')
    .option('--website <url>', 'Website (repeatable, max 2)', collect, [])
    .option('--body <json|@file|->', 'Complete Meta profile body (verbatim)')
    .option('-d, --data <json|@file|->', 'Alias for --body')
    .action(async function (this: Command, opts: WaProfileUpdateOpts) {
      await runWhatsappProfileUpdate(opts, this);
    });

  addExamples(
    get,
    `
EXAMPLES:
  $ hookmyapp whatsapp profile get --channel +1555
  $ hookmyapp whatsapp profile get --channel +1555 --fields about,email
`,
  );
  addExamples(
    update,
    `
EXAMPLES:
  $ hookmyapp whatsapp profile update --channel +1555 --about "We ship fast"
  $ hookmyapp whatsapp profile update --channel +1555 --website https://a.com --website https://b.com
`,
  );
}
