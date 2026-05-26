// src/commands/__tests__/channels-connect-poll.test.ts
//
// CRITICAL: this file does NOT mock '../channels-connect-poll.js' —
// we want to test the REAL polling loop. The sibling test file
// (channels-connect.test.ts) DOES mock it, which is why these tests
// have to live separately.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));

import { apiClient } from '../../api/client.js';
import { pollForNewChannels } from '../channels-connect-poll.js';

const wa = {
  id: 'ch_NEW_WA', type: 'whatsapp', workspaceId: 'ws_TEST0001',
  metaWabaId: '1179', metaResourceId: '1080', connectionType: 'cloud_api',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  wabaName: 'New WABA', displayPhoneNumber: '+15551234567', phoneNumberId: '1080',
  phoneVerifiedName: 'Test', qualityRating: null, qualityRatingCheckedAt: null,
  updatedAt: '2026-05-26T18:30:00.000Z',
};
const ig = {
  id: 'ch_NEW_IG', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'newhandle', instagramName: 'New', instagramProfilePictureUrl: null,
  updatedAt: '2026-05-26T18:30:01.000Z',
};

describe('pollForNewChannels — D2 acceptance criteria', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('returns BOTH channels appearing within the 4s stability window', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])           // poll 1: WA appeared
      .mockResolvedValueOnce([wa, ig])       // poll 2: IG appeared (within 4s of WA)
      .mockResolvedValueOnce([wa, ig])       // poll 3: stable
      .mockResolvedValueOnce([wa, ig]);      // poll 4: stable → exit
    const promise = pollForNewChannels('ws_TEST0001', new Map());
    await vi.advanceTimersByTimeAsync(2000); // poll 1
    await vi.advanceTimersByTimeAsync(2000); // poll 2 → stability window resets
    await vi.advanceTimersByTimeAsync(2000); // poll 3 → window started after IG
    await vi.advanceTimersByTimeAsync(2000); // poll 4 → 4s stable → exit
    const result = await promise;
    expect(result.map((c) => c.id).sort()).toEqual(['ch_NEW_IG', 'ch_NEW_WA']);
  });

  it('race-safe: a channel already in the snapshot (unchanged updatedAt) is NOT included in the result', async () => {
    // Full preExisting fixture used in EVERY poll response — pollForNewChannels
    // calls parseChannelListItem on every DTO before filtering by snapshot,
    // so each row must pass shape validation. Partial { id: 'ch_X' } stubs
    // would throw MALFORMED_CHANNEL and the test would fail for the wrong reason.
    const preExisting = {
      id: 'ch_PRE_EXISTING', type: 'whatsapp', workspaceId: 'ws_TEST0001',
      metaWabaId: '1', metaResourceId: '1', connectionType: 'cloud_api',
      metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
      wabaName: null, displayPhoneNumber: null, phoneNumberId: null,
      phoneVerifiedName: null, qualityRating: null, qualityRatingCheckedAt: null,
      updatedAt: '2026-05-26T18:00:00.000Z',
    };
    vi.mocked(apiClient)
      .mockResolvedValueOnce([preExisting, wa])
      .mockResolvedValueOnce([preExisting, wa])
      .mockResolvedValueOnce([preExisting, wa]);
    const snapshot = new Map<string, string | undefined>([
      ['ch_PRE_EXISTING', '2026-05-26T18:00:00.000Z'],
    ]);
    const promise = pollForNewChannels('ws_TEST0001', snapshot);
    await vi.advanceTimersByTimeAsync(2000); // poll 1: wa is new
    await vi.advanceTimersByTimeAsync(2000); // poll 2: stable
    await vi.advanceTimersByTimeAsync(2000); // poll 3: 4s stable → exit
    const result = await promise;
    expect(result.map((c) => c.id)).toEqual(['ch_NEW_WA']);
    expect(result.map((c) => c.id)).not.toContain('ch_PRE_EXISTING');
  });

  it('detects re-auth of existing channel: updatedAt advanced past snapshot → returned as "interesting"', async () => {
    const reauthed = {
      id: 'ch_REAUTH', type: 'whatsapp', workspaceId: 'ws_TEST0001',
      metaWabaId: '1', metaResourceId: '1', connectionType: 'cloud_api',
      metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
      wabaName: 'Existing WABA', displayPhoneNumber: '+15550000001', phoneNumberId: '999',
      phoneVerifiedName: 'Existing', qualityRating: 'GREEN', qualityRatingCheckedAt: null,
      updatedAt: '2026-05-26T18:30:00.000Z', // BUMPED past snapshot
    };
    vi.mocked(apiClient)
      .mockResolvedValueOnce([reauthed])
      .mockResolvedValueOnce([reauthed])
      .mockResolvedValueOnce([reauthed]);
    const snapshot = new Map<string, string | undefined>([
      ['ch_REAUTH', '2026-05-26T18:00:00.000Z'], // PRE-OAuth value
    ]);
    const promise = pollForNewChannels('ws_TEST0001', snapshot);
    await vi.advanceTimersByTimeAsync(2000); // poll 1: updatedAt advanced
    await vi.advanceTimersByTimeAsync(2000); // poll 2: stable
    await vi.advanceTimersByTimeAsync(2000); // poll 3: 4s stable → exit
    const result = await promise;
    expect(result.map((c) => c.id)).toEqual(['ch_REAUTH']);
  });

  it('legacy backend (no updatedAt on DTO): existing channel ignored even if row updated → falls back to id-diff', async () => {
    const reauthedNoTimestamp = {
      id: 'ch_REAUTH', type: 'whatsapp', workspaceId: 'ws_TEST0001',
      metaWabaId: '1', metaResourceId: '1', connectionType: 'cloud_api',
      metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
      wabaName: 'Existing WABA', displayPhoneNumber: '+15550000001', phoneNumberId: '999',
      phoneVerifiedName: 'Existing', qualityRating: 'GREEN', qualityRatingCheckedAt: null,
      // updatedAt deliberately absent (older backend)
    };
    vi.mocked(apiClient).mockResolvedValue([reauthedNoTimestamp]);
    const snapshot = new Map<string, string | undefined>([
      ['ch_REAUTH', undefined], // older snapshot had no updatedAt either
    ]);
    const promise = pollForNewChannels('ws_TEST0001', snapshot);
    promise.catch(() => {});
    for (let elapsed = 0; elapsed < 5 * 60 * 1000 + 1000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await expect(promise).rejects.toThrow(/No channels appeared within 5 minutes/);
  }, 30_000);

  it('rejects with CONNECT_TIMEOUT after 5 minutes of no new channels', async () => {
    vi.mocked(apiClient).mockResolvedValue([]); // every poll returns no new channels
    const promise = pollForNewChannels('ws_TEST0001', new Map());
    // Attach a no-op catch synchronously so an unhandled rejection cannot
    // bubble while we're advancing fake timers iteration-by-iteration. The
    // real assertion is still done via `await expect(...).rejects.toThrow`
    // below.
    promise.catch(() => {});
    // 150 iterations × 2000ms of fake-timer advance need a generous real-time
    // budget because each iteration drains microtasks (the awaited apiClient
    // mock promise) before the next setTimeout resolves. Vitest's default
    // 5s test timeout is real-wall-clock and trips before the fake-time
    // 5min loop completes. Advance in 30s chunks to amortize microtask drain.
    for (let elapsed = 0; elapsed < 5 * 60 * 1000 + 1000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await expect(promise).rejects.toThrow(/No channels appeared within 5 minutes/);
  }, 30_000);
});
