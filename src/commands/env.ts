import type { Command } from 'commander';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { ValidationError } from '../output/error.js';
import { resolveChannel } from './channels.js';

interface EnvOptions {
  write?: string | boolean;
}

const ENV_KEYS = [
  'WHATSAPP_WABA_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
] as const;

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

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Output credentials as .env format')
    .argument('<waba-id>', 'WABA ID')
    .option(
      '--write [path]',
      'Upsert credentials into a .env file (default ./.env). Replaces existing WHATSAPP_* keys, preserves everything else.',
    )
    .action(async (wabaId: string, options: EnvOptions) => {
      const channel = await resolveChannel(wabaId);
      if (!channel.phoneNumberId) {
        throw new ValidationError(
          `channel ${channel.id} has no phoneNumberId yet (signup not finished). Re-run \`hookmyapp channels list\` and try again once it appears.`,
        );
      }
      const tokenData = await apiClient(`/meta/channels/${channel.id}/token`);

      const values: Record<(typeof ENV_KEYS)[number], string> = {
        WHATSAPP_WABA_ID: channel.metaWabaId,
        WHATSAPP_ACCESS_TOKEN: tokenData.accessToken,
        WHATSAPP_PHONE_NUMBER_ID: channel.phoneNumberId,
      };

      if (options.write !== undefined && options.write !== false) {
        const target = resolvePath(
          typeof options.write === 'string' ? options.write : '.env',
        );
        const updates = new Map<string, string>(
          ENV_KEYS.map((k) => [k, values[k]]),
        );
        upsertEnvFile(target, updates);
        return;
      }

      process.stdout.write(
        `WHATSAPP_WABA_ID=${values.WHATSAPP_WABA_ID}\nWHATSAPP_ACCESS_TOKEN=${values.WHATSAPP_ACCESS_TOKEN}\nWHATSAPP_PHONE_NUMBER_ID=${values.WHATSAPP_PHONE_NUMBER_ID}\n`,
      );
    });

  addExamples(
    env,
    `
EXAMPLES:
  $ hookmyapp env 1234567890
  $ hookmyapp env 1234567890 --write .env
`,
  );
}
