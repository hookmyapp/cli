import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../channels.js', () => ({
  resolveChannel: vi.fn(async (ref: string) => ({ id: ref === '+15551234567' ? 'ch_phone001' : ref, type: 'whatsapp' })),
}));
vi.mock('../../config/env-profiles.js', () => ({
  getPersistedDefaultChannel: vi.fn(() => undefined),
}));

import { resolveChannelRefOrDefault } from '../_helpers.js';
import { resolveChannel } from '../channels.js';
import { getPersistedDefaultChannel } from '../../config/env-profiles.js';

describe('resolveChannelRefOrDefault', () => {
  beforeEach(() => { vi.mocked(resolveChannel).mockClear(); vi.mocked(getPersistedDefaultChannel).mockReset(); });

  it('uses the explicit --channel ref when given', async () => {
    vi.mocked(getPersistedDefaultChannel).mockReturnValue(undefined);
    const ch = await resolveChannelRefOrDefault('+15551234567');
    expect(ch.id).toBe('ch_phone001');
  });

  it('falls back to the persisted default channel', async () => {
    vi.mocked(getPersistedDefaultChannel).mockReturnValue('ch_def00001');
    const ch = await resolveChannelRefOrDefault(undefined);
    expect(resolveChannel).toHaveBeenCalledWith('ch_def00001');
    expect(ch.id).toBe('ch_def00001');
  });

  it('throws a clear ValidationError when neither is set', async () => {
    vi.mocked(getPersistedDefaultChannel).mockReturnValue(undefined);
    await expect(resolveChannelRefOrDefault(undefined)).rejects.toThrow(/--channel/);
  });

  it('errors when the resolved channel type does not match expectedType (D6 guard)', async () => {
    vi.mocked(getPersistedDefaultChannel).mockReturnValue(undefined);
    // mocked resolveChannel returns a whatsapp channel; ask for instagram
    await expect(resolveChannelRefOrDefault('+15551234567', 'instagram')).rejects.toThrow(/instagram/);
  });
});
