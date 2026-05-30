import type { Command } from 'commander';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
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
 * Canonical handler for `hookmyapp channels env <channel>`.
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
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const payload: ChannelEnvPayload = await apiClient(
    `/meta/channels/${channel.id}/env`,
    { workspaceId: channel.workspaceId },
  );

  // D6 (cli-cleanup): `--json` emits a flat {KEY: VALUE} object so agents can
  // iterate keys programmatically. Merges defaults + values; values win on
  // collision. Human mode keeps the dotenv text format suitable for piping
  // into a `.env` file (and for the existing --write upsert flow).
  if (cmd && isJsonMode(cmd)) {
    const merged: Record<string, string> = {
      ...(payload.defaults ?? {}),
      ...payload.values,
    };
    // In JSON mode `--write` is ignored — write JSON to stdout. The agent
    // pipeline that wants JSON-on-disk can `> file.json` from the shell.
    process.stdout.write(JSON.stringify(merged) + '\n');
    return;
  }

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
