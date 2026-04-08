import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Creates an isolated $HOME with empty .hookmyapp/ directory. */
export async function tmpHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'hookmyapp-cli-'));
  await mkdir(path.join(home, '.hookmyapp'), { recursive: true });
  return home;
}
