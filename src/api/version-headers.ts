import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { readSkillVersion } from './skill-marker.js';

// CLI semver, resolved in this priority order:
//   1. __HOOKMYAPP_CLI_PKG_VERSION__ — esbuild `define` constant baked by build.mjs
//      at bundle time. Present in published binaries (dist/cli.js).
//   2. Runtime read of ../../package.json — works for unbundled source (vitest,
//      `tsx src/index.ts`) where this file lives at src/api/.
// Cached on module load; the CLI binary's package.json is immutable for the
// lifetime of an invocation.
declare const __HOOKMYAPP_CLI_PKG_VERSION__: string | undefined;

function resolveCliVersion(): string {
  // typeof guard — esbuild replaces __HOOKMYAPP_CLI_PKG_VERSION__ with a
  // string literal at build time. In unbundled runs the identifier is
  // undefined; the typeof check returns 'undefined' without throwing a
  // ReferenceError, letting us fall through to the runtime read.
  if (typeof __HOOKMYAPP_CLI_PKG_VERSION__ === 'string' && __HOOKMYAPP_CLI_PKG_VERSION__.length > 0) {
    return __HOOKMYAPP_CLI_PKG_VERSION__;
  }
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../package.json', import.meta.url)),
      'utf-8',
    ),
  ) as { version: string };
  return pkg.version;
}

const CLI_VERSION = resolveCliVersion();
const NODE_VERSION = process.versions.node;
const ARCH = process.arch;
const OS = process.platform;

/**
 * Build the header set sent on every backend request. Mirrors the
 * Stainless-style headers used by the OpenAI and Anthropic SDKs
 * (`x-stainless-package-version` + `x-stainless-lang/runtime/arch/os`).
 *
 * Contract per docs/superpowers/specs/2026-05-06-cli-and-skill-version-enforcement-design.md:
 *   - User-Agent: hookmyapp-cli/<version> (node/<runtime>; <arch>; <os>)
 *   - X-HookMyApp-CLI-Version: <semver>                  (always)
 *   - X-HookMyApp-Lang: node                             (always)
 *   - X-HookMyApp-Runtime-Version: <node version>        (always)
 *   - X-HookMyApp-Arch: <arch>                           (always)
 *   - X-HookMyApp-OS: <platform>                         (always)
 *   - X-HookMyApp-Skill-Version: <semver | 'invalid'>    (conditional — see readSkillVersion)
 */
export function buildVersionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `hookmyapp-cli/${CLI_VERSION} (node/${NODE_VERSION}; ${ARCH}; ${OS})`,
    'X-HookMyApp-CLI-Version': CLI_VERSION,
    'X-HookMyApp-Lang': 'node',
    'X-HookMyApp-Runtime-Version': NODE_VERSION,
    'X-HookMyApp-Arch': ARCH,
    'X-HookMyApp-OS': OS,
  };
  const skill = readSkillVersion();
  if (skill !== undefined) {
    headers['X-HookMyApp-Skill-Version'] = skill;
  }
  return headers;
}
