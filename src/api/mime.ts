const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  aac: 'audio/aac', amr: 'audio/amr', pdf: 'application/pdf',
};

/** Best-effort MIME from a file extension; defaults to application/octet-stream. */
export function guessMime(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
