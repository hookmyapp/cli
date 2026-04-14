import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AuthError,
  PermissionError,
  ConflictError,
  ApiError,
  NetworkError,
} from '../../output/error.js';

// Wave 0 RED: exercises the FUTURE `mapApiError` helper and the
// ECONNREFUSED → NetworkError path via apiClient. Both fail today because
// mapApiError isn't exported from src/api/client.ts and apiClient only maps
// TypeError to NetworkError (not ECONNREFUSED code).

// Mock store so apiClient doesn't hit the real config dir during import.
vi.mock('../../auth/store.js', () => ({
  readCredentials: vi.fn(() => ({
    accessToken: 'test-token',
    refreshToken: 'refresh',
    // far in the future so no refresh is attempted
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })),
  saveCredentials: vi.fn(),
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

describe('mapApiError — Wave 0 RED', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

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
