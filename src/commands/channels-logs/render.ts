import type { DeliveryLog } from './api.js';

function stringifyBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  return JSON.stringify(body, null, 2);
}

function bodyPreview(meta: unknown): string {
  const text = stringifyBody(meta)?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return '(empty)';
  return `"${text.length > 80 ? `${text.slice(0, 80)}...` : text}"`;
}

/**
 * Meta status-only webhooks (delivered/sent/read receipts) carry no sender —
 * dig entry[].changes[].value.statuses[].status out of the payload so the
 * row reads as e.g. "(status: delivered)" instead of "(unknown)".
 */
function statusWebhookStatus(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const entry = (meta as Record<string, unknown>).entry;
  if (!Array.isArray(entry)) return null;
  for (const e of entry) {
    const changes = (e as Record<string, unknown> | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as Record<string, unknown> | null)?.value as
        | Record<string, unknown>
        | undefined;
      const statuses = value?.statuses;
      if (!Array.isArray(statuses)) continue;
      const status = (statuses[0] as Record<string, unknown> | undefined)?.status;
      if (typeof status === 'string' && status.length > 0) return status;
    }
  }
  return null;
}

function senderLabel(log: DeliveryLog): string {
  if (log.sender) return log.sender;
  const status = statusWebhookStatus(log.meta);
  return status ? `(status: ${status})` : '(unknown)';
}

function destinationLine(log: DeliveryLog): string | null {
  const destination = log.hookmyapp.destination;
  if (!destination) return null;
  if (destination.type === 'cli') return 'To: CLI listener';
  return `To: ${destination.url}`;
}

function appResponseText(log: DeliveryLog): string {
  const response = log.hookmyapp.appResponse;
  if (response.status === null) return '  (no response)';
  return `  ${response.status}${
    response.durationMs === null ? '' : ` in ${response.durationMs}ms`
  }`;
}

export function printSummaryRow(log: DeliveryLog): void {
  const time = new Date(log.receivedAt).toLocaleString();
  const sender = senderLabel(log);
  const response =
    log.hookmyapp.appResponse.status === null
      ? ''
      : ` App response: ${log.hookmyapp.appResponse.status}${
          log.hookmyapp.appResponse.durationMs === null
            ? ''
            : ` in ${log.hookmyapp.appResponse.durationMs}ms`
        }`;
  process.stdout.write(
    `${log.publicId}  ${time}  ${sender}  ${log.hookmyapp.statusText}${response}  ${bodyPreview(log.meta)}\n`,
  );
}

export function renderDeliveryDetail(
  log: DeliveryLog,
  _opts: { verbose?: boolean } = {},
): string {
  const lines = [
    `${log.publicId}  ${log.receivedAt}  ${senderLabel(log)}  ${log.hookmyapp.statusText}`,
  ];
  const destination = destinationLine(log);
  if (destination) lines.push(destination);

  lines.push('', 'Meta payload');
  lines.push(stringifyBody(log.meta) ?? '  (empty)');

  lines.push('', 'Your app responded');
  lines.push(appResponseText(log));

  const responseBody = stringifyBody(log.hookmyapp.appResponse.body);
  if (responseBody !== null) lines.push(responseBody);

  return lines.join('\n');
}
