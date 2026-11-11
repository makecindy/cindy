import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { withCrossProcessLock } from '../../device-link/crossProcessLock';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinaryProvisionerConfig } from '../types';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  download: vi.fn(),
  backgroundDownload: vi.fn(),
  fetchManifest: vi.fn(),
  getCachedManifest: vi.fn(),
  getVendorAsset: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }));
vi.mock('../../manifestService.js', () => ({
  fetchManifest: mocks.fetchManifest,
  getCachedManifest: mocks.getCachedManifest,
  getBaseUrl: () => 'https://cdn.test',
  getPlatformKey: () => 'darwin-arm64',
}));
vi.mock('../manifest.js', () => ({
  getVendorAsset: mocks.getVendorAsset,
  resolveVendorAssetUrl: (base: string, asset: { file: string }) => base + '/' + asset.file,
}));
vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  createDownloader: () => mocks.backgroundDownload,
  DownloadError: class DownloadError extends Error {},
}));

import { createBinaryProvisioner } from '../factory';

const archiveBytes = gzipSync(Buffer.from('runtime'));
const asset = {
  version: '3.0.0',
  file: 'claude-code/3.0.0/darwin-arm64/claude.gz',
  sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  size: archiveBytes.length,
};
const config: BinaryProvisionerConfig = {
  vendorKey: 'claude',
  manifestField: 'claudeCode',
  installSubdir: 'runtime',
  artifact: { kind: 'gz', binaryName: 'claude' },
};

function installLocal(version: string, verified = true): string {
  const installDir = path.join(mocks.userDataDir, config.installSubdir, version);
  fs.mkdirSync(installDir, { recursive: true });
  const binaryPath = path.join(installDir, config.artifact.binaryName);
  fs.writeFileSync(binaryPath, 'local');
  fs.chmodSync(binaryPath, 0o755);
  if (verified) fs.writeFileSync(path.join(installDir, '.verified'), '');
  return binaryPath;
}

beforeAll(() => {
  mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-startup-update-'));
});
afterAll(() => {
  fs.rmSync(mocks.userDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(mocks.userDataDir, config.installSubdir), { recursive: true, force: true });
  fs.rmSync(path.join(mocks.userDataDir, 'agent-binary-downloads'), { recursive: true, force: true });
  mocks.getCachedManifest.mockReset().mockReturnValue(null);
  mocks.fetchManifest.mockReset().mockResolvedValue({ app: {} });
  mocks.getVendorAsset.mockReset().mockReturnValue(asset);
  mocks.download.mockReset().mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, gzipSync(Buffer.from('runtime')));
    return { path: targetPath, size: 7, sha256: asset.sha256, fromCache: false };
  });
  mocks.backgroundDownload.mockReset().mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, archiveBytes);
    return { path: targetPath, size: asset.size, sha256: asset.sha256 };
  });
});

/*
 * Production entry/result: prefetch -> prepare returns the new local path without
 * HTTP; the running runtime remains usable until then. The former startup-only
 * suite had no staged downloads. Minimal inputs are one old install plus one
 * newer archive (or one failed/corrupt archive). Tier: unit, no external IO.
 */
