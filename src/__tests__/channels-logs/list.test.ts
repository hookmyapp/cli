import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  apiClient: vi.fn(),
  resolveChannel: vi.fn(),
  getDefaultWorkspaceId: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  apiClient: mocks.apiClient,
  setWorkspaceContext: vi.fn(),
}));
vi.mock('../../commands/channels.js', () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock('../../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: mocks.getDefaultWorkspaceId,
}));

import { registerChannelsLogsCommand } from '../../commands/channels-logs/index.js';
import { ValidationError } from '../../output/error.js';

function listItem(id: string) {
  return {
    id,
    receivedAt: new Date().toISOString(),
    fromPhone: '+14155550100',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusColor: 'green',
    latestAttempt: { outcome: 'delivered', forwardStatus: 200, attemptedAt: new Date().toISOString() },
  };
}

/**
 * DeliveryDetail factory mirroring the wire shape for /deliveries/:id.
 * Default-mode and --json mode both fetch detail per row (N+1) post-B11, so
 * tests that exercise either need to mock the detail response too.
 */
function detailItem(id: string) {
  return {
    id,
    workspaceId: 'ws_w1',
    scopeKind: 'channel',
    channelId: 'chan-uuid',
    sandboxSessionId: null,
    providerObject: 'whatsapp_business_account',
    providerResourceId: 'r1',
    metaMessageId: null,
    inboundBody: '{"text":"hi"}',
    inboundBodySha256: 'sha',
    inboundBodyTruncated: false,
    inboundHeaders: null,
    signatureOk: true,
    routingDecision: 'forwarded',
    isSandbox: false,
    requestId: 'req1',
    fromPhone: '+14155550100',
    senderDisplay: '+14155550100',
    senderId: '14155550100',
    receivedAt: new Date().toISOString(),
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusTooltip: null,
    humanStatusColor: 'green',
    attempts: [
      {
        id: 'a1',
        attemptNumber: 1,
        forwardUrl: 'https://customer.app/webhook',
        forwardRequestHeaders: null,
        forwardRequestBody: null,
        forwardStatus: 200,
        forwardDurationMs: 100,
        forwardResponseHeaders: null,
        forwardResponseBody: null,
        forwardResponseBodySha256: null,
        forwardResponseBodyTruncated: false,
        outcome: 'delivered',
        outcomeReason: null,
        attemptedAt: new Date().toISOString(),
      },
    ],
  };
}

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'json');
  const channels = program.command('channels');
  registerChannelsLogsCommand(channels, program);
  await program.parseAsync(['node', 'hookmyapp', 'channels', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveChannel.mockResolvedValue({ id: 'ch_abc12345', workspaceId: 'ws_w1' });
  mocks.getDefaultWorkspaceId.mockResolvedValue('ws_w1');
});

