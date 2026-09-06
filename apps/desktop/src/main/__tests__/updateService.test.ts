import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_CDN_BASE_URL as CDN_EXTERNAL_BASE_URL } from '../../test/vitest/clientEndpointsFixture';

const originalPlatform = process.platform;
const originalArch = process.arch;
let TEST_ROOT: string;
let TEST_USER_DATA: string;
let TEST_EXE: string;

const browserWindowGetAllWindows = vi.fn(() => []);
const ipcMainHandle = vi.fn();
const ipcMainOn = vi.fn();
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();
const powerMonitorGetSystemIdleState = vi.fn(() => 'idle');
const powerMonitorGetSystemIdleTime = vi.fn(() => 600);
const powerMonitorOn = vi.fn();
const powerMonitorRemoveListener = vi.fn();
const appGetVersion = vi.fn(() => '0.0.64');
const appRelaunch = vi.fn();
const appQuit = vi.fn();
const appGetAppPath = vi.fn(() => path.join(TEST_ROOT, 'Cindy.app', 'Contents', 'Resources', 'app.asar'));
const appIsInApplicationsFolder = vi.fn(() => true);
const appGetPath = vi.fn((name: string) => {
  if (name === 'userData') return TEST_USER_DATA;
  if (name === 'exe') return TEST_EXE;
  return TEST_ROOT;
});
const fetchManifest = vi.fn();
const getBaseUrl = vi.fn(() => CDN_EXTERNAL_BASE_URL);
const isDev = vi.fn(() => false);
const download = vi.fn();
const readAutoUpdateSettings = vi.fn(() => ({ autoRelaunchOnIdle: true }));
const spawnProcess = vi.fn(() => ({
  unref: vi.fn(),
  on: vi.fn(),
}));
const checkWindowsUpdaterPrerequisites = vi.fn<
  () => { satisfied: boolean; missingFiles: string[] }
>(() => ({
  satisfied: true,
  missingFiles: [],
}));
const stageBundledWindowsUpdaterRuntime = vi.fn<
  () => 'staged' | 'fallback-safe' | 'blocked'
>(() => 'staged');

const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
const logDebug = vi.fn();

vi.mock('electron', () => ({
  app: {
    getVersion: appGetVersion,
    getPath: appGetPath,
    relaunch: appRelaunch,
    quit: appQuit,
    getAppPath: appGetAppPath,
    isPackaged: true,
    isInApplicationsFolder: appIsInApplicationsFolder,
    moveToApplicationsFolder: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: browserWindowGetAllWindows,
  },
  ipcMain: {
    handle: ipcMainHandle,
    on: ipcMainOn,
  },
  powerMonitor: {
    getSystemIdleState: powerMonitorGetSystemIdleState,
    getSystemIdleTime: powerMonitorGetSystemIdleTime,
    on: powerMonitorOn,
    removeListener: powerMonitorRemoveListener,
  },
}));

vi.mock('../auto-update-settings-store', () => ({
  readAutoUpdateSettings,
  readAutoUpdateSettingsState: () => ({
    value: readAutoUpdateSettings(),
    isCustomized: true,
    defaults: { autoRelaunchOnIdle: false },
  }),
  resetAutoUpdateSettings: () => ({ autoRelaunchOnIdle: false }),
  writeAutoRelaunchOnIdle: vi.fn(),
}));

const tryEnableUncustomizedBetaAtomic = vi.fn(async () => true);
const writeEnableBeta = vi.fn(async () => undefined);
const readUpdateChannelSettings = vi.fn(() => ({
  enableBeta: false,
  orgDefaultEnableBeta: false,
}));

vi.mock('../manifestService', () => ({
  fetchManifest,
  getBaseUrl,
  isDev,
  clearCachedManifest: vi.fn(),
}));

vi.mock('../updateChannelStore', () => ({
  readUpdateChannelSettings,
  readUpdateChannelSettingsState: () => ({
    value: readUpdateChannelSettings(),
    isCustomized: false,
    customizedKeys: [],
    defaults: { enableBeta: false, orgDefaultEnableBeta: false },
  }),
  resetUpdateChannelSettings: () => ({ enableBeta: false, orgDefaultEnableBeta: false }),
  writeEnableBeta,
  tryEnableUncustomizedBetaAtomic,
  isEnableBetaUserCustomized: () => false,
  isBetaChannelEnabled: () => readUpdateChannelSettings().enableBeta === true,
}));

