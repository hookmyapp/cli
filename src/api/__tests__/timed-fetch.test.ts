import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  timedFetch,
  connectTimedFetch,
  DEFAULT_FETCH_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
} from '../timed-fetch.js';
import { isNetworkFailure } from '../client.js';

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

/** A server that accepts the connection and never answers — the AIT-540 shape. */
function neverAnswers() {
  return (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
}

describe('timedFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('attaches a timeout signal by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    await timedFetch('https://example.test/x');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("keeps a caller's own signal instead of replacing it", async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const mine = new AbortController().signal;
    await timedFetch('https://example.test/x', { signal: mine });
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBe(mine);
  });

  it('rejects with a TimeoutError that isNetworkFailure recognises', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(neverAnswers() as typeof fetch);
    const err = await timedFetch('https://example.test/x', {}, 10).catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
    // The whole timeout story: catch blocks already map network failures to
    // NetworkError, so recognising the abort here is all that is needed.
    expect(isNetworkFailure(err)).toBe(true);
  });

  it('budgets are ordered: a byte transfer gets more room than a JSON call', () => {
    expect(TRANSFER_TIMEOUT_MS).toBeGreaterThan(DEFAULT_FETCH_TIMEOUT_MS);
  });
});

describe('connectTimedFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does NOT abort the body once headers have arrived (SSE stays open)', async () => {
    let captured: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((_url: string, init: RequestInit) => {
      captured = init.signal ?? undefined;
      return Promise.resolve(okResponse());
    }) as typeof fetch);

    await connectTimedFetch('https://example.test/stream', {}, 10);
    // Well past the connect budget: a total timeout would have fired by now and
    // killed a working `text/event-stream` connection.
    await new Promise((r) => setTimeout(r, 40));
    expect(captured?.aborted).toBe(false);
  });

  it('aborts with a TimeoutError when headers never arrive', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(neverAnswers() as typeof fetch);
    const err = await connectTimedFetch('https://example.test/stream', {}, 10).catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
    expect(isNetworkFailure(err)).toBe(true);
  });

  it("keeps a caller's own signal instead of replacing it", async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const mine = new AbortController().signal;
    await connectTimedFetch('https://example.test/stream', { signal: mine });
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBe(mine);
  });
});
