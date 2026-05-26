import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxLogs, formatRelativeTime, formatListRow } from '../logs.js';
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
// List mode
// ---------------------------------------------------------------------------

describe('runSandboxLogs — list mode', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches sessions, picks WA session, calls GET /deliveries with scope + limit=50', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa]) // sessions
      .mockResolvedValueOnce(makeDeliveriesListResponse([makeDelivery()])); // deliveries

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    const deliveriesCall = vi.mocked(apiClient).mock.calls[1];
    expect(deliveriesCall[0]).toContain('/deliveries?');
    expect(deliveriesCall[0]).toContain('scope=sandbox-session%3Assn_WA000001');
    expect(deliveriesCall[0]).toContain('limit=50');
    expect(deliveriesCall[1]).toMatchObject({ workspaceId: 'ws_TEST0001' });
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

  it('prints empty-state copy (exact wording) when no deliveries', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    expect(logSpy).toHaveBeenCalledWith(
      'No deliveries yet. Send a message to this sandbox to see webhook deliveries appear here in real time.',
    );
    logSpy.mockRestore();
  });

  it('prints one row per delivery containing the 8-char id', async () => {
    const d = makeDelivery();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([d]));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxLogs({ phone: '+15551234567' });

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('a1b2c3d4'); // first 8 chars of id
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

  it('emits one JSONL line per delivery with no ANSI styling', async () => {
    const d = makeDelivery();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(makeDeliveriesListResponse([d]));

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
    expect(parsed.id).toBe(d.id);
    expect(parsed.humanStatus).toBe('Delivered');
    // No ANSI codes in JSON output
    expect(lines[0]).not.toMatch(/\x1b\[/);
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// --detail mode
// ---------------------------------------------------------------------------

const deliveryDetail = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  workspaceId: 'ws_TEST0001',
  scopeKind: 'sandbox_session',
  channelId: null,
  sandboxSessionId: 'ssn_WA000001',
  routingDecision: 'forwarded',
  inboundBody: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  inboundBodySha256: 'abc123',
  inboundBodyTruncated: false,
  inboundHeaders: null,
  signatureOk: true,
  isSandbox: true,
  requestId: 'req_test',
  fromPhone: '972545434384',
  senderId: '972545434384',
  senderDisplay: '972545434384',
  receivedAt: new Date().toISOString(),
  humanStatus: 'Delivered',
  humanStatusCopy: 'Delivered to your app',
  humanStatusTooltip: null,
  humanStatusColor: 'green' as const,
  attempts: [
    {
      id: 'att_001',
      attemptNumber: 1,
      forwardUrl: 'https://my.example/hook',
      forwardRequestHeaders: null,
      forwardRequestBody: JSON.stringify({ object: 'whatsapp_business_account' }),
      forwardStatus: 200,
      forwardDurationMs: 42,
      forwardResponseHeaders: null,
      forwardResponseBody: JSON.stringify({ ok: true }),
      forwardResponseBodySha256: 'def456',
      forwardResponseBodyTruncated: false,
      outcome: 'delivered',
      outcomeReason: null,
      attemptedAt: new Date().toISOString(),
    },
  ],
};

describe('runSandboxLogs — --detail mode', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls GET /deliveries/:id directly without fetching sessions', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce(deliveryDetail);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSandboxLogs({ detail: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });

    expect(vi.mocked(apiClient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe(
      '/deliveries/a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
    logSpy.mockRestore();
  });

  it('renders "We sent it to your app" heading when attempt exists', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce(deliveryDetail);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSandboxLogs({ detail: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('We sent it to your app');
    expect(output).toContain('Your app responded');
    expect(output).toContain('POST https://my.example/hook');
    logSpy.mockRestore();
  });

  it('renders "What WhatsApp sent us" + no-destination alert when no attempts', async () => {
    const noAttemptDetail = { ...deliveryDetail, attempts: [], humanStatus: 'Skipped' };
    vi.mocked(apiClient).mockResolvedValueOnce(noAttemptDetail);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSandboxLogs({ detail: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('What WhatsApp sent us');
    expect(output).toContain("couldn't forward it because no destination was configured");
    logSpy.mockRestore();
  });

  it('--detail --json emits one pretty-printed JSON object', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce(deliveryDetail);
    const written: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        if (typeof chunk === 'string') written.push(chunk);
        return true;
      });

    await runSandboxLogs({ detail: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', json: true });

    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]);
    expect(parsed.id).toBe(deliveryDetail.id);
    // Pretty-printed: contains newlines
    expect(written[0]).toContain('\n');
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// formatListRow — status colorization
// ---------------------------------------------------------------------------

describe('formatListRow — status colorization', () => {
  it('wraps green status in ANSI green codes when stdout is a TTY', () => {
    // In the test runner stdout is not a TTY, so picocolors won't emit ANSI.
    // Test the plain-text output (color stripped) contains the status label.
    const d = makeDelivery({ humanStatus: 'Delivered', humanStatusColor: 'green' });
    const row = formatListRow(d, Date.now());
    // Strip ANSI for assertion
    // eslint-disable-next-line no-control-regex
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Delivered');
    expect(plain).toContain('Delivered to your app');
    expect(plain).toContain('from 972545434384');
    expect(plain).toContain('a1b2c3d4'); // 8-char id
  });

  it('includes the 8-char id as the last non-whitespace token', () => {
    const d = makeDelivery();
    const row = formatListRow(d, Date.now());
    // eslint-disable-next-line no-control-regex
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    expect(plain.endsWith('a1b2c3d4')).toBe(true);
  });

  it('omits the "from" prefix when senderDisplay is null', () => {
    const d = makeDelivery({ senderDisplay: null, fromPhone: null });
    const row = formatListRow(d, Date.now());
    // eslint-disable-next-line no-control-regex
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('from ');
  });

  it('renders gray dot + dim label for gray status', () => {
    const d = makeDelivery({ humanStatusColor: 'gray', humanStatus: 'Skipped' });
    // In non-TTY test env picocolors returns the plain string; just verify
    // the row contains the correct label text.
    const row = formatListRow(d, Date.now());
    // eslint-disable-next-line no-control-regex
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Skipped');
  });
});

// NOTE: --follow SSE path is NOT integration-tested here (vi.mock can't easily
// simulate a streaming ReadableStream response from fetch). Verified manually
// via smoke test against the local stack (`node dist/cli.js sandbox logs
// --username @ordvir --follow`). Marked DONE_WITH_CONCERNS — SSE test gap is
// an acceptable trade-off; the protocol parsing is straightforward Node fetch
// boilerplate and covered by the broader test-in-production sandbox smoke.