vi.mock('../downloader/index', () => ({
  download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

// cindy-brain/index 的真身会拖进 authManager→node-machine-id 等平台相关
// 模块图;本套测试会伪造 process.platform,真加载会在非 Windows 上炸
// spawnSync cmd.exe。updateService 只用 destroyAll,按需给最小假身。
vi.mock('../cindy-brain/index', () => ({
  getGhostNodeRuntimeBroker: () => ({ destroyAll: vi.fn() }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnProcess,
  };
});

vi.mock('../windowsUpdaterPrerequisites', () => ({
  WINDOWS_UPDATER_RUNTIME_MISSING_ERROR_CODE: 'windows_vc_runtime_missing',
  WINDOWS_UPDATER_RUNTIME_FILES: ['vcruntime140.dll', 'vcruntime140_1.dll'],
  checkWindowsUpdaterPrerequisites,
  stageBundledWindowsUpdaterRuntime,
}));

vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: logInfo,
    warn: logWarn,
    error: logError,
    debug: logDebug,
  }),
  maskPath: (value: string) => value,
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setArch(value: string): void {
  Object.defineProperty(process, 'arch', { value, configurable: true });
}

async function freshUpdateService(platform: NodeJS.Platform, arch: string = originalArch) {
  vi.resetModules();
  setPlatform(platform);
  setArch(arch);
  return import('../updateService');
}

beforeAll(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-maker-update-service-test-'));
  TEST_USER_DATA = path.join(TEST_ROOT, 'user-data');
  TEST_EXE = path.join(TEST_ROOT, 'app', 'xdt-maker.exe');
});
afterAll(() => {
  if (!TEST_ROOT) return;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
beforeEach(() => {
  browserWindowGetAllWindows.mockReset();
  browserWindowGetAllWindows.mockReturnValue([]);
  ipcHandlers.clear();
  ipcListeners.clear();
  ipcMainHandle.mockReset();
  ipcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcHandlers.set(channel, handler);
  });
  ipcMainOn.mockReset();
  ipcMainOn.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcListeners.set(channel, handler);
  });
  powerMonitorGetSystemIdleState.mockReset();
  powerMonitorGetSystemIdleState.mockReturnValue('idle');
  powerMonitorGetSystemIdleTime.mockReset();
  powerMonitorGetSystemIdleTime.mockReturnValue(600);
  powerMonitorOn.mockReset();
  powerMonitorRemoveListener.mockReset();
  appGetVersion.mockReset();
  appGetVersion.mockReturnValue('0.0.64');
  appRelaunch.mockReset();
  appQuit.mockReset();
  appIsInApplicationsFolder.mockReset();
  appIsInApplicationsFolder.mockReturnValue(true);
  appGetPath.mockReset();
  appGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return TEST_USER_DATA;
    if (name === 'exe') return TEST_EXE;
    return TEST_ROOT;
  });
  fetchManifest.mockReset();
  getBaseUrl.mockReset();
  getBaseUrl.mockReturnValue(CDN_EXTERNAL_BASE_URL);
  isDev.mockReset();
  isDev.mockReturnValue(false);
  download.mockReset();
  tryEnableUncustomizedBetaAtomic.mockReset();
  tryEnableUncustomizedBetaAtomic.mockResolvedValue(true);
  writeEnableBeta.mockReset();
  writeEnableBeta.mockResolvedValue(undefined);
  readUpdateChannelSettings.mockReset();
  readUpdateChannelSettings.mockReturnValue({
    enableBeta: false,
    orgDefaultEnableBeta: false,
  });
  readAutoUpdateSettings.mockReset();
  readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
  spawnProcess.mockClear();
  checkWindowsUpdaterPrerequisites.mockReset();
  checkWindowsUpdaterPrerequisites.mockReturnValue({
    satisfied: true,
    missingFiles: [],
  });
  stageBundledWindowsUpdaterRuntime.mockReset();
  stageBundledWindowsUpdaterRuntime.mockReturnValue('staged');
  logInfo.mockReset();
  logWarn.mockReset();
  logError.mockReset();
  logDebug.mockReset();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  setPlatform(originalPlatform);
  setArch(originalArch);
});

describe('binary version checks after a user-requested update', () => {
  beforeEach(() => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
  });

  it('writes the target-version marker only when the user actually applies the update', async () => {
    const service = await freshUpdateService('darwin');
    const { consumeStartupBinaryUpdateMarker } = await import('../agent-binaries/startup-update');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest())).resolves.toBe('ready');
      const markerPath = path.join(TEST_USER_DATA, 'agent-binary-update-once.json');
      expect(fs.existsSync(markerPath)).toBe(false);
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ version: '0.0.65' });
      expect(consumeStartupBinaryUpdateMarker(TEST_USER_DATA, '0.0.65')).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(consumeStartupBinaryUpdateMarker(TEST_USER_DATA, '0.0.65')).toBe(false);
    } finally {
      service.stopUpdateService();
      exitSpy.mockRestore();
    }
  });

  it('does not write the marker for an automatic update relaunch', async () => {
    const service = await freshUpdateService('darwin');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      await expect(ipcHandlers.get('update-relaunch-auto')?.({}, 'dark')).resolves.toMatchObject({ accepted: true });
      await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
      exitSpy.mockRestore();
    }
  });

  it('does not write the marker when Windows updater prerequisites block applying', async () => {
    const service = await freshUpdateService('win32');
    checkWindowsUpdaterPrerequisites.mockReturnValue({ satisfied: false, missingFiles: ['vcruntime140.dll'] });
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('clears the marker when the Windows updater reports an asynchronous spawn error', async () => {
    const service = await freshUpdateService('win32');
    const resourcesPath = path.join(TEST_ROOT, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, 'cindy-updater.exe'), 'updater');
    const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });
    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(TEST_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const childListeners = new Map<string, (...args: unknown[]) => void>();
    spawnProcess.mockImplementationOnce(() => ({
      unref: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { childListeners.set(event, listener); }),
    }));
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(childListeners.has('error')).toBe(true); });
      const markerPath = path.join(TEST_USER_DATA, 'agent-binary-update-once.json');
      expect(fs.existsSync(markerPath)).toBe(true);
      childListeners.get('error')?.(Object.assign(new Error('spawn denied'), { code: 'EACCES' }));
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(service.getUpdateStatus()).toBe('error');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
      tmpdirSpy.mockRestore();
      exitSpy.mockRestore();
      if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('removes the marker when spawning the updater fails', async () => {
    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      await service.checkForUpdate(updateManifest());
      spawnProcess.mockImplementationOnce(() => {
        expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(true);
        throw new Error('updater spawn failed');
      });
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => { expect(service.getUpdateStatus()).toBe('error'); });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'agent-binary-update-once.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });
});

function updateManifest(version = '0.0.65', hotfixFile?: string) {
  return {
    app: {
      version,
      hotfix: {
        file: hotfixFile ?? `app/darwin-arm64/xdt-maker-${version}.zip`,
        sha256: 'abc',
        size: 123,
      },
    },
    claudeCode: {
      version: '1.0.0',
      file: 'claude-code/1.0.0/darwin-arm64/claude.gz',
      sha256: 'def',
      size: 456,
    },
  };
}

