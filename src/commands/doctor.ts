import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { readCredentials } from '../auth/store.js';
import { apiClient } from '../api/client.js';
import { AuthError, ForbiddenError, PermissionError } from '../output/error.js';
import { isJsonMode } from '../output/format.js';
import { getEffectiveApiUrl } from '../config/env-profiles.js';
import { readWorkspaceConfig } from './workspace.js';
import { addExamples } from '../output/help.js';

// `hard` checks gate the prereq (a FAIL → non-zero exit). Informational checks
// (auth/workspace/default-channel) are reported, never a crash or exit failure.
export interface DoctorCheck { id: string; label: string; ok: boolean; hard: boolean; detail: string; }
export interface DoctorReport { checks: DoctorCheck[]; loggedIn: boolean; ok: boolean; }

function parseMajor(v: string): number { return Number(v.replace(/^v/, '').split('.')[0]) || 0; }

function toolVersion(cmd: string): string | null {
  try {
    const r = spawnSync(cmd, ['-v'], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  } catch { return null; }
}

export async function collectDoctorReport(
  opts: { checkNetwork?: boolean; checkTools?: boolean; nodeVersionOverride?: string } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const nodeV = opts.nodeVersionOverride ?? process.version;
  const nodeOk = parseMajor(nodeV) >= 20;
  checks.push({ id: 'node', label: 'Node.js >= 20', ok: nodeOk, hard: true, detail: nodeOk ? nodeV : `${nodeV} — upgrade at https://nodejs.org` });

  // npm/npx presence (best-effort; gated so unit tests stay hermetic).
  if (opts.checkTools !== false) {
    const npm = toolVersion('npm');
    checks.push({ id: 'npm', label: 'npm', ok: npm !== null, hard: true, detail: npm ?? 'not found on PATH' });
    const npx = toolVersion('npx');
    checks.push({ id: 'npx', label: 'npx', ok: npx !== null, hard: true, detail: npx ?? 'not found on PATH' });
  }

  if (opts.checkNetwork !== false) {
    const apiUrl = getEffectiveApiUrl();
    let netOk = false; let detail = `${apiUrl} reachable`;
    try {
      const r = await fetch(`${apiUrl}/health`, { method: 'GET' });
      netOk = r.ok || r.status < 500;
    } catch { detail = `no outbound HTTPS to ${apiUrl}`; }
    checks.push({ id: 'network', label: 'Outbound HTTPS', ok: netOk, hard: true, detail });
  }

  let loggedIn = false;
  let creds: Awaited<ReturnType<typeof readCredentials>> = null;
  try { creds = await readCredentials(); loggedIn = creds !== null; } catch { loggedIn = false; }
  // Credentials-present alone is a false positive when the stored token is
  // expired or belongs to another env (2026-07-07 audit: doctor said OK, the
  // next command 401'd). When network checks are on, prove the token works
  // against the ACTIVE env through apiClient — the SAME path every real
  // command uses, including the token-refresh attempt. A raw fetch with the
  // stored accessToken false-FAILs on tokens that are merely expired but
  // refreshable (2026-07-08 audit).
  let authDetail = loggedIn ? 'credentials present' : 'not logged in — run: hookmyapp login';
  // Kept from the auth probe so the workspace check below can validate the
  // persisted activeWorkspaceId against the backend instead of trusting the
  // cache (AIT-51: after a DB re-seed doctor said OK while every scoped
  // command 404'd).
  let workspaces: Array<{ id?: string }> | null = null;
  if (loggedIn && opts.checkNetwork !== false) {
    try {
      const res = await apiClient('/workspaces');
      if (Array.isArray(res)) workspaces = res;
      authDetail = 'credentials valid for this env';
    } catch (err) {
      // ForbiddenError is what coded 403s map to since AIT-151 — a denial is
      // still a rejected credential, not a network flake.
      if (err instanceof AuthError || err instanceof PermissionError || err instanceof ForbiddenError) {
        loggedIn = false;
        authDetail = 'credentials present but rejected by this env — run: hookmyapp login';
      }
      // Anything else (network flake, 5xx) — leave the presence-based verdict.
    }
  }
  // Informational: not-logged-in is reported, not a hard prereq failure.
  checks.push({ id: 'auth', label: 'Logged in', ok: loggedIn, hard: false, detail: authDetail });

  let wsId: string | undefined;
  let wsSlug: string | undefined;
  try {
    const cfg = readWorkspaceConfig();
    wsId = cfg.activeWorkspaceId ?? undefined;
    wsSlug = cfg.activeWorkspaceSlug ?? undefined;
  } catch { /* ignore */ }
  let wsOk = true;
  let wsDetail = wsSlug ?? '(none — auto-resolves on first call)';
  // Only a definitive backend list can fail this check — on a network flake
  // (workspaces === null) the cache-based verdict stands, matching the auth
  // probe's fail-open posture above.
  if (wsId && workspaces && !workspaces.some((w) => w?.id === wsId)) {
    wsOk = false;
    wsDetail = `"${wsSlug ?? wsId}" not found on this env (stale selection) — run: hookmyapp workspace use <name>`;
  }
  checks.push({ id: 'workspace', label: 'Active workspace', ok: wsOk, hard: false, detail: wsDetail });
  const envChannel = process.env.HOOKMYAPP_CHANNEL_ID;
  checks.push({ id: 'default-channel', label: 'Default channel (HOOKMYAPP_CHANNEL_ID)', ok: true, hard: false, detail: envChannel || '(none — pass --channel or set HOOKMYAPP_CHANNEL_ID)' });

  const ok = checks.every((c) => !c.hard || c.ok);
  return { checks, loggedIn, ok };
}

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command('doctor')
    .description('Check prerequisites (Node, npm/npx, network) and login state')
    .action(async function (this: Command) {
      const report = await collectDoctorReport();
      if (isJsonMode(this)) {
        process.stdout.write(JSON.stringify(report) + '\n');
      } else {
        for (const c of report.checks) {
          process.stdout.write(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}: ${c.detail}\n`);
        }
      }
      // Block the prereq gate: any HARD check failing → non-zero exit (spec D5).
      // Informational checks (auth/workspace/default-channel) never set this.
      if (!report.ok) process.exitCode = 1;
    });

  addExamples(
    doctor,
    `
EXAMPLES:
  $ hookmyapp doctor
  $ hookmyapp doctor --json
`,
  );
}
