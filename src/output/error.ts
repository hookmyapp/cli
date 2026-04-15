import { cliCommandPrefix } from './cli-self.js';

export class CliError extends Error {
  public exitCode: number = 1;

  constructor(
    public readonly userMessage: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(userMessage);
    this.name = 'CliError';
  }
}

export class AuthError extends CliError {
  constructor(message: string = `Session expired. Run: ${cliCommandPrefix()} login`) {
    super(message, 'AUTH_REQUIRED', 401);
    this.name = 'AuthError';
    this.exitCode = 4;
  }
}

export class PermissionError extends CliError {
  constructor(activeWorkspaceSlug: string) {
    super(
      `This action requires workspace admin permission.\n\n` +
        `Active workspace: ${activeWorkspaceSlug}\n\n` +
        `If you should have admin access, try:\n` +
        `  ${cliCommandPrefix()} login          # refresh your session\n` +
        `  ${cliCommandPrefix()} workspace list # see all your workspaces and roles\n\n` +
        `Otherwise contact your workspace admin.`,
      'PERMISSION_DENIED',
      403,
    );
    this.name = 'PermissionError';
    this.exitCode = 3;
  }
}

export class NetworkError extends CliError {
  constructor(message: string = 'Could not connect to HookMyApp API. Check your internet connection or try again later.') {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
    this.exitCode = 5;
  }
}

export class ApiError extends CliError {
  constructor(message: string, statusCode: number) {
    const code = statusCode >= 500 ? 'SERVER_ERROR' : 'API_ERROR';
    super(message, code, statusCode);
    this.name = 'ApiError';
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.exitCode = 2;
  }
}

export class ConflictError extends CliError {
  constructor(message: string, code: string = 'CONFLICT') {
    super(message, code, 409);
    this.name = 'ConflictError';
    this.exitCode = 6;
  }
}

/**
 * 403 from sandbox-proxy when the recipient hasn't sent an inbound message
 * within the WhatsApp 24h reply window. Surfaces the proxy's friendly
 * `body.message` verbatim so the developer sees actionable guidance instead
 * of a generic "Something went wrong".
 *
 * exitCode = 1 (real API rejection, not a local validation error).
 */
export class SessionWindowError extends CliError {
  constructor(message: string) {
    super(message, 'SESSION_WINDOW_CLOSED', 403);
    this.name = 'SessionWindowError';
    this.exitCode = 1;
  }
}

export function outputError(error: CliError, opts: { human?: boolean }): void {
  if (opts.human) {
    process.stderr.write(`Error: ${error.userMessage}\n`);
  } else {
    const obj: Record<string, unknown> = {
      error: error.userMessage,
      code: error.code,
    };
    if (error.statusCode !== undefined) {
      obj.status = error.statusCode;
    }
    process.stderr.write(JSON.stringify(obj) + '\n');
  }
}
