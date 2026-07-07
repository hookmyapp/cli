import type { Command } from 'commander';
import { finished } from 'node:stream/promises';
import { addExamples } from '../output/help.js';
import {
  gatewayRequest,
  gatewayUpload,
  gatewayDownloadToStream,
  createWriteStream,
} from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

export interface WaMediaUploadOpts {
  channel?: string;
  file?: string;
  type?: string;
}

export async function runWhatsappMediaUpload(opts: WaMediaUploadOpts, cmd?: Command): Promise<void> {
  if (!opts.file) throw new ValidationError('--file <path> is required to upload media.', 'MISSING_FILE');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayUpload({ channel, path: `/{phone_number_id}/media`, file: opts.file, type: opts.type });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : `id=${res?.id ?? '(unknown)'}`) + '\n');
}

export interface WaMediaGetOpts {
  channel?: string;
}

export async function runWhatsappMediaGet(opts: WaMediaGetOpts, mediaId: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  // media-id is a literal Graph node — no placeholder substitution.
  const res = await gatewayRequest({ channel, method: 'GET', path: `/${mediaId}` });
  process.stdout.write(JSON.stringify(res, null, cmd && isJsonMode(cmd) ? 0 : 2) + '\n');
}

export interface WaMediaDownloadOpts {
  channel?: string;
  out?: string;
}

export async function runWhatsappMediaDownload(
  opts: WaMediaDownloadOpts,
  mediaId: string,
  cmd?: Command,
): Promise<void> {
  const json = Boolean(cmd && isJsonMode(cmd));
  const out = opts.out;
  if (json && !out) {
    throw new ValidationError('media download --json requires --out <path>', 'DOWNLOAD_JSON_NEEDS_OUT');
  }
  if (!out && process.stdout.isTTY) {
    throw new ValidationError('pass --out <path> or --out -', 'DOWNLOAD_NEEDS_OUT');
  }

  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  // Hop 1: read the gateway-signed url for this media node.
  const meta = await gatewayRequest({ channel, method: 'GET', path: `/${mediaId}` });
  const url = meta?.url;
  if (typeof url !== 'string' || !url) {
    throw new ValidationError(`Media ${mediaId} has no downloadable url.`, 'NO_MEDIA_URL');
  }

  // Hop 2: stream the bytes. Caller owns the sink lifecycle.
  if (out && out !== '-') {
    const sink = createWriteStream(out);
    const bytes = await gatewayDownloadToStream(url, sink);
    sink.end();
    await finished(sink);
    if (json) {
      process.stdout.write(JSON.stringify({ path: out, bytes }) + '\n');
    } else {
      process.stderr.write(`Saved ${out} (${bytes} bytes)\n`);
    }
    return;
  }

  // `--out -` or a non-TTY pipe → raw bytes to stdout. Do NOT end stdout.
  await gatewayDownloadToStream(url, process.stdout);
}

export interface WaMediaDeleteOpts {
  channel?: string;
}

export async function runWhatsappMediaDelete(
  opts: WaMediaDeleteOpts,
  mediaId: string,
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayRequest({ channel, method: 'DELETE', path: `/${mediaId}` });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Media deleted.') + '\n');
}

/** Registers `whatsapp media upload|get|download|delete`. Media is passthrough (we store nothing). */
export function registerWhatsappMedia(whatsapp: Command): void {
  const media = whatsapp.command('media').description('Upload, fetch, download, and delete WhatsApp media');

  addExamples(
    media,
    `
EXAMPLES:
  $ hookmyapp whatsapp media upload --channel 1555 --file ./a.jpg
  $ hookmyapp whatsapp media download media_123 --channel 1555 --out ./a.jpg
`,
  );

  const upload = media
    .command('upload')
    .description('Upload a media file (returns its media id)')
    .option('--channel <ref>', 'Channel: phone number, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--file <path>', 'Path to the file to upload')
    .option('--type <mime>', 'Override the MIME type (default: guessed from extension)')
    .action(async function (this: Command, opts: WaMediaUploadOpts) {
      await runWhatsappMediaUpload(opts, this);
    });

  const get = media
    .command('get')
    .description('Get media metadata (incl. the gateway-signed download url)')
    .argument('<media-id>', 'Media id')
    .option('--channel <ref>', 'Channel: phone number, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .action(async function (this: Command, mediaId: string, opts: WaMediaGetOpts) {
      await runWhatsappMediaGet(opts, mediaId, this);
    });

  const download = media
    .command('download')
    .description('Download media bytes to a file (--out <path>) or stdout (--out -)')
    .argument('<media-id>', 'Media id')
    .option('--channel <ref>', 'Channel: phone number, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--out <path|->', 'Destination file path, or - for stdout')
    .action(async function (this: Command, mediaId: string, opts: WaMediaDownloadOpts) {
      await runWhatsappMediaDownload(opts, mediaId, this);
    });

  const del = media
    .command('delete')
    .description('Delete media by id')
    .argument('<media-id>', 'Media id')
    .option('--channel <ref>', 'Channel: phone number, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .action(async function (this: Command, mediaId: string, opts: WaMediaDeleteOpts) {
      await runWhatsappMediaDelete(opts, mediaId, this);
    });

  addExamples(
    upload,
    `
EXAMPLES:
  $ hookmyapp whatsapp media upload --channel 1555 --file ./a.jpg
  $ hookmyapp whatsapp media upload --channel 1555 --file ./a.pdf --type application/pdf
`,
  );
  addExamples(
    get,
    `
EXAMPLES:
  $ hookmyapp whatsapp media get media_123 --channel 1555
  $ hookmyapp whatsapp media get media_123 --channel 1555 --json
`,
  );
  addExamples(
    download,
    `
EXAMPLES:
  $ hookmyapp whatsapp media download media_123 --channel 1555 --out ./a.jpg
  $ hookmyapp whatsapp media download media_123 --channel 1555 --out - > a.jpg
`,
  );
  addExamples(
    del,
    `
EXAMPLES:
  $ hookmyapp whatsapp media delete media_123 --channel 1555
  $ hookmyapp whatsapp media delete media_123 --channel 1555 --json
`,
  );
}