describe('background downloads handed to the existing installer', () => {
  it('keeps the running install during prefetch and installs the verified cache on restart without HTTP', async () => {
    const oldPath = installLocal('1.0.0');
    const provisioner = createBinaryProvisioner(config);
    await provisioner.prepare({ checkForUpdates: false });
    await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(true);
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('local');
    await expect(provisioner.getState()).resolves.toMatchObject({ binaryPath: oldPath });
    expect(fs.existsSync(path.join(mocks.userDataDir, config.installSubdir, asset.version, '.verified'))).toBe(false);

    const restarted = createBinaryProvisioner(config);
    const result = await restarted.prepare({ checkForUpdates: false });
    expect(result).toEqual({ ready: true, binaryPath: path.join(mocks.userDataDir, config.installSubdir, asset.version, 'claude') });
    expect(fs.readFileSync(result.binaryPath, 'utf8')).toBe('runtime');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userDataDir, 'agent-binary-downloads', 'claude', asset.sha256))).toBe(false);
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it('shares a simultaneous background and manual prefetch of the same target', async () => {
    let finish!: () => void;
    const started = Promise.withResolvers<void>();
    mocks.backgroundDownload.mockImplementationOnce(async ({ targetPath }: { targetPath: string }) => {
      started.resolve();
      await new Promise<void>(resolve => { finish = resolve; });
      fs.writeFileSync(targetPath, archiveBytes);
      return { path: targetPath, size: asset.size, sha256: asset.sha256 };
    });
    const one = createBinaryProvisioner(config).prefetch({ manifest: { app: {} } as never });
    await started.promise;
    const two = createBinaryProvisioner(config).prefetch({ manifest: { app: {} } as never });
    finish();
    expect(await Promise.all([one, two])).toEqual([true, true]);
    expect(mocks.backgroundDownload).toHaveBeenCalledOnce();
  });

  it('keeps a usable old runtime after failed prefetch and permits a later successful retry', async () => {
    const oldPath = installLocal('1.0.0');
    mocks.backgroundDownload.mockRejectedValueOnce(new Error('CDN unavailable'));
    const provisioner = createBinaryProvisioner(config);
    await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(false);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toEqual({ ready: true, binaryPath: oldPath });
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(true);
    expect((await provisioner.prepare({ checkForUpdates: false })).binaryPath).not.toBe(oldPath);
  });

  it('keeps a usable old runtime without HTTP when the prefetched target is superseded before restart', async () => {
    const oldPath = installLocal('1.0.0');
    const provisioner = createBinaryProvisioner(config);
    await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(true);
    mocks.getVendorAsset.mockReturnValue({ ...asset, version: '4.0.0', sha256: 'd'.repeat(64) });
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toEqual({ ready: true, binaryPath: oldPath });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('local');
    expect(fs.existsSync(path.join(mocks.userDataDir, config.installSubdir, '4.0.0', '.verified'))).toBe(false);
  });

  it('rejects a modified cache without a startup download or a false installed marker', async () => {
    const oldPath = installLocal('1.0.0');
    const provisioner = createBinaryProvisioner(config);
    await provisioner.prefetch({ manifest: { app: {} } as never });
    fs.writeFileSync(path.join(mocks.userDataDir, 'agent-binary-downloads', 'claude', asset.sha256, 'archive'), Buffer.alloc(asset.size));
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toEqual({ ready: true, binaryPath: oldPath });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userDataDir, config.installSubdir, asset.version, '.verified'))).toBe(false);
  });

  it('keeps first-install retries on one installation instead of removing an in-flight directory', async () => {
    const transfer = Promise.withResolvers<void>();
    const writeArchive = mocks.download.getMockImplementation()!;
    mocks.download.mockImplementationOnce(async (options) => { await transfer.promise; return writeArchive(options); });
    const provisioner = createBinaryProvisioner(config);
    const one = provisioner.prepare({ checkForUpdates: false });
    const two = provisioner.prepare({ checkForUpdates: false });
    transfer.resolve();
    const [first, second] = await Promise.all([one, two]);
    expect(first).toEqual(second);
    expect(first.ready).toBe(true);
    expect(fs.readFileSync(first.binaryPath, 'utf8')).toBe('runtime');
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it('keeps an optional installed runtime if the downloaded update passes its hash but cannot be extracted', async () => {
    const oldPath = installLocal('1.0.0');
    const bytes = Buffer.from('not a gzip archive');
    mocks.getVendorAsset.mockReturnValue({ ...asset, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    mocks.backgroundDownload.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.writeFileSync(targetPath, bytes);
      return { path: targetPath, size: bytes.length };
    });
    const provisioner = createBinaryProvisioner({ ...config, optionalAsset: true });
    await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(true);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toEqual({ ready: true, binaryPath: oldPath });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userDataDir, config.installSubdir, asset.version))).toBe(false);
  });

  it('cleans superseded and expired partial downloads without removing the installed runtime', async () => {
    const oldPath = installLocal('1.0.0');
    const root = path.join(mocks.userDataDir, 'agent-binary-downloads', 'claude');
    const obsolete = path.join(root, 'd'.repeat(64));
    const candidate = path.join(root, asset.sha256);
    for (const directory of [obsolete, candidate]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'archive.part'), 'abandoned');
      const expired = new Date(Date.now() - 8 * 24 * 60 * 60_000);
      fs.utimesSync(directory, expired, expired);
    }
    await expect(createBinaryProvisioner(config).prefetch({ manifest: { app: {} } as never })).resolves.toBe(true);
    expect(fs.existsSync(obsolete)).toBe(false);
    expect(fs.existsSync(path.join(candidate, 'archive.part'))).toBe(false);
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('local');
  });

  it('defers a download when another process owns the cache and remains retryable after it releases the lock', async () => {
    const oldPath = installLocal('1.0.0');
    const root = path.join(mocks.userDataDir, 'agent-binary-downloads', 'claude');
    fs.mkdirSync(root, { recursive: true });
    const provisioner = createBinaryProvisioner(config);
    await withCrossProcessLock(path.join(root, 'download.lock'), { label: 'other-instance', waitMs: 0 }, async status => {
      expect(status.held).toBe(true);
      await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(false);
      expect(mocks.backgroundDownload).not.toHaveBeenCalled();
      expect(fs.readFileSync(oldPath, 'utf8')).toBe('local');
    });
    await expect(provisioner.prefetch({ manifest: { app: {} } as never })).resolves.toBe(true);
  });
});

