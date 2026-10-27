import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../manifestService';
import { createPiRuntimeRecovery } from '../pi-runtime-recovery';
import { writeStartupBinaryUpdateMarker } from '../startup-update';
import { newerStableVersion, PINNED_CLAUDE_VERSION, PINNED_CODEX_VERSION } from './runtimeVersionFixtures';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  isPackaged: true,
  cachedManifest: null as Manifest | null,
  remoteManifest: null as Manifest | null,
  fetchManifest: vi.fn(),
  download: vi.fn(),
  backgroundDownload: vi.fn(),
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
  createDownloader: () => mocks.backgroundDownload,
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
  mocks.backgroundDownload.mockReset();
  await reloadBinaries();
});
afterEach(() => {
  fs.rmSync(mocks.userDataDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
afterAll(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

describe('shared startup policy through the real binary preparation chain', () => {
  // Public index -> cache -> original installer. Windows has an .exe entrypoint;
  // Linux can start from a system CLI. Existing tests had no background/next-start
  // handoff. Tier: unit, real local archives with a fake network.
  it.each(['darwin', 'win32', 'linux'] as const)('adopts a background Codex download on the next %s startup while keeping the running path unchanged', async platform => {
    await reloadBinaries(platform);
    const version = newerStableVersion(PINNED_CODEX_VERSION);
    const source = fs.mkdtempSync(path.join(tempRoot, 'prefetch-package-'));
    const binaryName = path.join('bin', platform === 'win32' ? 'codex.exe' : 'codex');
    writeExecutable(path.join(source, binaryName), version);
    fs.writeFileSync(path.join(source, 'codex-package.json'), '{}');
    const archivePath = path.join(source, 'payload.tar.gz');
    await createTar({ file: archivePath, cwd: source, gzip: true }, ['bin', 'codex-package.json']);
    const bytes = fs.readFileSync(archivePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    mocks.remoteManifest = { app: { version: '2.0.0' }, codexPackage: {
      version, file: `codex-package/${version}/runtime.tar.gz`, sha256, size: bytes.length,
    } };
    const oldPath = platform === 'linux'
      ? writeExecutable(path.join(tempRoot, 'system-prefetch-codex'), 'codex-cli ' + PINNED_CODEX_VERSION)
      : installManaged('codex', PINNED_CODEX_VERSION);
    if (platform === 'linux') mocks.systemCommands.set('codex', oldPath);
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true, path: oldPath });
    mocks.backgroundDownload.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.writeFileSync(targetPath, bytes);
      return { path: targetPath, sha256, size: bytes.length };
    });
    await expect(binaries.prefetch('codex', { manifest: mocks.remoteManifest! })).resolves.toBe(true);
    expect(binaries.getReadyBinaryPath('codex')).toBe(oldPath);
    expect(fs.existsSync(oldPath)).toBe(true);
    await reloadBinaries(platform);
    const nextPath = path.join(mocks.userDataDir, 'codex-package', version, binaryName);
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true, path: nextPath });
    expect(fs.readFileSync(nextPath, 'utf8')).toBe(version);
    expect(fs.readFileSync(path.join(mocks.userDataDir, 'codex-package', version, 'codex-package.json'), 'utf8')).toBe('{}');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userDataDir, 'agent-binary-downloads', 'codex', sha256))).toBe(false);
  });

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

  it('consumes a legacy harness marker once and retains its repair decision for retries and other vendors', async () => {
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0', ['pi', 'codex']);
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

  // Migration regression: older app updaters write an unscoped marker. With no
  // prepared download, the next startup must keep usable runtimes, not fetch them.
  it('consumes an old application-update marker without forcing any runtime download', async () => {
    const paths = new Map((['claude-code', 'codex', 'pi'] as const).map(kind => [kind, installManaged(kind)]));
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0');
    for (const [kind, binaryPath] of paths) {
      await expect(binaries.prepare(kind, quiet)).resolves.toMatchObject({ ready: true, path: binaryPath });
    }
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userDataDir, 'agent-binary-update-once.json'))).toBe(false);
  });

  it('limits a harness-scoped marker to the confirmed harness', async () => {
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0', ['codex']);
    installManaged('claude-code');
    installManaged('codex');
    await expect(binaries.peekNeedsDownload('claude-code')).resolves.toBe(false);
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    await expect(binaries.prepare('claude-code', quiet)).resolves.toMatchObject({ ready: true });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each([false, true])('Pi background recovery inherits checkForUpdates=%s without caller flags', async (allowUpdates) => {
    if (allowUpdates) writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0', ['pi']);
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

describe('explicit Pi selection on startup', () => {
  it('keeps a restored lower version across restart and never resurrects higher leftovers', async () => {
    installManaged('pi', '3.0.0');
    const version = '1.0.0';
    const directory = `${version}-00000000-0000-0000-0000-000000000001`;
    const selected = writeExecutable(path.join(mocks.userDataDir, 'pi', directory, 'pi'), version);
    fs.writeFileSync(path.join(path.dirname(selected), '.verified'), 'verified');
    fs.writeFileSync(path.join(mocks.userDataDir, 'pi', 'selected.json'), JSON.stringify({ schema: 1, source: 'official', version, directory }));
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: true, path: selected, downloaded: false });
    await reloadBinaries();
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: true, path: selected });
    expect(binaries.getReadyBinaryPath('pi')).toBe(selected);
    expect(mocks.download).not.toHaveBeenCalled();
    mocks.remoteManifest = null;
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: false, error: 'manifest_failed' });
    expect(binaries.getReadyBinaryPath('pi')).toBeUndefined();
    mocks.remoteManifest = releaseManifest();
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: true, path: selected });
    fs.unlinkSync(selected);
    await expect(binaries.prepare('pi', quiet)).resolves.toMatchObject({ ready: false, error: 'pi_selection_invalid' });
    expect(binaries.getReadyBinaryPath('pi')).toBeUndefined();
  });
});

