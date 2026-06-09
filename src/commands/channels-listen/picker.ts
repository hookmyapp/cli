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
import type { Channel } from '../../api/channel.js';

// Re-export so existing callers that imported `Channel` from this module
// (e.g. tests, the action handler) keep their import paths stable now that
// the parsed discriminated-union type is the canonical shape.
export type { Channel };

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
      'No channels have forwarding enabled. Enable a channel in the dashboard (or run `hookmyapp channels enable <channel>`) before connecting the CLI.',
      'NO_FORWARDING_CHANNELS',
    );
    err.exitCode = 2;
    throw err;
  }

  if (opts.channelFlag) {
    const match = eligible.find((c) => c.id === opts.channelFlag);
    if (!match) {
      const err = new CliError(
        `No forwarding-enabled channel matches "${opts.channelFlag}". Run \`hookmyapp channels list\` to see eligible channels.`,
        'CHANNEL_MISMATCH',
      );
      err.exitCode = 2;
      throw err;
    }
    return match;
  }

  if (eligible.length === 1) return eligible[0];

  return selectChannel(eligible, 'Choose a channel to listen on');
}

/**
 * Forwarding-agnostic interactive selector. Given a non-empty channel list,
 * prompts the user via @inquirer/prompts/select and returns the chosen
 * channel. Does NOT filter by `forwardingEnabled` — callers that need that
 * filter (e.g. `channels listen`, post-login wizard) should use `pickChannel`
 * which delegates here after filtering.
 *
 * Generic over the discriminated `Channel` union so the row renderer can
 * narrow on `type` (WA → +phone, IG → @handle, Messenger → id). Tightened
 * from a structural shape constraint in B10 once the parsed Channel became
 * the canonical type at this seam.
 */
export async function selectChannel<T extends Channel>(
  channels: T[],
  message = 'Choose a channel',
): Promise<T> {
  return select<T>({
    message,
    choices: channels.map((c) => ({
      name: renderRow(c),
      value: c,
    })),
  });
}

export function renderRow(c: Channel): string {
  if (c.type === 'whatsapp') {
    const name = c.whatsappWabaName ?? '(no name)';
    const phone = c.whatsappDisplayPhoneNumber ?? 'no phone';
    return `${c.id} (${name}, ${phone})`;
  }
  if (c.type === 'instagram') {
    const handle = c.instagramUsername ? `@${c.instagramUsername}` : '(no handle)';
    const name = c.instagramProfileName ?? '';
    return `${c.id} (${handle}${name ? `, ${name}` : ''})`;
  }
  return `${c.id} (Messenger)`;
}
