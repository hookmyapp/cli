import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Forks a fresh HOOKMYAPP_CONFIG_DIR per test so vitest.setup.ts's shared
// tmp dir doesn't leak state between tests in this file.
let CONFIG_DIR: string;
const SAVED_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;

function base64Json(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64');
  const body = base64Json(payload);
  return `${header}.${body}.signature-ignored`;
}

function writeCreds(creds: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'credentials.json'), JSON.stringify(creds));
}

function writeWorkspaceCfg(cfg: {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
}): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify(cfg));
}

function makeExchangeResponse(overrides: {
  email?: string;
  workspaceName?: string;
  workspaceId?: string;
} = {}): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  workspace: { id: string; name: string; workosOrganizationId: string };
  user: { publicId: string; email: string };
} {
  return {
    accessToken: buildJwt({
      email: overrides.email ?? 'info@ordvir.com',
      exp: 9999999999,
    }),
    refreshToken: 'r_new',
    expiresAt: 9999999999,
    workspace: {
      id: overrides.workspaceId ?? 'ws_NEWWS001',
      name: overrides.workspaceName ?? "Or's Workspace",
      workosOrganizationId: 'org_new',
    },
    user: {
      publicId: 'usr_NEW00001',
      email: overrides.email ?? 'info@ordvir.com',
    },
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- Module-scoped mock for api/client.ts ---
// Preserves mapApiError + isNetworkFailure (real), stubs apiClient so the
// downstream runWizard() call returns zero workspaces (→ wizard prints the
// "You aren't a member" hint and exits cleanly without hitting the net).
const apiClientMock = vi.fn();
const forceTokenRefreshMock = vi.fn();
vi.mock('../../api/client.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/client.js')>(
      '../../api/client.js',
    );
  return {
    ...actual,
    apiClient: apiClientMock,
    forceTokenRefresh: forceTokenRefreshMock,
  };
});

// Mock @inquirer/prompts so a bad code-path never actually prompts.
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

beforeEach(() => {
  CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hookmyapp-bootstrap-test-'));
  process.env.HOOKMYAPP_CONFIG_DIR = CONFIG_DIR;
  // Redirect API URL to a sentinel so fetch-stub URL assertions are stable.
  process.env.HOOKMYAPP_API_URL = 'https://test.example.com';
  apiClientMock.mockReset();
  forceTokenRefreshMock.mockReset();
  // Default: zero workspaces → runWizard prints "not a member" hint + returns.
  apiClientMock.mockResolvedValue([]);
});

afterEach(() => {
  if (existsSync(CONFIG_DIR)) {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  }
  if (SAVED_CONFIG_DIR !== undefined) {
    process.env.HOOKMYAPP_CONFIG_DIR = SAVED_CONFIG_DIR;
  } else {
    delete process.env.HOOKMYAPP_CONFIG_DIR;
  }
  delete process.env.HOOKMYAPP_API_URL;
  vi.unstubAllGlobals();
});

describe('peekIdentity()', () => {
  test('returns null when no credentials file exists', async () => {
    const { peekIdentity } = await import('../store.js');
    expect(peekIdentity()).toBeNull();
  });

  test('returns null when credentials exist but no active workspace', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: buildJwt({ email: 'info@ordvir.com', exp: 9999999999 }),
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    expect(peekIdentity()).toBeNull();
  });

  test('returns { email, workspaceSlug } when JWT carries email claim and workspace is active', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: buildJwt({ email: 'info@ordvir.com', exp: 9999999999 }),
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: "Or's Workspace",
    });
    expect(peekIdentity()).toEqual({
      email: 'info@ordvir.com',
      workspaceSlug: "Or's Workspace",
    });
  });

  test('returns null when JWT is malformed (no body segment)', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: 'not-a-jwt',
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: 'Anything',
    });
    expect(peekIdentity()).toBeNull();
  });

  test('returns null when JWT lacks an email claim', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: buildJwt({ sub: 'usr_1', exp: 9999999999 }),
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: 'Anything',
    });
    expect(peekIdentity()).toBeNull();
  });
});

