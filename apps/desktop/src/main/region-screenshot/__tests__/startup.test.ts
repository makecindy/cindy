import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  shortcut: null as (() => void) | null,
  capture: vi.fn(),
  start: vi.fn(),
  dispose: vi.fn(),
  windows: vi.fn(async () => []),
  frontmostPid: vi.fn(async () => null),
  activeSession: null as null | { close: () => void },
}));
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  desktopCapturer: { getSources: mocks.capture },
  dialog: { showMessageBox: vi.fn() },
  globalShortcut: {
    register: (_key: string, callback: () => void) => {
      mocks.shortcut = callback;
      return true;
    },
    unregister: vi.fn(),
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  screen: {
    on: vi.fn(),
    removeListener: vi.fn(),
    getAllDisplays: () => [{ id: 1, bounds: { width: 10, height: 10 }, scaleFactor: 1 }],
  },
  shell: {},
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => 'owner-a:1', isAppSessionBoundaryPending: () => false, onAppSessionInvalidated: () => () => {} }));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../../app-shortcuts', () => ({
  getAppShortcutStore: () => ({
    subscribe: () => () => {},
    getEffectiveCombos: () => ['screenshot'],
  }),
  setGlobalShortcutRegistrationFailures: vi.fn(),
  subscribeAppShortcutRecording: () => () => {},
}));
vi.mock('../../../shared/appShortcuts', () => ({ comboToElectronAccelerator: () => 'Ctrl+Alt+S' }));
vi.mock('../../remote-desktop/captureSource', () => ({
  enumerateDesktopSources: (fn: () => unknown) => fn(),
}));
vi.mock('../../computer-permission-guide/request', () => ({
  MAC_SCREEN_RECORDING_SETTINGS_URL: '',
}));
vi.mock('../compose', () => ({
  handOffScreenshotToTask: vi.fn(),
  registerScreenshotComposeIpc: vi.fn(),
}));
vi.mock('../pins', () => ({ closeAllPins: vi.fn(), openPin: vi.fn(), registerPinIpc: vi.fn() }));
vi.mock('../save', () => ({ saveScreenshotImage: vi.fn() }));
vi.mock('../overlays', () => ({
  OverlayPool: class {
    isDisabled = false;
    setGoneHandler() {}
    reset() {}
    prewarm() {}
    destroyAll() {}
  },
}));
vi.mock('../snapshotHost', () => ({
  SnapshotHelper: { start: mocks.start },
  resolveSnapshotBinary: vi.fn(),
}));
vi.mock('../session', () => ({
  RegionScreenshotSession: class {
    constructor(private deps: { onClosed: () => void }) {
      mocks.activeSession = this;
    }
    open = async () => true;
    close() {
      this.deps.onClosed();
    }
  },
}));
import { initRegionScreenshot, stopRegionScreenshot } from '../index';

// 测试价值：从真实快捷键启动入口验证失败和晚到 helper 的释放，填补原先启动编排零覆盖。
// 最小失败输入为 capture reject 早于 helper resolve；tier: unit，假定时器和内存依赖。
describe('screenshot startup cleanup', () => {
  const helper = {
    dispose: mocks.dispose,
    windows: mocks.windows,
    frontmostPid: mocks.frontmostPid,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.start.mockResolvedValue(helper);
    mocks.capture.mockResolvedValue([]);
    initRegionScreenshot();
  });
  afterEach(() => {
    stopRegionScreenshot();
    vi.useRealTimers();
  });
  it('releases the helper when capturing fails', async () => {
    mocks.capture.mockRejectedValueOnce(new Error('capture failed'));
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it('releases a helper arriving after capture has already failed', async () => {
    let resolve!: (value: typeof helper) => void;
    mocks.start.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mocks.capture.mockRejectedValueOnce(new Error('capture failed'));
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(0);
    resolve(helper);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it('requests nonblocking helper startup and releases it on an empty capture', async () => {
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledWith(false);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it('keeps the helper until the successfully opened screenshot closes', async () => {
    mocks.capture.mockResolvedValueOnce([{ display_id: '1', thumbnail: { isEmpty: () => false } }]);
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispose).not.toHaveBeenCalled();
    mocks.activeSession!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
