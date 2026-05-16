// Channel picker for `hookmyapp channels listen`.
//
// Contract (spec 2026-05-15-cli-channel-listen-design §D2 + D10):
//   0 eligible channels → ValidationError NO_FORWARDING_CHANNELS (exit 2)
//   1 eligible          → return silently (auto-select)
//   --channel <id> flag → exact-match on channel.id or CHANNEL_MISMATCH (exit 2)
//                         (CI-friendly; never falls back to interactive picker)
//   2+ + no flag        → interactive @inquirer/prompts select
//
// "Eligible" = channel.forwardingEnabled === true. Channels without
// forwarding enabled cannot receive inbound webhooks at all — picking one
// would set up a tunnel that never sees traffic.

import { select } from '@inquirer/prompts';
import { CliError } from '../../output/error.js';

export interface Channel {
  id: string;
  workspaceId: string;
  metaWabaId?: string | null;
  wabaName?: string | null;
  displayPhoneNumber?: string | null;
  forwardingEnabled: boolean;
}

export interface PickChannelOpts {
  channelFlag?: string;
}

export async function pickChannel(
  channels: Channel[],
  opts: PickChannelOpts = {},
): Promise<Channel> {
  const eligible = channels.filter((c) => c.forwardingEnabled);

  if (eligible.length === 0) {
    const err = new CliError(
      'No channels have forwarding enabled. Enable a channel in the dashboard (or run `hookmyapp channels enable <waba-id>`) before connecting the CLI.',
      'NO_FORWARDING_CHANNELS',
    );
    err.exitCode = 2;
    throw err;
  }

  if (opts.channelFlag) {
    const match = eligible.find((c) => c.id === opts.channelFlag);
    if (!match) {
      const err = new CliError(
        `No forwarding-enabled channel matches --channel=${opts.channelFlag}. Run \`hookmyapp channels list\` to see eligible channels.`,
        'CHANNEL_MISMATCH',
      );
      err.exitCode = 2;
      throw err;
    }
    return match;
  }

  if (eligible.length === 1) return eligible[0];

  return select<Channel>({
    message: 'Choose a channel to listen on',
    choices: eligible.map((c) => ({
      name: renderRow(c),
      value: c,
    })),
  });
}

function renderRow(c: Channel): string {
  const phone = c.displayPhoneNumber ?? '(no phone)';
  const name = c.wabaName ?? c.id;
  return `${phone}   ${name}`;
}
