// Task A4 — regression test for `sandbox listen` positional `[identifier]`.
//
// Asserts that the LOCAL wrapper at `sandbox-listen/picker.ts` forwards
// `identifierArg` through to the unified picker. The deeper shape-detection
// behavior (phone/username/sessionId routing) is covered by the unified
// picker tests at `src/commands/sandbox/__tests__/picker.test.ts` (A2).
//
// Strategy: mock the INNER unified picker so we can spy on what the local
// wrapper forwards. The local wrapper at sandbox-listen/picker.ts under test
// stays REAL — its `return unifiedPick({...})` body runs, exercising the
// forwarding logic.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the INNER unified picker so we can spy on what the wrapper forwards.
// The local wrapper at sandbox-listen/picker.ts under test stays REAL.
vi.mock('../../sandbox/picker.js', () => ({
  pickSession: vi.fn(),
}));

import { pickSession as unifiedPick } from '../../sandbox/picker.js';
import { pickSession } from '../picker.js';
import type { InstagramSandboxSession } from '../../../api/sandbox-session.js';

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  senderInstagramId: '8745912038476523',
  accountInstagramId: '17841478719287768',
  senderInstagramUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

describe('sandbox-listen pickSession wrapper — forwards identifierArg to unified picker (D3)', () => {
  beforeEach(() => vi.mocked(unifiedPick).mockReset());

  it('passes identifierArg through to unifiedPick', async () => {
    vi.mocked(unifiedPick).mockResolvedValueOnce(ig);
    const result = await pickSession({
      sessions: [ig],
      identifierArg: '@ordvir',
      isHuman: false,
    });
    expect(result).toBe(ig);
    expect(vi.mocked(unifiedPick)).toHaveBeenCalledWith(
      expect.objectContaining({ identifierArg: '@ordvir' }),
    );
  });

  it('omits identifierArg when caller does not provide it (back-compat)', async () => {
    vi.mocked(unifiedPick).mockResolvedValueOnce(ig);
    await pickSession({
      sessions: [ig],
      phoneFlag: '+15551234567',
      isHuman: false,
    });
    const forwarded = vi.mocked(unifiedPick).mock.calls[0][0];
    expect(forwarded.identifierArg).toBeUndefined();
    expect(forwarded.phoneFlag).toBe('+15551234567');
  });
});
