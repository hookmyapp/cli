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
import { registerOrgProfileCommand } from '../org-profile.js';

const mockedApi = vi.mocked(apiClient);

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  registerOrgProfileCommand(program);
  return program;
}

beforeEach(() => {
  mockedApi.mockReset();
  mockConsoleLog.mockClear();
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
