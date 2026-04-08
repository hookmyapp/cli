import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKMYAPP_API_URL, HOOKMYAPP_WORKOS_CLIENT_ID } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_BIN = path.resolve(__dirname, '../../dist/cli.js');

export interface RunCliOpts {
  home: string;
  env?: Record<string, string>;
  input?: string;
}

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(args: string[], opts: RunCliOpts): Promise<RunCliResult> {
  const result = await execa('node', [CLI_BIN, ...args], {
    env: {
      ...process.env,
      HOME: opts.home,
      USERPROFILE: opts.home,
      HOOKMYAPP_API_URL,
      HOOKMYAPP_WORKOS_CLIENT_ID,
      ...opts.env,
    },
    input: opts.input,
    reject: false,
    timeout: 30_000,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}