describe('channels logs list', () => {
  it('prints one summary row per delivery in default mode (D9 — table-by-default)', async () => {
    // Default mode (no --verbose, no --json) now emits one-line summary rows
    // via process.stdout.write (printSummaryRow), not console.log. Each row is
    // a detail fetch (N+1) — same pattern as sandbox/logs.ts.
    mocks.apiClient
      .mockResolvedValueOnce({
        deliveries: [listItem('row-aaa'), listItem('row-bbb')],
        nextCursor: null,
        floorHours: 168,
      })
      .mockResolvedValueOnce(detailItem('row-aaa'))
      .mockResolvedValueOnce(detailItem('row-bbb'));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await run(['logs', 'list', 'ch_abc12345']);

    const combined = writes.join('');
    expect(combined).toContain('customer.app'); // target host in summary
    expect(combined).toContain('"hi"'); // body preview
    // Two summary rows were emitted.
    expect(writes.filter((w) => w.includes('customer.app'))).toHaveLength(2);
  });

  it('emits one JSONL line per delivery under --json (contract change in 0.13.0)', async () => {
    // BREAKING CHANGE vs 0.12.x: --json was a pretty-printed dump of the raw
    // /deliveries page; it is now JSONL — one full DeliveryDetail per line,
    // with GUI-only humanStatusTooltip + humanStatusColor stripped. Mirrors
    // sandbox/logs.ts contract (D8 + plan B11).
    const fullDetail = {
      id: 'row-aaa',
      workspaceId: 'ws_w1',
      scopeKind: 'channel',
      channelId: 'chan-uuid',
      sandboxSessionId: null,
      providerObject: 'whatsapp_business_account',
      providerResourceId: 'r1',
      metaMessageId: null,
      inboundBody: '{"hello":"world"}',
      inboundBodySha256: 'sha',
      inboundBodyTruncated: false,
      inboundHeaders: null,
      signatureOk: true,
      routingDecision: 'forwarded',
      isSandbox: false,
      requestId: 'req1',
      fromPhone: '+14155550100',
      senderDisplay: '+14155550100',
      senderId: '14155550100',
      receivedAt: '2026-05-20T11:58:00.000Z',
      humanStatus: 'Delivered',
      humanStatusCopy: 'Delivered to your app',
      humanStatusTooltip: 'shown on hover (GUI)',
      humanStatusColor: 'green',
      attempts: [],
    };
    mocks.apiClient
      .mockResolvedValueOnce({
        deliveries: [listItem('row-aaa')],
        nextCursor: 'c1',
        floorHours: 24,
      })
      .mockResolvedValueOnce(fullDetail);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await run(['logs', 'list', 'ch_abc12345', '--json']);

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.id).toBe('row-aaa');
    expect(parsed.inboundBody).toBe('{"hello":"world"}');
    expect(parsed.humanStatusTooltip).toBeUndefined();
    expect(parsed.humanStatusColor).toBeUndefined();
  });

  it('prints a friendly message when there are no deliveries', async () => {
    mocks.apiClient.mockResolvedValue({ deliveries: [], nextCursor: null, floorHours: 24 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain(
      'No deliveries in the last 24h for this channel.',
    );
    log.mockRestore();
  });

  it('auto-paginates every page under --all', async () => {
    // 4 apiClient calls: 2 list pages + 2 detail fetches (N+1 per row).
    mocks.apiClient
      .mockResolvedValueOnce({ deliveries: [listItem('p1')], nextCursor: 'c1', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: [listItem('p2')], nextCursor: null, floorHours: 168 })
      .mockResolvedValueOnce(detailItem('p1'))
      .mockResolvedValueOnce(detailItem('p2'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['logs', 'list', 'ch_abc12345', '--all']);

    // Two list-page calls confirm pagination followed nextCursor.
    const listCalls = mocks.apiClient.mock.calls.filter(([path]) =>
      String(path).startsWith('/deliveries?'),
    );
    expect(listCalls).toHaveLength(2);
  });

  it('rejects an out-of-range --limit', async () => {
    await expect(run(['logs', 'list', 'ch_abc12345', '--limit', '999'])).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an unparseable --since', async () => {
    await expect(
      run(['logs', 'list', 'ch_abc12345', '--since', 'yesterday']),
    ).rejects.toThrow(ValidationError);
  });

  it('prints a retention-floor note when --since predates the floor', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({
        deliveries: [listItem('row-x')],
        nextCursor: null,
        floorHours: 168,
      })
      .mockResolvedValueOnce(detailItem('row-x'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['logs', 'list', 'ch_abc12345', '--since', '720h']);

    expect(log.mock.calls.flat().join('\n')).toContain('Showing last 168h');
    log.mockRestore();
  });

  it('prints a continuation hint when nextCursor is non-null', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({
        deliveries: [listItem('row-x')],
        nextCursor: 'tok_abc',
        floorHours: 168,
      })
      .mockResolvedValueOnce(detailItem('row-x'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain('--cursor tok_abc');
    log.mockRestore();
  });

  it('forwards --until and --cursor through to the API query', async () => {
    mocks.apiClient.mockResolvedValue({ deliveries: [], nextCursor: null, floorHours: 24 });

    await run(['logs', 'list', 'ch_abc12345', '--until', '1h', '--cursor', 'tok_xyz']);

    const listCall = mocks.apiClient.mock.calls.find(([path]) =>
      String(path).startsWith('/deliveries?'),
    );
    expect(listCall).toBeDefined();
    const [path] = listCall as [string, unknown];
    expect(path).toContain('until=');
    expect(path).toContain('cursor=tok_xyz');
  });
});
