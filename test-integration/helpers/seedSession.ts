import { copyFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './tmpHome.js';
import { runCli } from './runCli.js';
import { HOOKMYAPP_API_URL } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path where the post-login spec stashes a reusable credentials.json. */
export const SHARED_CREDS_PATH = path.resolve(__dirname, '../.cache/credentials.json');

export interface SeededSandbox {
  sessionId: string;
  phone: string;
  activationCode: string;
  hmacSecret: string;
}

export interface SeededSession {
  home: string;
  workspaceId?: string;
  sandbox?: SeededSandbox;
  cleanup: () => Promise<void>;
}

/**
 * Returns an isolated $HOME pre-populated with the shared logged-in
 * credentials.json AND an active workspace selected (config.json + JWT
 * refreshed to that org). The login spec (77-02) is responsible for
 * producing SHARED_CREDS_PATH before any other spec runs.
 *
 * Pass `opts.skipActiveWorkspace: true` to opt out (e.g. for tests that
 * specifically exercise the no-active-workspace code path).
 * Pass `opts.workspaceId` to seed a specific workspace id directly
 * (writes config.json without invoking the CLI).
 */
export async function seedSession(opts?: {
  workspaceId?: string;
  skipActiveWorkspace?: boolean;
  /**
   * When set, also provisions an active sandbox_session row in the shared
   * test DB for the given phone (via POST /internal/e2e/sandbox-session) so
   * the CLI's `sandbox send` / `sandbox env` subcommands can be exercised
   * end-to-end without a real WhatsApp activation round-trip.
   */
  includeSandboxSession?: { phone: string };
}): Promise<SeededSession> {
  if (!existsSync(SHARED_CREDS_PATH)) {
    throw new Error(
      `[seedSession] ${SHARED_CREDS_PATH} not found. The login spec must run before other specs ` +
        `to produce a shared credentials.json. Confirm spec order or run the login spec first.`,
    );
  }
  const home = await tmpHome();
  const credsDest = path.join(home, '.hookmyapp', 'credentials.json');
  await copyFile(SHARED_CREDS_PATH, credsDest);
  await chmod(credsDest, 0o600);

  let activeWorkspaceId = opts?.workspaceId;
  if (activeWorkspaceId) {
    await writeFile(
      path.join(home, '.hookmyapp', 'config.json'),
      JSON.stringify({ activeWorkspaceId }) + '\n',
    );
  } else if (!opts?.skipActiveWorkspace) {
    // Discover an existing workspace via the CLI itself and activate it.
    // This mirrors what a real user does after `hookmyapp login` and ensures
    // the seeded JWT is scoped to a real WorkOS org so commands that require
    // X-Workspace-Id (token, env, accounts, etc.) work end-to-end.
    const list = await runCli(['workspace', 'list', '--json'], { home });
    if (list.exitCode !== 0) {
      throw new Error(
        `[seedSession] failed to list workspaces with seeded credentials: ` +
          `exit ${list.exitCode}\nstderr: ${list.stderr}`,
      );
    }
    const workspaces = JSON.parse(list.stdout) as Array<{ id: string; name: string }>;
    if (workspaces.length === 0) {
      throw new Error(
        `[seedSession] seeded credentials returned an empty workspace list; ` +
          `cannot activate a workspace.`,
      );
    }
    const target = workspaces[0];
    const use = await runCli(['workspace', 'use', target.id], { home });
    if (use.exitCode !== 0) {
      throw new Error(
        `[seedSession] failed to activate workspace ${target.id}: ` +
          `exit ${use.exitCode}\nstderr: ${use.stderr}`,
      );
    }
    activeWorkspaceId = target.id;
  }

  let sandbox: SeededSandbox | undefined;
  if (opts?.includeSandboxSession) {
    if (!activeWorkspaceId) {
      throw new Error(
        '[seedSession] includeSandboxSession requires an active workspace ' +
          '(skipActiveWorkspace was set OR workspace lookup returned none).',
      );
    }
    const secret = process.env.E2E_PROVISION_SECRET;
    if (!secret) {
      throw new Error(
        '[seedSession] includeSandboxSession requires E2E_PROVISION_SECRET in the env',
      );
    }
    const url = `${HOOKMYAPP_API_URL.replace(/\/$/, '')}/internal/e2e/sandbox-session`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-e2e-secret': secret,
      },
      body: JSON.stringify({
        workspaceId: activeWorkspaceId,
        phone: opts.includeSandboxSession.phone,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `[seedSession] /internal/e2e/sandbox-session failed ${res.status}: ${text}`,
      );
    }
    const created = (await res.json()) as {
      id: string;
      phone: string;
      activationCode: string;
      hmacSecret: string;
    };
    sandbox = {
      sessionId: created.id,
      phone: created.phone,
      activationCode: created.activationCode,
      hmacSecret: created.hmacSecret,
    };
  }

  return {
    home,
    workspaceId: activeWorkspaceId,
    sandbox,
    cleanup: async () => {
      /* tmpdir is auto-cleaned by OS; no-op */
    },
  };
}
