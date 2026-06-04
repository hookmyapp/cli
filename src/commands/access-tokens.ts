import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';
import { ValidationError } from '../output/error.js';
import { getDefaultWorkspaceId } from './_helpers.js';
import { addExamples } from '../output/help.js';

/** A minted gateway access token as returned by `POST /access-tokens/credentials/:credentialPublicId`. */
export interface MintedAccessToken {
  token: string;
  publicId: string;
  tokenPrefix: string;
  tokenSuffix: string;
}

/** An access token row as returned by `GET /access-tokens/credentials/:credentialPublicId` (never the full secret). */
export interface AccessTokenListRow {
  publicId: string;
  tokenPrefix: string;
  tokenSuffix: string;
  label?: string | null;
}

// Mints an access token and RETURNS it WITHOUT printing (it does have a side
// effect — the token is persisted server-side). `env --write` (Task 3) reuses
// this instead of runAccessTokensCreate, which would leak an extra plaintext
// line into the command's own output.
export async function createAccessTokenForChannel(
  channelRef: string,
  label?: string,
): Promise<MintedAccessToken> {
  const channel = await resolveChannel(channelRef);
  if (!channel.credentialPublicId) {
    throw new ValidationError(
      `Channel ${channel.id} has no integration credential yet. Connect it first.`,
      'NO_CREDENTIAL',
    );
  }
  return (await apiClient(`/access-tokens/credentials/${channel.credentialPublicId}`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
    body: JSON.stringify({ label }),
  })) as MintedAccessToken;
}

export async function runAccessTokensCreate(
  channelRef: string,
  opts: { label?: string },
  cmd?: Command,
): Promise<void> {
  const res = await createAccessTokenForChannel(channelRef, opts.label);
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }
  process.stdout.write(res.token + '\n'); // one-time plaintext — store it now
}

export async function runAccessTokensList(channelRef: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannel(channelRef);
  if (!channel.credentialPublicId) {
    throw new ValidationError(
      `Channel ${channel.id} has no integration credential yet.`,
      'NO_CREDENTIAL',
    );
  }
  const { tokens } = (await apiClient(`/access-tokens/credentials/${channel.credentialPublicId}`, {
    workspaceId: channel.workspaceId,
  })) as { tokens: AccessTokenListRow[] };
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(tokens) + '\n');
    return;
  }
  for (const t of tokens) {
    process.stdout.write(`${t.publicId}  ${t.tokenPrefix}…${t.tokenSuffix}  ${t.label ?? ''}\n`);
  }
}

export async function runAccessTokensRevoke(tokenPublicId: string): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  await apiClient(`/access-tokens/${tokenPublicId}`, { method: 'DELETE', workspaceId });
  process.stdout.write('Revoked\n');
}

export function registerAccessTokensCommand(program: Command): void {
  const accessTokens = program
    .command('access-tokens')
    .description('Manage gateway access tokens for a channel');

  const accessTokensCreate = accessTokens
    .command('create')
    .description('Mint a new gateway access token for a channel (plaintext shown once)')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .option('--label <label>', 'Human-readable label for the access token')
    .action(async function (this: Command, channelRef: string, options: { label?: string }) {
      await runAccessTokensCreate(channelRef, options, this);
    });

  const accessTokensList = accessTokens
    .command('list')
    .description('List gateway access tokens for a channel (prefixes only, never full secrets)')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async function (this: Command, channelRef: string) {
      await runAccessTokensList(channelRef, this);
    });

  const accessTokensRevoke = accessTokens
    .command('revoke')
    .description('Revoke a gateway access token by its publicId')
    .argument('<tokenId>', 'Access token publicId (tok_xxxxxxxx)')
    .action(async (tokenPublicId: string) => {
      await runAccessTokensRevoke(tokenPublicId);
    });

  addExamples(
    accessTokens,
    `
EXAMPLES:
  $ hookmyapp access-tokens create @ordvir
  $ hookmyapp access-tokens list @ordvir
  $ hookmyapp access-tokens revoke tok_AAAA1111
`,
  );

  addExamples(
    accessTokensCreate,
    `
EXAMPLES:
  $ hookmyapp access-tokens create @ordvir
  $ hookmyapp access-tokens create +15551234567 --label prod
`,
  );

  addExamples(
    accessTokensList,
    `
EXAMPLES:
  $ hookmyapp access-tokens list @ordvir
  $ hookmyapp access-tokens list ch_WAaaaaaa --json
`,
  );

  addExamples(
    accessTokensRevoke,
    `
EXAMPLES:
  $ hookmyapp access-tokens revoke tok_AAAA1111
  $ hookmyapp access-tokens revoke tok_BBBB2222 --workspace acme-corp
`,
  );
}
