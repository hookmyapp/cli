import { readCredentials, saveCredentials } from '../auth/store.js';
import { isAgentCredential } from '../storage/secrets.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import {
  AuthError,
  ApiError,
  ClientOutdatedError,
  NetworkError,
  PermissionError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  SessionWindowError,
  FeatureDisabledError,
  UnexpectedError,
  AppError,
  type CliError,
} from '../output/error.js';
import {
  getEffectiveApiUrl,
  getEffectiveWorkosClientId,
} from '../config/env-profiles.js';
import { timedFetch } from './timed-fetch.js';
import { buildVersionHeaders } from './version-headers.js';

// Module-level workspace context populated by the top-level CLI entry after
// parsing --workspace. Explicit options.workspaceId on a specific apiClient()
// call always wins; this is the fallback used by every other call site, so
// subcommands like `env` don't have to remember to thread the header through.
let workspaceCtx: { workspaceId: string | null } = { workspaceId: null };

export function setWorkspaceContext(ctx: { workspaceId: string | null }): void {
  workspaceCtx = ctx;
}

function decodeJwtExp(token: string): number {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return decoded.exp ?? 0;
  } catch {
    return 0;
  }
}

/**
 * `res.json()` where a transport failure mid-body stays a transport failure.
 *
 * Headers can arrive 2xx and the bytes never follow — a stalled proxy, a
 * dropped connection, our own request timeout firing during the read. That
 * abort surfaces from `res.json()`, well after the `catch` around `fetch`, so
 * every blanket `.catch(() => empty)` in this file was quietly relabelling a
 * failed request: as an empty success, as a malformed response, as an expired
 * session. All three told the user something untrue about a network stall
 * (AIT-540). A genuinely empty or non-JSON body still reads as `null`.
 */
async function readJsonBody(res: Response, networkMessage: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    if (isNetworkFailure(err)) throw new NetworkError(networkMessage);
    return null;
  }
}

async function refreshToken(
  refreshTokenValue: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: getEffectiveWorkosClientId(),
  });
  let res: Response;
  try {
    res = await timedFetch('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
  } catch (err) {
    // Transport failure — the refresh never reached WorkOS. This is NOT an
    // expired session; long-running commands (support watch) retry it.
    throw new NetworkError(
      `Could not reach the sign-in service: ${describeFetchError(err)}. Check your internet connection.`,
    );
  }

  if (res.status === 429 || res.status >= 500) {
    // WorkOS-side transient — same retryable class as a transport failure.
    throw new NetworkError(`Sign-in service unavailable (HTTP ${res.status}). Try again shortly.`);
  }
  if (!res.ok) {
    // Throw a typed AppError so the top-level exit-code mapper + Sentry
    // capture get a severity-tagged event instead of a bare Error. The caller
    // (forceTokenRefresh / apiClient) catches this and surfaces a friendly
    // AuthError('Session expired. Run: hookmyapp login') to the user.
    throw new UnexpectedError('refresh failed', 'WORKOS_REFRESH_FAILED');
  }

  const data = (await readJsonBody(
    res,
    'Lost the connection to the sign-in service while reading its response. Try again.',
  )) as { access_token?: unknown; refresh_token?: unknown } | null;
  // Shape guard — a 200 with missing/empty tokens must NOT be persisted, or
  // saveCredentials would corrupt the store (JSON.stringify drops undefined
  // fields, leaving a credentials.json with no tokens at all).
  if (
    typeof data?.access_token !== 'string' || data.access_token === '' ||
    typeof data?.refresh_token !== 'string' || data.refresh_token === ''
  ) {
    throw new UnexpectedError('refresh response malformed', 'WORKOS_REFRESH_FAILED');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: decodeJwtExp(data.access_token),
  };
}

async function validAccessToken(
  creds: NonNullable<Awaited<ReturnType<typeof readCredentials>>>,
): Promise<string> {
  if (isAgentCredential(creds)) return creds.accessToken;
  const exp = decodeJwtExp(creds.accessToken);
  if (exp === 0 || Date.now() / 1000 <= exp - 60) return creds.accessToken;
  try {
    const refreshed = await refreshToken(creds.refreshToken);
    await saveCredentials(refreshed);
    return refreshed.accessToken;
  } catch (err) {
    // Transport/transient failures keep their retryable identity — only a
    // refresh WorkOS actually rejected means the session is gone.
    if (err instanceof NetworkError) throw err;
    throw new AuthError('Session expired. Run: hookmyapp login');
  }
}

/** Return the same fresh Bearer token used by normal CLI API requests. */
export async function getValidAccessToken(): Promise<string> {
  const creds = await readCredentials();
  if (!creds) throw new AuthError('Not logged in. Run: hookmyapp login');
  return validAccessToken(creds);
}

