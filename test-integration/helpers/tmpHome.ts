import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The CLI's config dir inside an isolated $HOME — mirrors src/storage/path.ts
 * XDG resolution (~/.config/hookmyapp). Specs must use this, not the legacy
 * ~/.hookmyapp dotdir the CLI migrated away from. */
export function cliConfigDir(home: string): string {
  return path.join(home, '.config', 'hookmyapp');
}

/** Creates an isolated $HOME with an empty CLI config directory. */
export async function tmpHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'hookmyapp-cli-'));
  await mkdir(cliConfigDir(home), { recursive: true });
  return home;
}