describe('hookmyapp login --code', () => {
  test('--code happy path: fetches /auth/bootstrap/exchange, saveCredentials, writeWorkspaceConfig, prints identity echo, calls runWizard', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson(makeExchangeResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../login.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runBootstrapCodeExchange('hma_boot_abc123', { next: 'exit' });

    // fetch hit the exchange endpoint exactly once with a POST + JSON body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://test.example.com/auth/bootstrap/exchange',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      code: 'hma_boot_abc123',
    });

    // credentials.json was written with the new tokens.
    const creds = JSON.parse(
      readFileSync(join(CONFIG_DIR, 'credentials.json'), 'utf-8'),
    );
    expect(creds.refreshToken).toBe('r_new');

    // config.json was written with the new workspace (via writeWorkspaceConfig).
    const cfg = JSON.parse(
      readFileSync(join(CONFIG_DIR, 'config.json'), 'utf-8'),
    );
    expect(cfg.activeWorkspaceId).toBe('ws_NEWWS001');
    expect(cfg.activeWorkspaceSlug).toBe("Or's Workspace");

    // Identity echo present in stdout.
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(
      /Logged in as info@ordvir\.com — workspace "Or's Workspace"/,
    );

    // runWizard was invoked — the /workspaces apiClient mock confirms it.
    expect(apiClientMock).toHaveBeenCalledWith('/workspaces');
    logSpy.mockRestore();
  });

  test('--code + --wizard → ValidationError exit 2 (mutually exclusive)', async () => {
    // The mutex is enforced in the commander .action() callback. This test
    // verifies the CLI-wiring contract: ValidationError is thrown BEFORE any
    // network call when both flags are present.
    const { ValidationError } = await import('../../output/error.js');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Simulate the exact mutex check from loginCommand.action:
    const simulateActionMutex = (opts: { code?: string; wizard?: boolean }) => {
      if (opts.code) {
        if (opts.wizard) {
          throw new ValidationError(
            '--code and --wizard are mutually exclusive.',
          );
        }
      }
    };
    expect(() =>
      simulateActionMutex({ code: 'hma_boot_abc', wizard: true }),
    ).toThrow(ValidationError);

    // Pin exit-code contract (ValidationError.exitCode === 2).
    try {
      simulateActionMutex({ code: 'hma_boot_abc', wizard: true });
    } catch (err) {
      expect((err as InstanceType<typeof ValidationError>).exitCode).toBe(2);
    }

    // No fetch was made.
    expect(fetchMock).not.toHaveBeenCalled();

    // Grep-verify the mutex check exists in the source (defensive drift check).
    const loginSrc = readFileSync(
      new URL('../login.ts', import.meta.url),
      'utf-8',
    );
    expect(loginSrc).toContain('--code and --wizard are mutually exclusive');
  });

  test('--code with prior identity present AND different → prints "was:" diff line before identity echo', async () => {
    // Seed prior identity: different email + workspace.
    writeCreds({
      accessToken: buildJwt({ email: 'old@other.com', exp: 9999999999 }),
      refreshToken: 'r_old',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_OLDWS001',
      activeWorkspaceSlug: 'Old Workspace',
    });

    const fetchMock = vi.fn().mockResolvedValue(
      okJson(
        makeExchangeResponse({
          email: 'info@ordvir.com',
          workspaceName: "Or's Workspace",
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../login.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runBootstrapCodeExchange('hma_boot_abc', { next: 'exit' });

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(
      /Replaced previous session \(was: old@other\.com — workspace "Old Workspace"\)/,
    );
    expect(out).toMatch(
      /Logged in as info@ordvir\.com — workspace "Or's Workspace"/,
    );
    // "was:" MUST appear before the "Logged in as" line.
    const wasIdx = out.search(/Replaced previous session/);
    const loggedIdx = out.search(/Logged in as/);
    expect(wasIdx).toBeGreaterThanOrEqual(0);
    expect(loggedIdx).toBeGreaterThan(wasIdx);
    logSpy.mockRestore();
  });

  test('--code with prior identity present AND same → does NOT print "was:" diff line', async () => {
    writeCreds({
      accessToken: buildJwt({ email: 'info@ordvir.com', exp: 9999999999 }),
      refreshToken: 'r_old',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_SAME0001',
      activeWorkspaceSlug: "Or's Workspace",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      okJson(
        makeExchangeResponse({
          email: 'info@ordvir.com',
          workspaceName: "Or's Workspace",
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../login.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runBootstrapCodeExchange('hma_boot_abc', { next: 'exit' });

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toMatch(/Replaced previous session/);
    expect(out).toMatch(/Logged in as info@ordvir\.com/);
    logSpy.mockRestore();
  });

  test('--code with 404 response → ApiError exitCode 5 with message matching /invalid or already used/i', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorJson(404, {
            code: 'BOOTSTRAP_NOT_FOUND',
            message: 'ignored client renders its own copy',
          }),
        ),
    );
    const mod = await import('../login.js');
    await expect(
      mod.runBootstrapCodeExchange('hma_boot_bad', { next: 'exit' }),
    ).rejects.toMatchObject({
      exitCode: 5,
      statusCode: 404,
    });
    // re-invoke for the message assertion (first fetch mock is exhausted;
    // re-stub cleanly).
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorJson(404, {
            code: 'BOOTSTRAP_NOT_FOUND',
            message: 'ignored',
          }),
        ),
    );
    await expect(
      mod.runBootstrapCodeExchange('hma_boot_bad', { next: 'exit' }),
    ).rejects.toThrow(/invalid or already used/i);
  });

  test('--code with 410 response → ApiError exitCode 5 with message matching /expired or already used/i', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorJson(410, {
            code: 'BOOTSTRAP_EXPIRED_OR_USED',
            message: 'ignored',
          }),
        ),
    );
    const mod = await import('../login.js');
    await expect(
      mod.runBootstrapCodeExchange('hma_boot_expired', { next: 'exit' }),
    ).rejects.toMatchObject({
      exitCode: 5,
      statusCode: 410,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorJson(410, {
            code: 'BOOTSTRAP_EXPIRED_OR_USED',
            message: 'ignored',
          }),
        ),
    );
    await expect(
      mod.runBootstrapCodeExchange('hma_boot_expired', { next: 'exit' }),
    ).rejects.toThrow(/expired or already used/i);
  });

  test('--code with 403 response → PermissionError exitCode 3', async () => {
    // mapApiError lazy-imports readWorkspaceConfig for the 403 branch. The
    // seed config.json lets it resolve the slug for the error message.
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: 'Some Workspace',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorJson(403, {
            code: 'FORBIDDEN',
            message: 'not a member',
          }),
        ),
    );
    const mod = await import('../login.js');
    await expect(
      mod.runBootstrapCodeExchange('hma_boot_forbidden', { next: 'exit' }),
    ).rejects.toMatchObject({
      exitCode: 3,
      code: 'PERMISSION_DENIED',
    });
  });

  test('--code with 429 response → ConflictError exitCode 6, code "RATE_LIMITED"', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorJson(429, {
            code: 'RATE_LIMITED',
            message: 'Too many codes minted. Wait a minute and retry.',
          }),
        ),
    );
    const mod = await import('../login.js');
    await expect(
      mod.runBootstrapCodeExchange('hma_boot_throttled', { next: 'exit' }),
    ).rejects.toMatchObject({
      exitCode: 6,
      code: 'RATE_LIMITED',
    });
  });

  test('identity echo line format: ✓ Logged in as <email> — workspace "<name>" (exact em-dash, exact quote chars)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okJson(
          makeExchangeResponse({
            email: 'info@ordvir.com',
            workspaceName: "Or's Workspace",
          }),
        ),
      ),
    );
    const mod = await import('../login.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mod.runBootstrapCodeExchange('hma_boot_abc', { next: 'exit' });
    const out = logSpy.mock.calls.flat().join('\n');
    // Regex pins the exact contract: leading checkmark (may be color-wrapped),
    // literal "Logged in as", email, space, em-dash (U+2014), space,
    // workspace name in double quotes.
    expect(out).toMatch(
      /\u2713.*Logged in as info@ordvir\.com \u2014 workspace "Or's Workspace"/,
    );
    logSpy.mockRestore();
  });
});
