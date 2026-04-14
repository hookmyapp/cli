// Non-blocking version-nudge check for `hookmyapp sandbox listen`.
//
// Contract locked by 107-CONTEXT.md §CLI Flow Step 2:
//   - GET https://registry.npmjs.org/@gethookmyapp/cli/latest
//   - 2s hard timeout via AbortSignal.timeout(2000)
//   - If newer, print EXACTLY:
//       "A newer version of hookmyapp is available (<cur> → <new>). Run npm update -g @gethookmyapp/cli"
//   - On ANY failure (network, timeout, non-2xx, malformed JSON): silently return.
//     The nudge is best-effort — it MUST NEVER block listen startup.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { version: string };

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@gethookmyapp/cli/latest';
const TIMEOUT_MS = 2000;

export async function checkForNewerCli(): Promise<void> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return;
    const body = (await res.json()) as { version?: unknown };
    const latest = body.version;
    if (typeof latest !== 'string' || latest.length === 0) return;
    if (latest === pkg.version) return;
    // Locked one-liner — Plan 09b smoke test asserts the exact prefix.
    console.log(
      `A newer version of hookmyapp is available (${pkg.version} → ${latest}). Run npm update -g @gethookmyapp/cli`,
    );
  } catch {
    // Silent by design — network errors, timeouts, parse failures all fall here.
  }
}
