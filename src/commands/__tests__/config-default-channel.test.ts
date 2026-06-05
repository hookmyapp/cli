import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../channels.js', () => ({ resolveChannel: vi.fn(async () => ({ id: 'ch_RESOLVE1', type: 'whatsapp' })) }));
import { runConfigSetDefaultChannel } from '../config.js';
import { getPersistedDefaultChannel } from '../../config/env-profiles.js';

describe('config set default-channel', () => {
  beforeEach(() => vi.resetModules());
  it('resolves a phone ref to a ch_ id and persists it', async () => {
    await runConfigSetDefaultChannel('+15551234567');
    expect(getPersistedDefaultChannel()).toBe('ch_RESOLVE1');
  });
});
