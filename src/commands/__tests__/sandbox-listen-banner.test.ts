// Quick task 260427-o7k. Asserts that the sandbox-listen banner emits a
// `📋 Logs UI: http://localhost:<port>/logs` hint in human mode, suppresses
// it under --json, and respects the user-supplied --port. Tests printBanner
// directly (exported from the module) so we don't have to mock the entire
// runSandboxListenFlow dependency surface (cloudflared, apiClient, etc.).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printBanner } from '../sandbox-listen/index.js';
import type { Session } from '../sandbox-listen/picker.js';

const SESSION: Session = {
  id: 'ssn_BANNER01',
  workspaceId: 'ws_TEST',
  workspaceName: 'Test Workspace',
  phone: '+15551234567',
  status: 'active',
  lastHeartbeatAt: null,
};

describe('sandbox listen banner: Logs UI hint', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('prints `Logs UI: http://localhost:<port>/logs` in human mode', () => {
    printBanner({
      hostname: 'fake.hookmyapp-sandbox.com',
      localPort: 3000,
      path: '/webhook',
      session: SESSION,
      json: false,
    });

    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toMatch(/Logs UI:\s+http:\/\/localhost:3000\/logs/);
  });

  it('does NOT print the Logs UI line in --json mode', () => {
    printBanner({
      hostname: 'fake.hookmyapp-sandbox.com',
      localPort: 3000,
      path: '/webhook',
      session: SESSION,
      json: true,
    });

    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toMatch(/Logs UI/);
    expect(output).not.toMatch(/\/logs/);
  });

  it('respects --port (uses the user-supplied port in the hint)', () => {
    printBanner({
      hostname: 'fake.hookmyapp-sandbox.com',
      localPort: 4242,
      path: '/webhook',
      session: SESSION,
      json: false,
    });

    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toMatch(/Logs UI:\s+http:\/\/localhost:4242\/logs/);
  });
});
