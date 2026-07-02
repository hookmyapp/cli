// `hookmyapp sandbox env` — emit the canonical .env block for a sandbox session.
// Pipe-safe by default (writes to stdout); --write [path] writes to disk with
// a clobber prompt (or --force).
//
// Per D2: WA block uses the WHATSAPP_* prefix (including the WA quirk where
// WHATSAPP_PHONE_NUMBER_ID carries the tester's phone, per spec D4). IG block
// uses the INSTAGRAM_* prefix. Both blocks carry the session's webhook HMAC
// signing secret as WEBHOOK_HMAC_SECRET, plus VERIFY_TOKEN as a temporary
// compat alias (same value) for older starter-kit setups. The webhook verify
// token and the HMAC signing secret are distinct concepts — the alias is
// legacy naming, not an equivalence.

import * as fs from 'node:fs';
import type { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  assertNever,
  INSTAGRAM_GRAPH_VERSION,
  parseSandboxSessions,
  type SandboxSession,
} from '../../api/sandbox-session.js';
import {
  getEffectiveSandboxProxyUrl,
} from '../../config/env-profiles.js';
import { ValidationError } from '../../output/error.js';
import { isJsonMode } from '../../output/format.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { pickSession } from './picker.js';

/**
 * Ordered KEY/VALUE pairs for a sandbox session. `buildEnvBlock` joins these
 * into dotenv text; the `--json` path serializes them into a flat object.
 *
 * Sandbox PORT=3000 is intentional — it's the real local forwarder port for
 * the sandbox listener, NOT the channels-env starter default that Phase A
 * dropped server-side. Keep it in both human and JSON output.
 */
export function buildEnvPairs(session: SandboxSession): [string, string][] {
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  switch (session.type) {
    case 'whatsapp':
      return [
        ['WEBHOOK_HMAC_SECRET', session.hmacSecret],
        // Temporary compat alias — older starter-kit setups read the HMAC
        // signing secret from VERIFY_TOKEN. Same value, distinct concept.
        ['VERIFY_TOKEN', session.hmacSecret],
        ['PORT', '3000'],
        ['WHATSAPP_API_URL', `${proxyBase}/${session.whatsappApiVersion}`],
        ['WHATSAPP_ACCESS_TOKEN', session.accessToken],
        ['WHATSAPP_PHONE_NUMBER_ID', session.whatsappPhone],
      ];
    case 'instagram':
      return [
        ['WEBHOOK_HMAC_SECRET', session.hmacSecret],
        // Temporary compat alias — see the WhatsApp block above.
        ['VERIFY_TOKEN', session.hmacSecret],
        ['PORT', '3000'],
        ['INSTAGRAM_API_URL', `${proxyBase}/${INSTAGRAM_GRAPH_VERSION}`],
        ['INSTAGRAM_ACCESS_TOKEN', session.accessToken],
        ['INSTAGRAM_ACCOUNT_ID', session.accountInstagramId],
      ];
    default:
      return assertNever(session, 'buildEnvPairs');
  }
}

export function buildEnvBlock(session: SandboxSession): string {
  return buildEnvPairs(session)
    .map(([k, v]) => `${k}=${v}`)
    .concat('')
    .join('\n');
}

export async function runSandboxEnv(
  opts: {
    identifierArg?: string;
    phone?: string;
    username?: string;
    session?: string;
    write?: string | boolean;
    force?: boolean;
    json?: boolean;
  },
  cmd?: Command,
): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const isHuman = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    identifierArg: opts.identifierArg,
    phoneFlag: opts.phone,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman,
  });

  // Symmetrical to the channels env --json fix (commit d0f0c82): emit a flat
  // {KEY: VALUE} object so agents can iterate keys programmatically. Honors
  // both the threaded Command (--json on the parsed tree) and the explicit
  // opts.json the registration site already reconciles against the root flag.
  // In JSON mode `--write` is ignored — the agent pipeline that wants
  // JSON-on-disk can `> file.json` from the shell.
  if (opts.json || (cmd && isJsonMode(cmd))) {
    const flat = Object.fromEntries(buildEnvPairs(session));
    process.stdout.write(JSON.stringify(flat) + '\n');
    return;
  }

  const content = buildEnvBlock(session);

  if (opts.write === undefined) {
    process.stdout.write(content);
    return;
  }

  const target = typeof opts.write === 'string' ? opts.write : '.env';
  if (fs.existsSync(target) && !opts.force) {
    if (opts.json) {
      throw new ValidationError(
        `${target} exists. Pass --force to overwrite (or --write=<other-path>)`,
      );
    }
    const ok = await confirm({
      message: `${target} already exists. Overwrite?`,
      default: false,
    });
    if (!ok) return;
  }
  fs.writeFileSync(target, content);
}
