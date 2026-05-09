import { CliError } from '../output/error.js';

/**
 * Thrown when the CLI cannot write to its config dir because the OS denied
 * the syscall (EPERM/EACCES). Most common cause: the CLI is running inside
 * a sandboxed shell (Claude Code, Cursor, restricted CI) that blocks writes
 * outside the project working directory.
 *
 * The userMessage gives the two known workarounds so the failure is
 * recoverable from the error alone — no support contact required.
 */
export class ConfigWriteForbiddenError extends CliError {
  constructor(path: string) {
    const userMessage =
      `Could not write config to ${path}: operation not permitted.\n\n` +
      `This usually means the CLI is running inside a sandboxed shell\n` +
      `(Claude Code, Cursor, etc.) that blocks writes outside the project.\n\n` +
      `Two ways to fix:\n` +
      `  1. Run \`hookmyapp login\` in your real terminal (not the agent shell).\n` +
      `  2. Set HOOKMYAPP_CONFIG_DIR to a project-local path:\n` +
      `       export HOOKMYAPP_CONFIG_DIR="$PWD/.hookmyapp"\n` +
      `     (then add .hookmyapp/ to .gitignore).`;
    super(userMessage, 'CONFIG_WRITE_FORBIDDEN');
  }
}
