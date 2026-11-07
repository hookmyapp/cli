import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../client.js', () => ({ apiClient: vi.fn(async () => ({ handle: '4:SA==', mimeType: 'image/png', sizeBytes: 7 })) }));

import { uploadHandle } from '../whatsapp-upload.js';
import { apiClient } from '../client.js';

describe('uploadHandle (AIT-713)', () => {
  it('posts the file as multipart to the channel uploads route in its workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ait713-'));
    const file = join(dir, 'logo.png');
    writeFileSync(file, 'PNGDATA');

    const out = await uploadHandle({ id: 'ch_a', workspaceId: 'ws_1' } as never, file);

    const [path, init] = vi.mocked(apiClient).mock.calls[0]!;
    const part = (init!.body as FormData).get('file') as File;
    expect([path, init!.method, init!.workspaceId]).toEqual(['/channels/ch_a/whatsapp/uploads', 'POST', 'ws_1']);
    expect([part.name, part.type, await part.text()]).toEqual(['logo.png', 'image/png', 'PNGDATA']);
    expect(out.handle).toBe('4:SA==');
  });

  it('a missing file is a validation error naming the path, not a raw filesystem crash', async () => {
    await expect(uploadHandle({ id: 'ch_a', workspaceId: 'ws_1' } as never, './nope.jpg')).rejects.toMatchObject({ code: 'FILE_NOT_READABLE' });
  });
});
