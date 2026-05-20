import type { DeliveryListItem, DeliveryAttempt, DeliveryDetail } from './api.js';

/**
 * Compact "time ago" label for the list table's `Received` column.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const sec = Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso).getTime()) / 1000),
  );
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Project delivery list items into flat rows for `renderTable`. `Status` is the
 * server-rendered `humanStatus`; the longer `humanStatusCopy` surfaces only in
 * `show` detail (spec D8).
 */
export function toListRows(
  deliveries: DeliveryListItem[],
  now: Date = new Date(),
): Record<string, unknown>[] {
  return deliveries.map((d) => ({
    ID: d.id,
    Received: relativeTime(d.receivedAt, now),
    Status: d.humanStatus,
    From: d.fromPhone ?? '-',
    Forwarded: d.latestAttempt?.forwardStatus ?? '-',
    Attempts: d.attemptsCount,
  }));
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** Pretty-print a body string — JSON if parseable, verbatim otherwise. */
function prettyBody(body: string | null): string {
  if (body === null) return '  (no body)';
  if (body === '') return '  (empty)';
  try {
    return indentBlock(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    return indentBlock(body);
  }
}

function renderHeaders(headers: Record<string, string> | null): string {
  if (!headers || Object.keys(headers).length === 0) return '  (none)';
  return Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
}

function renderAttempt(att: DeliveryAttempt, verbose: boolean): string {
  const lines: string[] = ['', 'We sent it to your app', `  POST ${att.forwardUrl}`];
  if (verbose) {
    lines.push('  request headers:');
    lines.push(renderHeaders(att.forwardRequestHeaders));
  }
  lines.push(prettyBody(att.forwardRequestBody));

  lines.push('', 'Your app responded');
  const status = att.forwardStatus ?? '(no response)';
  const duration =
    att.forwardDurationMs !== null ? ` (${att.forwardDurationMs}ms)` : '';
  lines.push(`  ${status}${duration}`);
  if (verbose) {
    lines.push('  response headers:');
    lines.push(renderHeaders(att.forwardResponseHeaders));
  }
  lines.push(prettyBody(att.forwardResponseBody));
  if (att.forwardResponseBodyTruncated) lines.push('  (truncated)');
  return lines.join('\n');
}

/**
 * Render one delivery's full detail as the human view. Mirrors the web UI
 * Channel Logs expanded row (spec D8): inbound body, then per-attempt forward
 * request and app response.
 */
export function renderDeliveryDetail(
  detail: DeliveryDetail,
  opts: { verbose?: boolean } = {},
): string {
  const verbose = !!opts.verbose;
  const from = detail.fromPhone ? `from ${detail.fromPhone}` : 'from (unknown)';
  const lines: string[] = [
    `Delivery ${detail.id}   ${detail.receivedAt}   ${from}`,
    `Routing: ${detail.routingDecision}   ` +
      `Signature: ${detail.signatureOk ? 'ok' : 'MISMATCH'}   ` +
      `Sandbox: ${detail.isSandbox ? 'yes' : 'no'}`,
    `Status: ${detail.humanStatusCopy}`,
    '',
    'What WhatsApp sent us',
  ];
  if (verbose) {
    lines.push('  headers:');
    lines.push(renderHeaders(detail.inboundHeaders));
  }
  lines.push(prettyBody(detail.inboundBody));
  if (detail.inboundBodyTruncated) lines.push('  (truncated)');

  // The web UI keys the no-destination case off "zero forward attempts" (see
  // frontend `ExpandedDetail` in delivery-row.tsx), NOT off `routingDecision`.
  // Real channels with no usable destination emit `routingDecision`
  // `no_webhook_config` (forwarder/src/webhook/webhook.service.ts) — `channels
  // logs` is channel-scoped, so `no_destination` (the sandbox value) never
  // appears here. Branching on `attempts.length` mirrors the UI exactly and is
  // decision-string-agnostic, so it is correct for every zero-forward case.
  if (detail.attempts.length === 0) {
    lines.push('');
    lines.push(
      'Not forwarded. No destination was configured for this channel at the time.',
    );
    lines.push(
      'Set one with: hookmyapp channels webhook set <channel> --url <your-url>',
    );
  } else {
    for (const att of detail.attempts) lines.push(renderAttempt(att, verbose));
  }

  return lines.join('\n');
}
