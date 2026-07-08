import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  renderDeliveryDetail,
  printSummaryRow,
} from '../../commands/channels-logs/render.js';
import type { DeliveryLog } from '../../commands/channels-logs/api.js';

function detail(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return {
    publicId: 'wd_u9uElygL',
    receivedAt: '2026-05-20T11:58:00.000Z',
    sender: '+14155550100',
    messageId: 'wamid.m1',
    meta: { entry: [] },
    hookmyapp: {
      status: 'rejected',
      statusText: "Your app got this, but couldn't process it",
      destination: { type: 'webhook', url: 'https://customer.app/webhook' },
      appResponse: { status: 500, durationMs: 842, body: 'internal error' },
    },
    ...overrides,
  };
}

function withHookmyapp(
  overrides: Partial<DeliveryLog['hookmyapp']>,
): DeliveryLog {
  const base = detail();
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

describe('printSummaryRow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a one-line summary from public delivery fields', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printSummaryRow(
      withHookmyapp({
        status: 'delivered',
        statusText: 'Delivered to your app',
        appResponse: { status: 200, durationMs: 100, body: null },
      }),
    );

    const line = writes.join('');
    expect(line).toContain('wd_u9uElygL');
    expect(line).toContain('+14155550100');
    expect(line).toContain('Delivered to your app');
    expect(line).toContain('App response: 200 in 100ms');
  });

  it('shows the receipt status as identity for status-only webhooks (no sender)', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printSummaryRow(
      detail({
        sender: null,
        meta: { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] },
      }),
    );

    const line = writes.join('');
    expect(line).toContain('(status: delivered)');
    expect(line).not.toContain('(unknown)');
  });

  it('falls back to (unknown) when no sender and no statuses in the payload', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printSummaryRow(detail({ sender: null, meta: { entry: [] } }));

    expect(writes.join('')).toContain('(unknown)');
  });

  it('does not crash and falls back when no destination or response exists', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printSummaryRow(
      withHookmyapp({
        status: 'skipped',
        statusText: 'No destination configured',
        destination: null,
        appResponse: { status: null, durationMs: null, body: null },
      }),
    );

    const line = writes.join('');
    expect(line).toContain('No destination configured');
    expect(line).not.toContain('App response:');
  });
});

describe('renderDeliveryDetail', () => {
  it('renders the clean public sections for a forwarded delivery', () => {
    const out = renderDeliveryDetail(detail());
    expect(out).toContain('wd_u9uElygL');
    expect(out).toContain('Meta payload');
    expect(out).toContain('To: https://customer.app/webhook');
    expect(out).toContain('Your app responded');
    expect(out).toContain('500 in 842ms');
    expect(out).toContain('internal error');
  });

  it('shows no destination line when no destination was set', () => {
    const out = renderDeliveryDetail(
      withHookmyapp({
        status: 'skipped',
        statusText: 'No destination configured',
        destination: null,
        appResponse: { status: null, durationMs: null, body: null },
      }),
    );
    expect(out).not.toContain('To:');
    expect(out).toContain('(no response)');
  });

  it('renders the CLI listener destination', () => {
    const out = renderDeliveryDetail(
      withHookmyapp({
        destination: { type: 'cli', label: 'CLI listener' },
      }),
    );
    expect(out).toContain('To: CLI listener');
  });

  it('does not expose internal routing, signature, request, or header fields', () => {
    const out = renderDeliveryDetail(detail(), { verbose: true });
    expect(out).not.toContain('Routing:');
    expect(out).not.toContain('Signature');
    expect(out).not.toContain('requestId');
    expect(out).not.toContain('x-hub-signature-256');
  });
});
