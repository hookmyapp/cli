import { readCredentials, saveCredentials } from '../auth/store.js';
import { AuthError, ApiError, NetworkError, PermissionError } from '../output/error.js';

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
    if (err instanceof TypeError) {
      throw new NetworkError();
    }
    throw err;
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new AuthError();
    }
    if (res.status === 403) {
      // Lazy-import to avoid a cycle with commands/workspace.ts
      const { readWorkspaceConfig } = await import('../commands/workspace.js');
      const cfg = readWorkspaceConfig();
      throw new PermissionError(cfg.activeWorkspaceSlug ?? '<unknown>');
    }
    const body = await res.json().catch(() => ({ message: res.statusText }));
    if (res.status >= 500) {
      throw new ApiError('Something went wrong on our end. Try again later.', res.status);
    }
    throw new ApiError(body.message ?? body.error ?? res.statusText, res.status);
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
