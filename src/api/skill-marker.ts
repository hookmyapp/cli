import { readFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../storage/path.js';

/**
 * XDG-style marker file written by the agent-skills installer at install time.
 * Resolved through the canonical getConfigDir() so HOOKMYAPP_CONFIG_DIR and
 * XDG_CONFIG_HOME are honored consistently with every other config file.
 */
export function getSkillMarkerPath(): string {
  return join(getConfigDir(), 'skill-version');
}

// Strict semver: major.minor.patch with optional -prerelease and +build.
// Mirrors https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Read the skill marker file and return one of three states:
 *
 *   absent              → undefined  (header omitted; server applies CLI checks only)
 *   parseable semver    → the value  (header carries the version)
 *   corrupt / empty / non-semver / unreadable → 'invalid'
 *
 * The 'invalid' sentinel is intentional: collapsing "absent" and "corrupt"
 * into a single "no header" state would bypass the skill_required gate when
 * a marker file has been partially written, manually edited, or otherwise
 * damaged. Server treats 'invalid' as definitively outdated → 426 reinstall.
 *
 * Never throws — non-fatal at the CLI layer per spec verification surface.
 */
export function readSkillVersion(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(getSkillMarkerPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'invalid';
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'invalid';
  if (!SEMVER_RE.test(trimmed)) return 'invalid';
  return trimmed;
}
