import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiClient } from '../client.js';
import { API_KEY_ENV_VAR } from '../../config/env-vars.js';
import * as secrets from '../../storage/secrets.js';
import { AuthError, ForbiddenError } from '../../output/error.js';
import { setWorkspaceContext } from '../client.js';

// The env key must reach the wire as the bearer token, exactly as a stored
// agent credential does — no refresh attempt, no rewriting (AIT-438).
describe('apiClient with HOOKMYAPP_API_KEY (AIT-438)', () => {
  const original = process.env[API_KEY_ENV_VAR];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(secrets, 'readSecrets').mockResolvedValue(null);
  });
  afterEach(() => {
    if (original === undefined) delete process.env[API_KEY_ENV_VAR];
    else process.env[API_KEY_ENV_VAR] = original;
    vi.unstubAllGlobals();
  });

  // A revoked key 401s. "Session expired. Run: login" is wrong twice over —
  // there is no session, and login refuses while the variable is set.
  it('names the variable when the key is rejected, not "session expired"', async () => {
    process.env[API_KEY_ENV_VAR] = 'hmok_revoked';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ message: 'Unauthorized' }),
    })));

    await expect(apiClient('/workspaces')).rejects.toThrow(AuthError);
    await expect(apiClient('/workspaces')).rejects.toThrow(
      /HOOKMYAPP_API_KEY was rejected/,
    );
  });

  // A bare 403 maps to PermissionError, whose stock message says "run:
  // hookmyapp login" — which login now refuses to do while the key is set.
  it('gives permission guidance, not login advice, on a bare 403', async () => {
    process.env[API_KEY_ENV_VAR] = 'hmok_lowperm';
    setWorkspaceContext({ workspaceId: 'ws_abc12345' });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ message: 'Forbidden' }),
    })));

    await expect(apiClient('/channels')).rejects.toThrow(ForbiddenError);
    await expect(apiClient('/channels')).rejects.toThrow(
      /HOOKMYAPP_API_KEY lacks permission for workspace ws_abc12345/,
    );
    await expect(apiClient('/channels')).rejects.not.toThrow(/hookmyapp login/);
    setWorkspaceContext({ workspaceId: null });
  });

  it('sends the env key as the Authorization bearer', async () => {
    process.env[API_KEY_ENV_VAR] = 'hmok_livekey123';
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [{ id: 'ws_abc12345' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiClient('/workspaces');

    expect(res).toEqual([{ id: 'ws_abc12345' }]);
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer hmok_livekey123');
    // One call only: an agent credential has no refresh token, so nothing
    // should have tried to reach WorkOS first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
