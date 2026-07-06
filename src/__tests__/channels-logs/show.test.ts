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
  receivedAt: '2026-05-20T11:58:00.000Z',
  sender: '+14155550100',
  messageId: 'wamid.m1',
  meta: { entry: [] },
  hookmyapp: {
    status: 'delivered',
    statusText: 'Delivered to your app',
    destination: { type: 'webhook', url: 'https://customer.app/webhook' },
    appResponse: { status: 200, durationMs: 120, body: 'ok' },
  },
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
    expect(out).toContain('Delivered to your app');
    expect(out).toContain('Meta payload');
    expect(out).toContain('To: https://customer.app/webhook');
    expect(out).not.toContain('Delivery d1');
    log.mockRestore();
  });

  it('emits only the clean public detail body under --json', async () => {
    mocks.apiClient.mockResolvedValue({
      ...DETAIL,
      routingDecision: 'forwarded',
      signatureOk: true,
      requestId: 'req_123',
      inboundHeaders: { 'x-hub-signature-256': 'secret' },
    });
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
