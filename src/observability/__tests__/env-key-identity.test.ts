import { describe, it, expect, afterEach } from 'vitest';
import { getDistinctId } from '../posthog.js';
import { API_KEY_ENV_VAR } from '../../config/env-vars.js';

// AIT-438: lastWorkosSub outlives a human's session, so without a key-specific
// identity every CI/agent event authenticated by HOOKMYAPP_API_KEY is merged
// into whoever last logged in on that machine.
describe('telemetry identity under HOOKMYAPP_API_KEY', () => {
  afterEach(() => {
    delete process.env[API_KEY_ENV_VAR];
  });

  it('uses a key-specific distinct id, not the persisted human sub', () => {
    const withoutKey = getDistinctId();
    process.env[API_KEY_ENV_VAR] = 'hmok_agentkey';
    const withKey = getDistinctId();

    expect(withKey).not.toBe(withoutKey);
    expect(withKey).toMatch(/^key_[0-9a-f]{16}$/);
    // Derived, never the secret itself.
    expect(withKey).not.toContain('agentkey');
  });

  it('is stable for one key and distinct across keys', () => {
    process.env[API_KEY_ENV_VAR] = 'hmok_a';
    const a1 = getDistinctId();
    const a2 = getDistinctId();
    process.env[API_KEY_ENV_VAR] = 'hmok_b';
    const b = getDistinctId();

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
