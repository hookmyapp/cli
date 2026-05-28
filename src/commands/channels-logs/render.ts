import type { DeliveryDetail } from './api.js';

/**
 * One-line summary row for `channels logs list` (D9 — table-by-default).
 *
 * Format: `<time>  <sender>  →  <target-host>  <status>(<latency>)  "<preview>"`
 *
 * Mirrors sandbox/logs.ts `printSummaryDelivery` byte-for-byte. The plan's
 * DRY guidance: "cross-command duplication of a single render function is
 * acceptable until a third caller appears." Keeping them in lockstep here
 * is intentional — the two commands answer the same question (did the
 * message reach my server, and what did the server say back?) and the same
 * UX should follow.
 *
 * Sender resolution chain (D8): senderDisplay → senderId → fromPhone →
 * '(unknown)'. fromPhone is the WA-only field; senderDisplay/senderId are
 * the IG-aware fields the backend provides for both channel types.
 *
 * Row-per-request model: the forward is flat on the detail (no attempts[]).
 * `forwardUrl === null` means no destination was configured; the status then
 * falls back to the row `outcome`. Target host parse guards malformed forward
 * URLs with a `(invalid forward URL)` fallback.
 */
export function printSummaryRow(d: DeliveryDetail): void {
  const time = new Date(d.receivedAt).toLocaleString();
  const sender = d.senderDisplay ?? d.senderId ?? d.fromPhone ?? '(unknown)';
  const target = (() => {
    if (!d.forwardUrl) return '(no forward URL set)';
    try {
      return new URL(d.forwardUrl).host;
    } catch {
      return '(invalid forward URL)';
    }
  })();
  const status = d.forwardStatus !== null ? `${d.forwardStatus}` : d.outcome;
  const latency =
    d.forwardDurationMs !== null && d.forwardDurationMs !== undefined
      ? `${d.forwardDurationMs}ms`
      : '';
  const preview = previewInbound(d.inboundBody);
  process.stdout.write(
    `${time}  ${sender}  →  ${target}  ${status}${latency ? ` (${latency})` : ''}  ${preview}\n`,
  );
}

function previewInbound(body: string | null): string {
  if (!body) return '(empty)';
  let text: string;
  try {
    const parsed: unknown = JSON.parse(body);
    // Common WA + IG message shapes carry a text body in `text` or `message.text`.
    const obj = parsed as { text?: unknown; message?: { text?: unknown } } | null;
    text = String(obj?.text ?? obj?.message?.text ?? body);
  } catch {
    text = body;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 40) text = text.slice(0, 40) + '…';
  return `"${text}"`;
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

/** Render the single flat forward block (request sent + app response). */
function renderForward(d: DeliveryDetail, verbose: boolean): string {
  const lines: string[] = ['', 'We sent it to your app', `  POST ${d.forwardUrl}`];
  if (verbose) {
    lines.push('  request headers:');
    lines.push(renderHeaders(d.forwardRequestHeaders));
  }
  lines.push(prettyBody(d.forwardRequestBody));

  lines.push('', 'Your app responded');
  const status = d.forwardStatus ?? '(no response)';
  const duration =
    d.forwardDurationMs !== null ? ` (${d.forwardDurationMs}ms)` : '';
  lines.push(`  ${status}${duration}`);
  if (verbose) {
    lines.push('  response headers:');
    lines.push(renderHeaders(d.forwardResponseHeaders));
  }
  lines.push(prettyBody(d.forwardResponseBody));
  if (d.forwardResponseBodyTruncated) lines.push('  (truncated)');
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

  // Row-per-request model: `forwardUrl === null` is the no-forward signal (no
  // destination was configured, so no forward was attempted). It is
  // decision-string-agnostic and mirrors the web UI's "zero forward attempts"
  // branch, which is correct for every no-forward case (skipped /
  // no_webhook_config / no_destination).
  if (detail.forwardUrl === null) {
    lines.push('');
    lines.push(
      'Not forwarded. No destination was configured for this channel at the time.',
    );
    lines.push(
      'Set one with: hookmyapp channels webhook set <channel> --url <your-url>',
    );
  } else {
    lines.push(renderForward(detail, verbose));
  }

  return lines.join('\n');
}
