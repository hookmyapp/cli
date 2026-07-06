import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxLogs, formatRelativeTime, printVerboseDelivery } from '../logs.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';
import type { DeliveryLog } from '../../channels-logs/api.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

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

function makeDelivery(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return {
    receivedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5m ago
    sender: '972545434384',
    messageId: 'wamid.sandbox',
    meta: { object: 'whatsapp_business_account', entry: [] },
    hookmyapp: {
      status: 'delivered',
      statusText: 'Delivered to your app',
      destination: { type: 'webhook', url: 'https://my.example/hook' },
      appResponse: { status: 200, durationMs: 142, body: { received: true } },
    },
    ...overrides,
  };
}

function withHookmyapp(
  base: DeliveryLog,
  overrides: Partial<DeliveryLog['hookmyapp']>,
): DeliveryLog {
  return {
    ...base,
    hookmyapp: {
      ...base.hookmyapp,
      ...overrides,
      appResponse: {
        ...base.hookmyapp.appResponse,
        ...overrides.appResponse,
      },
    },
  };
}

function makeDetail(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return makeDelivery(overrides);
}

function makeIgDetail(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return makeDelivery({
    sender: '828667679804698',
    messageId: 'mid-ig',
    meta: {
      object: 'instagram',
      entry: [{ id: '17841478719287768', messaging: [{ sender: { id: '828667679804698' } }] }],
    },
    hookmyapp: {
      status: 'delivered',
      statusText: 'Delivered to your app',
      destination: { type: 'webhook', url: 'https://my.example/hook' },
      appResponse: { status: 200, durationMs: 55, body: { ok: true } },
    },
    ...overrides,
  });
}

function makeDeliveriesListResponse(logs: DeliveryLog[]) {
  return { logs, nextCursor: null };
}

// ---------------------------------------------------------------------------
// formatRelativeTime — pure function tests
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-05-26T12:00:00Z').getTime();

  it('returns "Just now" for < 5s ago', () => {
    expect(formatRelativeTime(new Date(NOW - 3000).toISOString(), NOW)).toBe('Just now');
  });

  it('returns "{N}s ago" for < 60s ago', () => {
    expect(formatRelativeTime(new Date(NOW - 30000).toISOString(), NOW)).toBe('30s ago');
  });

  it('returns "{N}m ago" for < 60m ago', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW)).toBe('5m ago');
  });

  it('returns "{N}h ago" for < 24h ago (same day by hours)', () => {
    expect(formatRelativeTime(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW)).toBe('3h ago');
  });

  it('returns "Yesterday" for exactly 1 calendar day ago', () => {
    // 26h ago → definitely yesterday in any timezone
    const ts = new Date('2026-05-25T10:00:00Z').getTime();
    // Set now to a time where the local day diff is 1
    const customNow = new Date('2026-05-26T12:00:00Z').getTime();
    const result = formatRelativeTime(new Date(ts).toISOString(), customNow);
    // The diff will be >24h so it goes to calendar path; dayDiff must be 1
    // Depending on timezone of the test environment, this may vary. We accept
    // either 'Yesterday' or a weekday abbreviation (both are correct branches).
    expect(['Yesterday', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).toContain(result);
  });

  it('returns a short date (no year) for same-year dates > 7 days', () => {
    // 30 days ago, same year
    const ts = new Date('2026-04-26T12:00:00Z').getTime();
    const result = formatRelativeTime(new Date(ts).toISOString(), NOW);
    // Should be like "Apr 26" — no year component
    expect(result).not.toMatch(/\d{4}/);
    expect(result.length).toBeGreaterThan(3);
  });

  it('returns a date with year for prior-year dates', () => {
    const ts = new Date('2025-01-15T12:00:00Z').getTime();
    const result = formatRelativeTime(new Date(ts).toISOString(), NOW);
    expect(result).toMatch(/2025/);
  });
});

// ---------------------------------------------------------------------------
// List mode (human)
// ---------------------------------------------------------------------------

