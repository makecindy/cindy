import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinaryProvisionerConfig } from '../types';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  download: vi.fn(),
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
  DownloadError: class DownloadError extends Error {},
}));

import { createBinaryProvisioner } from '../factory';

const asset = {
  version: '3.0.0',
  file: 'claude-code/3.0.0/darwin-arm64/claude.gz',
  sha256: 'c'.repeat(64),
  size: 7,
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
  mocks.getCachedManifest.mockReset().mockReturnValue(null);
  mocks.fetchManifest.mockReset().mockResolvedValue({ app: {} });
  mocks.getVendorAsset.mockReset().mockReturnValue(asset);
  mocks.download.mockReset().mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, gzipSync(Buffer.from('runtime')));
    return { path: targetPath, size: 7, sha256: asset.sha256, fromCache: false };
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