describe('Linux local discovery before any update download', () => {
  // Independent review of #7435: a valid private CLI can differ from the new app's
  // bundled pin. A corrupt optional cache must not route it through pin-only repair.
  it('keeps an already usable private Linux Claude when a newer prepared archive is corrupt', async () => {
    await reloadBinaries('linux');
    const current = newerStableVersion(PINNED_CLAUDE_VERSION);
    const target = newerStableVersion(current);
    const runtimeRoot = path.join(mocks.userDataDir, 'agent-runtime', 'claude-code');
    const localPath = writeExecutable(path.join(runtimeRoot, 'bin', 'claude'), `${current} (Claude Code)`);
    fs.writeFileSync(path.join(runtimeRoot, '.version'), current);
    const archive = gzipSync(Buffer.from(target));
    const sha256 = createHash('sha256').update(archive).digest('hex');
    mocks.remoteManifest = { app: { version: '2.0.0' }, claudeCode: {
      version: target, file: `claude-code/${target}/linux-x64/claude.gz`, sha256, size: archive.length,
    } };
    mocks.backgroundDownload.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.writeFileSync(targetPath, archive);
      return { path: targetPath, sha256, size: archive.length };
    });
    await expect(binaries.prefetch('claude-code', { manifest: mocks.remoteManifest })).resolves.toBe(true);
    const altered = Buffer.from(archive);
    altered[0] ^= 1;
    fs.writeFileSync(path.join(mocks.userDataDir, 'agent-binary-downloads', 'claude', sha256, 'archive'), altered);
    mocks.download.mockRejectedValue(new Error('unexpected network fallback'));
    const result = await binaries.prepare('claude-code', quiet);
    expect.soft(result).toMatchObject({ ready: true, path: localPath });
    expect.soft(mocks.download).not.toHaveBeenCalled();
    expect(fs.readFileSync(localPath, 'utf8')).toBe(`${current} (Claude Code)`);
  });

  // #7435: a completed cache must not silently downgrade a user-managed Claude.
  // Public prefetch -> prepare, one newer system CLI and one older archive. Unit.
  it('keeps a newer Linux system Claude when an older background download is complete', async () => {
    await reloadBinaries('linux');
    const target = newerStableVersion(PINNED_CLAUDE_VERSION);
    const current = newerStableVersion(target);
    const oldArchive = gzipSync(Buffer.from(target));
    const sha256 = createHash('sha256').update(oldArchive).digest('hex');
    mocks.remoteManifest = { app: { version: '2.0.0' }, claudeCode: {
      version: target, file: `claude-code/${target}/linux-x64/claude.gz`, sha256, size: oldArchive.length,
    } };
    const systemPath = writeExecutable(path.join(tempRoot, 'newer-system-claude'), `${current} (Claude Code)`);
    mocks.systemCommands.set('claude', systemPath);
    mocks.backgroundDownload.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.writeFileSync(targetPath, oldArchive);
      return { path: targetPath, sha256, size: oldArchive.length };
    });
    await expect(binaries.prefetch('claude-code', { manifest: mocks.remoteManifest })).resolves.toBe(true);
    await expect(binaries.prepare('claude-code', quiet)).resolves.toMatchObject({ ready: true, path: systemPath });
    expect(binaries.getReadyBinaryPath('claude-code')).toBe(systemPath);
    expect(fs.readFileSync(systemPath, 'utf8')).toBe(`${current} (Claude Code)`);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userDataDir, 'claude-code', target, '.verified'))).toBe(false);
  });

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
    await expect(binaries.prepare('codex', quiet)).resolves.toMatchObject({ ready: true, path: systemPath });
    expect(mocks.download).not.toHaveBeenCalled();
    writeStartupBinaryUpdateMarker(mocks.userDataDir, '2.0.0', ['codex']);
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
