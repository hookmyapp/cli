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
  constructor(message: string = 'Session expired. Run: hookmyapp login') {
    super(message, 'AUTH_REQUIRED', 401);
    this.name = 'AuthError';
    this.exitCode = 4;
  }
}

export class PermissionError extends CliError {
  constructor(activeWorkspaceSlug: string) {
    super(
      `Admin access required for this workspace.\n\n` +
        `Active workspace: ${activeWorkspaceSlug} (role: member)\n` +
        'Run `hookmyapp workspace use <admin-workspace>` to switch, or contact your workspace admin.',
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
  }
}

export class ApiError extends CliError {
  constructor(message: string, statusCode: number) {
    const code = statusCode >= 500 ? 'SERVER_ERROR' : 'API_ERROR';
    super(message, code, statusCode);
    this.name = 'ApiError';
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
