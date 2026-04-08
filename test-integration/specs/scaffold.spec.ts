import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { CLI_BIN } from '../helpers/runCli.js';

/**
 * Placeholder spec proving the integration scaffold runs end-to-end:
 * globalSetup builds dist/cli.js and provisions WorkOS users. Wave 2
 * replaces this with real command specs.
 */
describe('scaffold', () => {
  it('built the CLI binary via global-setup', () => {
    expect(existsSync(CLI_BIN)).toBe(true);
  });
});
