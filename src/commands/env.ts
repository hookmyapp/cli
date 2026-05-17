import type { Command } from 'commander';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';

export interface EnvOptions {
  write?: string | boolean;
}

/**
 * Backend wire-shape for `GET /meta/channels/:publicId/env`. The endpoint
 * returns a generic envelope so the CLI never hardcodes per-channel-type
 * key names — when Instagram/Messenger ship, backend changes alone unlock
 * them. `values` is always overwritten on `--write`; `defaults` is
 * preserve-if-exists (only written when the key is absent locally).
 */
interface ChannelEnvPayload {
  channelType: 'whatsapp' | 'instagram' | 'messenger' | string;
  values: Record<string, string>;
  defaults: Record<string, string>;
}

function upsertEnvFile(targetPath: string, updates: Map<string, string>): void {
  const existing = existsSync(targetPath)
    ? readFileSync(targetPath, 'utf8')
    : '';
  const lines = existing === '' ? [] : existing.split('\n');
  const trailingNewline = existing.endsWith('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(raw);
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      out.push(raw);
      continue;
    }
    const key = raw.slice(0, eq).trim();
    if (updates.has(key)) {
      out.push(`${key}=${updates.get(key)!}`);
      seen.add(key);
    } else {
      out.push(raw);
    }
  }
  if (trailingNewline && out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }
  for (const [key, value] of updates) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, out.join('\n') + '\n');
  renameSync(tmp, targetPath);
}

/**
 * Canonical handler for `hookmyapp channels env <channel>` (D9). Also invoked
 * by the deprecated top-level `hookmyapp env <channel>` alias.
 *
 * The CLI is channel-type-agnostic: it consumes whatever `values` + `defaults`
 * the backend returns and writes them verbatim. No per-channel-type branching
 * lives here. Backend `/meta/channels/:publicId/env` owns the shape (see Task
 * 2); incomplete channels surface as a backend DataIntegrityError (5xx, code
 * `CHANNEL_ENV_INCOMPLETE`) which flows through the standard apiClient error
 * path.
 */
export async function runChannelEnv(
  channelRef: string,
  options: EnvOptions,
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const payload: ChannelEnvPayload = await apiClient(
    `/meta/channels/${channel.id}/env`,
    { workspaceId: channel.workspaceId },
  );

  const envText =
    [
      ...Object.entries(payload.values).map(([k, v]) => `${k}=${v}`),
      ...Object.entries(payload.defaults).map(([k, v]) => `${k}=${v}`),
    ].join('\n') + '\n';

  if (options.write === undefined || options.write === false) {
    process.stdout.write(envText);
    return;
  }

  const target = resolvePath(
    typeof options.write === 'string' ? options.write : '.env',
  );

  // values: always overwrite existing entries.
  const updates = new Map<string, string>(Object.entries(payload.values));

  // defaults: preserve-if-exists. Inspect the target file ourselves and only
  // include defaults whose keys are absent — upsertEnvFile is overwrite-or-
  // append, so filtering here gives us the preserve-if-exists semantics.
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const existingKeys = new Set(
    existing
      .split('\n')
      .map((line) => {
        const trimmed = line.trimStart();
        if (trimmed === '' || trimmed.startsWith('#')) return '';
        const eq = line.indexOf('=');
        if (eq <= 0) return '';
        return line.slice(0, eq).trim();
      })
      .filter(Boolean),
  );
  for (const [key, value] of Object.entries(payload.defaults)) {
    if (!existingKeys.has(key)) updates.set(key, value);
  }

  upsertEnvFile(target, updates);
}

/**
 * Deprecated top-level `hookmyapp env` alias. Emits a stderr deprecation
 * warning and delegates to {@link runChannelEnv}. Canonical form is
 * `hookmyapp channels env <channel>`.
 */
export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('[deprecated] Use `hookmyapp channels env <channel>` instead.')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .option(
      '--write [path]',
      'Upsert credentials into a .env file (default ./.env). Replaces existing WHATSAPP_* keys, preserves everything else.',
    )
    .action(async (channelRef: string, options: EnvOptions) => {
      console.warn(
        '[deprecated] `hookmyapp env` will be removed in a future release. ' +
          'Use: hookmyapp channels env <channel>',
      );
      await runChannelEnv(channelRef, options);
    });

  addExamples(
    env,
    `
EXAMPLES:
  $ hookmyapp channels env ch_AAAAAAAA
  $ hookmyapp channels env ch_AAAAAAAA --write .env
`,
  );
}
