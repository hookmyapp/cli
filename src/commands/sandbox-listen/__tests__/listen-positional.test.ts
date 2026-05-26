// Task A4 — regression test for `sandbox listen` positional `[identifier]`.
//
// Asserts that the LOCAL wrapper at `sandbox-listen/picker.ts` forwards
// `identifierArg` through to the unified picker. The deeper shape-detection
// behavior (phone/username/sessionId routing) is covered by the unified
// picker tests at `src/commands/sandbox/__tests__/picker.test.ts` (A2).
//
// We mock the wrapper itself to keep this test from driving the full tunnel
// + heartbeat flow — the goal is contract: index.ts → picker.ts → unifiedPick
// without dropping `identifierArg`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../picker.js', async () => {
  const actual = await vi.importActual<typeof import('../picker.js')>('../picker.js');
  return { ...actual, pickSession: vi.fn() };
});

import { pickSession } from '../picker.js';
import type { InstagramSandboxSession } from '../../../api/sandbox-session.js';

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '1907',
  instagramAccountId: '1784',
  instagramSenderUsername: 'ordvir',
  accessToken: 'tok',
  hmacSecret: 'hmac',
  status: 'active',
  origin: 'demo_handoff',
};

describe('sandbox-listen picker — positional identifier forwarding (D3)', () => {
  beforeEach(() => vi.mocked(pickSession).mockReset());

  it('passes identifierArg through to the unified picker', async () => {
    vi.mocked(pickSession).mockResolvedValueOnce(ig);

    const result = await pickSession({
      sessions: [ig],
      identifierArg: '@ordvir',
      isHuman: false,
    });

    expect(result).toBe(ig);
    expect(vi.mocked(pickSession)).toHaveBeenCalledWith(
      expect.objectContaining({ identifierArg: '@ordvir' }),
    );
  });
});
