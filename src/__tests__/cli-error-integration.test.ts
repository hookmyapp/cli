// Phase B Task 3 — integration test against the built CLI binary.
//
// Validates that commander parse errors emit the canonical nested envelope
// (D1) with the right machine code AND that only ONE envelope lands in
// stderr (no double-emit from configureOutput.writeErr + catch block).
import { describe, test, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// CLI repo is ESM (package.json "type": "module") so __dirname is undefined.
const __filename = fileURLToPath(import.meta.url);
const BIN = resolve(__filename, '../../../bin/hookmyapp.js');

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  // Strip VITEST from the spawned child's env — src/index.ts short-circuits
  // its main() when VITEST is set so other unit tests can import the program
  // without triggering process.exit. We need the real CLI to run here.
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  try {
    const stdout = execSync(`node ${BIN} ${args.join(' ')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).toString();
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
    };
  }
}

describe('CLI commander parse errors emit canonical envelope (integration)', () => {
  test('When missing required argument, then JSON envelope has MISSING_ARGUMENT', () => {
    const { exitCode, stderr } = runCli(['--json', 'channels', 'show']);
    expect(exitCode).not.toBe(0);
    const lines = stderr.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.error.code).toBe('MISSING_ARGUMENT');
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).not.toMatch(/^error: /);
  });

  test('When unknown subcommand, then JSON envelope has UNKNOWN_SUBCOMMAND', () => {
    const { exitCode, stderr } = runCli(['--json', 'channels', 'totally-fake-sub']);
    expect(exitCode).not.toBe(0);
    const lines = stderr.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.error.code).toBe('UNKNOWN_SUBCOMMAND');
  });
});
