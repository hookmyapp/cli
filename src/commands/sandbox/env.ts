// `hookmyapp sandbox env` — emit the canonical .env block for a sandbox session.
// Pipe-safe by default (writes to stdout); --write [path] writes to disk with
// a clobber prompt (or --force).
//
// Per D2: WA block is 5 lines with WHATSAPP_* prefix (unchanged — including
// the WA quirk where WHATSAPP_PHONE_NUMBER_ID carries the tester's phone, per
// spec D4). IG block is 5 lines with INSTAGRAM_* prefix:
//   VERIFY_TOKEN, PORT, INSTAGRAM_API_URL, INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID.

import * as fs from 'node:fs';
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
import { getDefaultWorkspaceId } from '../_helpers.js';
import { pickSession } from './picker.js';

export function buildEnvBlock(session: SandboxSession): string {
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  switch (session.type) {
    case 'whatsapp':
      return [
        `VERIFY_TOKEN=${session.hmacSecret}`,
        `PORT=3000`,
        `WHATSAPP_API_URL=${proxyBase}/${session.whatsappApiVersion}`,
        `WHATSAPP_ACCESS_TOKEN=${session.accessToken}`,
        `WHATSAPP_PHONE_NUMBER_ID=${session.whatsappPhone}`,
        '',
      ].join('\n');
    case 'instagram':
      return [
        `VERIFY_TOKEN=${session.hmacSecret}`,
        `PORT=3000`,
        `INSTAGRAM_API_URL=${proxyBase}/${INSTAGRAM_GRAPH_VERSION}`,
        `INSTAGRAM_ACCESS_TOKEN=${session.accessToken}`,
        `INSTAGRAM_ACCOUNT_ID=${session.instagramAccountId}`,
        '',
      ].join('\n');
    default:
      return assertNever(session, 'buildEnvBlock');
  }
}

export async function runSandboxEnv(opts: {
  identifierArg?: string;
  phone?: string;
  username?: string;
  session?: string;
  write?: string | boolean;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
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

  const content = buildEnvBlock(session);

  if (opts.write === undefined) {
    process.stdout.write(content);
    return;
  }

  const target = typeof opts.write === 'string' ? opts.write : '.env';
  if (fs.existsSync(target) && !opts.force) {
    if (opts.json) {
      throw new ValidationError(
        `${target} exists — pass --force to overwrite (or --write=<other-path>)`,
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
