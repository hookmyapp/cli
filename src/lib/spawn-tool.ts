// One place where the CLI shells out to another tool (AIT-395).
//
// Windows never resolves a bare command name to its `.cmd` shim: `spawnSync`
// does no PATHEXT expansion, so `spawnSync('claude', …)` is ENOENT even with
// claude on PATH, and naming the shim directly is EINVAL (`.cmd` needs an
// interpreter). `shell: true` is NOT the fix — it concatenates argv into one
// command line instead of escaping it, which mangles the JSON payload
// `claude mcp add-json` expects. Spawning cmd.exe with `/c` and separate args
// keeps every argument intact and lets cmd.exe do the shim lookup.
//
// ponytail: no caret-escaping of cmd.exe metacharacters (& | < > ^). Our
// arguments are our own API URL + a JSON config; if a caller ever passes
// user-controlled text with those characters, escape here.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';

export function runTool(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
  platform: NodeJS.Platform = process.platform,
): SpawnSyncReturns<string> {
  if (platform !== 'win32') return spawnSync(command, args, options);
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', command, ...args], options);
}

/**
 * "The tool isn't installed" — ENOENT on posix, where the spawn itself fails,
 * OR cmd.exe's own complaint on Windows, where the spawn SUCCEEDS (cmd.exe
 * runs fine) and the missing command only shows up in its output.
 */
export function isCommandNotFound(result: SpawnSyncReturns<string>): boolean {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true;
  if (result.error?.message.includes('ENOENT')) return true;
  if (result.status === 0) return false;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return output.includes('is not recognized as an internal or external command');
}
