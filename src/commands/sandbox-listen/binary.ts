// Lazy cloudflared download + SHA-256 verification for `hookmyapp sandbox listen`.
//
// Why we self-own the binary rather than depend on the npm `cloudflared` package:
//   - Release cadence is ours, not Cloudflare's. Pin in source (CLOUDFLARED_VERSION).
//   - We verify SHA-256 against a hardcoded manifest (Cloudflare does not publish
//     per-asset checksums — see 107-RESEARCH.md §Pitfall 5).
//   - Platform asset formats differ (RESEARCH §Pitfall 4):
//       macOS   → .tgz archive (extract `cloudflared` member)
//       Linux   → standalone binary
//       Windows → standalone .exe
//
import { mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { x as tarExtract } from 'tar';
import { CliError } from '../../output/error.js';

export const CLOUDFLARED_VERSION = '2026.3.0';

// Hand-maintained manifest keyed by "<platform>-<arch>[.ext]" to match resolveAsset's
// `manifestKey`. Cloudflare does not publish per-asset checksums, so these MUST be
// regenerated at each version bump via scripts/generate-cf-manifest.ts.
export const CLOUDFLARED_SHA256: Record<string, string> = {
  'darwin-arm64.tgz':    '2aae4f69b0fc1c671b8353b4f594cbd902cd1e360c8eed2b8cad4602cb1546fb',
  'darwin-amd64.tgz':    '0f30140c4a5e213d22f951ef4c964cac5fb6a5f061ba6eba5ea932999f7c0394',
  'linux-arm64':         '0755ba4cbab59980e6148367fcf53a8f3ec85a97deefd63c2420cf7850769bee',
  'linux-amd64':         '4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30',
  'windows-amd64.exe':   '59b12880b24af581cf5b1013db601c7d843b9b097e9c78aa5957c7f39f741885',
};

/** Test-only escape hatch: override a manifest entry for a single test case. */
export function __testOverrideSha(key: string, sha: string): void {
  CLOUDFLARED_SHA256[key] = sha;
}

const BIN_DIR = join(homedir(), '.hookmyapp', 'bin');
const BIN_PATH = join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

export interface ResolvedAsset {
  filename: string;
  url: string;
  manifestKey: string;
}

/**
 * Map a platform+arch pair to the GitHub release asset filename + its manifest key.
 * arch input is node's `process.arch` string (e.g. 'x64', 'arm64'); we normalize
 * 'x64' → 'amd64' to match Cloudflare's asset naming.
 */
export function resolveAsset(platform: NodeJS.Platform, arch: string): ResolvedAsset {
  const normalizedArch = arch === 'x64' ? 'amd64' : arch;
  let filename: string;
  let manifestKey: string;

  if (platform === 'darwin') {
    filename = `cloudflared-darwin-${normalizedArch}.tgz`;
    manifestKey = `darwin-${normalizedArch}.tgz`;
  } else if (platform === 'win32') {
    filename = `cloudflared-windows-${normalizedArch}.exe`;
    manifestKey = `windows-${normalizedArch}.exe`;
  } else {
    // linux + anything else falls through to the Linux standalone pattern.
    filename = `cloudflared-linux-${normalizedArch}`;
    manifestKey = `linux-${normalizedArch}`;
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${filename}`;
  return { filename, url, manifestKey };
}

/**
 * Ensure ~/.hookmyapp/bin/cloudflared exists and matches the expected SHA-256.
 *
 * @param opts.force — skip the on-disk check and re-download unconditionally.
 * @returns absolute path to the verified binary.
 * @throws {CliError} BINARY_DOWNLOAD_FAILED or BINARY_CHECKSUM_FAILED (exitCode=4).
 *
 * Test-only escape hatch: when `HOOKMYAPP_CLOUDFLARED_BIN` points at an
 * existing executable, this returns the env-supplied path verbatim — no
 * download, no checksum. Used by `test-integration/specs/sandbox-listen.spec.ts`
 * to substitute a `node`-based stub that simulates cloudflared lifetime
 * without provisioning a real CF tunnel via the local backend. Not advertised
 * in --help; surfaced as a loud error when the path is missing because that's
 * a test-config bug, not a user bug.
 */
export async function ensureCloudflaredBinary(opts: { force: boolean }): Promise<string> {
  // Test-only escape hatch — checked first so it overrides force/download flow.
  const overridePath = process.env.HOOKMYAPP_CLOUDFLARED_BIN;
  if (overridePath) {
    if (!existsSync(overridePath)) {
      const err = new CliError(
        `cloudflared override path does not exist: ${overridePath}`,
        'CLOUDFLARED_OVERRIDE_MISSING',
      );
      err.exitCode = 4;
      throw err;
    }
    return overridePath;
  }

  if (!opts.force) {
    try {
      await stat(BIN_PATH);
      return BIN_PATH;
    } catch {
      // Fall through to download.
    }
  }

  await mkdir(BIN_DIR, { recursive: true });

  const asset = resolveAsset(process.platform, process.arch);
  const expectedSha = CLOUDFLARED_SHA256[asset.manifestKey];
  if (!expectedSha) {
    const err = new CliError(
      `No SHA-256 manifest entry for ${asset.manifestKey}. Run scripts/generate-cf-manifest.ts.`,
      'BINARY_CHECKSUM_FAILED',
    );
    err.exitCode = 4;
    throw err;
  }

  const res = await fetch(asset.url);
  if (!res.ok) {
    const err = new CliError(
      `Failed to download cloudflared from ${asset.url}: HTTP ${res.status}`,
      'BINARY_DOWNLOAD_FAILED',
    );
    err.exitCode = 4;
    throw err;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const computedSha = createHash('sha256').update(buf).digest('hex');
  if (computedSha !== expectedSha) {
    const err = new CliError(
      `cloudflared checksum mismatch for ${asset.filename}: expected ${expectedSha}, got ${computedSha}`,
      'BINARY_CHECKSUM_FAILED',
    );
    err.exitCode = 4;
    throw err;
  }

  if (asset.filename.endsWith('.tgz')) {
    // Write archive to a tempfile under BIN_DIR, extract the single `cloudflared`
    // member, then chmod. The tar package handles BSD vs GNU tar differences that
    // would trip up a spawned `tar` subprocess.
    const tmp = join(BIN_DIR, asset.filename);
    await writeFile(tmp, buf);
    await tarExtract({
      file: tmp,
      cwd: BIN_DIR,
      filter: (p: string) => p === 'cloudflared',
    });
  } else {
    await writeFile(BIN_PATH, buf);
  }

  if (process.platform !== 'win32') {
    await chmod(BIN_PATH, 0o755);
  }

  return BIN_PATH;
}