describe('startup binary version check policy', () => {
  it('still fetches the manifest but reuses a verified older binary on ordinary startup', async () => {
    const binaryPath = installLocal('1.0.0');
    const provisioner = createBinaryProvisioner(config);
    const options = { checkForUpdates: false };

    await expect(provisioner.peekNeedsDownload(options)).resolves.toBe(false);
    await expect(provisioner.prepare(options)).resolves.toEqual({ ready: true, binaryPath });
    expect(mocks.fetchManifest).toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(provisioner.getState()).resolves.toMatchObject({
      status: 'ready', installedVersion: '1.0.0', binaryPath,
    });
  });

  it.each([undefined, true])('retains the existing upgrade flow with checkForUpdates=%s', async (checkForUpdates) => {
    installLocal('1.0.0');
    const provisioner = createBinaryProvisioner(config);
    await expect(provisioner.peekNeedsDownload({ checkForUpdates })).resolves.toBe(true);
    await expect(provisioner.prepare({ checkForUpdates })).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledOnce();
    await expect(provisioner.getState()).resolves.toMatchObject({ installedVersion: asset.version });
  });

  it('downloads and verifies the first installation even when upgrade checks are disabled', async () => {
    const provisioner = createBinaryProvisioner(config);
    await expect(provisioner.peekNeedsDownload({ checkForUpdates: false })).resolves.toBe(true);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(mocks.userDataDir, config.installSubdir, asset.version, '.verified'))).toBe(true);
  });

  it.each(['unverified', 'missing'])('repairs a %s local installation instead of falsely reporting ready', async (damage) => {
    const binaryPath = installLocal('1.0.0', damage !== 'unverified');
    if (damage === 'missing') fs.unlinkSync(binaryPath);
    const provisioner = createBinaryProvisioner(config);
    await expect(provisioner.peekNeedsDownload({ checkForUpdates: false })).resolves.toBe(true);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it('preserves the highest actual self-updated runtime rather than selecting by directory name', async () => {
    const selfUpdated = installLocal('1.0.0');
    const otherBinary = installLocal('2.0.0');
    const versions = new Map([[selfUpdated, '4.0.0'], [otherBinary, '2.0.0']]);
    const provisioner = createBinaryProvisioner({
      ...config,
      localVersionResolver: async (binaryPath) => versions.get(binaryPath) ?? null,
    });
    await expect(provisioner.peekNeedsDownload({ checkForUpdates: false })).resolves.toBe(false);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toEqual({ ready: true, binaryPath: selfUpdated });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(otherBinary)).toBe(true);
  });

  it('repairs a verified runtime whose executable no longer passes its local probe', async () => {
    installLocal(asset.version);
    const provisioner = createBinaryProvisioner({ ...config, localVersionResolver: async () => null });
    await expect(provisioner.peekNeedsDownload({ checkForUpdates: false })).resolves.toBe(true);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it('keeps the required-runtime offline fallback', async () => {
    const binaryPath = installLocal('1.0.0');
    mocks.fetchManifest.mockResolvedValue(null);
    await expect(createBinaryProvisioner(config).prepare({ checkForUpdates: false }))
      .resolves.toEqual({ ready: true, binaryPath });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('does not resurrect an optional runtime withdrawn from the manifest', async () => {
    installLocal('1.0.0');
    mocks.getCachedManifest.mockReturnValue({ app: {} });
    mocks.getVendorAsset.mockReturnValue(undefined);
    const provisioner = createBinaryProvisioner({ ...config, optionalAsset: true });
    await expect(provisioner.peekNeedsDownload({ checkForUpdates: false })).resolves.toBe(false);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toMatchObject({ ready: false, error: 'asset_missing' });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('keeps optional runtimes unavailable when the manifest cannot be fetched', async () => {
    installLocal('1.0.0');
    mocks.fetchManifest.mockResolvedValue(null);
    await expect(createBinaryProvisioner({ ...config, optionalAsset: true }).prepare({ checkForUpdates: false }))
      .resolves.toMatchObject({ ready: false, error: 'manifest_failed' });
  });

  it('does not bypass manifest platform validation', async () => {
    installLocal('1.0.0');
    mocks.getVendorAsset.mockReturnValue({ ...asset, file: 'claude-code/3.0.0/win32-x64/claude.exe' });
    await expect(createBinaryProvisioner(config).prepare({ checkForUpdates: false }))
      .resolves.toMatchObject({ ready: false, error: 'asset_platform_mismatch' });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('surfaces a failed first download and allows a retry', async () => {
    mocks.download.mockRejectedValueOnce(new Error('network unavailable'));
    const provisioner = createBinaryProvisioner(config);
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toMatchObject({ ready: false });
    await expect(provisioner.prepare({ checkForUpdates: false })).resolves.toMatchObject({ ready: true });
  });
});