async function runStartupUpdate(
  options: {
    idleState?: 'active' | 'idle' | 'locked' | 'unknown';
    enabled?: boolean;
    busy?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  vi.useFakeTimers();
  powerMonitorGetSystemIdleState.mockReturnValue(options.idleState ?? 'idle');
  readAutoUpdateSettings.mockReturnValue({
    autoRelaunchOnIdle: options.enabled ?? true,
  });
  fetchManifest.mockResolvedValue(
    options.platform === 'linux' ? linuxInstallerManifest() : updateManifest(),
  );
  download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
    fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
    fs.writeFileSync(targetPath, 'update');
    return { path: targetPath, size: 123 };
  });

  const service = await freshUpdateService(options.platform ?? 'darwin');
  if (options.busy) service.setUpdateAutoRelaunchBusyProbe(() => true);
  service.initUpdateService();
  const handler = ipcHandlers.get('update-check-startup');
  if (!handler) throw new Error('update-check-startup handler not registered');
  try {
    return await handler();
  } finally {
    service.stopUpdateService();
  }
}

function linuxInstallerManifest(version = '0.0.65') {
  return {
    app: {
      version,
      installer: {
        file: `app/linux-x64/cindy-${version}-amd64.deb`,
        sha256: 'abc',
        size: 123,
      },
    },
  };
}

