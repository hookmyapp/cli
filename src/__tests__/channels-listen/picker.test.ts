import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import { pickChannel } from '../../commands/channels-listen/picker.js';
import type { WhatsAppChannel } from '../../api/channel.js';
import { CliError } from '../../output/error.js';

const mockedSelect = vi.mocked(select);

function makeChannel(
  overrides: Partial<WhatsAppChannel> = {},
): WhatsAppChannel {
  // Factory returns a WhatsAppChannel — the picker is forwarding-shaped-
  // agnostic (it only reads .id + .forwardingEnabled) so a single concrete
  // variant of the discriminated union suffices for every existing
  // pickChannel assertion. The overrides type is `Partial<WhatsAppChannel>`
  // rather than `Partial<Channel>` because a Partial<Channel> collapses to
  // a per-variant union that can't be merged into a concrete arm — pinning
  // the variant keeps the spread well-typed. Migrated from the legacy
  // local Channel shape in B10 when picker.ts adopted the parsed
  // discriminated union from src/api/channel.ts.
  return {
    id: 'ch_TEST0001',
    type: 'whatsapp',
    workspaceId: 'ws_TEST0010',
    metaWabaId: '1276334778010256',
    metaResourceId: '1080996501762047',
    connectionType: 'embedded_signup',
    metaConnected: true,
    forwardingEnabled: true,
    webhookUrl: null,
    verifyToken: null,
    whatsappWabaName: 'Test WABA',
    whatsappDisplayPhoneNumber: '+1 (555) 111-1111',
    whatsappPhoneNumberId: null,
    whatsappVerifiedName: null,
    whatsappQualityRating: null,
    whatsappProfilePictureUrl: null,
    ...overrides,
  };
}

describe('pickChannel', () => {
  beforeEach(() => {
    mockedSelect.mockReset();
  });

  describe('When no forwarding-enabled channel exists', () => {
    it('then throws CliError NO_FORWARDING_CHANNELS with exitCode 2', async () => {
      const channels = [makeChannel({ forwardingEnabled: false })];

      let caught: CliError | undefined;
      try {
        await pickChannel(channels);
      } catch (e) {
        caught = e as CliError;
      }

      expect(caught).toBeInstanceOf(CliError);
      expect(caught?.code).toBe('NO_FORWARDING_CHANNELS');
      expect(caught?.exitCode).toBe(2);
      expect(mockedSelect).not.toHaveBeenCalled();
    });
  });

  describe('When channelFlag opt (positional channelRef) matches a forwarding-enabled channel', () => {
    it('then returns that channel without prompting', async () => {
      const a = makeChannel({ id: 'ch_AAAAAAAA', whatsappWabaName: 'A' });
      const b = makeChannel({ id: 'ch_BBBBBBBB', whatsappWabaName: 'B' });

      const picked = await pickChannel([a, b], { channelFlag: 'ch_BBBBBBBB' });

      expect(picked).toBe(b);
      expect(mockedSelect).not.toHaveBeenCalled();
    });
  });

  describe('When channelFlag opt (positional channelRef) does not match any channel', () => {
    it('then throws CliError CHANNEL_MISMATCH with exitCode 2', async () => {
      const channels = [makeChannel({ id: 'ch_AAAAAAAA' })];

      let caught: CliError | undefined;
      try {
        await pickChannel(channels, { channelFlag: 'ch_NONEXIST' });
      } catch (e) {
        caught = e as CliError;
      }

      expect(caught).toBeInstanceOf(CliError);
      expect(caught?.code).toBe('CHANNEL_MISMATCH');
      expect(caught?.exitCode).toBe(2);
    });
  });

  describe('When exactly 1 forwarding-enabled channel exists', () => {
    it('then returns it silently without prompting', async () => {
      const only = makeChannel();

      const picked = await pickChannel([only]);

      expect(picked).toBe(only);
      expect(mockedSelect).not.toHaveBeenCalled();
    });
  });

  describe('When 2+ forwarding-enabled channels exist and no flag is set', () => {
    it('then prompts via @inquirer select', async () => {
      const a = makeChannel({ id: 'ch_AAAAAAAA', whatsappWabaName: 'A' });
      const b = makeChannel({ id: 'ch_BBBBBBBB', whatsappWabaName: 'B' });
      mockedSelect.mockResolvedValueOnce(a);

      const picked = await pickChannel([a, b]);

      expect(picked).toBe(a);
      expect(mockedSelect).toHaveBeenCalledOnce();
    });
  });
});
