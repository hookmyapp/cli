// Defensive one-line summarizer for Meta WhatsApp webhook payloads.
//
// Invariant: MUST NEVER throw — `sandbox listen`'s per-request log must stay
// useful even on malformed bodies. On any parse or shape failure, fall back
// to a byte-count line.
//
// Recognised Meta payload shapes (see developers.facebook.com/docs/whatsapp/
// cloud-api/webhooks/payload-examples):
//   entry[0].changes[0].value.messages[0].type === 'text'|'reaction'|'image'|…
//   entry[0].changes[0].value.statuses[0].status + recipient_id

export function summarize(payloadBuf: Buffer): string {
  const byteCount = payloadBuf.length;
  const fallback = `POST /webhook (${byteCount} bytes)`;

  if (byteCount === 0) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return fallback;
  }

  try {
    const root = parsed as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{ type?: string; from?: string }>;
            statuses?: Array<{ status?: string; recipient_id?: string }>;
          };
        }>;
      }>;
    };
    const value = root.entry?.[0]?.changes?.[0]?.value;
    if (!value) return fallback;

    const message = value.messages?.[0];
    if (message && message.type && message.from) {
      return `${message.type}_message from ${message.from}`;
    }

    const status = value.statuses?.[0];
    if (status && status.status && status.recipient_id) {
      return `${status.status} from ${status.recipient_id}`;
    }

    return fallback;
  } catch {
    return fallback;
  }
}
