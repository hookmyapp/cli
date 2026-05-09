import { describe, it, expect } from 'vitest';
import { ConfigWriteForbiddenError } from '../errors.js';
import { CliError } from '../../output/error.js';

describe('ConfigWriteForbiddenError', () => {
  it('extends CliError so the existing exit-code mapper handles it', () => {
    const err = new ConfigWriteForbiddenError('/path/to/config.json');
    expect(err).toBeInstanceOf(CliError);
  });

  it('includes the path in the message', () => {
    const err = new ConfigWriteForbiddenError('/path/to/config.json');
    expect(err.message).toContain('/path/to/config.json');
  });

  it('includes the two recovery instructions in the user message', () => {
    const err = new ConfigWriteForbiddenError('/path/to/config.json');
    expect(err.userMessage).toContain('real terminal');
    expect(err.userMessage).toContain('HOOKMYAPP_CONFIG_DIR');
  });

  it('uses the stable code CONFIG_WRITE_FORBIDDEN', () => {
    const err = new ConfigWriteForbiddenError('/path');
    expect(err.code).toBe('CONFIG_WRITE_FORBIDDEN');
  });
});
