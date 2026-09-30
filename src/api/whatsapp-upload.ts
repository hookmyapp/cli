import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { apiClient } from './client.js';
import { guessMime } from './mime.js';
import type { Channel } from './channel.js';

/**
 * AIT-713: upload a file to the backend for a reusable Meta handle (profile
 * photo, template media header). The backend runs Meta's resumable upload.
 */
export async function uploadHandle(
  channel: Channel,
  file: string,
  mimeType?: string,
): Promise<{ handle: string; mimeType: string; sizeBytes: number }> {
  const type = mimeType ?? guessMime(file);
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)], { type }), basename(file));
  return apiClient(`/channels/${channel.id}/whatsapp/uploads`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
    body: form,
  });
}
