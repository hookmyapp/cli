import { describe, it, test, expect, vi, beforeEach } from 'vitest';
import {
  CliError,
  AuthError,
  PermissionError,
  NetworkError,
  NotFoundError,
  ApiError,
  ValidationError,
  ConflictError,
  outputError,
  wrapCommanderError,
} from '../error.js';

describe('error hierarchy — Wave 0 RED (ValidationError + ConflictError)', () => {
  it('ValidationError exits 2', () => {
    const err = new ValidationError('bad input');
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe('ValidationError');
  });

  it('ConflictError exits 6', () => {
    const err = new ConflictError('phone taken');
    expect(err.exitCode).toBe(6);
    expect(err.code).toBe('CONFLICT');
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe('ConflictError');
  });

  it('ConflictError preserves custom code', () => {
    const err = new ConflictError('X', 'PHONE_TAKEN_ANOTHER');
    expect(err.code).toBe('PHONE_TAKEN_ANOTHER');
  });

  it('existing classes unchanged', () => {
    expect(new AuthError().exitCode).toBe(4);
    expect(new PermissionError('ws').exitCode).toBe(3);
    expect(new NetworkError('x').exitCode).toBe(5);
    expect(new ApiError('x', 500).exitCode).toBe(1);
  });
});

describe('outputError JSON envelope (D1)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as any;
  });

  test('When JSON mode, then envelope is nested under `error` with required fields', () => {
    const err = new ValidationError('Bad input', 'BAD_INPUT');
    outputError(err, { human: false });
    expect(stderrSpy).toHaveBeenCalled();
    const written = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({
      error: {
        code: 'BAD_INPUT',
        message: 'Bad input',
        status: 400,
      },
    });
  });

  test('When error has no statusCode but subclass defines httpStatus, then status is resolved', () => {
    const err = new ValidationError('Bad input');
    outputError(err, { human: false });
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.error.status).toBe(400);
  });

  test('When code is a CLI-error code (no class), then status comes from ERROR_CODE_STATUS', () => {
    const err = new ValidationError("missing required argument 'channel'", 'MISSING_ARGUMENT');
    outputError(err, { human: false });
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.code).toBe('MISSING_ARGUMENT');
  });

  test('When error has details, then they appear under error.details', () => {
    const err = new ValidationError('Bad input', 'BAD_INPUT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).details = { field: 'channel', supplied: 'garbage' };
    outputError(err, { human: false });
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.error.details).toEqual({ field: 'channel', supplied: 'garbage' });
  });

  test('When error has a hint, then it appears under error.hint', () => {
    const err = new ValidationError('Bad input', 'BAD_INPUT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).hint = 'Run: hookmyapp channels list';
    outputError(err, { human: false });
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.error.hint).toBe('Run: hookmyapp channels list');
  });

  test('When human mode, then plain text is emitted (unchanged behavior)', () => {
    const err = new ValidationError('Bad input', 'BAD_INPUT');
    outputError(err, { human: true });
    expect(stderrSpy).toHaveBeenCalledWith('Error: Bad input\n');
  });

  test('When commander error has its own `error: ` prefix, then outputError strips it', () => {
    const err = new ValidationError("error: missing required argument 'channel'", 'CLI_ERROR');
    outputError(err, { human: false });
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.error.message).toBe("missing required argument 'channel'");
    expect(parsed.error.message).not.toMatch(/^error: /);
  });

  test('When NotFoundError (used for CHANNEL_NOT_FOUND), then status resolves to 404', () => {
    const err = new NotFoundError(
      'No channel matches ch_zzzzzzzz. Available: ...',
      'CHANNEL_NOT_FOUND',
    );
    outputError(err, { human: false });
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.error.code).toBe('CHANNEL_NOT_FOUND');
    expect(parsed.error.status).toBe(404);
  });
});

describe('wrapCommanderError (D1)', () => {
  test('When commander throws missing-argument, then code is MISSING_ARGUMENT', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmdErr: any = new Error("missing required argument 'channel'");
    cmdErr.code = 'commander.missingArgument';
    const wrapped = wrapCommanderError(cmdErr);
    expect(wrapped.code).toBe('MISSING_ARGUMENT');
  });

  test('When commander throws unknown-command, then code is UNKNOWN_SUBCOMMAND', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmdErr: any = new Error("unknown command 'foo'");
    cmdErr.code = 'commander.unknownCommand';
    const wrapped = wrapCommanderError(cmdErr);
    expect(wrapped.code).toBe('UNKNOWN_SUBCOMMAND');
  });

  test('When commander throws an unknown class, then code falls back to CLI_ERROR', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmdErr: any = new Error('weird');
    cmdErr.code = 'commander.somethingNew';
    const wrapped = wrapCommanderError(cmdErr);
    expect(wrapped.code).toBe('CLI_ERROR');
  });

  test('When commander throws unknown-option, then code is INVALID_FLAG', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmdErr: any = new Error("unknown option '--bogus'");
    cmdErr.code = 'commander.unknownOption';
    const wrapped = wrapCommanderError(cmdErr);
    expect(wrapped.code).toBe('INVALID_FLAG');
  });

  test('When commander throws help (no subcommand), then code is MISSING_SUBCOMMAND and message is useful', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmdErr: any = new Error('(outputHelp)');
    cmdErr.code = 'commander.help';
    const wrapped = wrapCommanderError(cmdErr);
    expect(wrapped.code).toBe('MISSING_SUBCOMMAND');
    expect(wrapped.userMessage).not.toMatch(/outputHelp/);
    expect(wrapped.userMessage).toMatch(/No subcommand specified/);
    expect(wrapped.userMessage).toMatch(/--help/);
  });
});
