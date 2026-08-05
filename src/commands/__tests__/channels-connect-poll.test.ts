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
  whatsappWabaName: 'New WABA', whatsappDisplayPhoneNumber: '+15551234567', whatsappPhoneNumberId: '1080',
  whatsappVerifiedName: 'Test', whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
  updatedAt: '2026-05-26T18:30:00.000Z',
};
const ig = {
  id: 'ch_NEW_IG', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'newhandle', instagramProfileName: 'New', instagramProfilePictureUrl: null,
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
      whatsappWabaName: null, whatsappDisplayPhoneNumber: null, whatsappPhoneNumberId: null,
      whatsappVerifiedName: null, whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
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
      whatsappWabaName: 'Existing WABA', whatsappDisplayPhoneNumber: '+15550000001', whatsappPhoneNumberId: '999',
      whatsappVerifiedName: 'Existing', whatsappQualityRating: 'GREEN', whatsappQualityRatingCheckedAt: null,
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

  it('legacy backend (no updatedAt on DTO): existing channel ignored even if row updated → falls back to id-diff, keeps waiting', async () => {
    const reauthedNoTimestamp = {
      id: 'ch_REAUTH', type: 'whatsapp', workspaceId: 'ws_TEST0001',
      metaWabaId: '1', metaResourceId: '1', connectionType: 'cloud_api',
      metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
      whatsappWabaName: 'Existing WABA', whatsappDisplayPhoneNumber: '+15550000001', whatsappPhoneNumberId: '999',
      whatsappVerifiedName: 'Existing', whatsappQualityRating: 'GREEN', whatsappQualityRatingCheckedAt: null,
      // updatedAt deliberately absent (older backend)
    };
    vi.mocked(apiClient).mockResolvedValue([reauthedNoTimestamp]);
    const snapshot = new Map<string, string | undefined>([
      ['ch_REAUTH', undefined], // older snapshot had no updatedAt either
    ]);
    let settled = false;
    const promise = pollForNewChannels('ws_TEST0001', snapshot);
    void promise.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false); // existing channel never reported; still polling
  }, 30_000);

  it('no hard timeout (AIT-334): resolves with a channel arriving after 6 minutes instead of rejecting at 5', async () => {
    vi.mocked(apiClient).mockResolvedValue([]); // nothing new for the first 6 min
    const promise = pollForNewChannels('ws_TEST0001', new Map());
    // Advance in 30s chunks to amortize microtask drain (each iteration
    // awaits the mocked apiClient promise before the next setTimeout).
    for (let elapsed = 0; elapsed < 6 * 60 * 1000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    vi.mocked(apiClient).mockResolvedValue([wa]); // OAuth finally completed
    await vi.advanceTimersByTimeAsync(2000); // poll picks it up
    await vi.advanceTimersByTimeAsync(4000); // stability window
    const result = await promise;
    expect(result.map((c) => c.id)).toEqual(['ch_NEW_WA']);
  }, 30_000);

  it('fires onStillWaiting roughly every 30s while nothing has appeared, then stops once a channel shows', async () => {
    vi.mocked(apiClient).mockResolvedValue([]);
    const hints: number[] = [];
    const promise = pollForNewChannels('ws_TEST0001', new Map(), (ms) => hints.push(ms));
    await vi.advanceTimersByTimeAsync(70_000); // ~2 hint intervals
    expect(hints.length).toBe(2);
    vi.mocked(apiClient).mockResolvedValue([wa]);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await promise;
  }, 30_000);
});
