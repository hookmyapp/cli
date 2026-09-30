import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ success: true })) }));
vi.mock('../../api/whatsapp-upload.js', () => ({ uploadHandle: vi.fn(async () => ({ handle: '4:SA==', mimeType: 'image/png', sizeBytes: 7 })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })) }));

import { runWhatsappProfileGet, runWhatsappProfileUpdate } from '../whatsapp-profile.js';
import { gatewayRequest } from '../../api/gateway.js';
import { uploadHandle } from '../../api/whatsapp-upload.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ait713-'));
const logo = join(dir, 'logo.png');
writeFileSync(logo, 'PNGDATA');
const huge = join(dir, 'huge.png');
writeFileSync(huge, Buffer.alloc(5 * 1024 * 1024 + 1));

describe('whatsapp profile', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(uploadHandle).mockClear();
  });

  it('AIT-713: --photo uploads for a handle, then sends it with the text flags in one update', async () => {
    await runWhatsappProfileUpdate({ channel: '+1', about: 'hi', photo: logo });
    expect(uploadHandle).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch_a' }), logo, 'image/png');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { messaging_product: 'whatsapp', about: 'hi', profile_picture_handle: '4:SA==' },
    }));
  });

  it.each([['./a.gif'], [huge]])('AIT-713: --photo %s is refused before uploading', async (photo) => {
    await expect(runWhatsappProfileUpdate({ channel: '+1', photo })).rejects.toThrow(/JPEG or PNG image up to 5 MB/);
    expect(uploadHandle).not.toHaveBeenCalled();
  });

  it('AIT-713: --photo cannot be combined with --body', async () => {
    await expect(runWhatsappProfileUpdate({ channel: '+1', photo: logo, body: '{}' })).rejects.toThrow(/not both/);
  });

  it('updates from builder flags (about + 2 websites)', async () => {
    await runWhatsappProfileUpdate({ channel: '+1', about: 'hi', website: ['a', 'b'] });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      body: { messaging_product: 'whatsapp', about: 'hi', websites: ['a', 'b'] },
    }));
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.path).toContain('{phone_number_id}/whatsapp_business_profile');
  });

  it('rejects mixing --about and --body', async () => {
    await expect(
      runWhatsappProfileUpdate({ channel: '+1', about: 'hi', body: '{}' }),
    ).rejects.toThrow(/not both/);
  });

  it('rejects more than 2 websites', async () => {
    await expect(
      runWhatsappProfileUpdate({ channel: '+1', website: ['a', 'b', 'c'] }),
    ).rejects.toThrow(/at most 2 websites/);
  });

  it('accepts -d/--data as an alias for --body', async () => {
    await runWhatsappProfileUpdate({ channel: '+1', data: '{"messaging_product":"whatsapp","about":"x"}' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { messaging_product: 'whatsapp', about: 'x' },
    }));
  });

  it('gets the profile with default fields', async () => {
    await runWhatsappProfileGet({ channel: '+1' });
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.path).toContain('fields=');
  });
});