describe('checkForUpdate Linux installer flow', () => {
  it('downloads the Linux installer .deb instead of a hotfix zip', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'deb');
      return { path: targetPath, size: 123 };
    });
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux', 'x64');

    const result = await checkForUpdate(linuxInstallerManifest('9.9.9'));

    expect(result).toBe('ready');
    expect(getUpdateStatus()).toBe('ready');
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toMatchObject({
      url: expect.stringContaining('cindy-9.9.9-amd64.deb'),
      sha256: 'abc',
    });
  });

  it('ignores a Linux hotfix zip and stays idle without an installer', async () => {
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux', 'x64');

    const result = await checkForUpdate({
      app: {
        version: '9.9.9',
        hotfix: {
          file: 'app/linux-x64/app.hotfix.zip',
          sha256: 'abc',
          size: 123,
        },
      },
    });

    expect(result).toBe('idle');
    expect(getUpdateStatus()).toBe('idle');
    expect(download).not.toHaveBeenCalled();
  });

  it('does not auto-apply a staged Linux .deb at startup', async () => {
    await expect(runStartupUpdate({ platform: 'linux' })).resolves.toMatchObject({
      hasUpdate: true,
      action: 'none',
      version: '0.0.65',
    });
  });

  it('allows the xd org beta default on Linux x64', async () => {
    tryEnableUncustomizedBetaAtomic.mockReset();
    tryEnableUncustomizedBetaAtomic.mockResolvedValue(true);
    const { enableUncustomizedBetaChannel } = await freshUpdateService('linux', 'x64');

    await expect(enableUncustomizedBetaChannel()).resolves.toBe(true);
    expect(tryEnableUncustomizedBetaAtomic).toHaveBeenCalledOnce();
  });

  it('refuses the xd org beta default on Linux arm64 without writing to disk', async () => {
    tryEnableUncustomizedBetaAtomic.mockReset();
    const { enableUncustomizedBetaChannel } = await freshUpdateService('linux', 'arm64');

    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
    expect(tryEnableUncustomizedBetaAtomic).not.toHaveBeenCalled();
  });

  it('allows the beta channel setting to be written on Linux x64', async () => {
    const service = await freshUpdateService('linux', 'x64');
    service.initUpdateService();
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');

      await expect(
        setHandler?.({ sender: { id: 1 } }, { enableBeta: true }),
      ).resolves.toBeDefined();
      expect(writeEnableBeta).toHaveBeenCalledWith(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('rejects beta channel setting writes on Linux arm64', async () => {
    const service = await freshUpdateService('linux', 'arm64');
    service.initUpdateService();
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');

      await expect(
        setHandler?.({ sender: { id: 1 } }, { enableBeta: true }),
      ).rejects.toThrow('This build does not support the beta update channel');
      expect(writeEnableBeta).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
    }
  });

  it.each([
    { arch: 'x64', expected: true },
    { arch: 'arm64', expected: false },
  ])('reports a persisted beta setting correctly on Linux $arch', async ({ arch, expected }) => {
    readUpdateChannelSettings.mockReturnValue({
      enableBeta: true,
      orgDefaultEnableBeta: false,
    });
    const service = await freshUpdateService('linux', arch);
    service.initUpdateService();
    try {
      const getHandler = ipcHandlers.get('update-channel-settings-get');
      expect(getHandler).toBeTypeOf('function');

      expect(getHandler?.({ sender: { id: 1 } })).toMatchObject({ enableBeta: expected });
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('checkForUpdate 版本无关(占位 0.0.0)打包豁免', () => {
  it('占位版本 0.0.0 时直接 idle,不拉 manifest 不下载(即便传入含热更的 manifest)', async () => {
    appGetVersion.mockReturnValue('0.0.0');
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('darwin');

    const result = await checkForUpdate(updateManifest('9.9.9'));

    expect(result).toBe('idle');
    expect(getUpdateStatus()).toBe('idle');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('update-check-startup 同样豁免:即便本地残留已下好的 patch 也不触发 relaunch', async () => {
    // 版本无关包与正式版同 userData,updates/ 里可能残留正式版下好的 patch;
    // startup 快路径(manifest 拉不到 → 本地 patch 直接 relaunch)必须一并短路。
    appGetVersion.mockReturnValue('0.0.0');
    fetchManifest.mockResolvedValue(null);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'stale.zip'), 'zip');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({ version: '9.9.9', fileName: 'stale.zip', sha256: 'abc' }),
    );

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      if (!handler) throw new Error('update-check-startup handler not registered');
      const reply = (await handler()) as { hasUpdate: boolean; action: string };
      expect(reply.hasUpdate).toBe(false);
      expect(reply.action).toBe('none');
      expect(service.getUpdateStatus()).toBe('idle');
      expect(download).not.toHaveBeenCalled();
    } finally {
      service.stopUpdateService();
      fs.rmSync(updatesDir, { recursive: true, force: true });
    }
  });

  it('0.0.0-dev 形态同样豁免;真实版本不受影响', async () => {
    appGetVersion.mockReturnValue('0.0.0-dev');
    const service = await freshUpdateService('win32');
    expect(await service.checkForUpdate(updateManifest('9.9.9'))).toBe('idle');
    expect(download).not.toHaveBeenCalled();

    expect(service.isVersionlessAppVersion('0.0.0')).toBe(true);
    expect(service.isVersionlessAppVersion('0.0.0-dev')).toBe(true);
    expect(service.isVersionlessAppVersion('0.0.1')).toBe(false);
    expect(service.isVersionlessAppVersion('1.0.0')).toBe(false);
  });
});

describe('app update forward-only policy', () => {
  it('does not download a manifest version lower than the running app', async () => {
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');

    expect(service.getUpdateStatus()).toBe('idle');
    expect(download).not.toHaveBeenCalled();
    expect(logWarn.mock.calls.map((call) => String(call[0]))).toContain(
      'Skipping app downgrade from %s to %s',
    );
  });

  it('fails closed when the manifest app version is not valid SemVer', async () => {
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('not-semver'))).resolves.toBe(
      'manifest_failed',
    );

    expect(service.getUpdateStatus()).toBe('idle');
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['0.0.63', 'not-semver'])(
    'does not apply an offline non-upgrade staged patch (%s)',
    async (patchVersion) => {
      vi.useFakeTimers();
      fetchManifest.mockResolvedValue(null);
      const updatesDir = path.join(TEST_USER_DATA, 'updates');
      const patchPath = path.join(updatesDir, 'staged.zip');
      const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
      fs.mkdirSync(updatesDir, { recursive: true });
      fs.writeFileSync(patchPath, 'update');
      fs.writeFileSync(
        path.join(updatesDir, 'patch-info.json'),
        JSON.stringify({
          version: patchVersion,
          fileName: 'staged.zip',
          sha256: 'abc',
          requireRelogin: true,
          enableBeta: false,
        }),
      );
      fs.writeFileSync(flagPath, JSON.stringify({ version: patchVersion }));

      const service = await freshUpdateService('darwin');
      service.initUpdateService();
      try {
        const handler = ipcHandlers.get('update-check-startup');
        await expect(handler?.()).resolves.toMatchObject({
          hasUpdate: false,
          action: 'none',
          error: 'manifest_failed',
        });
        expect(service.getUpdateStatus()).toBe('idle');
        expect(fs.existsSync(patchPath)).toBe(false);
        expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
        expect(fs.existsSync(flagPath)).toBe(false);
      } finally {
        service.stopUpdateService();
      }
    },
  );

  it('still restores a newer staged patch when startup is offline', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(null);
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: true,
        action: 'relaunch',
        version: '0.0.65',
      });
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(patchPath)).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not apply a lower local patch that matches the online manifest', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest('0.0.63'));
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.63',
        fileName: 'staged.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(download).not.toHaveBeenCalled();
      expect(fs.existsSync(patchPath)).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('discards a newer local patch that is no longer advertised by the online manifest', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest('0.0.64'));
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    const patchPath = path.join(updatesDir, 'staged.zip');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(patchPath, 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'staged.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
      });
      expect(service.getUpdateStatus()).toBe('idle');
      expect(fs.existsSync(patchPath)).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('drops a ready patch when a later manifest no longer advertises an upgrade', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
    const service = await freshUpdateService('darwin');

    await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
    await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');

    expect(service.getUpdateStatus()).toBe('idle');
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
  });

  it('rechecks the version immediately before launching the native updater', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');

      appGetVersion.mockReturnValue('0.0.65');
      ipcListeners.get('update-relaunch')?.({}, 'dark');

      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
      expect(logError.mock.calls.map((call) => String(call[0]))).toContain(
        'executeRelaunch() refused non-upgrade patch: current=%s patch=%s relation=%s',
      );
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not discard a staged patch while the native updater is already applying it', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');

      ipcListeners.get('update-relaunch')?.({}, 'dark');
      await vi.waitFor(() => {
        expect(logInfo.mock.calls.map((call) => String(call[0]))).toContain(
          'executeRelaunch() called, theme=%s, readyFilePath=%s',
        );
      });

      await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');
      const stagedFile = path.basename(updateManifest('0.0.65').app.hotfix.file);
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', stagedFile))).toBe(true);
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it('defers manifest-driven discard while auto-relaunch eligibility is pending', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    let releaseProbe: ((busy: boolean) => void) | undefined;
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      const stagedFile = path.join(
        TEST_USER_DATA,
        'updates',
        path.basename(updateManifest('0.0.65').app.hotfix.file),
      );
      expect(fs.existsSync(stagedFile)).toBe(true);

      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
      const probeStarted = new Promise<void>((resolveStarted) => {
        service.setUpdateAutoRelaunchBusyProbe(
          () =>
            new Promise<boolean>((resolveProbe) => {
              resolveStarted();
              releaseProbe = resolveProbe;
            }),
        );
      });
      await probeStarted;

      await expect(service.checkForUpdate(updateManifest('0.0.63'))).resolves.toBe('idle');
      // The manifest says the staged version is no longer eligible, but the
      // pending busy probe still owns the apply decision. Keep the zip intact
      // until that decision settles; only the marker is removed immediately.
      expect(fs.existsSync(stagedFile)).toBe(true);
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);

      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(stagedFile)).toBe(false);
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });
});

