// Phase 123 Plan 10 — telemetry consent tests.
//
// Exercises the three-layer override chain defined in
// `src/observability/telemetry.ts`:
//
//   1. HOOKMYAPP_TELEMETRY=off env var (session-scoped, no file read)
//   2. `hookmyapp config set telemetry off` persisted in config.json
//   3. Default → ON (industry-standard for product CLIs: npm, Next.js, Vercel)
//
// Also pins the first-run disclosure contract:
//   - Prints ONCE per installation (first call that fires it)
//   - `telemetryDisclosureShown: true` persists → subsequent calls no-op
//   - Banner goes to STDERR (so it doesn't pollute `--json` stdout scripts)
//   - Banner mentions both override paths verbatim (config set + env var)
//
// Uses `vitest.setup.ts`'s `HOOKMYAPP_CONFIG_DIR` tmp-dir isolation. Each test
// resets the config file (writeFileSync('{}')) to keep state local.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTelemetryEnabled,
  getPersistedTelemetry,
  setPersistedTelemetry,
  unsetPersistedTelemetry,
  maybePrintFirstRunDisclosure,
} from '../observability/telemetry.js';

function configDir(): string {
  const d = process.env.HOOKMYAPP_CONFIG_DIR;
  if (!d) throw new Error('HOOKMYAPP_CONFIG_DIR must be set by vitest.setup.ts');
  return d;
}

function configPath(): string {
  return join(configDir(), 'config.json');
}

function resetConfig(): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), '{}');
}

function readConfigRaw(): Record<string, unknown> {
  if (!existsSync(configPath())) return {};
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
}

describe('telemetry consent', () => {
  const originalEnv = process.env.HOOKMYAPP_TELEMETRY;

  beforeEach(() => {
    resetConfig();
    delete process.env.HOOKMYAPP_TELEMETRY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HOOKMYAPP_TELEMETRY;
    } else {
      process.env.HOOKMYAPP_TELEMETRY = originalEnv;
    }
  });

  describe('isTelemetryEnabled()', () => {
    it('default = ON when no env var + no persisted flag', () => {
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('HOOKMYAPP_TELEMETRY=off forces OFF regardless of persisted flag', () => {
      setPersistedTelemetry('on');
      process.env.HOOKMYAPP_TELEMETRY = 'off';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('HOOKMYAPP_TELEMETRY=on|anything-else does NOT force ON over persisted off (safety)', () => {
      // Env var only disables; accidentally setting HOOKMYAPP_TELEMETRY=on
      // must NOT re-enable a persisted off. Principle: the user's explicit
      // `config set telemetry off` wins unless they explicitly override with
      // the documented disable switch.
      setPersistedTelemetry('off');
      process.env.HOOKMYAPP_TELEMETRY = 'on';
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('persisted telemetry=off disables even with env var unset', () => {
      setPersistedTelemetry('off');
      expect(isTelemetryEnabled()).toBe(false);
    });

    it('persisted telemetry=on is the documented "re-enable after off" path', () => {
      setPersistedTelemetry('off');
      expect(isTelemetryEnabled()).toBe(false);
      setPersistedTelemetry('on');
      expect(isTelemetryEnabled()).toBe(true);
    });

    it('unset reverts to default (ON)', () => {
      setPersistedTelemetry('off');
      expect(isTelemetryEnabled()).toBe(false);
      unsetPersistedTelemetry();
      expect(isTelemetryEnabled()).toBe(true);
      expect(getPersistedTelemetry()).toBeNull();
    });
  });

  describe('persisted config file shape', () => {
    it('setPersistedTelemetry writes { telemetry: "off" }', () => {
      setPersistedTelemetry('off');
      const raw = readConfigRaw();
      expect(raw.telemetry).toBe('off');
    });

    it('setPersistedTelemetry preserves other config keys (merge, not replace)', () => {
      writeFileSync(
        configPath(),
        JSON.stringify({
          activeWorkspaceId: 'ws_A4zq8d2T',
          env: 'staging',
        }),
      );
      setPersistedTelemetry('off');
      const raw = readConfigRaw();
      expect(raw.activeWorkspaceId).toBe('ws_A4zq8d2T');
      expect(raw.env).toBe('staging');
      expect(raw.telemetry).toBe('off');
    });

    it('unsetPersistedTelemetry removes the key without wiping other keys', () => {
      writeFileSync(
        configPath(),
        JSON.stringify({
          activeWorkspaceId: 'ws_A4zq8d2T',
          telemetry: 'off',
        }),
      );
      unsetPersistedTelemetry();
      const raw = readConfigRaw();
      expect('telemetry' in raw).toBe(false);
      expect(raw.activeWorkspaceId).toBe('ws_A4zq8d2T');
    });
  });

  describe('first-run disclosure', () => {
    it('prints the banner ONCE, then persists telemetryDisclosureShown', () => {
      const chunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
        chunks.push(chunk.toString());
        return true;
      };
      try {
        maybePrintFirstRunDisclosure();
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stderr as any).write = origWrite;
      }
      const output = chunks.join('');
      expect(output).toContain('Telemetry');
      expect(output).toContain('HookMyApp CLI');
      // Both override paths are documented in the banner:
      expect(output).toContain('hookmyapp config set telemetry off');
      expect(output).toContain('HOOKMYAPP_TELEMETRY=off');
      // Persisted flag flipped:
      expect(readConfigRaw().telemetryDisclosureShown).toBe(true);
    });

    it('second call is a no-op (banner not reprinted)', () => {
      // First call → prints.
      maybePrintFirstRunDisclosure();
      // Now silence stderr and re-call; nothing should write.
      const chunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
        chunks.push(chunk.toString());
        return true;
      };
      try {
        maybePrintFirstRunDisclosure();
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stderr as any).write = origWrite;
      }
      expect(chunks.join('')).toBe('');
    });

    it('disclosure flag is preserved across setPersistedTelemetry calls (no regression)', () => {
      maybePrintFirstRunDisclosure();
      expect(readConfigRaw().telemetryDisclosureShown).toBe(true);
      setPersistedTelemetry('off');
      expect(readConfigRaw().telemetryDisclosureShown).toBe(true);
      setPersistedTelemetry('on');
      expect(readConfigRaw().telemetryDisclosureShown).toBe(true);
    });
  });

  describe('HOOKMYAPP_CONFIG_DIR isolation', () => {
    it('respects HOOKMYAPP_CONFIG_DIR (used by vitest setup + local test-runs)', () => {
      const d = configDir();
      // sanity: vitest.setup.ts should have pointed this at a tmpdir, not ~/.hookmyapp
      expect(d).not.toBe(join(process.env.HOME ?? '', '.hookmyapp'));
      // Writing through our helpers lands in the isolated dir:
      setPersistedTelemetry('off');
      expect(existsSync(join(d, 'config.json'))).toBe(true);
    });
  });
});

// Clean up at end of suite so later test files don't see disclosure-shown state.
afterEach(() => {
  try {
    rmSync(configPath(), { force: true });
  } catch {
    // best-effort
  }
});