export async function forceTokenRefresh(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }
  // Agent (auth.md) credentials are org-scoped Bearer tokens with no refresh
  // token; there is nothing to refresh.
  if (isAgentCredential(creds)) {
    return;
  }
  try {
    const refreshed = await refreshToken(creds.refreshToken);
    await saveCredentials(refreshed);
  } catch (err) {
    // Same rule as validAccessToken: only a refresh WorkOS actually rejected
    // means the session is gone. A transport failure kept its identity there
    // and was losing it here, so `channels connect` on a stalled network told
    // the user to log in again (AIT-540).
    if (err instanceof NetworkError) throw err;
    throw new AuthError('Session expired. Run: hookmyapp login');
  }
}

/**
 * Re-scope the stored session to a workspace's organization via the backend
 * (POST /auth/rescope). The server resolves workspace → org — the CLI never
 * sees the internal WorkOS organization id (AIT-182).
 */
export async function rescopeWorkspaceToken(workspaceId: string): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }
  // Agent (auth.md) credentials are org-scoped Bearer tokens with no refresh
  // token; nothing to rescope.
  if (isAgentCredential(creds)) {
    return;
  }
  let res: Response;
  try {
    res = await timedFetch(`${getEffectiveApiUrl()}/auth/rescope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildVersionHeaders() },
      body: JSON.stringify({ refreshToken: creds.refreshToken, workspaceId }),
    });
  } catch (err) {
    if (isNetworkFailure(err)) {
      throw new NetworkError(
        `Could not connect to HookMyApp API (${new URL(getEffectiveApiUrl()).host}): ${describeFetchError(err)}. Check your internet connection or try again later.`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    throw await mapApiError(res);
  }
  const data = (await readJsonBody(
    res,
    `Lost the connection to HookMyApp API (${new URL(getEffectiveApiUrl()).host}) while reading the response. Try again.`,
  )) as { accessToken?: unknown; refreshToken?: unknown } | null;
  // Shape guard — never persist a 200 with missing/empty tokens (same rule as
  // refreshToken above; a corrupt credentials.json is worse than a hard error).
  if (
    typeof data?.accessToken !== 'string' || data.accessToken === '' ||
    typeof data?.refreshToken !== 'string' || data.refreshToken === ''
  ) {
    throw new UnexpectedError('rescope response malformed', 'RESCOPE_FAILED');
  }
  await saveCredentials({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: decodeJwtExp(data.accessToken),
  });
}

// Centralized HTTP-status → AppError subclass mapping. Every non-ok response
// from apiClient funnels through here so that error shape/exit codes stay
// consistent across commands. Keep this in sync with the error-hierarchy
// contract in output/error.ts (exit codes: 2 / 3 / 4 / 5 / 6).
//
// Return type is `CliError` — a an earlier release alias that is identical at runtime
// to `AppError` under an earlier release. Existing callers see no change.
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
    // Feature-availability rejections (e.g. INSTAGRAM_DISABLED) surface the
    // server's message verbatim — "contact your workspace admin" would be
    // wrong guidance for a feature the server has turned off.
    if (code === 'INSTAGRAM_DISABLED') {
      return new FeatureDisabledError(msg, code);
    }
    // AIT-525: the workspace is in an org this session isn't scoped to. Append
    // the CLI's own remedy — the server message is client-neutral, and without
    // the next command this reads as an unfixable wall.
    if (code === 'WORKSPACE_ORG_MISMATCH') {
      const creds = await readCredentials();
      const remedy =
        creds && isAgentCredential(creds)
          ? `This login is locked to one organization. Sign in again for the other one: ${cliCommandPrefix()} login --email ${creds.email ?? '<your-email>'} --org <org_id>`
          : `Switch to it: ${cliCommandPrefix()} workspace use <name-or-ws_id>`;
      return new ForbiddenError(`${msg}\n\n${remedy}`, code);
    }
    // AIT-151: any other 403 that carries a server code + message is a specific
    // denial (e.g. AGENT_KEY_REVOKE_SELF_ONLY) — surface the server's own
    // message + code verbatim instead of the blanket "requires workspace admin"
    // guidance, which is wrong for most coded 403s.
    if (code) {
      return new ForbiddenError(msg, code);
    }
    // Bare 403 with no server code — a genuine permission gate. Keep the
    // actionable admin guidance.
    // Lazy-import to avoid a cycle with commands/workspace.ts
    const { readWorkspaceConfig } = await import('../commands/workspace.js');
    const cfg = readWorkspaceConfig();
    return new PermissionError(cfg.activeWorkspaceSlug ?? '<unknown>');
  }
  if (res.status === 409) return new ConflictError(msg, code ?? 'CONFLICT');
  // bootstrap-code exchange error mapping.
  // 404 and 410 collapse to the same user-facing message (oracle-attack
  // defense — brute-force guessers can't distinguish "unknown code" from
  // "already spent code"). ApiError.exitCode defaults to 1; we override
  // to 5 on the instance so the CLI's exit-code contract stays honest
  // ("API rejected the bootstrap code" is a distinct failure class).
  // AIT-51: a stale activeWorkspaceId (DB re-seed, deleted workspace) makes
  // every workspace-scoped command 404 — point at the recovery command.
  if (res.status === 404 && code === 'WORKSPACE_NOT_FOUND') {
    return new ApiError(`${msg}. Run: hookmyapp workspace use <name>`, 404);
  }
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
  // The Stripe billing portal endpoints were retired — any call that still
  // reaches one gets a pointer to the in-app Billing page instead of a raw 410.
  if (res.status === 410 && code === 'BILLING_PORTAL_RETIRED') {
    return new ApiError(
      'This billing endpoint was retired. Manage billing from your Billing page in the app. Run: hookmyapp billing manage',
      410,
    );
  }
  if (res.status === 429) {
    // use the new RateLimitError class (sev3, httpStatus
    // 429). Exit code remains 6 so the an earlier release exit-code contract for 429
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
    // AIT-337: coded support errors (503 SUPPORT_NOT_CONFIGURED, the
    // "result unknown — list your tickets before retrying" ambiguity, …)
    // carry safe, actionable user messages — surface them verbatim instead
    // of the generic 5xx line.
    if (code?.startsWith('SUPPORT_')) return new ApiError(msg, res.status, code);
    return new ApiError('Something went wrong on our end. Try again later.', res.status);
  }
  // Generic 4xx fallback — preserve the server's own code (AIT-151) so scripts
  // reading --json can branch on it instead of a flat API_ERROR.
  return new ApiError(msg, res.status, code);
}

export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  // AbortSignal.timeout aborts with a DOMException named TimeoutError. Every
  // catch block in this file already maps a network failure to NetworkError
  // (exit 5), so recognising it here is the whole of the timeout handling.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((err as any)?.name === 'TimeoutError') return true;
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

/** Undici wraps the real failure ("getaddrinfo ENOTFOUND …", cert errors) in
 * `err.cause` behind a generic "fetch failed" — surface the inner message. */
export function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const inner = cause instanceof Error ? cause.message : undefined;
  const outer = err instanceof Error ? err.message : String(err);
  return inner && inner !== outer ? `${outer} (${inner})` : outer;
}

export async function apiClient(
  path: string,
  options?: RequestInit & { workspaceId?: string },
): Promise<any> {
  const creds = await readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }

  // set Sentry user tag on every authenticated API call.
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

  const accessToken = await validAccessToken(creds);

  const baseUrl = getEffectiveApiUrl();

  const { workspaceId, ...fetchOptions } = options ?? {};

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...buildVersionHeaders(),
    ...(fetchOptions.headers as Record<string, string> ?? {}),
  };

  // Precedence: explicit options.workspaceId wins, else fall back to the
  // global --workspace context. /workspaces is the discovery endpoint — we
  // intentionally never inject (chicken-and-egg: the user is fetching the
  // list precisely to pick a workspace).
  const resolvedWsId = workspaceId !== undefined ? workspaceId : workspaceCtx.workspaceId;
  if (resolvedWsId && !path.startsWith('/workspaces')) {
    headers['X-Workspace-Id'] = resolvedWsId;
  }

  let res: Response;
  try {
    res = await timedFetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      headers,
    });
  } catch (err) {
    if (isNetworkFailure(err)) {
      // Name the host + underlying cause (AIT-88) — the bare copy made
      // network failures undiagnosable in nightly logs.
      throw new NetworkError(
        `Could not connect to HookMyApp API (${new URL(baseUrl).host}): ${describeFetchError(err)}. Check your internet connection or try again later.`,
      );
    }
    throw err;
  }

  // Soft-warn — server signals "client below min_recommended" via the response
  // header. Banner is informational; the underlying response continues to flow.
  // Suppressed by NO_UPDATE_NOTIFIER=1 (npm/AWS CDK/Vue CLI/Yeoman convention).
  maybePrintOutdatedBanner(res);

  // Hard block — 426 Upgrade Required (RFC 9110 §15.5.16). Spec payload shape:
  // { code, outdated[], minVersions{}, messages[] }. Print the messages, throw
  // a ClientOutdatedError so the top-level mapper exits 1 cleanly.
  if (res.status === 426) {
    throw await parseClientOutdated(res);
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
  // `?? undefined`: an empty or non-JSON 2xx body reads as void rather than
  // crashing with "Unexpected end of JSON input" for callers that don't
  // consume the return.
  return (
    (await readJsonBody(
      res,
      `Lost the connection to HookMyApp API (${new URL(baseUrl).host}) while reading the response. Try again.`,
    )) ?? undefined
  );
}

// --- money model v2 billing contract (Plan 05 Task 1) ---
//
// Mirrors backend/src/organizations/billing/eligibility.controller.ts.
// `eligiblePlan` is which plan a trial/expired org is allowed to check out
// into — never a picker, the eligibility gate decides. `trialStatus` mirrors
// the subscription's own `trial.status` but is returned unauthenticated-org-
// scoped so the CLI can call it before deciding whether to show a picker at
// all (Task 3).
export interface BillingEligibility {
  eligiblePlan: 'build' | 'scale' | 'business';
  trialActions: number;
  trialStatus: 'not_started' | 'active' | 'expired';
}

// Plan 02 Task 6's additive subscription contract. Legacy orgs never carry
// these fields (usageUnit undefined) — callers branch on `usageUnit`/`trial`
// presence, never re-derive "is this a money-model-v2 org" some other way.
export interface BillingTrial {
  status: 'not_started' | 'active' | 'expired';
  endsAt: string | null;
  daysLeft: number | null;
}

export interface BillingSubscription {
  status: string;
  plan: { slug: string; name: string; messages: number; priceInCents?: number; annualPriceInCents?: number };
  billingInterval?: 'monthly' | 'annual';
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  pendingPlanChange?: unknown;
  // Additive — absent entirely for legacy (messages-generation) orgs.
  usageUnit?: 'messages' | 'actions';
  actionsUsed?: number;
  actionsQuota?: number | null; // null = unlimited
  unlimited?: boolean;
  trial?: BillingTrial | null;
}

/**
 * Fetch checkout eligibility for the org. Returns `null` when the backend has
 * the money-model-v2 flag off (400 `PLAN_NOT_AVAILABLE`) — callers treat null
 * as "legacy world" and keep pre-v2 output/behavior unchanged. Any other
 * error rethrows through the normal mapApiError contract.
 */
export async function getBillingEligibility(
  orgPublicId: string,
): Promise<BillingEligibility | null> {
  try {
    return (await apiClient(
      `/organizations/${orgPublicId}/billing/eligibility`,
    )) as BillingEligibility;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PLAN_NOT_AVAILABLE') {
      return null;
    }
    throw err;
  }
}

// --- sandbox bind-code contract ---
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

// --- Phase 2 of CLI + skill version enforcement (spec 2026-05-06) ---

/**
 * Print the soft-warn banner if the response carries `X-HookMyApp-Client-Outdated`.
 * Header value is a comma-separated list of components (e.g. "cli", "skill",
 * "cli,skill"). Banner is suppressed when NO_UPDATE_NOTIFIER=1.
 *
 * Banner is informational only — the original response continues to flow.
 * Printed once per process (a single CLI command makes O(1) backend calls,
 * but we still de-dupe defensively in case of paginated/poll loops).
 */
let bannerPrinted = false;
function maybePrintOutdatedBanner(res: Response): void {
  if (bannerPrinted) return;
  if (process.env.NO_UPDATE_NOTIFIER === '1') return;
  // Defensive: tests use minimal Response mocks that may omit `headers`. The
  // real fetch() always populates it, but `?.get` keeps the soft-warn path
  // crash-proof when the mock skips the field.
  const outdated = res.headers?.get('x-hookmyapp-client-outdated');
  if (!outdated) return;
  const parts = outdated.split(',').map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  if (parts.includes('cli')) {
    lines.push('A newer hookmyapp CLI is available. Update: npm install -g @gethookmyapp/cli@latest');
  }
  if (parts.includes('skill')) {
    lines.push('A newer integrate-hookmyapp skill is available. Update: npx skills add hookmyapp/agent-skills@latest');
  }
  if (lines.length === 0) return;
  process.stderr.write('\n' + lines.join('\n') + '\n\n');
  bannerPrinted = true;
}

interface ClientOutdatedPayload {
  code?: string;
  outdated?: string[];
  minVersions?: { cli?: string; skill?: string };
  messages?: string[];
}

/**
 * Parse a 426 body into a ClientOutdatedError. Defensive against malformed
 * payloads — falls back to a generic upgrade-required message so the CLI
 * never crashes on a server-side regression in payload shape.
 */
async function parseClientOutdated(res: Response): Promise<ClientOutdatedError> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: ClientOutdatedPayload = (await res.json().catch(() => ({}))) as any;
  const messages = Array.isArray(body.messages) && body.messages.length > 0
    ? body.messages.filter((m): m is string => typeof m === 'string')
    : ['HookMyApp CLI or skill needs an upgrade. Run: npm install -g @gethookmyapp/cli@latest'];
  return new ClientOutdatedError(messages, body.code ?? 'CLIENT_OUTDATED');
}
