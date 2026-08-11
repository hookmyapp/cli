import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
  resolveOrgPublicIdForWorkspace: vi.fn().mockResolvedValue('org_abc12345'),
}));

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient } from '../../api/client.js';
import { registerPhoneCommand } from '../phone.js';
import { registerOrgProfileCommand } from '../org-profile.js';

const mockedApi = vi.mocked(apiClient);

const STATUS = {
  phone: '+155•••4567',
  verified: true,
  consents: { operational: true, product: false, marketing: false },
  channelPreference: 'whatsapp',
};

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  registerPhoneCommand(program);
  registerOrgProfileCommand(program);
  return program;
}

beforeEach(() => {
  mockedApi.mockReset();
  mockConsoleLog.mockClear();
});

describe('hookmyapp phone', () => {
  it('phone status GETs /auth/phone and prints JSON with --json', async () => {
    mockedApi.mockResolvedValue(STATUS);

    await makeProgram().parseAsync(['node', 'hookmyapp', 'phone', 'status', '--json']);

    expect(mockedApi).toHaveBeenCalledWith('/auth/phone');
    expect(mockConsoleLog.mock.calls[0][0]).toContain('+155•••4567');
  });

  it('phone set normalizes the number, defaults operational on, POSTs /auth/phone', async () => {
    mockedApi.mockResolvedValue({ delivery: 'sent' });

    await makeProgram().parseAsync(['node', 'hookmyapp', 'phone', 'set', '+1 (555) 123-4567', '--product']);

    const [path, init] = mockedApi.mock.calls[0];
    expect(path).toBe('/auth/phone');
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      phone: '+15551234567',
      consentOperational: true,
      consentProduct: true,
      consentMarketing: false,
      channelPreference: 'whatsapp',
    });
  });

  it('phone set rejects a non-E.164 number without calling the API', async () => {
    await expect(
      makeProgram().parseAsync(['node', 'hookmyapp', 'phone', 'set', 'not-a-number']),
    ).rejects.toThrow(/international format/);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('phone verify POSTs the code and rejects non-6-digit codes locally', async () => {
    mockedApi.mockResolvedValue(STATUS);
    await makeProgram().parseAsync(['node', 'hookmyapp', 'phone', 'verify', '123456']);
    expect(mockedApi).toHaveBeenCalledWith('/auth/phone/verify', expect.objectContaining({ method: 'POST' }));

    mockedApi.mockClear();
    await expect(
      makeProgram().parseAsync(['node', 'hookmyapp', 'phone', 'verify', '12']),
    ).rejects.toThrow(/6 digits/);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('phone consents PATCHes only the provided flags', async () => {
    mockedApi.mockResolvedValue(STATUS);

    await makeProgram().parseAsync(['node', 'hookmyapp', 'phone', 'consents', '--marketing', 'on', '--prefer', 'both']);

    const [path, init] = mockedApi.mock.calls[0];
    expect(path).toBe('/auth/phone/consents');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ marketing: true, channelPreference: 'both' });
  });
});

describe('hookmyapp org profile', () => {
  const PROFILE = {
    publicId: 'org_abc12345',
    name: 'Acme',
    email: null,
    phone: null,
    website: 'https://acme.com',
    businessCategory: null,
    businessNiche: null,
    primaryUseCase: null,
  };

  it('org profile show GETs the org summary', async () => {
    mockedApi.mockResolvedValue(PROFILE);

    await makeProgram().parseAsync(['node', 'hookmyapp', 'org', 'profile', 'show', '--json']);

    expect(mockedApi).toHaveBeenCalledWith('/organizations/org_abc12345');
    expect(mockConsoleLog.mock.calls[0][0]).toContain('acme.com');
  });

  it('org profile set PATCHes only the provided fields', async () => {
    mockedApi.mockResolvedValue(PROFILE);

    await makeProgram().parseAsync([
      'node', 'hookmyapp', 'org', 'profile', 'set',
      '--website', 'https://acme.com', '--business-category', 'E-commerce',
    ]);

    const [path, init] = mockedApi.mock.calls[0];
    expect(path).toBe('/organizations/org_abc12345/profile');
    expect((init as { method: string }).method).toBe('PATCH');
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      website: 'https://acme.com',
      businessCategory: 'E-commerce',
    });
  });

  it('org profile set with no flags fails locally without calling the API', async () => {
    await expect(
      makeProgram().parseAsync(['node', 'hookmyapp', 'org', 'profile', 'set']),
    ).rejects.toThrow(/Nothing to update/);
    expect(mockedApi).not.toHaveBeenCalled();
  });
});
