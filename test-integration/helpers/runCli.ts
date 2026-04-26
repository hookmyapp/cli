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
  // Strip VITEST from the spawned CLI's env. src/index.ts gates `main()`
  // behind `if (!process.env.VITEST)` so the bundled module can be imported
  // safely by the CLI's own vitest unit tests. When that gate sees
  // VITEST=true in a SPAWNED subprocess (vitest worker fork → execa → CLI),
  // main() never runs — the process exits 0 with no output, which surfaces
  // in callers (seedSession.ts:79) as `Unexpected end of JSON input` on the
  // empty stdout. Spawned subprocesses are NOT vitest test files; they
  // should run main() normally.
  //
  // Execa v9 default `extendEnv: true` merges `process.env` UNDER our env
  // option, so plain `delete env.VITEST` on a copy doesn't work — VITEST
  // re-appears from process.env. Explicit `VITEST: undefined` overrides it.
  const result = await execa('node', [CLI_BIN, ...args], {
    env: {
      HOME: opts.home,
      USERPROFILE: opts.home,
      HOOKMYAPP_API_URL,
      HOOKMYAPP_WORKOS_CLIENT_ID,
      ...opts.env,
      VITEST: undefined,
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
