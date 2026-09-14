import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { c as createTar } from 'tar';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../manifestService';
import { createPiRuntimeRecovery } from '../pi-runtime-recovery';
import { writeStartupBinaryUpdateMarker } from '../startup-update';
import { newerStableVersion, PINNED_CODEX_VERSION } from './runtimeVersionFixtures';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  isPackaged: true,
  cachedManifest: null as Manifest | null,
  remoteManifest: null as Manifest | null,
  fetchManifest: vi.fn(),
  download: vi.fn(),
  execFile: vi.fn(),
  systemCommands: new Map<string, string>(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mocks.isPackaged; },
    getPath: () => mocks.userDataDir,
    getVersion: () => '2.0.0',
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../../manifestService.js', () => ({
  getCachedManifest: () => mocks.cachedManifest,
  fetchManifest: mocks.fetchManifest,
  getPlatformKey: () => process.platform === 'win32' ? 'win32-x64' : process.platform === 'linux' ? 'linux-x64' : 'darwin-arm64',
  getBaseUrl: () => 'https://cdn.test',
}));
vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  DownloadError: class DownloadError extends Error {},
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../dev-fallback.js', () => ({ findDevBinary: () => null }));

const originalPlatform = process.platform;
const quiet = { broadcastProgress: false, broadcastFailure: false };
let tempRoot: string;
let binaries: typeof import('../index');

function writeExecutable(binaryPath: string, version: string): string {
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, version, { mode: 0o755 });
  return binaryPath;
}

function installManaged(kind: 'claude-code' | 'codex' | 'pi', version = '1.0.0'): string {
  const installDir = path.join(mocks.userDataDir, kind === 'codex' ? 'codex-package' : kind, version);
  const name = kind === 'claude-code' ? 'claude' : kind;
  const executable = process.platform === 'win32' ? name + '.exe' : name;
  const binaryPath = writeExecutable(path.join(installDir, kind === 'codex' ? 'bin' : '', executable), version);
  fs.writeFileSync(path.join(installDir, '.verified'), '');
  return binaryPath;
}

function releaseManifest(version = '2.0.0'): Manifest {
  const asset = (kind: string) => ({ version, file: kind + '/' + version + '/runtime', sha256: 'a'.repeat(64), size: 7 });
  return { app: {}, claudeCode: asset('claude'), codexPackage: asset('codex'), pi: asset('pi') } as unknown as Manifest;
}