describe('startup update relaunch safety', () => {
  // Startup/splash auto-applies a staged patch as soon as it is ready — the
  // historic behavior restored deliberately (owner-approved). A fresh launch has
  // no in-flight agent turn / schedule to protect, so the startup gate skips the
  // idle/busy/user-active checks that guard the *background* auto-relaunch and
  // keeps only the essentials (disabled / dev / not-ready / relaunching).
  it('auto-applies a staged startup update as soon as it is ready', async () => {
    await expect(runStartupUpdate()).resolves.toMatchObject({
      hasUpdate: true,
      action: 'relaunch',
      version: '0.0.65',
    });
  });

  it.each(['idle', 'active', 'unknown', 'locked'] as const)(
    'auto-applies at startup regardless of system idle state (%s)',
    async (idleState) => {
      await expect(runStartupUpdate({ idleState })).resolves.toMatchObject({
        hasUpdate: true,
        action: 'relaunch',
        version: '0.0.65',
      });
    },
  );

  it('auto-applies at startup even when agent tasks are busy', async () => {
    await expect(runStartupUpdate({ busy: true })).resolves.toMatchObject({
      action: 'relaunch',
    });
  });

  it('auto-applies startup updates even when idle auto-install is disabled', async () => {
    await expect(runStartupUpdate({ enabled: false })).resolves.toMatchObject({
      hasUpdate: true,
      action: 'relaunch',
      version: '0.0.65',
    });
  });

  it('never runs the startup update flow (nor the native updater) on a dev build', async () => {
    // The handler bails before any update work in dev (updater can't replace a
    // forge/dev instance); the startup gate's `dev` branch is defense-in-depth.
    isDev.mockReturnValue(true);
    await expect(runStartupUpdate()).resolves.toMatchObject({ hasUpdate: false, action: 'none' });
  });

  it('keeps startup and manual relaunch IPC paths separate', async () => {
    vi.useFakeTimers();
    fetchManifest.mockResolvedValue(updateManifest());
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      const autoApplyHandler = ipcHandlers.get('update-relaunch-auto');
      expect(startupHandler).toBeTypeOf('function');
      expect(autoApplyHandler).toBeTypeOf('function');
      // Manual "立即重启" path stays a separate, unguarded listener.
      expect(ipcListeners.get('update-relaunch')).toBeTypeOf('function');

      await expect(startupHandler?.()).resolves.toMatchObject({ action: 'relaunch' });

      // Startup/Splash relaunch is independent from the background idle setting.
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      expect(service.getUpdateStatus()).toBe('ready');
    } finally {
      service.stopUpdateService();
    }
  });

  /** Boots the startup flow (staging a patch) and hands back the live module. */
  async function bootWithStagedPatch(options: {
    enabled?: boolean;
    manifest?: ReturnType<typeof updateManifest>;
  } = {}) {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: options.enabled ?? true });
    fetchManifest.mockResolvedValue(options.manifest ?? updateManifest());
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    const handler = ipcHandlers.get('update-check-startup');
    if (!handler) throw new Error('update-check-startup handler not registered');
    await handler();
    return service;
  }

  it('is false with nothing staged', async () => {
    const service = await freshUpdateService('darwin');
    try {
      expect(service.getUpdateStatus()).toBe('idle');
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  // Regression: a staged patch used to read as "about to relaunch" purely from
  // status==='ready'. With auto-relaunch off the patch sits there indefinitely,
  // so every cold boot re-observed 'ready' and callers (startImConnection) kept
  // deferring to a "next cold boot" that behaved identically — the FeishuBot
  // never came online and feishuBot:save failed with [IM_NOT_READY] forever.
  it('is false for a patch staged while auto-relaunch is off', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('is true for a patch staged while auto-relaunch is on', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      expect(service.isUpdateRelaunchImminent()).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('re-reads the auto-relaunch switch on every call', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.isUpdateRelaunchImminent()).toBe(true);
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      expect(service.isUpdateRelaunchImminent()).toBe(false);
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
      expect(service.isUpdateRelaunchImminent()).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('is false on a dev build even with a staged patch', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      isDev.mockReturnValue(true);
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not clear the staged patch while busyProbe is still pending', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      expect(service.getUpdateStatus()).toBe('ready');
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('clears a matching relogin flag when the staged patch is discarded', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
    fs.writeFileSync(flagPath, JSON.stringify({ version: '0.0.65' }));
    try {
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('clears the deferred staged patch after a busy eligibility check settles', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
    } finally {
      service.stopUpdateService();
    }
  });

  it('aborts auto-relaunch when the channel changes during eligibility', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps a same-path newer patch after deferred channel-change clear', async () => {
    const sharedHotfix = 'app/darwin-arm64/xdt-maker-hotfix.zip';
    const service = await bootWithStagedPatch({
      enabled: true,
      manifest: updateManifest('0.0.65', sharedHotfix),
    });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      // 后续 ready 不要再挂住另一条 probe,否则延迟清理永远不会 flush。
      service.setUpdateAutoRelaunchBusyProbe(() => true);

      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66', sharedHotfix));
      await expect(service.checkForUpdate()).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');

      const destPath = path.join(TEST_USER_DATA, 'updates', path.basename(sharedHotfix));
      expect(fs.existsSync(destPath)).toBe(true);

      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(
          logInfo.mock.calls.some((call) =>
            String(call[0]).includes('keeping newer staged patch after deferred channel-change clear'),
          ),
        ).toBe(true);
      });
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'), 'utf-8')).toContain('0.0.66');
    } finally {
      service.stopUpdateService();
    }
  });

  it('drops patch-info immediately so a channel relaunch cannot revive the old zip', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);

      const relaunch = ipcHandlers.get('update-channel-relaunch');
      expect(relaunch).toBeTypeOf('function');
      relaunch?.({ sender: { id: 1 } });
      expect(appRelaunch).toHaveBeenCalled();
      expect(appQuit).toHaveBeenCalled();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('does not bump the channel epoch again when flushing during a same-path download', async () => {
    const sharedHotfix = 'app/darwin-arm64/xdt-maker-hotfix.zip';
    const service = await bootWithStagedPatch({
      enabled: true,
      manifest: updateManifest('0.0.65', sharedHotfix),
    });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let finishDownload: (() => void) | undefined;
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      await new Promise<void>((resolve) => {
        finishDownload = resolve;
      });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'newer-update');
      return { path: targetPath, size: 123 };
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      service.setUpdateAutoRelaunchBusyProbe(() => true);
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66', sharedHotfix));
      const checkPromise = service.checkForUpdate();
      await vi.waitFor(() => {
        expect(finishDownload).toBeTypeOf('function');
      });
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('superseding');
      });
      finishDownload?.();
      await expect(checkPromise).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      expect(
        fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'), 'utf-8'),
      ).toContain('0.0.66');
    } finally {
      service.stopUpdateService();
    }
  });

  it('invalidates an in-flight check when another instance changes the shared channel', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    try {
      expect(service.getUpdateStatus()).toBe('ready');
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      await expect(service.checkForUpdate()).resolves.toBe('idle');
      expect(service.getUpdateStatus()).toBe('idle');
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not restore a superseded patch after a channel change', async () => {
    const { DownloadError } = await import('../downloader/index');
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let failDownload: ((error: Error) => void) | undefined;
    download.mockImplementation(() => new Promise((_, reject) => {
      failDownload = reject;
    }));
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      service.setUpdateAutoRelaunchBusyProbe(() => true);
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66'));
      const checkPromise = service.checkForUpdate();
      await vi.waitFor(() => {
        expect(failDownload).toBeTypeOf('function');
      });
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('superseding');
      });
      failDownload?.(new DownloadError('NETWORK', 'boom'));
      await expect(checkPromise).resolves.toBe('idle');
      expect(service.getUpdateStatus()).toBe('idle');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('aborts a manual relaunch when a channel change is still deferred', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      await setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      expect(service.getUpdateStatus()).toBe('ready');
      const relaunch = ipcListeners.get('update-relaunch');
      expect(relaunch).toBeTypeOf('function');
      logInfo.mockClear();
      relaunch?.({}, 'dark');
      expect(logInfo.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('executeRelaunch() aborted'),
        ]),
      );
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('invalidates the staged patch before the settings write settles', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    let releaseWrite: (() => void) | undefined;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => resolve(undefined);
        }),
    );
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      const writePromise = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(releaseWrite).toBeTypeOf('function');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseWrite?.();
      await writePromise;
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps the staged patch when an org-default write is rejected', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    tryEnableUncustomizedBetaAtomic.mockResolvedValue(false);
    try {
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(false);
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps a settings-page hold when a concurrent org-default write throws', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let releaseWrite: (() => void) | undefined;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => resolve(undefined);
        }),
    );
    tryEnableUncustomizedBetaAtomic.mockRejectedValue(new Error('lock timeout'));
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      const writePromise = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(releaseWrite).toBeTypeOf('function');
      });
      await expect(service.enableUncustomizedBetaChannel()).rejects.toThrow('lock timeout');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      logInfo.mockClear();
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      expect(logInfo.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('executeRelaunch() aborted'),
        ]),
      );
      expect(service.getUpdateStatus()).toBe('ready');
      releaseWrite?.();
      await writePromise;
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('applies a newer same-path patch after a deferred channel change', async () => {
    const sharedHotfix = 'app/darwin-arm64/xdt-maker-hotfix.zip';
    const service = await bootWithStagedPatch({
      enabled: true,
      manifest: updateManifest('0.0.65', sharedHotfix),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(true);
      service.setUpdateAutoRelaunchBusyProbe(() => true);
      readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      fetchManifest.mockResolvedValue(updateManifest('0.0.66', sharedHotfix));
      await expect(service.checkForUpdate()).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      logInfo.mockClear();
      ipcListeners.get('update-relaunch')?.({}, 'dark');
      expect(logInfo.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(
        'executeRelaunch() aborted',
      );
      expect(logInfo.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'executeRelaunch() called',
      );
      expect(
        fs.readFileSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'), 'utf-8'),
      ).toContain('0.0.66');
    } finally {
      exitSpy.mockRestore();
      releaseProbe?.(true);
      service.stopUpdateService();
    }
  });

  it('does not treat a failed settings write as a committed channel change', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    let rejectWrite: ((error: Error) => void) | undefined;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      const writePromise = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(rejectWrite).toBeTypeOf('function');
      });
      rejectWrite?.(new Error('lock timeout'));
      await expect(writePromise).rejects.toThrow();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not treat a failed settings write as an external channel change', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    writeEnableBeta.mockRejectedValueOnce(new Error('lock timeout'));
    try {
      await probeStarted;
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      await expect(setHandler?.({ sender: { id: 1 } }, { enableBeta: true })).rejects.toThrow();
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not let a failed settings write overwrite a committed observed channel', async () => {
    const service = await bootWithStagedPatch({ enabled: false });
    let releaseFirstWrite: (() => void) | undefined;
    let rejectSecondWrite: ((error: Error) => void) | undefined;
    let writeCalls = 0;
    writeEnableBeta.mockImplementation(
      () =>
        new Promise<undefined>((resolve, reject) => {
          writeCalls += 1;
          if (writeCalls === 1) {
            releaseFirstWrite = () => resolve(undefined);
            return;
          }
          rejectSecondWrite = reject;
        }),
    );
    try {
      const setHandler = ipcHandlers.get('update-channel-settings-set');
      expect(setHandler).toBeTypeOf('function');
      const firstWrite = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      const secondWrite = setHandler?.({ sender: { id: 1 } }, { enableBeta: true });
      await vi.waitFor(() => {
        expect(releaseFirstWrite).toBeTypeOf('function');
        expect(rejectSecondWrite).toBeTypeOf('function');
      });
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      releaseFirstWrite?.();
      await firstWrite;
      rejectSecondWrite?.(new Error('lock timeout'));
      await expect(secondWrite).rejects.toThrow();
      await expect(service.checkForUpdate()).resolves.toBe('ready');
      expect(service.getUpdateStatus()).toBe('ready');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('invalidates the staged patch when another instance already enabled beta', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    tryEnableUncustomizedBetaAtomic.mockImplementation(async () => {
      readUpdateChannelSettings.mockReturnValue({
        enableBeta: true,
        orgDefaultEnableBeta: true,
      });
      return false;
    });
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).resolves.toBe(false);
      expect(service.getUpdateStatus()).toBe('ready');
      releaseProbe?.(false);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('idle');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('releases a pending hold when the org-default write throws', async () => {
    const service = await bootWithStagedPatch({ enabled: true });
    let releaseProbe: ((busy: boolean) => void) | undefined;
    const probeStarted = new Promise<void>((resolveStarted) => {
      service.setUpdateAutoRelaunchBusyProbe(
        () =>
          new Promise<boolean>((resolveProbe) => {
            resolveStarted();
            releaseProbe = resolveProbe;
          }),
      );
    });
    tryEnableUncustomizedBetaAtomic.mockRejectedValue(new Error('lock timeout'));
    try {
      await probeStarted;
      await expect(service.enableUncustomizedBetaChannel()).rejects.toThrow('lock timeout');
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
      releaseProbe?.(true);
      await vi.waitFor(() => {
        expect(service.getUpdateStatus()).toBe('ready');
      });
      expect(fs.existsSync(path.join(TEST_USER_DATA, 'updates', 'patch-info.json'))).toBe(true);
    } finally {
      service.stopUpdateService();
    }
  });

  it('does not apply a leftover patch after an offline channel change', async () => {
    const updatesDir = path.join(TEST_USER_DATA, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'xdt-maker-0.0.65.zip'), 'update');
    fs.writeFileSync(
      path.join(updatesDir, 'patch-info.json'),
      JSON.stringify({
        version: '0.0.65',
        fileName: 'xdt-maker-0.0.65.zip',
        sha256: 'abc',
        enableBeta: false,
      }),
    );
    const flagPath = path.join(TEST_USER_DATA, 'relogin-required.flag');
    fs.writeFileSync(flagPath, JSON.stringify({ version: '0.0.65' }));
    readUpdateChannelSettings.mockReturnValue({
      enableBeta: true,
      orgDefaultEnableBeta: true,
    });
    fetchManifest.mockResolvedValue(null);
    const service = await freshUpdateService('darwin');
    service.initUpdateService();
    try {
      const handler = ipcHandlers.get('update-check-startup');
      expect(handler).toBeTypeOf('function');
      await expect(handler?.()).resolves.toMatchObject({
        hasUpdate: false,
        action: 'none',
        error: 'manifest_failed',
      });
      expect(service.getUpdateStatus()).toBe('idle');
      expect(fs.existsSync(path.join(updatesDir, 'patch-info.json'))).toBe(false);
      expect(fs.existsSync(path.join(updatesDir, 'xdt-maker-0.0.65.zip'))).toBe(false);
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('Windows updater prerequisites', () => {
  it('defers the first startup relaunch and exposes the prerequisite error', async () => {
    vi.useFakeTimers();
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140.dll', 'vcruntime140_1.dll'],
    });
    fetchManifest.mockResolvedValue(updateManifest('0.0.65'));
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      const startupHandler = ipcHandlers.get('update-check-startup');
      await expect(startupHandler?.()).resolves.toMatchObject({
        hasUpdate: true,
        action: 'none',
        version: '0.0.65',
      });
      expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
        status: 'ready',
        version: '0.0.65',
        errorCode: 'windows_vc_runtime_missing',
      });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });

  it('keeps Cindy and the staged patch intact when the VC++ Runtime is missing', async () => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140_1.dll'],
    });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      const patchInfoPath = path.join(TEST_USER_DATA, 'updates', 'patch-info.json');
      const patchInfoBefore = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        fileName: string;
      };
      const stagedPatchPath = path.join(TEST_USER_DATA, 'updates', patchInfoBefore.fileName);

      ipcListeners.get('update-relaunch')?.({}, 'dark');

      await vi.waitFor(() => {
        expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
          status: 'ready',
          version: '0.0.65',
          errorCode: 'windows_vc_runtime_missing',
        });
      });
      const patchInfoAfter = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        applyAttempts?: number;
      };
      expect(patchInfoAfter.applyAttempts).toBeUndefined();
      expect(fs.existsSync(stagedPatchPath)).toBe(true);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      exitSpy.mockRestore();
      service.stopUpdateService();
    }
  });

  it.each([
    { stageResult: 'fallback-safe' as const, prerequisiteChecks: 2 },
    { stageResult: 'blocked' as const, prerequisiteChecks: 1 },
  ])('keeps the patch and retry count when Runtime staging is $stageResult', async ({
    stageResult,
    prerequisiteChecks,
  }) => {
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
    checkWindowsUpdaterPrerequisites
      .mockReturnValueOnce({ satisfied: true, missingFiles: [] })
      .mockReturnValue({
        satisfied: false,
        missingFiles: ['vcruntime140.dll', 'vcruntime140_1.dll'],
      });
    stageBundledWindowsUpdaterRuntime.mockReturnValue(stageResult);
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const resourcesPath = path.join(TEST_ROOT, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, 'cindy-updater.exe'), 'updater');
    const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    });
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const updaterWorkDir = path.join(os.tmpdir(), `cindy-update-${now}`);

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      const patchInfoPath = path.join(TEST_USER_DATA, 'updates', 'patch-info.json');
      const patchInfoBefore = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        fileName: string;
      };
      const stagedPatchPath = path.join(TEST_USER_DATA, 'updates', patchInfoBefore.fileName);

      ipcListeners.get('update-relaunch')?.({}, 'dark');

      await vi.waitFor(() => {
        expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(prerequisiteChecks);
        expect(ipcHandlers.get('update-get-status')?.()).toMatchObject({
          status: 'ready',
          version: '0.0.65',
          errorCode: 'windows_vc_runtime_missing',
        });
      });
      if (stageResult === 'fallback-safe') {
        expect(checkWindowsUpdaterPrerequisites).toHaveBeenNthCalledWith(2, undefined, '');
      }
      const patchInfoAfter = JSON.parse(fs.readFileSync(patchInfoPath, 'utf-8')) as {
        applyAttempts?: number;
      };
      expect(patchInfoAfter.applyAttempts).toBeUndefined();
      expect(fs.existsSync(stagedPatchPath)).toBe(true);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
      nowSpy.mockRestore();
      fs.rmSync(updaterWorkDir, { recursive: true, force: true });
      if (resourcesPathDescriptor) {
        Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
      } else {
        Reflect.deleteProperty(process, 'resourcesPath');
      }
    }
  });

  it('does not repeatedly auto-relaunch a prerequisite-blocked patch', async () => {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
    checkWindowsUpdaterPrerequisites.mockReturnValue({
      satisfied: false,
      missingFiles: ['vcruntime140.dll', 'vcruntime140_1.dll'],
    });
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });

    const service = await freshUpdateService('win32');
    service.initUpdateService();
    try {
      await expect(service.checkForUpdate(updateManifest('0.0.65'))).resolves.toBe('ready');
      await vi.waitFor(() => {
        expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(checkWindowsUpdaterPrerequisites).toHaveBeenCalledTimes(1);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.getUpdateStatus()).toBe('ready');
      expect(service.isUpdateRelaunchImminent()).toBe(false);
    } finally {
      service.stopUpdateService();
    }
  });
});

