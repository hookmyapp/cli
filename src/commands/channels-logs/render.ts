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
  const sender = log.sender ?? '(unknown)';
  const response =
    log.hookmyapp.appResponse.status === null
      ? ''
      : ` App response: ${log.hookmyapp.appResponse.status}${
          log.hookmyapp.appResponse.durationMs === null
            ? ''
            : ` in ${log.hookmyapp.appResponse.durationMs}ms`
        }`;
  process.stdout.write(
    `${time}  ${sender}  ${log.hookmyapp.statusText}${response}  ${bodyPreview(log.meta)}\n`,
  );
}

export function renderDeliveryDetail(
  log: DeliveryLog,
  _opts: { verbose?: boolean } = {},
): string {
  const lines = [
    `${log.receivedAt}  ${log.sender ?? '(unknown)'}  ${log.hookmyapp.statusText}`,
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
