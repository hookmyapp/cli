import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock store module
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { readCredentials, saveCredentials } from '../auth/store.js';
const mockedReadCredentials = vi.mocked(readCredentials);
const mockedSaveCredentials = vi.mocked(saveCredentials);

describe('apiClient', () => {
  let apiClient: typeof import('../api/client.js').apiClient;
  let AuthError: typeof import('../output/error.js').AuthError;
  let ApiError: typeof import('../output/error.js').ApiError;
  let NetworkError: typeof import('../output/error.js').NetworkError;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    mockedReadCredentials.mockReset();
    mockedSaveCredentials.mockReset();

    // Re-import to get fresh modules (resetModules creates new instances)
    const mod = await import('../api/client.js');
    const errMod = await import('../output/error.js');
    apiClient = mod.apiClient;
    AuthError = errMod.AuthError;
    ApiError = errMod.ApiError;
    NetworkError = errMod.NetworkError;
  });

  afterEach(() => {
    delete process.env.HOOKMYAPP_API_URL;
  });

  it('adds Authorization Bearer header from stored credentials', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64');
    const fakeJwt = `header.${payload}.sig`;

    mockedReadCredentials.mockReturnValue({
      accessToken: fakeJwt,
      refreshToken: 'rt',
      expiresAt: futureExp,
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: 'ok' }),
    });

    const result = await apiClient('/test');
    expect(result).toEqual({ data: 'ok' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/test'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${fakeJwt}`,
        }),
      }),
    );
  });

  it('throws AuthError when no credentials stored', async () => {
    mockedReadCredentials.mockReturnValue(null);

    try {
      await apiClient('/test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).userMessage).toContain('Not logged in');
    }
  });

  it('refreshes token when expiresAt is in the past', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 300;
    const payload = Buffer.from(JSON.stringify({ exp: pastExp })).toString('base64');
    const expiredJwt = `header.${payload}.sig`;

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const newPayload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64');
    const newJwt = `header.${newPayload}.sig`;

    mockedReadCredentials.mockReturnValue({
      accessToken: expiredJwt,
      refreshToken: 'rt-old',
      expiresAt: pastExp,
    });

    // First call: refresh token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: newJwt,
        refresh_token: 'rt-new',
      }),
    });

    // Second call: actual API call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ refreshed: true }),
    });

    const result = await apiClient('/test');
    expect(result).toEqual({ refreshed: true });
    expect(mockedSaveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: newJwt,
        refreshToken: 'rt-new',
      }),
    );
  });

  it('uses HOOKMYAPP_API_URL env var when set, defaults to ngrok dev URL', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64');
    const fakeJwt = `header.${payload}.sig`;

    mockedReadCredentials.mockReturnValue({
      accessToken: fakeJwt,
      refreshToken: 'rt',
      expiresAt: futureExp,
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    // Test default URL (ngrok dev URL)
    await apiClient('/foo');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://uninked-robbi-boughless.ngrok-free.dev/foo',
      expect.anything(),
    );

    mockFetch.mockClear();

    // Test env override
    process.env.HOOKMYAPP_API_URL = 'http://localhost:4312';
    await apiClient('/bar');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4312/bar',
      expect.anything(),
    );
  });

  it('throws NetworkError when fetch fails with TypeError', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64');
    const fakeJwt = `header.${payload}.sig`;

    mockedReadCredentials.mockReturnValue({
      accessToken: fakeJwt,
      refreshToken: 'rt',
      expiresAt: futureExp,
    });

    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(apiClient('/test')).rejects.toThrow(NetworkError);
  });

  it('throws ApiError with generic message on 5xx', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64');
    const fakeJwt = `header.${payload}.sig`;

    mockedReadCredentials.mockReturnValue({
      accessToken: fakeJwt,
      refreshToken: 'rt',
      expiresAt: futureExp,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal Server Error' }),
      statusText: 'Internal Server Error',
    });

    try {
      await apiClient('/test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).userMessage).toContain('Something went wrong on our end');
      expect((err as ApiError).statusCode).toBe(500);
    }
  });

  it('throws ApiError with backend message on 4xx', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64');
    const fakeJwt = `header.${payload}.sig`;

    mockedReadCredentials.mockReturnValue({
      accessToken: fakeJwt,
      refreshToken: 'rt',
      expiresAt: futureExp,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not found' }),
      statusText: 'Not Found',
    });

    try {
      await apiClient('/test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).userMessage).toBe('Not found');
      expect((err as ApiError).statusCode).toBe(404);
    }
  });
});
