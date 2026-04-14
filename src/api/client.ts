import { readCredentials, saveCredentials } from '../auth/store.js';
import {
  AuthError,
  ApiError,
  NetworkError,
  PermissionError,
  ConflictError,
  CliError,
} from '../output/error.js';

const WORKOS_CLIENT_ID = process.env.HOOKMYAPP_WORKOS_CLIENT_ID ?? 'client_01KM5S4CGX9M2M2P63JTA6AFEH';

function decodeJwtExp(token: string): number {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return decoded.exp ?? 0;
  } catch {
    return 0;
  }
}

async function refreshToken(
  refreshTokenValue: string,
  organizationId?: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: WORKOS_CLIENT_ID,
  });
  if (organizationId) {
    params.set('organization_id', organizationId);
  }
  const res = await fetch('https://api.workos.com/user_management/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) {
    throw new Error('refresh failed');
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: decodeJwtExp(data.access_token),
  };
}

export async function forceTokenRefresh(organizationId?: string): Promise<void> {
  const creds = readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }
  try {
    const refreshed = await refreshToken(creds.refreshToken, organizationId);
    saveCredentials(refreshed);
  } catch {
    throw new AuthError('Session expired. Run: hookmyapp login');
  }
}

// Centralized HTTP-status → CliError subclass mapping. Every non-ok response
// from apiClient funnels through here so that error shape/exit codes stay
// consistent across commands. Keep this in sync with the error-hierarchy
// contract in output/error.ts (exit codes: 2 / 3 / 4 / 5 / 6).
export async function mapApiError(res: Response): Promise<CliError> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await res.json().catch(() => ({ message: res.statusText }));
  const msg: string = body?.message ?? body?.error ?? res.statusText;
  const code: string | undefined = body?.code;

  if (res.status === 401) return new AuthError();
  if (res.status === 403) {
    // Lazy-import to avoid a cycle with commands/workspace.ts
    const { readWorkspaceConfig } = await import('../commands/workspace.js');
    const cfg = readWorkspaceConfig();
    return new PermissionError(cfg.activeWorkspaceSlug ?? '<unknown>');
  }
  if (res.status === 409) return new ConflictError(msg, code ?? 'CONFLICT');
  if (res.status >= 500) {
    return new ApiError('Something went wrong on our end. Try again later.', res.status);
  }
  return new ApiError(msg, res.status);
}

function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = (err as any)?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = (err as any)?.message;
  if (typeof message === 'string' && /fetch failed/i.test(message)) return true;
  return false;
}

export async function apiClient(
  path: string,
  options?: RequestInit & { workspaceId?: string },
): Promise<any> {
  const creds = readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }

  let { accessToken } = creds;

  // Check if token is expired (with 60-second buffer)
  const exp = decodeJwtExp(accessToken);
  if (exp > 0 && Date.now() / 1000 > exp - 60) {
    try {
      const refreshed = await refreshToken(creds.refreshToken);
      saveCredentials(refreshed);
      accessToken = refreshed.accessToken;
    } catch {
      throw new AuthError('Session expired. Run: hookmyapp login');
    }
  }

  const baseUrl = process.env.HOOKMYAPP_API_URL ?? 'https://uninked-robbi-boughless.ngrok-free.dev';

  const { workspaceId, ...fetchOptions } = options ?? {};

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> ?? {}),
  };

  if (workspaceId !== undefined) {
    headers['X-Workspace-Id'] = workspaceId;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      headers,
    });
  } catch (err) {
    if (isNetworkFailure(err)) {
      throw new NetworkError();
    }
    throw err;
  }

  if (!res.ok) {
    throw await mapApiError(res);
  }

  // 204 No Content (and other empty-body 2xx responses) have no JSON to parse.
  // Returning undefined avoids `Unexpected end of JSON input` in callers that
  // don't consume the return value (e.g. the heartbeat loop).
  if (res.status === 204) {
    return undefined;
  }
  try {
    return await res.json();
  } catch {
    // Empty or non-JSON 2xx body — treat as void rather than crashing with
    // "Unexpected end of JSON input" for callers that don't consume the return.
    return undefined;
  }
}
