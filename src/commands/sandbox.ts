import type { Command } from 'commander';
import { input, confirm, select } from '@inquirer/prompts';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { getDefaultWorkspaceId } from './_helpers.js';

const SANDBOX_WHATSAPP_NUMBER = '972557046276';

interface SandboxSession {
  id: string;
  workspaceId: string;
  phone: string | null;
  activationCode: string;
  status: 'pending_activation' | 'active' | 'replaced' | 'expired';
  webhookUrl: string | null;
  // Cloudflare tunnel fields (populated only while a tunnel is live via
  // `hookmyapp sandbox listen`; see Phase 107 for the full lifecycle).
  cloudflareTunnelId: string | null;
  cloudflareTunnelToken: string | null;
  hostname: string | null;
  lastHeartbeatAt: string | null;
  hmacSecret: string;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function registerSandboxCommand(program: Command): void {
  const sandbox = program.command('sandbox').description('Manage sandbox sessions for local development');

  sandbox
    .command('start')
    .description('Create a new sandbox session')
    .option('--phone <phone>', 'Phone number for WhatsApp activation')
    .action(async (opts: { phone?: string }) => {
      let phone = opts.phone;
      if (!phone) {
        phone = await input({
          message: 'Phone number for WhatsApp activation (e.g. +1234567890):',
        });
      }

      const workspaceId = await getDefaultWorkspaceId();
      const session: SandboxSession = await apiClient('/sandbox/sessions', {
        method: 'POST',
        body: JSON.stringify({ phone }),
        workspaceId,
      });

      const human = !program.opts().json;
      if (!human) {
        output(session, { human: false });
        return;
      }

      console.log(`\nSandbox session created!\n`);
      console.log(`  1. Send your activation code via WhatsApp:`);
      console.log(`     Open: https://wa.me/${SANDBOX_WHATSAPP_NUMBER}?text=${session.activationCode}\n`);

      if (session.status === 'active') {
        printActiveSteps(session);
      } else {
        console.log(`  Your session is pending activation.`);
        console.log(`  After sending the activation code, run:\n`);
        console.log(`     hookmyapp sandbox status\n`);
        console.log(`  to see your tunnel credentials and next steps.\n`);
      }
    });

  sandbox
    .command('status')
    .description('Show active sandbox sessions')
    .action(async () => {
      const workspaceId = await getDefaultWorkspaceId();
      const sessions: SandboxSession[] = await apiClient('/sandbox/sessions', { workspaceId });

      const human = !program.opts().json;
      if (!human) {
        output(sessions, { human: false });
        return;
      }

      if (sessions.length === 0) {
        console.log('No sandbox sessions. Run: hookmyapp sandbox start');
        return;
      }

      for (const session of sessions) {
        const phone = session.phone ? `+${session.phone.replace(/^\+/, '')}` : '(none)';
        console.log(`\nSandbox session for ${phone}`);
        console.log(`  Status:          ${session.status}`);
        console.log(`  Activation Code: ${session.activationCode}`);
        console.log(`  Tunnel Host:     ${session.hostname ?? '(no live tunnel)'}`);
        console.log(`  Webhook URL:     ${session.webhookUrl ?? '(not set — run sandbox listen)'}`);
        console.log(`  Activated At:    ${session.activatedAt ?? '(not yet)'}`);

        if (session.status === 'active') {
          console.log('');
          printActiveSteps(session);
        }
      }
    });

  sandbox
    .command('stop')
    .description('Delete a sandbox session')
    .action(async () => {
      const workspaceId = await getDefaultWorkspaceId();
      const sessions: SandboxSession[] = await apiClient('/sandbox/sessions', { workspaceId });

      if (sessions.length === 0) {
        throw new ValidationError(
          'No sandbox sessions found. Run: hookmyapp sandbox start',
        );
      }

      let sessionToDelete: SandboxSession;

      const phoneLabel = (s: SandboxSession): string =>
        s.phone ? `+${s.phone.replace(/^\+/, '')}` : 'no phone';

      if (sessions.length === 1) {
        sessionToDelete = sessions[0];
        const proceed = await confirm({
          message: `Delete sandbox session for ${phoneLabel(sessionToDelete)}? This will tear down your tunnel.`,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }
      } else {
        const choice = await select({
          message: 'Which session do you want to delete?',
          choices: sessions.map((s) => ({
            name: `${phoneLabel(s)} (${s.status})`,
            value: s.id,
          })),
        });
        sessionToDelete = sessions.find((s) => s.id === choice)!;
        const proceed = await confirm({
          message: `Delete sandbox session for ${phoneLabel(sessionToDelete)}? This will tear down your tunnel.`,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }
      }

      await apiClient(`/sandbox/sessions/${sessionToDelete.id}`, {
        method: 'DELETE',
        workspaceId,
      });

      const human = !program.opts().json;
      if (human) {
        console.log(`\nSandbox session for ${phoneLabel(sessionToDelete)} deleted.\n`);
      } else {
        output({ deleted: true, id: sessionToDelete.id }, { human: false });
      }
    });
}

function printActiveSteps(session: SandboxSession): void {
  console.log(`  2. Start your tunnel:`);
  console.log(`     hookmyapp sandbox listen --phone ${session.phone ?? '<your-test-phone>'}\n`);
  console.log(`  3. Clone the starter kit:`);
  console.log(`     npx degit hookmyapp/webhook-starter-kit my-app`);
  console.log(`     cd my-app && npm install\n`);
  console.log(`  4. Copy these values to your .env:`);
  console.log(`     VERIFY_TOKEN=hookmyapp-verify`);
  console.log(`     WHATSAPP_API_URL=https://sandbox.hookmyapp.com/v22.0`);
  console.log(`     WHATSAPP_ACCESS_TOKEN=${session.activationCode}\n`);
  console.log(`  5. Start your server:`);
  console.log(`     npm run dev\n`);
}
