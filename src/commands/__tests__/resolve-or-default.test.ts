import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../channels.js', () => ({
  resolveChannel: vi.fn(async (ref: string) => ({ id: ref === '+15551234567' ? 'ch_phone001' : ref, type: 'whatsapp' })),
}));

import { resolveChannelRefOrDefault } from '../_helpers.js';
import { resolveChannel } from '../channels.js';

describe('resolveChannelRefOrDefault', () => {
  let savedEnvChannel: string | undefined;
  beforeEach(() => {
    vi.mocked(resolveChannel).mockClear();
    savedEnvChannel = process.env.HOOKMYAPP_CHANNEL_ID;
    delete process.env.HOOKMYAPP_CHANNEL_ID;
  });
  afterEach(() => {
    if (savedEnvChannel === undefined) delete process.env.HOOKMYAPP_CHANNEL_ID;
    else process.env.HOOKMYAPP_CHANNEL_ID = savedEnvChannel;
  });

  it('uses the explicit --channel ref when given (wins over env var)', async () => {
    process.env.HOOKMYAPP_CHANNEL_ID = 'ch_env00001';
    const ch = await resolveChannelRefOrDefault('+15551234567');
    expect(ch.id).toBe('ch_phone001');
  });

  it('falls back to HOOKMYAPP_CHANNEL_ID when no ref is given', async () => {
    process.env.HOOKMYAPP_CHANNEL_ID = 'ch_def00001';
    const ch = await resolveChannelRefOrDefault(undefined);
    expect(resolveChannel).toHaveBeenCalledWith('ch_def00001');
    expect(ch.id).toBe('ch_def00001');
  });

  it('throws a NO_CHANNEL ValidationError when neither ref nor env var is set', async () => {
    await expect(resolveChannelRefOrDefault(undefined)).rejects.toThrow(/HOOKMYAPP_CHANNEL_ID/);
  });

  it('errors when the resolved channel type does not match expectedType (D6 guard)', async () => {
    // mocked resolveChannel returns a whatsapp channel; ask for instagram
    await expect(resolveChannelRefOrDefault('+15551234567', 'instagram')).rejects.toThrow(/instagram/);
  });
});
