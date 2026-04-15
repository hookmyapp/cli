import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { registerConfigCommand } from './commands/config.js';
import { CliError, outputError } from './output/error.js';
import { addExamples } from './output/help.js';
import { VALID_ENV_NAMES, isValidEnv } from './config/env-profiles.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
) as { version: string };

const program = new Command();

program
  .name('hookmyapp')
  .description('HookMyApp CLI — manage WhatsApp Business accounts')
  .version(pkg.version);

program.option('--json', 'Machine-readable JSON output (scripts/CI)');
program.option('--human', 'Human-readable output (default — kept for back-compat)');
program.option('--debug', 'Show full error stack traces');
program.option(
  '--workspace <slug>',
  'Override default workspace for this invocation (name, slug, or id)',
);
program.option(
  '--env <name>',
  `Environment profile (one-off override). One of: ${VALID_ENV_NAMES.join(', ')}.`,
);

// Propagate --env flag into process.env.HOOKMYAPP_ENV so downstream resolvers
// (src/config/env-profiles.ts, api/client.ts, etc.) pick it up uniformly.
// Also propagate --debug into HOOKMYAPP_DEBUG=1 so the cloudflared stderr
// filter in sandbox-listen/lifecycle.ts can bypass its allowlist and surface
// every line verbatim — whether the user invokes `sandbox listen --debug`
// directly or reaches it through the wizard (auth/login.ts runSandboxFlow).
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  const envFlag = opts.env as string | undefined;
  if (envFlag) {
    if (!isValidEnv(envFlag)) {
      throw new CommanderError(
        2,
        'commander.invalidArgument',
        `Invalid --env "${envFlag}". Valid values: ${VALID_ENV_NAMES.join(', ')}.`,
      );
    }
    process.env.HOOKMYAPP_ENV = envFlag;
  }
  if (opts.debug) {
    process.env.HOOKMYAPP_DEBUG = '1';
  }
});

addExamples(
  program,
  `
USAGE:
  $ hookmyapp <command> [flags]

COMMON COMMANDS:
  login             Browser sign-in + workspace picker and next-steps guide
  sandbox start     Create or resume a sandbox session (tunnel + credentials)
  sandbox status    Show the active sandbox session for this workspace
  sandbox stop      End the active sandbox session
  sandbox listen    Stream Meta webhooks to your local server through a sandbox tunnel
  sandbox env       Print or write the .env values for a sandbox session
  sandbox send      Send a test WhatsApp message via sandbox-proxy
  accounts connect  Connect a WhatsApp Business account (embedded signup)
  workspace list    List workspaces you belong to
  billing           View or change your plan

GLOBAL FLAGS:
  --json              Emit JSON output (machine-readable; silences colors + spinners)
  --workspace <slug>  Run in a specific workspace (overrides default)
  --human             Force human-readable output (default)
  --debug             Full HTTP request/response + stack traces
`,
);

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

// Persistent CLI config (env profile: local | staging | production)
registerConfigCommand(program);

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
