import { apiClient, isNetworkFailure } from './client.js';
import { getGatewayBaseOverride } from '../config/env-profiles.js';
import { ApiError, NetworkError, ValidationError, AuthError } from '../output/error.js';
import type { Channel } from './channel.js';

export interface GatewayConfig { token: string; baseUrl: string; }

/**
 * Fetch a channel's gateway config from the backend in one call: the hmat_ token
 * AND the version-bearing baseUrl (host + /meta + version, e.g.
 * `…/meta/v22.0` for WhatsApp, `…/meta/v25.0` for Instagram). The version is
 * single-sourced from the backend — the CLI never hardcodes it. A local/CI
 * `HOOKMYAPP_GATEWAY_URL` override (Task 1) replaces baseUrl verbatim.
 */
export async function getGatewayConfig(channel: Channel): Promise<GatewayConfig> {
  const data = (await apiClient(`/meta/channels/${channel.id}/token`, {
    workspaceId: channel.workspaceId,
  })) as { token?: string; baseUrl?: string };
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

function mapGatewayError(status: number, body: unknown): never {
  // Meta error shape: { error: { message, code, type, ... } }
  const metaMsg =
    body && typeof body === 'object' && 'error' in body
      ? ((body as { error?: { message?: string } }).error?.message ?? null)
      : null;
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
  try {
    res = await fetch(url, {
      method: call.method,
      headers,
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    });
  } catch (err) {
    if (isNetworkFailure(err)) throw new NetworkError();
    throw err;
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) mapGatewayError(res.status, json);
  return json;
}
