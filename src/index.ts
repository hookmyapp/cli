import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { loginCommand } from './auth/login.js';
import { logoutCommand } from './auth/logout.js';
import { registerChannelsCommand } from './commands/channels.js';
import { registerHealthCommand } from './commands/health.js';
import { registerWebhookCommand } from './commands/webhook.js';
import { registerTokenCommand } from './commands/token.js';
import { registerEnvCommand } from './commands/env.js';
import { registerBillingCommand } from './commands/billing.js';
import { registerWorkspaceCommand } from './commands/workspace.js';
import { registerSandboxCommand } from './commands/sandbox.js';
import { registerListenCommand } from './commands/sandbox-listen/index.js';
import { registerConfigCommand } from './commands/config.js';
import { CliError, UnexpectedError, exitCodeFor, outputError } from './output/error.js';
import { addExamples } from './output/help.js';
import { VALID_ENV_NAMES, isValidEnv } from './config/env-profiles.js';
import { initSentryLazy, captureError, flushAndExit } from './observability/sentry.js';
import {
  maybeEmitFirstRun,
  emit,
  shouldEmitCommandInvoked,
  getCliVersion,
} from './observability/posthog.js';
import type { CliExitCode } from './analytics/events.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
) as { version: string };

const program = new Command();

program
  .name('hookmyapp')
  .description('HookMyApp CLI — manage WhatsApp Business channels')
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

// Phase 125 — capture the command + subcommand resolved by Commander into
// module-level state so main() can emit `cli_command_invoked` with the
// correct names without each action handler having to wrap itself. Commander
// passes `actionCommand` (the leaf) AND we walk parents to reconstruct the
// full path, e.g. `workspace list` (parent + leaf) or `login` (no parent).
let invokedCommand: string | null = null;
let invokedSubcommand: string | null = null;
const ROOT_NAME = 'hookmyapp';

// Propagate --env flag into process.env.HOOKMYAPP_ENV so downstream resolvers
// (src/config/env-profiles.ts, api/client.ts, etc.) pick it up uniformly.
// Also propagate --debug into HOOKMYAPP_DEBUG=1 so the cloudflared stderr
// filter in sandbox-listen/lifecycle.ts can bypass its allowlist and surface
// every line verbatim — whether the user invokes `sandbox listen --debug`
// directly or reaches it through the wizard (auth/login.ts runSandboxFlow).
program.hook('preAction', (thisCommand, actionCommand) => {
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

  // Capture the resolved command name for cli_command_invoked. Walk up the
  // parent chain to skip the root program name. e.g.
  //   hookmyapp workspace list  → command='workspace', subcommand='list'
  //   hookmyapp login           → command='login',     subcommand=null
  //   hookmyapp sandbox listen  → command='sandbox',   subcommand='listen'
  const chain: string[] = [];
  let cur: Command | null = actionCommand;
  while (cur && cur.name() !== ROOT_NAME) {
    chain.unshift(cur.name());
    cur = cur.parent;
  }
  invokedCommand = chain[0] ?? null;
  invokedSubcommand = chain[1] ?? null;
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
  channels connect  Connect a WhatsApp Business channel (embedded signup)
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

// Channel management
registerChannelsCommand(program);

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

async function emitCommandInvoked(
  exit_code: CliExitCode,
  duration_ms: number,
  errorCode: string | null,
): Promise<void> {
  if (invokedCommand === null) return; // Commander didn't dispatch (e.g. --help, --version, parse error)
  if (!shouldEmitCommandInvoked(invokedCommand, invokedSubcommand)) return;
  await emit('cli_command_invoked', {
    cli_version: getCliVersion(),
    command: invokedCommand,
    subcommand: invokedSubcommand,
    exit_code,
    duration_ms,
    node_version: process.version,
    platform: process.platform,
  });
  if (errorCode !== null) {
    await emit('cli_error_shown', {
      cli_version: getCliVersion(),
      error_code: errorCode,
      exit_code,
      command: invokedCommand,
    });
  }
}

async function main(): Promise<void> {
  // Phase 123 Plan 10 — init Sentry early so top-level throws + unhandled
  // rejections capture before we hit the exit boundary. The function is
  // idempotent + lazy: if telemetry is disabled (HOOKMYAPP_TELEMETRY=off
  // or `config set telemetry off`), Sentry is never loaded.
  await initSentryLazy();

  // Phase 125 Plan 02 — emit cli_first_run on the first-ever invocation per
  // machine. Idempotent: subsequent invocations short-circuit on the
  // persisted machine-id presence. Skipped silently when telemetry is off.
  await maybeEmitFirstRun();

  const startedAt = Date.now();
  try {
    await program.parseAsync();
    await emitCommandInvoked(0, Date.now() - startedAt, null);
    await flushAndExit(0);
  } catch (err) {
    const human = resolveHuman();
    const debug = program.opts().debug ?? process.argv.includes('--debug');
    if (err instanceof CliError) {
      outputError(err, { human });
      if (debug && err.stack) {
        process.stderr.write('\n' + err.stack + '\n');
      }
    } else if (err instanceof CommanderError) {
      if (err.exitCode === 0) await flushAndExit(0); // --help, --version
      // Arg errors already formatted by configureOutput — exit via
      // flushAndExit below so any early Sentry events drain.
    } else {
      const msg = 'Something went wrong. Try again later.';
      outputError(new UnexpectedError(msg, 'UNKNOWN_ERROR'), { human });
      if (debug && err instanceof Error && err.stack) {
        process.stderr.write('\n' + err.stack + '\n');
      }
    }
    // Forward CLI-local errors to Sentry (HTTP-5xx wrappers are filtered out
    // by shouldCaptureToSentry — backend already captured them).
    await captureError(err);
    const ec = exitCodeFor(err);
    const exitCode = ec;
    const ecBucket = (ec >= 0 && ec <= 6 ? ec : 1) as CliExitCode;
    let errorCode: string | null = null;
    if (err instanceof CliError) {
      errorCode = err.code;
    } else if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
      errorCode = (err as { code: string }).code;
    } else {
      errorCode = 'UNKNOWN_ERROR';
    }
    await emitCommandInvoked(ecBucket, Date.now() - startedAt, errorCode);
    await flushAndExit(exitCode);
  }
}

// Skip CLI side-effects when this module is imported by vitest tests (e.g.
// help.test.ts imports `program`). Without this guard, the module-level
// main() call runs with vitest's process.argv and the unhandledRejection
// handler fires on test-driven CLI error paths — exiting the test worker
// with code 1 even though every test passed. VITEST=true is set by vitest.
if (!process.env.VITEST) {
  process.on('unhandledRejection', async (reason) => {
    const human = resolveHuman();
    const msg = 'Something went wrong. Try again later.';
    outputError(new UnexpectedError(msg, 'UNKNOWN_ERROR'), { human });
    await captureError(reason);
    await flushAndExit(1);
  });

  main();
}

export { program };
