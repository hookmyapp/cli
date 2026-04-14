import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// Hoist-safe mocks for fs/promises.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('tar', () => ({
  x: vi.fn().mockResolvedValue(undefined),
}));

import { stat, writeFile, chmod } from 'node:fs/promises';
import { x as tarExtract } from 'tar';

const mockedStat = vi.mocked(stat);
const mockedWriteFile = vi.mocked(writeFile);
const mockedChmod = vi.mocked(chmod);
const mockedTarExtract = vi.mocked(tarExtract);

// Compute real SHA-256 for our fake "binary" payload so we can drive the verify path.
const FAKE_BINARY = Buffer.from('fake-cloudflared-bytes');
const FAKE_SHA = createHash('sha256').update(FAKE_BINARY).digest('hex');

function installFetchMock(opts: { ok?: boolean; status?: number; body?: Buffer } = {}): void {
  const { ok = true, status = 200, body = FAKE_BINARY } = opts;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response);
}

describe('ensureCloudflaredBinary', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    vi.resetModules();
    mockedStat.mockReset();
    mockedWriteFile.mockReset();
    mockedChmod.mockReset();
    mockedTarExtract.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  it('resolveAsset returns darwin-arm64 .tgz on macOS arm64', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const mod = await import('../../commands/sandbox-listen/binary.js');
    const asset = mod.resolveAsset('darwin', 'arm64');
    expect(asset.filename).toBe('cloudflared-darwin-arm64.tgz');
    expect(asset.url).toContain('cloudflared-darwin-arm64.tgz');
    expect(asset.manifestKey).toBe('darwin-arm64.tgz');
  });

  it('resolveAsset returns linux-amd64 standalone on Linux x64', async () => {
    const mod = await import('../../commands/sandbox-listen/binary.js');
    const asset = mod.resolveAsset('linux', 'x64');
    expect(asset.filename).toBe('cloudflared-linux-amd64');
    expect(asset.manifestKey).toBe('linux-amd64');
  });

  it('resolveAsset returns windows .exe on win32', async () => {
    const mod = await import('../../commands/sandbox-listen/binary.js');
    const asset = mod.resolveAsset('win32', 'x64');
    expect(asset.filename).toBe('cloudflared-windows-amd64.exe');
    expect(asset.manifestKey).toBe('windows-amd64.exe');
  });

  it('ensureCloudflaredBinary skips download when file exists and !force', async () => {
    mockedStat.mockResolvedValueOnce({} as Awaited<ReturnType<typeof stat>>);
    installFetchMock();

    const mod = await import('../../commands/sandbox-listen/binary.js');
    const result = await mod.ensureCloudflaredBinary({ force: false });

    expect(result).toMatch(/cloudflared(\.exe)?$/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('ensureCloudflaredBinary re-downloads when force=true even if file exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    mockedStat.mockResolvedValueOnce({} as Awaited<ReturnType<typeof stat>>);
    installFetchMock();

    const mod = await import('../../commands/sandbox-listen/binary.js');
    // Override manifest with the real sha for this test so verify passes.
    mod.__testOverrideSha('linux-amd64', FAKE_SHA);

    await mod.ensureCloudflaredBinary({ force: true });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(mockedWriteFile).toHaveBeenCalled();
    expect(mockedChmod).toHaveBeenCalled();
  });

  it('ensureCloudflaredBinary throws CliError with exit code 4 on sha256 mismatch', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    mockedStat.mockRejectedValueOnce(new Error('ENOENT'));
    installFetchMock();

    const mod = await import('../../commands/sandbox-listen/binary.js');
    // Leave default PENDING manifest value so the computed sha will NOT match.
    mod.__testOverrideSha('linux-amd64', 'deadbeef_not_the_real_sha');

    try {
      await mod.ensureCloudflaredBinary({ force: false });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as { code?: string; exitCode?: number; name?: string };
      expect(e.name).toBe('CliError');
      expect(e.code).toBe('BINARY_CHECKSUM_FAILED');
      expect(e.exitCode).toBe(4);
    }
  });

  it('ensureCloudflaredBinary throws CliError on HTTP error', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    mockedStat.mockRejectedValueOnce(new Error('ENOENT'));
    installFetchMock({ ok: false, status: 500 });

    const mod = await import('../../commands/sandbox-listen/binary.js');

    try {
      await mod.ensureCloudflaredBinary({ force: false });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as { code?: string; exitCode?: number };
      expect(e.code).toBe('BINARY_DOWNLOAD_FAILED');
      expect(e.exitCode).toBe(4);
    }
  });

  it('ensureCloudflaredBinary extracts tar member on macOS .tgz', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    mockedStat.mockRejectedValueOnce(new Error('ENOENT'));
    installFetchMock();

    const mod = await import('../../commands/sandbox-listen/binary.js');
    mod.__testOverrideSha('darwin-arm64.tgz', FAKE_SHA);

    await mod.ensureCloudflaredBinary({ force: false });

    expect(mockedTarExtract).toHaveBeenCalledOnce();
    expect(mockedChmod).toHaveBeenCalled();
  });

  it('exports CLOUDFLARED_VERSION and CLOUDFLARED_SHA256 with 5 platform entries', async () => {
    const mod = await import('../../commands/sandbox-listen/binary.js');
    expect(mod.CLOUDFLARED_VERSION).toBe('2026.3.0');
    expect(Object.keys(mod.CLOUDFLARED_SHA256)).toHaveLength(5);
    expect(mod.CLOUDFLARED_SHA256).toHaveProperty('darwin-arm64.tgz');
    expect(mod.CLOUDFLARED_SHA256).toHaveProperty('darwin-amd64.tgz');
    expect(mod.CLOUDFLARED_SHA256).toHaveProperty('linux-arm64');
    expect(mod.CLOUDFLARED_SHA256).toHaveProperty('linux-amd64');
    expect(mod.CLOUDFLARED_SHA256).toHaveProperty('windows-amd64.exe');
  });
});
