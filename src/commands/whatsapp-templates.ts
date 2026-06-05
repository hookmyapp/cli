import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { readBodyFlag } from './whatsapp.js';
import { ValidationError } from '../output/error.js';

export interface WaTemplatesListOpts {
  channel?: string;
  status?: string;
  category?: string;
  limit?: string;
}

interface TemplateRow {
  name?: string;
  status?: string;
  category?: string;
}

function buildTemplatesQuery(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, v);
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export async function runWhatsappTemplatesList(opts: WaTemplatesListOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const query = buildTemplatesQuery({ status: opts.status, category: opts.category, limit: opts.limit });
  const res = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/{waba_id}/message_templates${query}`,
  });
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }
  const rows: TemplateRow[] = Array.isArray(res?.data) ? res.data : [];
  for (const t of rows) {
    process.stdout.write(`${t.name ?? ''}  ${t.status ?? ''}  ${t.category ?? ''}\n`);
  }
}

export interface WaTemplatesGetOpts {
  channel?: string;
}

export async function runWhatsappTemplatesGet(
  opts: WaTemplatesGetOpts,
  name: string,
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const query = buildTemplatesQuery({ name });
  const res = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/{waba_id}/message_templates${query}`,
  });
  process.stdout.write(JSON.stringify(res, null, cmd && isJsonMode(cmd) ? 0 : 2) + '\n');
}

export interface WaTemplatesCreateOpts {
  channel?: string;
  body?: string;
  data?: string;
}

export async function runWhatsappTemplatesCreate(opts: WaTemplatesCreateOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const bodyRaw = opts.body ?? opts.data; // -d/--data alias of --body (D2)
  if (!bodyRaw) throw new ValidationError('templates create requires --body <json|@file|->.', 'MISSING_BODY');
  const body = await readBodyFlag(bodyRaw);
  const res = await gatewayRequest({ channel, method: 'POST', path: `/{waba_id}/message_templates`, body });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Template created.') + '\n');
}

export interface WaTemplatesDeleteOpts {
  channel?: string;
}

export async function runWhatsappTemplatesDelete(
  opts: WaTemplatesDeleteOpts,
  name: string,
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const query = buildTemplatesQuery({ name });
  const res = await gatewayRequest({
    channel,
    method: 'DELETE',
    path: `/{waba_id}/message_templates${query}`,
  });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Template deleted.') + '\n');
}

/** Registers `whatsapp templates list|get|create|delete`. Templates are WABA-scoped (D8). */
export function registerWhatsappTemplates(whatsapp: Command): void {
  const templates = whatsapp.command('templates').description('Manage WhatsApp message templates (WABA-scoped)');

  addExamples(
    templates,
    `
EXAMPLES:
  $ hookmyapp whatsapp templates list --channel +1555
  $ hookmyapp whatsapp templates get hello_world --channel +1555
`,
  );

  const list = templates
    .command('list')
    .description('List message templates')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
    .option('--status <status>', 'Filter by status (e.g. APPROVED, PENDING, REJECTED)')
    .option('--category <category>', 'Filter by category (e.g. MARKETING, UTILITY)')
    .option('--limit <n>', 'Max templates to return')
    .action(async function (this: Command, opts: WaTemplatesListOpts) {
      await runWhatsappTemplatesList(opts, this);
    });

  const get = templates
    .command('get')
    .description('Get a message template by name')
    .argument('<name>', 'Template name')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
    .action(async function (this: Command, name: string, opts: WaTemplatesGetOpts) {
      await runWhatsappTemplatesGet(opts, name, this);
    });

  const create = templates
    .command('create')
    .description('Create a message template (complete --body JSON only)')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
    .option('--body <json|@file|->', 'Complete Meta template body (verbatim)')
    .option('-d, --data <json|@file|->', 'Alias for --body')
    .action(async function (this: Command, opts: WaTemplatesCreateOpts) {
      await runWhatsappTemplatesCreate(opts, this);
    });

  const del = templates
    .command('delete')
    .description('Delete a message template by name')
    .argument('<name>', 'Template name')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
    .action(async function (this: Command, name: string, opts: WaTemplatesDeleteOpts) {
      await runWhatsappTemplatesDelete(opts, name, this);
    });

  addExamples(
    list,
    `
EXAMPLES:
  $ hookmyapp whatsapp templates list --channel +1555
  $ hookmyapp whatsapp templates list --channel +1555 --status APPROVED --json
`,
  );
  addExamples(
    get,
    `
EXAMPLES:
  $ hookmyapp whatsapp templates get hello_world --channel +1555
  $ hookmyapp whatsapp templates get hello_world --channel +1555 --json
`,
  );
  addExamples(
    create,
    `
EXAMPLES:
  $ hookmyapp whatsapp templates create --channel +1555 --body @template.json
  $ hookmyapp whatsapp templates create --channel +1555 -d @template.json
`,
  );
  addExamples(
    del,
    `
EXAMPLES:
  $ hookmyapp whatsapp templates delete hello_world --channel +1555
  $ hookmyapp whatsapp templates delete hello_world --channel +1555 --json
`,
  );
}
