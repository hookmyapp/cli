import { Command, CommanderError } from 'commander';
import { loginCommand } from './auth/login.js';
import { logoutCommand } from './auth/logout.js';
import { registerAccountsCommand } from './commands/accounts.js';
import { registerHealthCommand } from './commands/health.js';
import { registerWebhookCommand } from './commands/webhook.js';
import { registerTokenCommand } from './commands/token.js';
import { registerEnvCommand } from './commands/env.js';
import { registerBillingCommand } from './commands/billing.js';
import { registerWorkspaceCommand } from './commands/workspace.js';
import { registerSandboxCommand } from './commands/sandbox.js';
import { registerListenCommand } from './commands/sandbox-listen/index.js';
import { CliError, outputError } from './output/error.js';

const program = new Command();

program
  .name('hookmyapp')
  .description('HookMyApp CLI — manage WhatsApp Business accounts')
  .version('0.1.0');

program.option('--json', 'Machine-readable JSON output (scripts/CI)');
program.option('--human', 'Human-readable output (default — kept for back-compat)');
program.option('--debug', 'Show full error stack traces');

program.exitOverride();

// Human output is the DEFAULT. --json flips to JSON for scripts/CI.
function resolveHuman(): boolean {
  if (process.argv.includes('--json')) return false;
  return true;
}

program.configureOutput({
  writeErr: (str) => {
    if (resolveHuman()) {
      process.stderr.write(str);
    } else {
      process.stderr.write(JSON.stringify({ error: str.trim(), code: 'CLI_ERROR' }) + '\n');
    }
  },
});

// Auth commands
loginCommand(program);
logoutCommand(program);

// Account management
registerAccountsCommand(program);

// Health check
registerHealthCommand(program);

// Webhook configuration
registerWebhookCommand(program);

// Token reveal
registerTokenCommand(program);

// Env output
registerEnvCommand(program);

// Billing
registerBillingCommand(program);

// Workspace management
registerWorkspaceCommand(program);

// Sandbox sessions (start/status/stop)
registerSandboxCommand(program);

// Sandbox listen — CF tunnel + streaming webhook log
const sandboxCmd = program.commands.find((c) => c.name() === 'sandbox');
if (sandboxCmd) {
  registerListenCommand(sandboxCmd, program);
}

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (err) {
    const human = resolveHuman();
    const debug = program.opts().debug ?? process.argv.includes('--debug');
    if (err instanceof CliError) {
      outputError(err, { human });
      if (debug && err.stack) {
        process.stderr.write('\n' + err.stack + '\n');
      }
    } else if (err instanceof CommanderError) {
      if (err.exitCode === 0) process.exit(0); // --help, --version
      // Arg errors already formatted by configureOutput
    } else {
      const msg = 'Something went wrong. Try again later.';
      outputError(new CliError(msg, 'UNKNOWN_ERROR'), { human });
      if (debug && err instanceof Error && err.stack) {
        process.stderr.write('\n' + err.stack + '\n');
      }
    }
    const exitCode = err instanceof CliError ? err.exitCode : 1;
    process.exit(exitCode);
  }
}

process.on('unhandledRejection', (reason) => {
  const human = resolveHuman();
  const msg = 'Something went wrong. Try again later.';
  outputError(new CliError(msg, 'UNKNOWN_ERROR'), { human });
  process.exit(1);
});

main();

export { program };