describe('splash 启动下载 0% 显式广播', () => {
  interface SentIpc {
    channel: string;
    payload: { progress?: number; received?: number; total?: number };
  }

  function makeProgressCollector() {
    const sends: SentIpc[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: SentIpc['payload']) => {
          sends.push({ channel, payload });
        },
      },
    };
    browserWindowGetAllWindows.mockReturnValue([win as never]);
    const progressSends = () => sends.filter((s) => s.channel === 'app-update-progress');
    return { sends, progressSends };
  }

  function mockDownloadSuccess(onInvoke?: () => void) {
    download.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      onInvoke?.();
      fs.mkdirSync(path.join(TEST_USER_DATA, 'updates'), { recursive: true });
      fs.writeFileSync(targetPath, 'update');
      return { path: targetPath, size: 123 };
    });
  }

  beforeEach(() => {
    // setStatus('ready') 会触发 evaluateAutoRelaunch;关掉无人值守开关,
    // 避免测试进程里真的走到 executeRelaunch(spawn + process.exit)。
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: false });
  });

  it('启动(非 wasReady)路径:download() 之前恰好广播一次 progress:0', async () => {
    const { progressSends } = makeProgressCollector();
    // ProgressNormalizer 只在进度上升时 emit,首个 ≥1% 事件在大补丁/慢网下
    // 可能要等数秒;没有这条显式 0%,splash 会停留在 'checking'、grace 定时器
    // 也看不到 'updating' 而提前放行进 app —— 这里锁死"下载真正开始前恰好
    // 已广播一次 0%"的契约。
    let progressCountWhenDownloadStarted = -1;
    mockDownloadSuccess(() => {
      progressCountWhenDownloadStarted = progressSends().length;
    });

    const { checkForUpdate } = await freshUpdateService('darwin');
    expect(await checkForUpdate(updateManifest())).toBe('ready');

    expect(progressCountWhenDownloadStarted).toBe(1);
    const payloads = progressSends().map((s) => s.payload);
    expect(payloads[0]).toMatchObject({ progress: 0, received: 0, total: 123 });
    expect(payloads[payloads.length - 1]).toMatchObject({ progress: 100 });
  });

  it('superseding(wasReady)路径:下载前不向 splash 通道广播 0%', async () => {
    const { sends, progressSends } = makeProgressCollector();
    mockDownloadSuccess();

    const service = await freshUpdateService('darwin');
    expect(await service.checkForUpdate(updateManifest('0.0.65'))).toBe('ready');

    // 清空第一轮的广播,只观察 superseding 轮。
    sends.length = 0;
    let progressCountWhenDownloadStarted = -1;
    mockDownloadSuccess(() => {
      progressCountWhenDownloadStarted = progressSends().length;
    });

    // banner 已 ready(a=0.0.65),后台轮询发现更高的 b=0.0.66 → superseding。
    // 此时用户在主界面,启动 splash 早已结束;0% 广播只属于启动态。
    expect(await service.checkForUpdate(updateManifest('0.0.66'))).toBe('ready');
    expect(progressCountWhenDownloadStarted).toBe(0);
  });
});