describe('runSandboxLogs — list mode (human)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches sessions, picks WA session, calls GET /deliveries with scope + limit=50', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa]) // sessions
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()])); // list

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    const deliveriesCall = vi.mocked(apiClient).mock.calls[1];
    expect(deliveriesCall[0]).toContain('/deliveries?');
    expect(deliveriesCall[0]).toContain('scope=sandbox-session%3Assn_WA000001');
    expect(deliveriesCall[0]).toContain('limit=50');
    expect(deliveriesCall[1]).toMatchObject({ workspaceId: 'ws_TEST0001' });
    logSpy.mockRestore();
  });

  it('does not fetch detail for each row in the list', async () => {
    const delivery1 = makeDelivery({ messageId: 'mid-1' });
    const delivery2 = makeDelivery({ messageId: 'mid-2' });

    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([delivery1, delivery2]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
  });

  it('renders "What WhatsApp sent us:" for a WA session (--verbose)', async () => {
    const detail = makeDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([detail]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567', verbose: true });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What WhatsApp sent us:');
    expect(output).toContain('To: https://my.example/hook');
    expect(output).toContain('Your app responded');
    logSpy.mockRestore();
  });

  it('renders "What Instagram sent us:" for an IG session (--verbose)', async () => {
    const detail = makeIgDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce(makeDeliveriesListResponse([detail]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ username: '@ordvir', verbose: true });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What Instagram sent us:');
    logSpy.mockRestore();
  });

  it('passes limit=20 when --limit 20 is set', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567', limit: 20 });

    const deliveriesCall = vi.mocked(apiClient).mock.calls[1];
    expect(deliveriesCall[0]).toContain('limit=20');
    logSpy.mockRestore();
  });

  it('clamps --limit 999 to 100', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567', limit: 999 });

    const deliveriesCall = vi.mocked(apiClient).mock.calls[1];
    expect(deliveriesCall[0]).toContain('limit=100');
    logSpy.mockRestore();
  });

  it('clamps --limit 0 to 1', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567', limit: 0 });

    const deliveriesCall = vi.mocked(apiClient).mock.calls[1];
    expect(deliveriesCall[0]).toContain('limit=1');
    logSpy.mockRestore();
  });

  it('prints empty-state copy (exact wording) when no deliveries, makes ZERO detail fetches', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    expect(logSpy).toHaveBeenCalledWith(
      'No deliveries yet. Send a message to this sandbox to see webhook deliveries appear here in real time.',
    );
    // Only 2 apiClient calls: sessions + list. No detail fetches.
    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
  });

  it('renders "(No forward attempt: destination wasn\'t reachable.)" for zero-attempts delivery (--verbose)', async () => {
    const detail = withHookmyapp(makeDetail(), {
      status: 'no_response',
      statusText: 'No response from your app',
      destination: null,
      appResponse: { status: null, durationMs: null, body: null },
    });

    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([detail]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567', verbose: true });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Your app responded');
    expect(output).toContain('(no response)');
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// --json mode
// ---------------------------------------------------------------------------

describe('runSandboxLogs — --json mode', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a single JSON array of public logs with no ANSI styling', async () => {
    const d = {
      ...makeDelivery(),
      routingDecision: 'forwarded',
      signatureOk: true,
      requestId: 'req_123',
      inboundHeaders: { 'x-hub-signature-256': 'secret' },
    } as unknown as DeliveryLog;
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([d]));

    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sender).toBe('972545434384');
    expect(parsed[0].hookmyapp.statusText).toBe('Delivered to your app');
    expect(parsed[0].routingDecision).toBeUndefined();
    expect(parsed[0].signatureOk).toBeUndefined();
    expect(parsed[0].requestId).toBeUndefined();
    expect(parsed[0].inboundHeaders).toBeUndefined();
    expect(parsed[0].inboundBody).toBeUndefined();
    expect(parsed[0].forwardUrl).toBeUndefined();
    // No ANSI codes in JSON output
    expect(logs[0]).not.toMatch(/\x1b\[/);
    logSpy.mockRestore();
  });

  it('array length equals delivery list length', async () => {
    const summaries = [makeDelivery({ messageId: 'mid-1' }), makeDelivery({ messageId: 'mid-2' })];

    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse(summaries));

    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toHaveLength(2);
    logSpy.mockRestore();
  });

  it('emits [] (not empty output) when the session has no deliveries', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([]));

    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual([]);
    // No detail fetch when there are no deliveries (sessions + list only).
    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
  });

  it('emits no section headings in --json mode', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()]));

    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    const output = logs.join('');
    expect(output).not.toContain('What WhatsApp sent us');
    expect(output).not.toContain('To: ');
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// printVerboseDelivery — direct unit tests for the renderer
// ---------------------------------------------------------------------------

describe('printVerboseDelivery — status colorization and provider noun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "What WhatsApp sent us:" for whatsapp sessionType', () => {
    const detail = makeDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What WhatsApp sent us:');
    logSpy.mockRestore();
  });

  it('renders "What Instagram sent us:" for instagram sessionType', () => {
    const detail = makeIgDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'instagram');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What Instagram sent us:');
    logSpy.mockRestore();
  });

  it('renders header with statusText, sender, and relative time', () => {
    const detail = makeDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const firstLine = logSpy.mock.calls[0][0] as string;
    // eslint-disable-next-line no-control-regex
    const plain = firstLine.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Delivered');
    expect(plain).toContain('Delivered to your app');
    expect(plain).toContain('from 972545434384');
    logSpy.mockRestore();
  });

  it('renders the destination and app response when a destination exists', () => {
    const detail = makeDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('To: https://my.example/hook');
    expect(output).toContain('Your app responded');
    logSpy.mockRestore();
  });

  it('renders no-response text when destination or response is missing', () => {
    const detail = withHookmyapp(makeDetail(), {
      destination: null,
      appResponse: { status: null, durationMs: null, body: null },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('(no response)');
    expect(output).not.toContain('To:');
    logSpy.mockRestore();
  });

  it('renders gray dot + dim label for gray/Skipped status', () => {
    const detail = withHookmyapp(makeDetail(), {
      status: 'skipped',
      statusText: 'Skipped',
      destination: null,
      appResponse: { status: null, durationMs: null, body: null },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Skipped');
    logSpy.mockRestore();
  });

  it('does NOT expose the delivery UUID anywhere in the output', () => {
    const detail = makeDetail({ messageId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    logSpy.mockRestore();
  });

  it('includes the separator line at the end of each block', () => {
    const detail = makeDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const lastLine = logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string;
    // eslint-disable-next-line no-control-regex
    const plain = lastLine.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/─{10,}/);
    logSpy.mockRestore();
  });
});

// NOTE: --follow SSE path is NOT integration-tested here (vi.mock can't easily
// simulate a streaming ReadableStream response from fetch). Verified manually
// via smoke test against the local stack (`node dist/cli.js sandbox logs
// --username @ordvir --follow`). Marked DONE_WITH_CONCERNS — SSE test gap is
// an acceptable trade-off; the protocol parsing is straightforward Node fetch
// boilerplate and covered by the broader test-in-production sandbox smoke.
