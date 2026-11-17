import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  shortcut: null as (() => void) | null,
  capture: vi.fn(),
  nativeCapture: vi.fn(),
  displays: vi.fn(),
  start: vi.fn(),
  dispose: vi.fn(),
  windows: vi.fn(async () => []),
  frontmostPid: vi.fn(async () => null),
  screenInsets: vi.fn(async () => new Map()),
  activeSession: null as null | { close: () => void },
}));
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  desktopCapturer: { getSources: mocks.capture },
  nativeImage: { createFromBitmap: () => ({ isEmpty: () => false, native: true }) },
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
    getAllDisplays: mocks.displays,
    dipToScreenRect: (_window: unknown, rect: unknown) => rect,
  },
  shell: {},
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => 'owner-a:1', isAppSessionBoundaryPending: () => false, onAppSessionInvalidated: () => () => {} }));
vi.mock('../../i18n.desktop', () => ({ t: (key: string) => key }));
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
    capture: mocks.nativeCapture,
    dispose: mocks.dispose,
    windows: mocks.windows,
    frontmostPid: mocks.frontmostPid,
    screenInsets: mocks.screenInsets,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    mocks.activeSession = null;
    mocks.displays.mockReturnValue([{ id: 1, bounds: { width: 10, height: 10 }, scaleFactor: 1 }]);
    mocks.start.mockResolvedValue(helper);
    mocks.capture.mockResolvedValue([]);
    initRegionScreenshot();
  });
  afterEach(() => {
    stopRegionScreenshot();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  // User-selected lazy lifecycle: registration must not schedule shell creation,
  // capture, or native compilation. Earlier tests only invoked the shortcut.
  it('does not prepare or capture anything before the first shortcut', async () => {
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('releases the helper when capturing fails', async () => {
    mocks.capture.mockRejectedValueOnce(new Error('capture failed'));
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it('waits for the optional helper before capture and releases it if capture fails', async () => {
    let resolve!: (value: typeof helper) => void;
    mocks.start.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mocks.capture.mockRejectedValueOnce(new Error('capture failed'));
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.capture).not.toHaveBeenCalled();
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
    expect(vi.getTimerCount()).toBe(0);
  });

  // Unit regression: the real shortcut must retain native frames when optional
  // window enumeration stalls the serial helper. Previous cleanup tests used
  // only Electron; two displays also catch interleaving windows between frames.
  // Standalone Vitest duration: 2.45s on Windows.
  it('finishes all native frames before a slow window query can expire the helper', async () => {
    mocks.displays.mockReturnValue([1, 2].map(id => ({
      id, bounds: { x: (id - 1) * 10, y: 0, width: 10, height: 10 }, scaleFactor: 1,
      depthPerComponent: 8, colorSpace: '{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}',
    })));
    let blocked = false;
    mocks.windows.mockImplementationOnce(() => {
      blocked = true;
      return new Promise(resolve => setTimeout(() => resolve([]), 1500));
    });
    mocks.nativeCapture.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(blocked ? null : { width: 10, height: 10, data: new Uint8Array(400) }), 10);
    }));
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(1600);
    expect(mocks.activeSession).not.toBeNull();
    expect(mocks.nativeCapture).toHaveBeenCalledTimes(2);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.windows).toHaveBeenCalledTimes(1);
  });

  // Unit regression (review): ordering frames first must not also delay window
  // queries behind Electron capture, which never uses the helper. Minimum input:
  // one wide-gamut Windows display. getSources blocks synchronously in Electron,
  // so the query must already be sent when it is entered, not merely later.
  it('keeps window queries parallel with Electron capture on wide-gamut displays', async () => {
    mocks.displays.mockReturnValue([{ id: 1, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1,
      depthPerComponent: 10, colorSpace: '{primaries:BT2020, transfer:PQ, matrix:RGB, range:FULL}' }]);
    let windowsAtFallback = -1;
    mocks.capture.mockImplementation(async () => { windowsAtFallback = mocks.windows.mock.calls.length; return []; });
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(10);
    expect(windowsAtFallback).toBe(1);
    expect(mocks.nativeCapture).not.toHaveBeenCalled();
  });

  // Same review regression for a native frame that fails after precheck: the
  // window query must be sent before getSources starts its blocking work.
  it('sends window queries before the Electron fallback after a failed native frame', async () => {
    mocks.displays.mockReturnValue([{ id: 1, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1,
      depthPerComponent: 8, colorSpace: '{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}' }]);
    mocks.nativeCapture.mockResolvedValue(null);
    let windowsAtFallback = -1;
    mocks.capture.mockImplementation(async () => { windowsAtFallback = mocks.windows.mock.calls.length; return []; });
    mocks.shortcut!();
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.nativeCapture).toHaveBeenCalledTimes(1);
    expect(windowsAtFallback).toBe(1);
  });
});
