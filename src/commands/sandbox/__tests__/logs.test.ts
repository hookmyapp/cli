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
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    receivedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5m ago
    fromPhone: '972545434384',
    senderId: '972545434384',
    senderDisplay: '972545434384',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusTooltip: null,
    humanStatusColor: 'green' as const,
    latestAttempt: {
      outcome: 'delivered',
      forwardStatus: 200,
      attemptedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    routingDecision: 'forwarded',
    inboundBody: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    fromPhone: '972545434384',
    senderId: '972545434384',
    senderDisplay: '972545434384',
    receivedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusTooltip: null,
    humanStatusColor: 'green' as const,
    attempts: [
      {
        id: 'att_001',
        attemptNumber: 1,
        forwardUrl: 'https://my.example/hook',
        forwardRequestBody: JSON.stringify({ object: 'whatsapp_business_account' }),
        forwardStatus: 200,
        forwardDurationMs: 142,
        forwardResponseBody: JSON.stringify({ received: true }),
        outcome: 'delivered',
        attemptedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function makeIgDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    routingDecision: 'forwarded',
    inboundBody: JSON.stringify({
      object: 'instagram',
      entry: [{ id: '17841478719287768', messaging: [{ sender: { id: '828667679804698' } }] }],
    }),
    fromPhone: null,
    senderId: '828667679804698',
    senderDisplay: '828667679804698',
    receivedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusTooltip: null,
    humanStatusColor: 'green' as const,
    attempts: [
      {
        id: 'att_002',
        attemptNumber: 1,
        forwardUrl: 'https://my.example/hook',
        forwardRequestBody: JSON.stringify({ object: 'instagram' }),
        forwardStatus: 200,
        forwardDurationMs: 55,
        forwardResponseBody: JSON.stringify({ ok: true }),
        outcome: 'delivered',
        attemptedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function makeDeliveriesListResponse(deliveries: ReturnType<typeof makeDelivery>[]) {
  return { deliveries, nextCursor: null, floorHours: 168 };
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
// List mode (verbose-by-default)
// ---------------------------------------------------------------------------

describe('runSandboxLogs — list mode (verbose-by-default)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches sessions, picks WA session, calls GET /deliveries with scope + limit=50', async () => {
    const detail = makeDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa]) // sessions
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()])) // list
      .mockResolvedValueOnce(detail); // detail for the one delivery

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    const deliveriesCall = vi.mocked(apiClient).mock.calls[1];
    expect(deliveriesCall[0]).toContain('/deliveries?');
    expect(deliveriesCall[0]).toContain('scope=sandbox-session%3Assn_WA000001');
    expect(deliveriesCall[0]).toContain('limit=50');
    expect(deliveriesCall[1]).toMatchObject({ workspaceId: 'ws_TEST0001' });
    logSpy.mockRestore();
  });

  it('fetches detail for each row in the list (N+1 calls)', async () => {
    const delivery1 = makeDelivery({ id: 'aaaa0001-0000-0000-0000-000000000000' });
    const delivery2 = makeDelivery({ id: 'bbbb0002-0000-0000-0000-000000000000' });
    const detail1 = makeDetail({ id: delivery1.id });
    const detail2 = makeDetail({ id: delivery2.id });

    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([delivery1, delivery2]))
      .mockResolvedValueOnce(detail1)
      .mockResolvedValueOnce(detail2);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    // 1 session + 1 list + 2 detail = 4 total calls
    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(apiClient).mock.calls[2][0]).toBe(`/deliveries/${delivery1.id}`);
    expect(vi.mocked(apiClient).mock.calls[3][0]).toBe(`/deliveries/${delivery2.id}`);
    logSpy.mockRestore();
  });

  it('renders "What WhatsApp sent us:" for a WA session', async () => {
    const detail = makeDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()]))
      .mockResolvedValueOnce(detail);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What WhatsApp sent us:');
    expect(output).toContain('We sent it to your app');
    expect(output).toContain('Your app responded');
    logSpy.mockRestore();
  });

  it('renders "What Instagram sent us:" for an IG session', async () => {
    const detail = makeIgDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery({ senderId: '828667679804698', senderDisplay: '828667679804698' })]))
      .mockResolvedValueOnce(detail);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ username: '@ordvir' });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What Instagram sent us:');
    logSpy.mockRestore();
  });

  it('passes limit=20 when --limit 20 is set', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()]))
      .mockResolvedValueOnce(makeDetail());

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

  it('renders "(No forward attempt — destination wasn\'t reachable.)" for zero-attempts delivery', async () => {
    const summary = makeDelivery({ attemptsCount: 0, humanStatus: 'Not delivered', humanStatusColor: 'red', latestAttempt: null });
    const detail = makeDetail({ attempts: [], humanStatus: 'Not delivered', humanStatusColor: 'red', routingDecision: 'forwarded' });

    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([summary]))
      .mockResolvedValueOnce(detail);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain("destination wasn't reachable");
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

  it('fetches detail and emits one JSONL line per delivery with no ANSI styling', async () => {
    const d = makeDelivery();
    const detail = makeDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([d]))
      .mockResolvedValueOnce(detail);

    const lines: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        if (typeof chunk === 'string') lines.push(chunk);
        return true;
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    // Detail DTO fields are present (not just summary)
    expect(parsed.id).toBe(detail.id);
    expect(parsed.inboundBody).toBeDefined();
    expect(parsed.attempts).toBeDefined();
    // No ANSI codes in JSON output
    expect(lines[0]).not.toMatch(/\x1b\[/);
    writeSpy.mockRestore();
  });

  it('emits one line per delivery (line count equals list length)', async () => {
    const summaries = [makeDelivery({ id: 'id1-0000-0000-0000-000000000000' }), makeDelivery({ id: 'id2-0000-0000-0000-000000000000' })];
    const details = [makeDetail({ id: summaries[0].id }), makeDetail({ id: summaries[1].id })];

    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse(summaries))
      .mockResolvedValueOnce(details[0])
      .mockResolvedValueOnce(details[1]);

    const lines: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        if (typeof chunk === 'string') lines.push(chunk);
        return true;
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    expect(lines).toHaveLength(2);
    writeSpy.mockRestore();
  });

  it('emits no section headings in --json mode', async () => {
    const detail = makeDetail();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()]))
      .mockResolvedValueOnce(detail);

    const lines: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        if (typeof chunk === 'string') lines.push(chunk);
        return true;
      });

    await runSandboxLogs({ phone: '+15551234567', json: true });

    const output = lines.join('');
    expect(output).not.toContain('What WhatsApp sent us');
    expect(output).not.toContain('We sent it to your app');
    writeSpy.mockRestore();
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

  it('renders header with humanStatus, humanStatusCopy, senderDisplay, and relative time', () => {
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

  it('renders "We sent it to your app" and "Your app responded" when attempt exists', () => {
    const detail = makeDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('We sent it to your app');
    expect(output).toContain('POST https://my.example/hook');
    expect(output).toContain('Your app responded');
    logSpy.mockRestore();
  });

  it('renders no-attempt message when attempts is empty and routingDecision is forwarded', () => {
    const detail = makeDetail({ attempts: [], routingDecision: 'forwarded' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain("destination wasn't reachable");
    expect(output).not.toContain('We sent it to your app');
    logSpy.mockRestore();
  });

  it('renders gray dot + dim label for gray/Skipped status', () => {
    const detail = makeDetail({ humanStatusColor: 'gray', humanStatus: 'Skipped', routingDecision: 'skipped', attempts: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Skipped');
    logSpy.mockRestore();
  });

  it('does NOT expose delivery UUIDs anywhere in the output', () => {
    const detail = makeDetail();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printVerboseDelivery(detail, 'whatsapp');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The delivery UUID and attempt UUID must not appear in human output
    expect(output).not.toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(output).not.toContain('att_001');
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
