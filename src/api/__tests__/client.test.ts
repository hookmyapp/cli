import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest';
import {
  AuthError,
  PermissionError,
  ConflictError,
  ApiError,
  NetworkError,
  ClientOutdatedError,
} from '../../output/error.js';

// Wave 0 RED: exercises the FUTURE `mapApiError` helper and the
// ECONNREFUSED → NetworkError path via apiClient. Both fail today because
// mapApiError isn't exported from src/api/client.ts and apiClient only maps
// TypeError to NetworkError (not ECONNREFUSED code).

// Mock store so apiClient doesn't hit the real config dir during import.
vi.mock('../../auth/store.js', () => ({
  readCredentials: vi.fn(() =>
    Promise.resolve({
      accessToken: 'test-token',
      refreshToken: 'refresh',
      // far in the future so no refresh is attempted
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  ),
  saveCredentials: vi.fn(() => Promise.resolve(undefined)),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(status: number, body: any): Response {
  return {
    ok: false,
    status,
    statusText: 'x',
    json: async () => body,
  } as unknown as Response;
}

// Note: we intentionally do NOT call vi.resetModules() between tests.
// Both this file and client.ts import the same error-class module graph; a
// reset would mint fresh class identities and break `instanceof` across the
// boundary (client.ts returns instances from its copy of error.js, while this
// file's `AuthError` reference would still point at the original copy).

describe('mapApiError — Wave 0 RED', () => {
  it('401 → AuthError', async () => {
    const { mapApiError } = await import('../client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (mapApiError as any)(mkRes(401, {}))).toBeInstanceOf(AuthError);
  });

  it('403 → PermissionError', async () => {
    const { mapApiError } = await import('../client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (mapApiError as any)(mkRes(403, {}))).toBeInstanceOf(
      PermissionError,
    );
  });

  it('409 preserves code + message → ConflictError', async () => {
    const { mapApiError } = await import('../client.js');
    const err = (await (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapApiError as any
    )(mkRes(409, { code: 'PHONE_TAKEN_ANOTHER', message: 'M' }))) as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('PHONE_TAKEN_ANOTHER');
    expect(err.message).toBe('M');
  });

  it('410 + BILLING_PORTAL_RETIRED → ApiError pointing at billing manage', async () => {
    const { mapApiError } = await import('../client.js');
    const err = (await (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapApiError as any
    )(mkRes(410, { code: 'BILLING_PORTAL_RETIRED', message: 'retired' }))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/billing manage/);
  });

  it('422 → ApiError', async () => {
    const { mapApiError } = await import('../client.js');
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mapApiError as any)(mkRes(422, { message: 'bad' })),
    ).toBeInstanceOf(ApiError);
  });

  it('5xx → generic server error', async () => {
    const { mapApiError } = await import('../client.js');
    const err = (await (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapApiError as any
    )(mkRes(502, {}))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/something went wrong/i);
  });
});

describe('apiClient network failure — Wave 0 RED', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ECONNREFUSED → NetworkError', async () => {
    const { apiClient } = await import('../client.js');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      );
    await expect(apiClient('/workspaces')).rejects.toBeInstanceOf(NetworkError);
    fetchSpy.mockRestore();
  });
});

// --- Phase 2 of CLI + skill version enforcement (spec 2026-05-06) ---

function mkOk(status = 200, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

describe('apiClient injects version-enforcement headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('every request carries User-Agent + X-HookMyApp-CLI-Version + lang/runtime/arch/os', async () => {
    const { apiClient } = await import('../client.js');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mkOk(200, { ok: true }));
    await apiClient('/workspaces');

    const sent = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = sent.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/^hookmyapp-cli\/\d+\.\d+\.\d+ \(node\//);
    expect(headers['X-HookMyApp-CLI-Version']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(headers['X-HookMyApp-Lang']).toBe('node');
    expect(headers['X-HookMyApp-Runtime-Version']).toBe(process.versions.node);
    expect(headers['X-HookMyApp-Arch']).toBe(process.arch);
    expect(headers['X-HookMyApp-OS']).toBe(process.platform);
  });
});

describe('apiClient — 426 Upgrade Required handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws ClientOutdatedError carrying messages[] from the body', async () => {
    const { apiClient } = await import('../client.js');
    const body = {
      code: 'CLIENT_OUTDATED',
      outdated: ['skill'],
      minVersions: { cli: '1.4.0', skill: '1.2.0' },
      messages: [
        'Your agent skill is outdated (installed 1.0.0, required 1.2.0).',
        'Run: npx skills add hookmyapp/agent-skills@latest',
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mkOk(426, body));

    try {
      await apiClient('/workspaces');
      expect.fail('expected ClientOutdatedError');
    } catch (e) {
      expect(e).toBeInstanceOf(ClientOutdatedError);
      const err = e as ClientOutdatedError;
      expect(err.messages).toEqual(body.messages);
      expect(err.code).toBe('CLIENT_OUTDATED');
      expect(err.exitCode).toBe(1);
    }
  });

  it('falls back to a generic message when 426 body is malformed', async () => {
    const { apiClient } = await import('../client.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mkOk(426, { malformed: true }));

    try {
      await apiClient('/workspaces');
      expect.fail('expected ClientOutdatedError');
    } catch (e) {
      expect(e).toBeInstanceOf(ClientOutdatedError);
      const err = e as ClientOutdatedError;
      expect(err.messages.length).toBeGreaterThan(0);
      expect(err.messages.join(' ')).toMatch(/upgrade/i);
    }
  });
});

describe('apiClient — soft-warn banner via X-HookMyApp-Client-Outdated', () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NO_UPDATE_NOTIFIER;
  });

  it('prints a CLI banner when the response carries x-hookmyapp-client-outdated: cli', async () => {
    // Reset module state so the bannerPrinted singleton starts fresh.
    vi.resetModules();
    const { apiClient } = await import('../client.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mkOk(200, { ok: true }, { 'x-hookmyapp-client-outdated': 'cli' }),
    );
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await apiClient('/workspaces');
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toMatch(/newer hookmyapp CLI/i);
    expect(printed).toMatch(/npm install -g @gethookmyapp\/cli/);
  });

  it('NO_UPDATE_NOTIFIER=1 suppresses the banner', async () => {
    vi.resetModules();
    process.env.NO_UPDATE_NOTIFIER = '1';
    const { apiClient } = await import('../client.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mkOk(200, { ok: true }, { 'x-hookmyapp-client-outdated': 'cli,skill' }),
    );
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await apiClient('/workspaces');
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toBe('');
  });
});
