import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));

import { apiClient } from '../../api/client.js';
import { alertPhoneConsents, alertPhoneRemove, alertPhoneSet, alertPhoneStatus, alertPhoneVerify } from '../alerts.js';

const VERIFIED = {
  phone: '+141•••2671',
  verified: true,
  consents: { operational: true, product: false, marketing: false },
  channelPreference: 'whatsapp',
};

describe('alerts phone', () => {
  let logs: string[];

  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('When no phone is verified, then status points at the set command', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({ ...VERIFIED, phone: null, verified: false });
    // Act
    await alertPhoneStatus({ json: false });
    // Assert
    expect(logs.join('\n')).toContain('alerts phone set');
  });

  test('When the number is not international format, then it is rejected before any call', async () => {
    // Act + Assert — a national number would be sent to the wrong country.
    await expect(alertPhoneSet('0545434384')).rejects.toThrow(/international format/);
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('When the number is a bare plus or over-length, then it is rejected', async () => {
    // Act + Assert — CodeRabbit: startsWith('+') let these through.
    await expect(alertPhoneSet('+')).rejects.toThrow(/international format/);
    await expect(alertPhoneSet('+abc')).rejects.toThrow(/international format/);
    await expect(alertPhoneSet('+1234567890123456')).rejects.toThrow(/international format/);
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('When there is no TTY and no --json or --code, then it refuses before sending', async () => {
    // Act + Assert — non-interactive, so no code is sent and no apiClient call.
    await expect(alertPhoneSet('+14155552671', { interactive: false })).rejects.toThrow(/interactive terminal/);
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('When --code is malformed, then no code is sent', async () => {
    // Act + Assert — Codex: the send used to go out first, burning quota for a
    // code that could only be rejected locally.
    await expect(alertPhoneSet('+14155552671', { code: '12ab' })).rejects.toThrow(/6 digits/);
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('When consent flags are omitted, then only operational consent is sent', async () => {
    // Arrange — marketing consent must never be assumed from a bare command.
    vi.mocked(apiClient).mockResolvedValueOnce({ delivery: 'sent' });
    // Act
    await alertPhoneSet('+14155552671', { json: true });
    // Assert
    const body = JSON.parse(String(vi.mocked(apiClient).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ consentOperational: true, consentProduct: true, consentMarketing: true });
  });

  test('When delivery fails, then it does not ask for a code', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({ delivery: 'unavailable' });
    // Act — interactive so the run reaches the delivery check, not the TTY guard.
    await alertPhoneSet('+14155552671', { json: false, interactive: true });
    // Assert — one call only: no verify attempt against a code nobody received.
    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('could not deliver');
  });

  test('When a code is supplied, then set verifies directly without starting a new challenge', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce(VERIFIED);
    // Act
    await alertPhoneSet('+14155552671', { code: '123456', json: false });
    // Assert — one call only: a new challenge would supersede the one the code belongs to.
    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe('/auth/phone/verify');
  });

  test('When the code is not six digits, then verify rejects it locally', async () => {
    // Act + Assert
    await expect(alertPhoneVerify('12ab')).rejects.toThrow(/6 digits/);
    expect(apiClient).not.toHaveBeenCalled();
  });
});

describe('alerts phone remove', () => {
  test('When --json, then it deletes without a prompt and prints the status', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({
      phone: null,
      verified: false,
      consents: { operational: true, product: false, marketing: false },
      channelPreference: 'whatsapp',
    });
    await alertPhoneRemove({ json: true });
    expect(apiClient).toHaveBeenCalledWith('/auth/phone', { method: 'DELETE' });
  });
});

describe('alerts phone consents', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('When flags are given, then only those fields are PATCHed', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce(VERIFIED);
    // Act
    await alertPhoneConsents({ marketing: 'off', prefer: 'sms', json: true });
    // Assert
    const [path, init] = vi.mocked(apiClient).mock.calls[0];
    expect(path).toBe('/auth/phone/consents');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ marketing: false, channelPreference: 'sms' });
  });

  test('When no flags are given, then it fails locally without calling the API', async () => {
    // Act + Assert
    await expect(alertPhoneConsents({})).rejects.toThrow(/Nothing to update/);
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('When a consent value is not on or off, then it is rejected before any call', async () => {
    // Act + Assert
    await expect(alertPhoneConsents({ product: 'yes' })).rejects.toThrow(/"on" or "off"/);
    expect(apiClient).not.toHaveBeenCalled();
  });
});