async function reloadBinaries(platform: NodeJS.Platform = 'darwin') {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  mocks.cachedManifest = null;
  binaries = await import('../index');
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-startup-policy-'));
});
beforeEach(async () => {
  mocks.userDataDir = path.join(tempRoot, 'user-data');
  mocks.isPackaged = true;
  mocks.systemCommands.clear();
  mocks.remoteManifest = releaseManifest();
  mocks.fetchManifest.mockReset().mockImplementation(async () => {
    mocks.cachedManifest = mocks.remoteManifest;
    return mocks.cachedManifest;
  });
  mocks.execFile.mockReset().mockImplementation((
    command: string, args: string[], options: { signal?: AbortSignal },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (options.signal?.aborted) {
      callback(new Error('aborted'), '', '');
      return;
    }
    if (command === '/bin/sh') {
      const commandName = [...mocks.systemCommands.keys()].find((name) => args.join(' ').includes(name));
      callback(null, commandName ? mocks.systemCommands.get(commandName)! : '', '');
      return;
    }
    try { callback(null, fs.readFileSync(command, 'utf8'), ''); }
    catch { callback(new Error('executable missing'), '', ''); }
  });
  mocks.download.mockReset().mockImplementation(async ({ targetPath, url }: { targetPath: string; url: string }) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const version = url.split('/').at(-2)!;
    if (targetPath.endsWith('.tar.gz')) {
      const executable = url.includes('/codex/') ? path.join('bin', 'codex') : 'pi';
      const payload = fs.mkdtempSync(path.join(tempRoot, 'payload-'));
      try {
        writeExecutable(path.join(payload, executable), version);
        await createTar({ file: targetPath, cwd: payload, gzip: true }, [executable]);
      } finally { fs.rmSync(payload, { recursive: true, force: true }); }
    } else {
      fs.writeFileSync(targetPath, gzipSync(Buffer.from(version)));
    }
    return { path: targetPath, size: 7 };
  });
  await reloadBinaries();
});
afterEach(() => {
  fs.rmSync(mocks.userDataDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
afterAll(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

describe('shared startup policy through the real binary preparation chain', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('reuses managed runtimes by default on %s after fetching manifest', async (platform) => {
    await reloadBinaries(platform);
    for (const kind of ['claude-code', 'codex', 'pi'] as const) {
      const binaryPath = installManaged(kind);
      await expect(binaries.peekNeedsDownload(kind)).resolves.toBe(false);
      await expect(binaries.prepare(kind, quiet)).resolves.toMatchObject({ ready: true, path: binaryPath });
    }
    expect(mocks.fetchManifest).toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('consumes a matching marker once and retains the upgrade decision for retries and other vendors', async () => {
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0');
    installManaged('pi');
    await expect(binaries.peekNeedsDownload('pi')).resolves.toBe(true);
    expect(fs.existsSync(path.join(mocks.userDataDir, 'agent-binary-update-once.json'))).toBe(false);
    mocks.download.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: false });
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: true, path: path.join(mocks.userDataDir, 'pi', '2.0.0', 'pi') });
    installManaged('codex');
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    await reloadBinaries();
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(false);
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('Pi background recovery inherits checkForUpdates=%s without caller flags', async (allowUpdates) => {
    if (allowUpdates) writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0');
    const localPath = installManaged('pi');
    mocks.remoteManifest = null;
    const startup = await binaries.prepare('pi', quiet);
    expect(startup).toMatchObject({ ready: false, error: 'manifest_failed' });
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare: () => binaries.prepare('pi', quiet),
      register: () => true,
      onRegistered: vi.fn(),
    });
    try {
      recovery.markUnavailable(startup.error);
      mocks.remoteManifest = releaseManifest();
      await expect(recovery.retryNow('window-focus')).resolves.toBe(true);
      expect(binaries.getReadyBinaryPath('pi')).toBe(allowUpdates ? path.join(mocks.userDataDir, 'pi', '2.0.0', 'pi') : localPath);
      expect(mocks.download).toHaveBeenCalledTimes(allowUpdates ? 1 : 0);
    } finally { recovery.dispose(); }
  });

  it('repairs the first installation and a broken managed executable without an update marker', async () => {
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: true });
    writeExecutable(path.join(mocks.userDataDir, 'pi', '2.0.0', 'pi'), 'broken executable');
    await expect(binaries.peekNeedsDownload('pi')).resolves.toBe(true);
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: true });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it('allows an explicit update check without changing the default startup decision', async () => {
    installManaged('pi');
    installManaged('codex');
    await expect(binaries.prepare('pi', { ...quiet, checkForUpdates: true })).resolves.toMatchObject({ ready: true });
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(false);
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it('does not resurrect a withdrawn optional runtime through the shared policy', async () => {
    installManaged('pi');
    mocks.remoteManifest = { app: {} } as Manifest;
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: false, error: 'asset_missing' });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('does not consume the packaged marker during a development startup', async () => {
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0');
    mocks.isPackaged = false;
    await binaries.peekNeedsDownload('pi');
    await binaries.prepare('pi', quiet);
    expect(fs.existsSync(path.join(mocks.userDataDir, 'agent-binary-update-once.json'))).toBe(true);
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

describe('Linux local discovery before any update download', () => {
  it('keeps the previously used system Codex when a newer CDN release appears on the next startup', async () => {
    await reloadBinaries('linux');
    const systemPath = writeExecutable(path.join(tempRoot, 'system-codex'), 'codex-cli ' + PINNED_CODEX_VERSION);
    mocks.systemCommands.set('codex', systemPath);
    mocks.remoteManifest = { app: {} } as Manifest;
    await expect(binaries.prepare('codex', { ...quiet, checkForUpdates: true })).resolves.toMatchObject({ ready: true, path: systemPath });
    expect(mocks.download).not.toHaveBeenCalled();
    await reloadBinaries('linux');
    mocks.remoteManifest = releaseManifest(newerStableVersion(PINNED_CODEX_VERSION));
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(false);
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true, path: systemPath });
    expect(mocks.download).not.toHaveBeenCalled();
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0');
    await reloadBinaries('linux');
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true });
    expect(binaries.getReadyBinaryPath('codex')).not.toBe(systemPath);
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it.each([false, true])('only reuses a private cached runtime when it is executable (broken=%s)', async (broken) => {
    await reloadBinaries('linux');
    const runtimeRoot = path.join(mocks.userDataDir, 'agent-runtime', 'codex');
    const binaryPath = writeExecutable(path.join(runtimeRoot, 'bin', 'codex'), broken ? 'invalid output' : 'codex-cli ' + PINNED_CODEX_VERSION);
    fs.writeFileSync(path.join(runtimeRoot, '.version'), PINNED_CODEX_VERSION);
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(broken);
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true });
    expect(binaries.getReadyBinaryPath('codex') === binaryPath).toBe(!broken);
    expect(mocks.download).toHaveBeenCalledTimes(broken ? 1 : 0);
  });
});
