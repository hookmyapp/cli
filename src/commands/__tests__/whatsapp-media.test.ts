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
vi.mock('../../api/whatsapp-upload.js', () => ({ uploadHandle: vi.fn(async () => ({ handle: '4:SA==', mimeType: 'application/pdf', sizeBytes: 3 })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })) }));

import {
  runWhatsappMediaUpload,
  runWhatsappMediaDownload,
} from '../whatsapp-media.js';
import { gatewayUpload } from '../../api/gateway.js';
import { uploadHandle } from '../../api/whatsapp-upload.js';

const origIsTTY = process.stdout.isTTY;

describe('whatsapp media', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('AIT-713: --handle prints a reusable handle, forwards --type, and skips the media-id upload', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWhatsappMediaUpload({ channel: '+1', file: './doc.bin', type: 'application/pdf', handle: true });
    expect(uploadHandle).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch_a' }), './doc.bin', 'application/pdf');
    expect(write).toHaveBeenCalledWith('handle=4:SA==\n');
    expect(gatewayUpload).not.toHaveBeenCalled();
    write.mockRestore();
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

  it('rejects --json without --out', async () => {
    const cmd = { optsWithGlobals: () => ({ json: true }) } as unknown as import('commander').Command;
    await expect(runWhatsappMediaDownload({ channel: '+1' }, 'media_123', cmd)).rejects.toThrow(/requires --out/);
  });

  it('rejects an interactive TTY with no --out', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    await expect(runWhatsappMediaDownload({ channel: '+1' }, 'media_123')).rejects.toThrow(/--out/);
  });
});
