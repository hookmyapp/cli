import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  renderDeliveryDetail,
  printSummaryRow,
} from '../../commands/channels-logs/render.js';
import type { DeliveryDetail } from '../../commands/channels-logs/api.js';

function detail(over: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
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
    inboundHeaders: { 'x-hub-signature-256': 'sig' },
    signatureOk: true,
    routingDecision: 'forwarded',
    isSandbox: false,
    requestId: 'req1',
    fromPhone: '+14155550100',
    senderId: '14155550100',
    senderDisplay: '+14155550100',
    receivedAt: '2026-05-20T11:58:00.000Z',
    humanStatus: 'Rejected',
    humanStatusCopy: "Your app got this, but couldn't process it",
    humanStatusTooltip: null,
    humanStatusColor: 'red',
    outcome: 'rejected',
    outcomeReason: null,
    forwardUrl: 'https://customer.app/webhook',
    forwardRequestHeaders: { 'content-type': 'application/json' },
    forwardRequestBody: '{"hello":"world"}',
    forwardStatus: 500,
    forwardDurationMs: 842,
    forwardResponseHeaders: { 'x-trace': 'abc' },
    forwardResponseBody: 'internal error',
    forwardResponseBodySha256: 'sha',
    forwardResponseBodyTruncated: false,
    attemptedAt: '2026-05-20T11:58:01.000Z',
    relatedDeliveries: [],
    ...over,
  };
}

describe('printSummaryRow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a one-line summary from the flat forward fields', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printSummaryRow(detail({ forwardStatus: 200, forwardDurationMs: 100 }));

    const line = writes.join('');
    expect(line).toContain('customer.app');
    expect(line).toContain('200');
    expect(line).toContain('(100ms)');
  });

  it('does not crash and falls back to outcome when no forward was made', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printSummaryRow(
      detail({
        forwardUrl: null,
        forwardStatus: null,
        forwardDurationMs: null,
        outcome: 'skipped',
      }),
    );

    const line = writes.join('');
    expect(line).toContain('(no forward URL set)');
    expect(line).toContain('skipped');
  });
});

describe('renderDeliveryDetail', () => {
  it('renders the three sections for a forwarded delivery', () => {
    const out = renderDeliveryDetail(detail());
    expect(out).toContain('What WhatsApp sent us');
    expect(out).toContain('We sent it to your app');
    expect(out).toContain('POST https://customer.app/webhook');
    expect(out).toContain('Your app responded');
    expect(out).toContain('  500 (842ms)');
  });

  it('shows the no-destination note when no forward URL was set', () => {
    const out = renderDeliveryDetail(
      detail({ forwardUrl: null, forwardStatus: null, attemptedAt: null, outcome: 'skipped' }),
    );
    expect(out).toContain('No destination was configured');
    expect(out).not.toContain('We sent it to your app');
  });

  it('treats a real-channel no_webhook_config delivery as no-destination', () => {
    const out = renderDeliveryDetail(
      detail({
        routingDecision: 'no_webhook_config',
        forwardUrl: null,
        forwardStatus: null,
        attemptedAt: null,
        outcome: 'skipped',
      }),
    );
    expect(out).toContain('No destination was configured');
  });

  it('omits headers by default and includes them when verbose', () => {
    expect(renderDeliveryDetail(detail())).not.toContain('x-hub-signature-256');
    expect(renderDeliveryDetail(detail(), { verbose: true })).toContain(
      'x-hub-signature-256',
    );
  });

  it('marks a truncated inbound body', () => {
    const out = renderDeliveryDetail(detail({ inboundBodyTruncated: true }));
    expect(out).toContain('(truncated)');
  });
});
