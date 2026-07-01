import { expect, test, beforeEach, afterEach, vi } from 'vitest';

const SAVED = process.env.HOOKMYAPP_API_URL;
beforeEach(() => {
  process.env.HOOKMYAPP_API_URL = 'https://test.example.com';
});
afterEach(() => {
  if (SAVED) process.env.HOOKMYAPP_API_URL = SAVED;
  else delete process.env.HOOKMYAPP_API_URL;
  vi.unstubAllGlobals();
});

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('fetchSupportedScopes reads scopes_supported from the well-known', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ scopes_supported: ['workspace.read', 'message.send'] })));
  const { fetchSupportedScopes } = await import('../agent-auth.js');
  expect(await fetchSupportedScopes()).toEqual(['workspace.read', 'message.send']);
});

test('initiateClaim POSTs email + scopes and returns registrationId + expiresAt', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    okJson({ registrationId: '11111111-1111-1111-1111-111111111111', expiresAt: '2026-07-01T00:10:00.000Z', message: 'sent' }, 202),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { initiateClaim } = await import('../agent-auth.js');
  const out = await initiateClaim({ email: 'a@b.com', scopes: ['workspace.read'] });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe('https://test.example.com/agent/auth/claim');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.com', scopes: ['workspace.read'] });
  expect(out.registrationId).toBe('11111111-1111-1111-1111-111111111111');
});

test('completeClaim POSTs registrationId + otp and returns the ac_ credential', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    okJson({ accessToken: 'ac_live_x', tokenType: 'Bearer', scopes: ['workspace.read'], credentialPublicId: 'ac_pub1' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { completeClaim } = await import('../agent-auth.js');
  const out = await completeClaim({ registrationId: '11111111-1111-1111-1111-111111111111', otp: '123456' });
  expect(String(fetchMock.mock.calls[0][0])).toBe('https://test.example.com/agent/auth/claim/complete');
  expect(out.accessToken).toBe('ac_live_x');
  expect(out.credentialPublicId).toBe('ac_pub1');
});

test('completeClaim maps a 429 to a typed rate-limit error (exitCode 6)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ code: 'RATE_LIMITED', message: 'slow down' }, 429)));
  const { completeClaim } = await import('../agent-auth.js');
  await expect(completeClaim({ registrationId: '11111111-1111-1111-1111-111111111111', otp: '000000' })).rejects.toMatchObject({ exitCode: 6 });
});
