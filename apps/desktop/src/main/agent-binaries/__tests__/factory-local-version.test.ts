import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorAsset } from '../manifest.js';

const FAKE_SHA = 'c'.repeat(64);
const installRoots: string[] = [];

const mocks = vi.hoisted(() => ({
  asset: {
    current: {
      version: '0.84.3',
      file: 'pi/0.84.3/darwin-arm64/pi.gz',
      sha256: 'c'.repeat(64),
      size: 3,
    } as VendorAsset,
  },
  download: vi.fn(),
}));

vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../../manifestService.js', () => ({
  fetchManifest: vi.fn(async () => ({ app: {} })),
  getCachedManifest: vi.fn(() => ({ app: {} })),
  getBaseUrl: () => 'https://cdn.test',
  getPlatformKey: () => 'darwin-arm64',
}));

vi.mock('../manifest.js', () => ({
  getVendorAsset: () => mocks.asset.current,
  resolveVendorAssetUrl: (base: string, asset: VendorAsset) => `${base}/${asset.file}`,
}));

import { createBinaryProvisioner } from '../factory.js';

interface DownloadOpts {
  targetPath: string;
}

function uniqueInstallSubdir(): string {
  return `factory-local-version-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function mountVerifiedBinary(
  installSubdir: string,
  directoryVersion: string,
  binaryName: string,
): Promise<string> {
  const { app } = await import('electron');
  const installRoot = path.join(app.getPath('userData'), installSubdir);
  if (!installRoots.includes(installRoot)) installRoots.push(installRoot);
  const versionDir = path.join(installRoot, directoryVersion);
  fs.mkdirSync(versionDir, { recursive: true });
  const binaryPath = path.join(versionDir, binaryName);
  fs.writeFileSync(binaryPath, 'local binary');
  fs.chmodSync(binaryPath, 0o755);
  fs.writeFileSync(path.join(versionDir, '.verified'), '');
  return binaryPath;
}

function makeProvisioner(
  installSubdir: string,
  binaryName: string,
  localVersionResolver: (binaryPath: string) => Promise<string | null>,
) {
  return createBinaryProvisioner({
    vendorKey: 'pi',
    manifestField: 'pi',
    installSubdir,
    optionalAsset: true,
    artifact: { kind: 'gz', binaryName },
    localVersionResolver,
  });
}

beforeEach(() => {
  mocks.asset.current = {
    version: '0.84.3',
    file: 'pi/0.84.3/darwin-arm64/pi.gz',
    sha256: FAKE_SHA,
    size: 3,
  };
  mocks.download.mockReset();
  mocks.download.mockImplementation(async (opts: DownloadOpts) => {
    fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
    fs.writeFileSync(opts.targetPath, gzipSync(Buffer.from('cdn binary')));
    return {
      path: opts.targetPath,
      size: 3,
      sha256: FAKE_SHA,
      fromCache: false,
      durationMs: 1,
      resumedFromBytes: 0,
    };
  });
});

afterEach(() => {
  for (const root of installRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('local runtime version arbitration', () => {
  it('preserves an in-place self-update newer than the manifest without download or cleanup', async () => {
    const installSubdir = uniqueInstallSubdir();
    const binaryName = 'pi';
    const selfUpdated = await mountVerifiedBinary(installSubdir, '0.84.3', binaryName);
    const older = await mountVerifiedBinary(installSubdir, '0.83.0', binaryName);
    const versions = new Map([
      [selfUpdated, '0.84.4'],
      [older, '0.83.0'],
    ]);
    const resolveVersion = vi.fn(async (binaryPath: string) => versions.get(binaryPath) ?? null);
    const provisioner = makeProvisioner(installSubdir, binaryName, resolveVersion);

    await expect(provisioner.peekNeedsDownload()).resolves.toBe(false);
    expect(resolveVersion).not.toHaveBeenCalled();
    await expect(provisioner.prepare()).resolves.toEqual({
      ready: true,
      binaryPath: selfUpdated,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(resolveVersion).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.dirname(older))).toBe(true);
    await expect(provisioner.getState()).resolves.toMatchObject({
      status: 'ready',
      installedVersion: '0.84.4',
      availableVersion: '0.84.3',
      binaryPath: selfUpdated,
    });
  });

  it.each([
    ['the directory-latest candidate is invalid', null, '0.84.4'],
    ['the older directory reports a higher version', '0.84.4', '0.84.5'],
  ])(
    'selects the highest real version when %s',
    async (_label, latestReported, olderDirectoryReported) => {
      const installSubdir = uniqueInstallSubdir();
      const binaryName = 'pi';
      const olderDirectory = await mountVerifiedBinary(installSubdir, '0.84.3', binaryName);
      const latestDirectory = await mountVerifiedBinary(installSubdir, '0.84.4', binaryName);
      const versions = new Map([
        [latestDirectory, latestReported],
        [olderDirectory, olderDirectoryReported],
      ]);
      const resolveVersion = vi.fn(
        async (binaryPath: string) => versions.get(binaryPath) ?? null,
      );

      const result = await makeProvisioner(
        installSubdir,
        binaryName,
        resolveVersion,
      ).prepare();

      expect(result).toEqual({ ready: true, binaryPath: olderDirectory });
      expect(resolveVersion).toHaveBeenCalledTimes(2);
      expect(mocks.download).not.toHaveBeenCalled();
      expect(fs.existsSync(path.dirname(olderDirectory))).toBe(true);
      expect(fs.existsSync(path.dirname(latestDirectory))).toBe(true);
    },
  );

  it('selects the highest real local version before an exact manifest-directory match', async () => {
    const installSubdir = uniqueInstallSubdir();
    const binaryName = 'pi';
    const exact = await mountVerifiedBinary(installSubdir, '0.84.3', binaryName);
    const newer = await mountVerifiedBinary(installSubdir, '0.84.4', binaryName);
    const versions = new Map([
      [exact, '0.84.3'],
      [newer, '0.84.4'],
    ]);

    const result = await makeProvisioner(
      installSubdir,
      binaryName,
      async (binaryPath) => versions.get(binaryPath) ?? null,
    ).prepare();

    expect(result).toEqual({ ready: true, binaryPath: newer });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('keeps an equal real version even when self-update left an older directory name', async () => {
    mocks.asset.current.version = '0.84.4';
    const installSubdir = uniqueInstallSubdir();
    const binaryPath = await mountVerifiedBinary(installSubdir, '0.84.3', 'pi');

    const result = await makeProvisioner(installSubdir, 'pi', async () => '0.84.4').prepare();

    expect(result).toEqual({ ready: true, binaryPath });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('retains the existing CDN upgrade and cleanup flow when the local version is older', async () => {
    mocks.asset.current = {
      ...mocks.asset.current,
      version: '0.84.5',
      file: 'pi/0.84.5/darwin-arm64/pi.gz',
    };
    const installSubdir = uniqueInstallSubdir();
    const oldBinary = await mountVerifiedBinary(installSubdir, '0.84.4', 'pi');

    const result = await makeProvisioner(installSubdir, 'pi', async (binaryPath) =>
      binaryPath === oldBinary ? '0.84.4' : null,
    ).prepare();

    expect(result.ready).toBe(true);
    expect(path.basename(path.dirname(result.binaryPath))).toBe('0.84.5');
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.dirname(oldBinary))).toBe(false);
  });

  it.each([
    ['the probe fails', 'throw'],
    ['the output is invalid', null],
    ['the real version is older', '0.84.2'],
  ])('repairs an exact-manifest directory when %s', async (_label, reported) => {
    const installSubdir = uniqueInstallSubdir();
    const exact = await mountVerifiedBinary(installSubdir, '0.84.3', 'pi');
    const provisioner = makeProvisioner(installSubdir, 'pi', async () => {
      if (reported === 'throw') throw new Error('probe failed');
      return reported;
    });

    await expect(provisioner.peekNeedsDownload()).resolves.toBe(false);
    await expect(provisioner.prepare()).resolves.toEqual({
      ready: true,
      binaryPath: exact,
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
});
