import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';

vi.mock('../../api/gateway.js', () => ({
  gatewayUpload: vi.fn(async () => ({ id: 'media_123' })),
  gatewayRequest: vi.fn(async () => ({ url: 'https://signed.example/media.bin' })),
  gatewayDownloadToStream: vi.fn(async (_url: string, sink: NodeJS.WritableStream) => {
    const bytes = Buffer.from('hello-bytes');
    await new Promise<void>((res, rej) => sink.write(bytes, (e) => (e ? rej(e) : res())));
    return bytes.byteLength;
  }),
  createWriteStream,
}));
vi.mock('../../api/client.js', () => ({ apiRedirectLocation: vi.fn(async () => 'https://storage.example/signed') }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })) }));

import {
  runWhatsappMediaUpload,
  runWhatsappMediaDownload,
} from '../whatsapp-media.js';
import { apiRedirectLocation } from '../../api/client.js';
import { gatewayUpload, gatewayRequest, gatewayDownloadToStream } from '../../api/gateway.js';

const origIsTTY = process.stdout.isTTY;

describe('whatsapp media', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('uploads a file with the resolved channel', async () => {
    await runWhatsappMediaUpload({ channel: '+1', file: './a.jpg' });
    expect(gatewayUpload).toHaveBeenCalledWith(expect.objectContaining({
      path: '/{phone_number_id}/media',
      file: './a.jpg',
    }));
  });

  it('downloads to a file and reports the byte count', async () => {
    const out = join(tmpdir(), `wa-media-${Date.now()}.bin`);
    try {
      await runWhatsappMediaDownload({ channel: '+1', out }, 'media_123');
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out).byteLength).toBe(Buffer.from('hello-bytes').byteLength);
    } finally {
      if (existsSync(out)) rmSync(out);
    }
  });

  it('prefers downloadUrl: authenticated via the login, then fetches the redirect target', async () => {
    vi.mocked(gatewayRequest).mockResolvedValueOnce({ url: 'https://signed.example/m', downloadUrl: 'https://api.hookmyapp.com/channels/ch_a/whatsapp/media/m1/download' });
    const out = join(tmpdir(), `wa-media-dl-${Date.now()}.bin`);
    try {
      await runWhatsappMediaDownload({ channel: '+1', out }, 'm1');
      expect(apiRedirectLocation).toHaveBeenCalledWith('/channels/ch_a/whatsapp/media/m1/download', { workspaceId: 'ws_1' });
      expect(gatewayDownloadToStream).toHaveBeenCalledWith('https://storage.example/signed', expect.anything());
    } finally {
      if (existsSync(out)) rmSync(out);
    }
  });

  it('falls back to url when downloadUrl is absent', async () => {
    const out = join(tmpdir(), `wa-media-fb-${Date.now()}.bin`);
    try {
      await runWhatsappMediaDownload({ channel: '+1', out }, 'm1');
      expect(gatewayDownloadToStream).toHaveBeenCalledWith('https://signed.example/media.bin', expect.anything());
      expect(apiRedirectLocation).not.toHaveBeenCalled();
    } finally {
      if (existsSync(out)) rmSync(out);
    }
  });

  it('rejects --json without --out', async () => {
    const cmd = { optsWithGlobals: () => ({ json: true }) } as unknown as import('commander').Command;
    await expect(runWhatsappMediaDownload({ channel: '+1' }, 'media_123', cmd)).rejects.toThrow(/requires --out/);
  });

  it('rejects an interactive TTY with no --out', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    await expect(runWhatsappMediaDownload({ channel: '+1' }, 'media_123')).rejects.toThrow(/--out/);
  });
});
