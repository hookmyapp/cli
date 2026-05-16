import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import {
  pickChannel,
  type Channel,
} from '../../commands/channels-listen/picker.js';
import { CliError } from '../../output/error.js';

const mockedSelect = vi.mocked(select);

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch_TEST0001',
    workspaceId: 'ws_TEST0010',
    metaWabaId: '1276334778010256',
    wabaName: 'Test WABA',
    displayPhoneNumber: '+1 (555) 111-1111',
    forwardingEnabled: true,
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

  describe('When --channel flag matches a forwarding-enabled channel', () => {
    it('then returns that channel without prompting', async () => {
      const a = makeChannel({ id: 'ch_AAAAAAAA', wabaName: 'A' });
      const b = makeChannel({ id: 'ch_BBBBBBBB', wabaName: 'B' });

      const picked = await pickChannel([a, b], { channelFlag: 'ch_BBBBBBBB' });

      expect(picked).toBe(b);
      expect(mockedSelect).not.toHaveBeenCalled();
    });
  });

  describe('When --channel flag does not match any channel', () => {
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
      const a = makeChannel({ id: 'ch_AAAAAAAA', wabaName: 'A' });
      const b = makeChannel({ id: 'ch_BBBBBBBB', wabaName: 'B' });
      mockedSelect.mockResolvedValueOnce(a);

      const picked = await pickChannel([a, b]);

      expect(picked).toBe(a);
      expect(mockedSelect).toHaveBeenCalledOnce();
    });
  });
});
