import type { Command } from 'commander';
import { renderTable } from './table.js';
import { c, icon } from './color.js';

export interface OutputOpts {
  /** True when the caller wants machine-readable JSON output. */
  json?: boolean;
  /** Legacy inverse of `json` — accepted for back-compat with existing callers. */
  human?: boolean;
  /** Optional follow-up hint printed under mutation results. */
  nudge?: string;
  /** `read` suppresses the nudge, `mutation` emits it. Defaults to `read`. */
  kind?: 'read' | 'mutation';
}

function isJsonModeFromOpts(opts: OutputOpts): boolean {
  if (opts.json !== undefined) return !!opts.json;
  if (opts.human !== undefined) return !opts.human;
  return false;
}

/**
 * Returns true when the user passed `--json` (global or local) on the given
 * Commander Command. Used by action handlers that take `this: Command` so
 * they can branch on machine-readable output without re-implementing
 * `optsWithGlobals().json` at every call site.
 */
export function isJsonMode(cmd: Command): boolean {
  return !!cmd.optsWithGlobals().json;
}

export function output(data: unknown, opts: OutputOpts = {}): void {
  const json = isJsonModeFromOpts(opts);
  const kind = opts.kind ?? 'read';

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Human mode
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('(empty)');
    } else if (typeof data[0] === 'object' && data[0] !== null) {
      console.log(renderTable(data as Record<string, unknown>[]));
    } else {
      for (const item of data) console.log(String(item));
    }
  } else if (typeof data === 'string') {
    console.log(data);
  } else if (data !== null && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      console.log(`${k}: ${v}`);
    }
  } else {
    console.log(String(data));
  }

  if (opts.nudge && kind === 'mutation') {
    console.log(c.dim(`${icon.arrow} ${opts.nudge}`));
  }
}
