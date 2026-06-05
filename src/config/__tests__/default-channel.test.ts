import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('default channel persistence', () => {
  beforeEach(() => vi.resetModules());

  it('round-trips the default channel id', async () => {
    const m = await import('../env-profiles.js');
    expect(m.getPersistedDefaultChannel()).toBeUndefined();
    m.setPersistedDefaultChannel('ch_abc12345');
    expect(m.getPersistedDefaultChannel()).toBe('ch_abc12345');
    m.unsetPersistedDefaultChannel();
    expect(m.getPersistedDefaultChannel()).toBeUndefined();
  });
});
