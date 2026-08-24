import { apiClient, isNetworkFailure } from './client.js';
import { getGatewayBaseOverride } from '../config/env-profiles.js';
import {
  ApiError,
  NetworkError,
  ValidationError,
  AuthError,
  ConflictError,
  ForbiddenError,
  RateLimitError,
} from '../output/error.js';
import type { Channel } from './channel.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';

export interface GatewayConfig { token: string; baseUrl: string; }

// A JSON gateway call must never hang a command forever (e.g. a publish flow
// stuck in createContainer). 60s is far above Meta's normal response time;
// binary uploads keep their own path without this cap. Shared by the backend
// config lookup below — every leg of a gateway command is bounded.
const GATEWAY_JSON_TIMEOUT_MS = 60_000;

/**
 * Fetch a channel's gateway config from the backend in one call: the hmat_ token
 * AND the version-bearing baseUrl (host + /meta + version, e.g.
 * `…/meta/v22.0` for WhatsApp, `…/meta/v25.0` for Instagram). The version is
 * single-sourced from the backend — the CLI never hardcodes it. A local/CI
 * `HOOKMYAPP_GATEWAY_URL` override (Task 1) replaces baseUrl verbatim.
 */
export async function getGatewayConfig(channel: Channel): Promise<GatewayConfig> {
  let data: { token?: string; baseUrl?: string };
  try {
    // The config lookup shares the gateway deadline — without it, a stalled
    // backend token fetch hangs the command before the Meta call even starts.
    data = (await apiClient(`/meta/channels/${channel.id}/token`, {
      workspaceId: channel.workspaceId,
      signal: AbortSignal.timeout(GATEWAY_JSON_TIMEOUT_MS),
    })) as { token?: string; baseUrl?: string };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new NetworkError();
    throw err;
  }
  if (!data?.token) throw new ApiError('Backend returned no gateway access token for this channel.', 500);
  const baseUrl = getGatewayBaseOverride() ?? data.baseUrl;
  if (!baseUrl) throw new ApiError('Backend returned no gateway baseUrl for this channel.', 500);
  return { token: data.token, baseUrl: baseUrl.replace(/\/$/, '') };
}

/** Replace {phone_number_id} / {waba_id} / {ig_id} in a Graph path from the channel. */
export function substitutePath(path: string, channel: Channel): string {
  const map: Record<string, string | null | undefined> = {
    phone_number_id: channel.type === 'whatsapp' ? channel.whatsappPhoneNumberId : undefined,
    waba_id: channel.metaWabaId,
    ig_id: channel.type === 'instagram' ? channel.metaResourceId : undefined,
  };
  return path.replace(/\{(phone_number_id|waba_id|ig_id)\}/g, (_m, key: string) => {
    const v = map[key];
    if (!v) {
      throw new ValidationError(
        `Cannot fill {${key}} for channel ${channel.id} (type ${channel.type}). ` +
          `Use an explicit id in the path, or a channel that has it.`,
        'PLACEHOLDER_UNRESOLVED',
      );
    }
    return v;
  });
}

function buildGatewayUrl(baseUrl: string, path: string): string {
  // baseUrl already includes host + /meta + version; path is version-less.
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

// Meta subcodes that mean "Meta has restricted this account from an action",
// not "your request was malformed". Meta returns them as a generic code-100
// "Invalid parameter" whose message names no cause, so without this mapping the
// CLI (and any agent reading it) blames the request body. Each message states
// what is blocked and where the business sees the expiry — claims beyond that
// (why it was applied, when it lifts) are Meta's to make, not ours.
const META_RESTRICTION_SUBCODES: Record<number, string> = {
  2494160:
    'Meta has restricted this WhatsApp Business account from creating or editing templates. ' +
    'Open Business Support Home in Meta Business Manager for the reason, how long it lasts, and ' +
    'the option to request a review. This restriction does not affect sending templates that are ' +
    'already approved.',
};

/**
 * Looked up through `Object.hasOwn` rather than a bare index: `error_subcode`
 * is parsed JSON, so a payload carrying `"constructor"` would otherwise resolve
 * up the prototype chain to a function and be thrown as an error message.
 */
function metaRestrictionMessage(subcode: number | undefined): string | undefined {
  if (subcode === undefined) return undefined;
  return Object.hasOwn(META_RESTRICTION_SUBCODES, subcode)
    ? META_RESTRICTION_SUBCODES[subcode]
    : undefined;
}

function mapGatewayError(status: number, body: unknown): never {
  const gatewayError =
    body &&
    typeof body === 'object' &&
    typeof (body as { statusCode?: unknown }).statusCode === 'number' &&
    typeof (body as { code?: unknown }).code === 'string' &&
    typeof (body as { message?: unknown }).message === 'string'
      ? (body as { code: string; message: string; retry_after_seconds?: unknown })
      : undefined;
  if (gatewayError) {
    const retryAfter = gatewayError.retry_after_seconds;
    const details =
      typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
        ? { retry_after_seconds: retryAfter }
        : undefined;
    if (status === 400 || status === 422) {
      throw new ValidationError(gatewayError.message, gatewayError.code);
    }
    if (status === 401) throw new AuthError(gatewayError.message, gatewayError.code);
    if (status === 403) throw new ForbiddenError(gatewayError.message, gatewayError.code);
    if (status === 409) throw new ConflictError(gatewayError.message, gatewayError.code);
    if (status === 429) {
      throw new RateLimitError(gatewayError.message, gatewayError.code, details);
    }
    throw new ApiError(gatewayError.message, status, gatewayError.code, details);
  }

  // Meta error shape: { error: { message, code, error_subcode, type, ... } }
  const metaError =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: { message?: string; error_subcode?: number } }).error
      : undefined;
  const metaMsg = metaError?.message ?? null;
  // Ahead of every status branch on purpose: a restriction is the real cause
  // whatever status Meta wrapped it in, and each status branch below would
  // rename it into something the reader would act on wrongly — 401 into
  // "re-authenticate", 400 into "fix your request". ConflictError (exit 6), not
  // ValidationError (exit 2), for the same reason: exit 2 tells a script its
  // input was wrong, the misdiagnosis this mapping exists to prevent.
  // Adding a subcode that can fire on an Instagram path? Check the META_REJECTED
  // branches in instagram-insights.ts / instagram-publish.ts first — this
  // returns before them.
  const restriction = metaRestrictionMessage(metaError?.error_subcode);
  if (restriction) {
    throw new ConflictError(restriction, 'META_ACCOUNT_RESTRICTED');
  }
  if (status === 401) throw new AuthError();
  if (status === 400 || status === 422) {
    throw new ValidationError(metaMsg ?? `Meta rejected the request (${status}).`, 'META_REJECTED');
  }
  throw new ApiError(metaMsg ?? `Meta gateway error (${status}).`, status);
}

