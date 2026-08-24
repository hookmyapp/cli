import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn() }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
vi.mock('../../output/format.js', () => ({ isJsonMode: vi.fn(() => false) }));
import { runInstagramThreads } from '../instagram-inbox.js';
import { gatewayRequest } from '../../api/gateway.js';
import { isJsonMode } from '../../output/format.js';
import { ValidationError } from '../../output/error.js';

function captureStdout(): [() => string, () => void] {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
  return [() => writes.join(''), () => spy.mockRestore()];
}

describe('instagram threads', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockReset();
    vi.mocked(isJsonMode).mockReturnValue(false);
  });

  it('scopes the conversation list to the instagram inbox, not the linked Page inbox', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [] });
    const [, restore] = captureStdout();

    await runInstagramThreads({ channel: '@acme' });
    restore();

    expect(vi.mocked(gatewayRequest).mock.calls[0][0].path).toContain('platform=instagram');
  });

  it('lists threads with the people in them', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({
      data: [{ id: 'aWdfX', updated_time: 'T', participants: { data: [{ username: 'fan' }] } }],
    });
    const [out, restore] = captureStdout();

    await runInstagramThreads({ channel: '@acme' });
    restore();

    expect(out()).toContain('aWdfX\tT\t@fan');
  });

  it('reads one thread messages when --thread is given', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({
      data: [{ created_time: 'T', from: { username: 'fan' }, message: 'hello there' }],
    });
    const [out, restore] = captureStdout();

    await runInstagramThreads({ channel: '@acme', thread: 'aWdfXTHREAD' });
    restore();

    expect(vi.mocked(gatewayRequest).mock.calls[0][0].path).toContain('/aWdfXTHREAD/messages?');
    expect(out()).toContain('@fan\thello there');
  });

  it('reads only the public profile when --participant is given', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ id: 'IGSID1', username: 'fan' });
    const [, restore] = captureStdout();

    await runInstagramThreads({ channel: '@acme', participant: 'IGSID1' });
    restore();

    const path = decodeURIComponent(vi.mocked(gatewayRequest).mock.calls[0][0].path as string);
    expect(path).toContain('/IGSID1?fields=');
    expect(path).not.toContain('followers_count');
  });

  it('rejects a thread id carrying a path separator before any gateway call', async () => {
    await expect(
      runInstagramThreads({ channel: '@acme', thread: 'abc/../def' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('rejects a limit that is not a whole number', async () => {
    await expect(runInstagramThreads({ channel: '@acme', limit: 'lots' })).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });
});
