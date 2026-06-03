import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';
import { ValidationError } from '../output/error.js';
import { getDefaultWorkspaceId } from './_helpers.js';
import { addExamples } from '../output/help.js';

/** A minted gateway API key as returned by `POST /api-keys/connections/:connId`. */
export interface MintedKey {
  key: string;
  publicId: string;
  keyPrefix: string;
  keySuffix: string;
}

/** A key row as returned by `GET /api-keys/connections/:connId` (never the full secret). */
export interface KeyListRow {
  publicId: string;
  keyPrefix: string;
  keySuffix: string;
  label?: string | null;
}

// Side-effect-free helper: mints a key and RETURNS it. `env --write` (Task 3)
// reuses this WITHOUT printing — calling runKeysCreate there would leak an extra
// plaintext line into the command's own output.
export async function createKeyForChannel(
  channelRef: string,
  label?: string,
): Promise<MintedKey> {
  const channel = await resolveChannel(channelRef);
  if (!channel.connectionId) {
    throw new ValidationError(
      `Channel ${channel.id} has no Meta connection yet — connect it first.`,
      'NO_CONNECTION',
    );
  }
  return (await apiClient(`/api-keys/connections/${channel.connectionId}`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
    body: JSON.stringify({ label }),
  })) as MintedKey;
}

export async function runKeysCreate(
  channelRef: string,
  opts: { label?: string },
  cmd?: Command,
): Promise<void> {
  const res = await createKeyForChannel(channelRef, opts.label);
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }
  process.stdout.write(res.key + '\n'); // one-time plaintext — store it now
}

export async function runKeysList(channelRef: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannel(channelRef);
  if (!channel.connectionId) {
    throw new ValidationError(
      `Channel ${channel.id} has no Meta connection yet.`,
      'NO_CONNECTION',
    );
  }
  const { keys } = (await apiClient(`/api-keys/connections/${channel.connectionId}`, {
    workspaceId: channel.workspaceId,
  })) as { keys: KeyListRow[] };
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(keys) + '\n');
    return;
  }
  for (const k of keys) {
    process.stdout.write(`${k.publicId}  ${k.keyPrefix}…${k.keySuffix}  ${k.label ?? ''}\n`);
  }
}

export async function runKeysRevoke(keyPublicId: string): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  await apiClient(`/api-keys/${keyPublicId}`, { method: 'DELETE', workspaceId });
  process.stdout.write('Revoked\n');
}

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description('Manage gateway API keys for a channel');

  const keysCreate = keys
    .command('create')
    .description('Mint a new gateway API key for a channel (plaintext shown once)')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .option('--label <label>', 'Human-readable label for the key')
    .action(async function (this: Command, channelRef: string, options: { label?: string }) {
      await runKeysCreate(channelRef, options, this);
    });

  const keysList = keys
    .command('list')
    .description('List gateway API keys for a channel (prefixes only, never full keys)')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async function (this: Command, channelRef: string) {
      await runKeysList(channelRef, this);
    });

  const keysRevoke = keys
    .command('revoke')
    .description('Revoke a gateway API key by its publicId')
    .argument('<keyId>', 'API key publicId (key_xxxxxxxx)')
    .action(async (keyPublicId: string) => {
      await runKeysRevoke(keyPublicId);
    });

  addExamples(
    keys,
    `
EXAMPLES:
  $ hookmyapp keys create @ordvir
  $ hookmyapp keys list @ordvir
  $ hookmyapp keys revoke key_AAAA1111
`,
  );

  addExamples(
    keysCreate,
    `
EXAMPLES:
  $ hookmyapp keys create @ordvir
  $ hookmyapp keys create +15551234567 --label prod
`,
  );

  addExamples(
    keysList,
    `
EXAMPLES:
  $ hookmyapp keys list @ordvir
  $ hookmyapp keys list ch_WAaaaaaa --json
`,
  );

  addExamples(
    keysRevoke,
    `
EXAMPLES:
  $ hookmyapp keys revoke key_AAAA1111
  $ hookmyapp keys revoke key_BBBB2222 --workspace acme-corp
`,
  );
}
