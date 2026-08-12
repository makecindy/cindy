import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_CDN_BASE_URL as CDN_EXTERNAL_BASE_URL } from '../../test/vitest/clientEndpointsFixture';

const originalPlatform = process.platform;
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

const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
const logDebug = vi.fn();

vi.mock('electron', () => ({
  app: {
    getVersion: appGetVersion,
    getPath: appGetPath,
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

vi.mock('../manifestService', () => ({
  fetchManifest,
  getBaseUrl,
  isDev,
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

async function freshUpdateService(platform: NodeJS.Platform) {
  vi.resetModules();
  setPlatform(platform);
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
  readAutoUpdateSettings.mockReset();
  readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: true });
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
});

function updateManifest(version = '0.0.65') {
  return {
    app: {
      version,
      hotfix: {
        file: `app/darwin-arm64/xdt-maker-${version}.zip`,
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
  fetchManifest.mockResolvedValue(updateManifest());
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

describe('checkForUpdate Linux first-release guard', () => {
  it('returns manual_download on Linux without fetching or downloading, even with a hotfix manifest override', async () => {
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux');

    const result = await checkForUpdate({
      app: {
        version: '9.9.9',
        hotfix: {
          file: 'app/linux-x64/app.hotfix.zip',
          sha256: 'abc',
          size: 123,
        },
      },
      claudeCode: {
        version: '1.0.0',
        file: 'claude-code/1.0.0/linux-x64/claude.gz',
        sha256: 'def',
        size: 456,
      },
    });

    expect(result).toBe('manual_download');
    expect(getUpdateStatus()).toBe('idle');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('keeps returning manual_download on repeated Linux checks while remaining idle', async () => {
    const { checkForUpdate, getUpdateStatus } = await freshUpdateService('linux');

    expect(await checkForUpdate()).toBe('manual_download');
    expect(await checkForUpdate()).toBe('manual_download');

    expect(getUpdateStatus()).toBe('idle');
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
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
  async function bootWithStagedPatch(options: { enabled?: boolean } = {}) {
    vi.useFakeTimers();
    readAutoUpdateSettings.mockReturnValue({ autoRelaunchOnIdle: options.enabled ?? true });
    fetchManifest.mockResolvedValue(updateManifest());
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
