import { describe, it, expect } from 'vitest';
import { relativeTime, toListRows } from '../../commands/channels-logs/render.js';
import type { DeliveryListItem } from '../../commands/channels-logs/api.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function item(over: Partial<DeliveryListItem>): DeliveryListItem {
  return {
    id: 'd1',
    receivedAt: '2026-05-20T11:58:00.000Z',
    fromPhone: '+14155550100',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusColor: 'green',
    latestAttempt: { outcome: 'delivered', forwardStatus: 200, attemptedAt: '2026-05-20T11:58:01.000Z' },
    ...over,
  };
}

describe('relativeTime', () => {
  it('renders sub-minute deltas as "just now"', () => {
    expect(relativeTime('2026-05-20T11:59:30.000Z', NOW)).toBe('just now');
  });

  it('renders minute, hour and day buckets', () => {
    expect(relativeTime('2026-05-20T11:45:00.000Z', NOW)).toBe('15m ago');
    expect(relativeTime('2026-05-20T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(relativeTime('2026-05-18T12:00:00.000Z', NOW)).toBe('2d ago');
  });

  it('renders exactly 60 seconds as the first minute bucket, not "just now"', () => {
    expect(relativeTime('2026-05-20T11:59:00.000Z', NOW)).toBe('1m ago');
  });
});

describe('toListRows', () => {
  it('projects delivery items into flat table rows', () => {
    const rows = toListRows([item({ id: 'abc' })], NOW);
    expect(rows[0]).toEqual({
      ID: 'abc',
      Received: '2m ago',
      Status: 'Delivered',
      From: '+14155550100',
      Forwarded: 200,
      Attempts: 1,
    });
  });

  it('falls back to a dash for a missing phone or forward status', () => {
    const rows = toListRows(
      [item({ fromPhone: null, latestAttempt: null, attemptsCount: 0 })],
      NOW,
    );
    expect(rows[0].From).toBe('-');
    expect(rows[0].Forwarded).toBe('-');
  });
});

import { renderDeliveryDetail } from '../../commands/channels-logs/render.js';
import type { DeliveryDetail, DeliveryAttempt } from '../../commands/channels-logs/api.js';

function attempt(over: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: 'a1',
    attemptNumber: 1,
    forwardUrl: 'https://customer.app/webhook',
    forwardRequestHeaders: { 'content-type': 'application/json' },
    forwardRequestBody: '{"hello":"world"}',
    forwardStatus: 500,
    forwardDurationMs: 842,
    forwardResponseHeaders: { 'x-trace': 'abc' },
    forwardResponseBody: 'internal error',
    forwardResponseBodySha256: 'sha',
    forwardResponseBodyTruncated: false,
    outcome: 'rejected',
    outcomeReason: null,
    attemptedAt: '2026-05-20T11:58:01.000Z',
    ...over,
  };
}

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
    receivedAt: '2026-05-20T11:58:00.000Z',
    humanStatus: 'Rejected',
    humanStatusCopy: "Your app got this, but couldn't process it",
    humanStatusColor: 'red',
    attempts: [attempt()],
    ...over,
  };
}

describe('renderDeliveryDetail', () => {
  it('renders the three sections for a forwarded delivery', () => {
    const out = renderDeliveryDetail(detail());
    expect(out).toContain('What WhatsApp sent us');
    expect(out).toContain('We sent it to your app');
    expect(out).toContain('POST https://customer.app/webhook');
    expect(out).toContain('Your app responded');
    expect(out).toContain('500');
    expect(out).toContain('842ms');
  });

  it('renders one block pair per attempt for a multi-attempt delivery', () => {
    const out = renderDeliveryDetail(
      detail({ attempts: [attempt({ attemptNumber: 1 }), attempt({ attemptNumber: 2 })] }),
    );
    expect(out.match(/We sent it to your app/g)).toHaveLength(2);
  });

  it('shows the no-destination note when a delivery has zero attempts', () => {
    const out = renderDeliveryDetail(detail({ attempts: [] }));
    expect(out).toContain('No destination was configured');
    expect(out).not.toContain('We sent it to your app');
  });

  it('treats a real-channel no_webhook_config delivery as no-destination', () => {
    const out = renderDeliveryDetail(
      detail({ routingDecision: 'no_webhook_config', attempts: [] }),
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
