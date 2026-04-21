import { readCredentials, saveCredentials } from '../auth/store.js';
import {
  AuthError,
  ApiError,
  NetworkError,
  PermissionError,
  ConflictError,
  RateLimitError,
  SessionWindowError,
  UnexpectedError,
  AppError,
  type CliError,
} from '../output/error.js';
import {
  getEffectiveApiUrl,
  getEffectiveWorkosClientId,
} from '../config/env-profiles.js';

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
    client_id: getEffectiveWorkosClientId(),
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
    // Throw a typed AppError so the top-level exit-code mapper + Sentry
    // capture get a severity-tagged event instead of a bare Error. The caller
    // (forceTokenRefresh / apiClient) catches this and surfaces a friendly
    // AuthError('Session expired. Run: hookmyapp login') to the user.
    throw new UnexpectedError('refresh failed', 'WORKOS_REFRESH_FAILED');
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

// Centralized HTTP-status → AppError subclass mapping. Every non-ok response
// from apiClient funnels through here so that error shape/exit codes stay
// consistent across commands. Keep this in sync with the error-hierarchy
// contract in output/error.ts (exit codes: 2 / 3 / 4 / 5 / 6).
//
// Return type is `CliError` — a Phase 108 alias that is identical at runtime
// to `AppError` under Phase 123 Plan 10. Existing callers see no change.
export async function mapApiError(res: Response): Promise<CliError> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await res.json().catch(() => ({ message: res.statusText }));
  const msg: string = body?.message ?? body?.error ?? res.statusText;
  const code: string | undefined = body?.code;

  if (res.status === 401) return new AuthError();
  if (res.status === 403) {
    // Sandbox-proxy 24h-window rejections surface verbatim — not a permission
    // problem, the developer needs the actionable "ask the recipient to
    // message first" guidance.
    if (code === 'SESSION_WINDOW_CLOSED') {
      return new SessionWindowError(msg);
    }
    // Lazy-import to avoid a cycle with commands/workspace.ts
    const { readWorkspaceConfig } = await import('../commands/workspace.js');
    const cfg = readWorkspaceConfig();
    return new PermissionError(cfg.activeWorkspaceSlug ?? '<unknown>');
  }
  if (res.status === 409) return new ConflictError(msg, code ?? 'CONFLICT');
  // Phase 122 — bootstrap-code exchange error mapping.
  // 404 and 410 collapse to the same user-facing message (oracle-attack
  // defense — brute-force guessers can't distinguish "unknown code" from
  // "already spent code"). ApiError.exitCode defaults to 1; we override
  // to 5 on the instance so the CLI's exit-code contract stays honest
  // ("API rejected the bootstrap code" is a distinct failure class).
  if (res.status === 404 && code === 'BOOTSTRAP_NOT_FOUND') {
    const err = new ApiError(
      'Code invalid or already used. Ask the dashboard user to click Copy again.',
      404,
    );
    err.exitCode = 5;
    return err;
  }
  if (res.status === 410 && code === 'BOOTSTRAP_EXPIRED_OR_USED') {
    const err = new ApiError(
      'Code expired or already used. Ask the dashboard user to click Copy again.',
      410,
    );
    err.exitCode = 5;
    return err;
  }
  if (res.status === 429) {
    // Phase 123 Plan 10 — use the new RateLimitError class (sev3, httpStatus
    // 429). Exit code remains 6 so the Phase 108 exit-code contract for 429
    // is preserved (historically this flowed through ConflictError → exit 6).
    // The body.code 'RATE_LIMITED' matches the backend's
    // UserIdThrottlerGuard structured 429 body.
    return new RateLimitError(
      msg && msg !== 'Too Many Requests'
        ? msg
        : 'Too many codes minted. Wait a minute and retry.',
      'RATE_LIMITED',
    );
  }
  if (res.status >= 500) {
    return new ApiError('Something went wrong on our end. Try again later.', res.status);
  }
  return new ApiError(msg, res.status);
}

export function isNetworkFailure(err: unknown): boolean {
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

  // Phase 123 Plan 10 — set Sentry user tag on every authenticated API call.
  // Idempotent + lazy (no-op when telemetry off or Sentry not initialized).
  // Fire-and-forget so the API call's latency isn't gated on dynamic import.
  void (async () => {
    try {
      const { setCliUserFromCreds } = await import('../observability/sentry.js');
      await setCliUserFromCreds();
    } catch {
      // Swallow — telemetry must never affect API calls.
    }
  })();

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

  const baseUrl = getEffectiveApiUrl();

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

// --- Phase 126 sandbox bind-code contract ---
//
// Mirrors backend/src/sandbox/bind-code.controller.ts (Plan 03 Wave 2 locked
// contract: `GET /sandbox/bind-code` returns the caller's available bind code
// for the active workspace. The code doubles as the consumed-session bearer
// token once a phone claims it via an inbound WhatsApp message). The backend
// populates `consumedSessionId` only after the code has been consumed — the
// CLI polls until that field is present, then fetches the session detail via
// the existing `GET /sandbox/sessions/:sessionPublicId` path.
export interface BindCodeResponse {
  code: string;
  issuedAt: string; // ISO timestamp
  consumedSessionId?: string; // ssn_<8> publicId; present iff the code was consumed
}

/**
 * Fetch the caller's available bind code for the active workspace. Thin
 * wrapper around `apiClient` so the CLI commands get a typed return +
 * centralized retry/error-mapping through the main client.
 *
 * Errors funnel through `mapApiError`: 401 → AuthError (exit 4), 409 →
 * ConflictError (exit 6), 5xx → ApiError (exit 1) — same contract every other
 * typed helper in this file honors.
 */
export async function getBindCode(
  workspaceId: string,
): Promise<BindCodeResponse> {
  return (await apiClient('/sandbox/bind-code', {
    method: 'GET',
    workspaceId,
  })) as BindCodeResponse;
}
