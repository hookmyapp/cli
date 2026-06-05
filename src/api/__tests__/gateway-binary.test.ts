import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../client.js', () => ({ apiClient: vi.fn(async () => ({ token: 'hmat_X', baseUrl: 'https://gw.example.com/meta/v22.0' })), isNetworkFailure: () => false }));
vi.mock('../../config/env-profiles.js', () => ({ getGatewayBaseOverride: () => undefined }));

import { gatewayUpload, gatewayDownloadToStream } from '../gateway.js';
import { ApiError } from '../../output/error.js';
import { Writable } from 'node:stream';
const waChannel = { id: 'ch_a', type: 'whatsapp', workspaceId: 'ws_1', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111' } as any;

describe('gatewayUpload', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('posts multipart form-data with messaging_product and returns {id}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-')); const f = join(dir, 'img.jpg'); writeFileSync(f, Buffer.from([1,2,3]));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'media_1' }), { status: 200 }));
    const out = await gatewayUpload({ channel: waChannel, path: '/{phone_number_id}/media', file: f });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gw.example.com/meta/v22.0/111/media');
    expect(init!.body).toBeInstanceOf(FormData);
    expect((init!.body as FormData).get('messaging_product')).toBe('whatsapp');
    expect((init!.body as FormData).get('type')).toBe('image/jpeg'); // from img.jpg
    expect(out).toEqual({ id: 'media_1' });
  });
});

describe('gatewayDownloadToStream', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('drains the body and throws an ApiError on a non-ok download response', async () => {
    const cancel = vi.fn(async () => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404, body: { cancel } } as any);
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const promise = gatewayDownloadToStream('https://gw.example.com/media/signed', sink);
    await expect(promise).rejects.toMatchObject({ message: 'Media download failed (HTTP 404).', statusCode: 404 });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
