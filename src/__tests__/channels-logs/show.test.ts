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
import { ApiError, ValidationError } from '../../output/error.js';

const DETAIL = {
  id: 'd1',
  workspaceId: 'ws_w1',
  scopeKind: 'channel',
  channelId: 'chan-uuid',
  sandboxSessionId: null,
  providerObject: 'whatsapp_business_account',
  providerResourceId: 'r1',
  metaMessageId: 'm1',
  inboundBody: '{"entry":[]}',
  inboundBodySha256: 'sha',
  inboundBodyTruncated: false,
  inboundHeaders: null,
  signatureOk: true,
  routingDecision: 'forwarded',
  isSandbox: false,
  requestId: 'req1',
  fromPhone: '+14155550100',
  senderId: '14155550100',
  senderDisplay: '+14155550100',
  receivedAt: '2026-05-20T11:58:00.000Z',
  humanStatus: 'Delivered',
  humanStatusCopy: 'Delivered to your app',
  humanStatusTooltip: null,
  humanStatusColor: 'green',
  outcome: 'delivered',
  outcomeReason: null,
  forwardUrl: 'https://customer.app/webhook',
  forwardRequestHeaders: null,
  forwardRequestBody: '{"entry":[]}',
  forwardStatus: 200,
  forwardDurationMs: 120,
  forwardResponseHeaders: null,
  forwardResponseBody: 'ok',
  forwardResponseBodySha256: null,
  forwardResponseBodyTruncated: false,
  attemptedAt: '2026-05-20T11:58:01.000Z',
  relatedDeliveries: [],
};

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
  mocks.getDefaultWorkspaceId.mockResolvedValue('ws_w1');
});

describe('channels logs show', () => {
  it('renders the human detail view for a delivery', async () => {
    mocks.apiClient.mockResolvedValue(DETAIL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'show', 'd1']);

    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('Delivery d1');
    expect(out).toContain('What WhatsApp sent us');
    log.mockRestore();
  });

  it('emits the raw detail body verbatim under --json', async () => {
    mocks.apiClient.mockResolvedValue(DETAIL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'show', 'd1', '--json']);

    expect(log).toHaveBeenCalledWith(JSON.stringify(DETAIL, null, 2));
    log.mockRestore();
  });

  it('fetches detail with the resolved workspace id, no channel', async () => {
    mocks.apiClient.mockResolvedValue(DETAIL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'show', 'd1']);

    expect(mocks.apiClient).toHaveBeenCalledWith('/deliveries/d1', {
      workspaceId: 'ws_w1',
    });
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('remaps a 404 into a friendly ValidationError', async () => {
    mocks.apiClient.mockRejectedValue(new ApiError('Delivery not found.', 404));

    await expect(run(['logs', 'show', 'missing'])).rejects.toThrow(ValidationError);
  });

  it('rethrows a non-404 ApiError unchanged', async () => {
    mocks.apiClient.mockRejectedValue(new ApiError('Internal error', 500));

    await expect(run(['logs', 'show', 'd1'])).rejects.toThrow(ApiError);
  });
});