export interface GatewayCall {
  channel: Channel;
  method: string;
  path: string;
  body?: unknown;
}

/** Make a JSON call to the Meta gateway for a channel. Returns parsed JSON (or undefined for empty 2xx). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gatewayRequest(call: GatewayCall): Promise<any> {
  const { token, baseUrl } = await getGatewayConfig(call.channel);
  const url = buildGatewayUrl(baseUrl, substitutePath(call.path, call.channel));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: call.method,
      headers,
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(GATEWAY_JSON_TIMEOUT_MS),
    });
    // The timeout signal can also fire mid-body-read — same NetworkError mapping.
    text = await res.text();
  } catch (err) {
    if (
      isNetworkFailure(err) ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    ) {
      throw new NetworkError();
    }
    throw err;
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) mapGatewayError(res.status, json);
  return json;
}

export interface GatewayUpload { channel: Channel; path: string; file: string; type?: string; }

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  aac: 'audio/aac', amr: 'audio/amr', pdf: 'application/pdf',
};
/** Best-effort MIME from a file extension; defaults to application/octet-stream. */
function guessMime(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Multipart upload to the gateway (/media). Returns parsed JSON ({ id }). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gatewayUpload(up: GatewayUpload): Promise<any> {
  const { token, baseUrl } = await getGatewayConfig(up.channel);
  const url = buildGatewayUrl(baseUrl, substitutePath(up.path, up.channel));
  const bytes = await readFile(up.file);
  const mime = up.type ?? guessMime(up.file);
  const form = new FormData();
  form.set('messaging_product', 'whatsapp'); // WhatsApp-only in M1 (see scope note)
  form.set('type', mime);                     // Meta /media requires the MIME type field
  form.set('file', new Blob([bytes], { type: mime }), basename(up.file));
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  } catch (err) {
    if (isNetworkFailure(err)) throw new NetworkError();
    throw err;
  }
  const text = await res.text();
  let json: unknown; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) mapGatewayError(res.status, json);
  return json;
}

/**
 * Fetch a (gateway-signed) media URL and stream bytes into `sink`. Returns the
 * byte count. OWNERSHIP: this helper awaits each write (backpressure) but does
 * NOT end the sink — the CALLER owns the sink lifecycle. For a file stream the
 * caller must `sink.end()` then `await finished(sink)` (node:stream/promises)
 * before reporting bytes; for `process.stdout` the caller must NOT end it.
 */
export async function gatewayDownloadToStream(signedUrl: string, sink: Writable): Promise<number> {
  let res: Response;
  try { res = await fetch(signedUrl); } catch (err) { if (isNetworkFailure(err)) throw new NetworkError(); throw err; }
  if (!res.ok || !res.body) {
    // The download target is a gateway-signed media/CDN URL, NOT a Meta Graph
    // endpoint — so the Meta `{error:{message}}` mapper does not apply. Drain
    // the body before throwing to avoid leaking the response stream.
    await res.body?.cancel();
    throw new ApiError(`Media download failed (HTTP ${res.status}).`, res.status || 502);
  }
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    await new Promise<void>((resolve, reject) => sink.write(value, (e) => (e ? reject(e) : resolve())));
  }
  return bytes;
}

export { createWriteStream };
