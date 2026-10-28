import { EventEmitter } from 'node:events';
import type { BrowserWindow, Display, NativeImage } from 'electron';
import type { SnapshotHelper } from '../snapshotHost';
import type { RegionRect, RegionScreenshotBitmap } from '../../../shared/regionScreenshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ownerScope: 'owner-a:1',
  boundary: false,
  invalidations: new Set<() => void>(),
  switches: new Set<string>(),
  create: vi.fn(),
  focus: vi.fn(),
  screen: new (class {
    on = vi.fn();
    removeListener = vi.fn();
    getAllDisplays = vi.fn();
    getDisplayMatching = (bounds: unknown) => ({ workArea: bounds });
    getCursorScreenPoint = () => ({ x: 20, y: 20 });
    dipToScreenPoint = (point: unknown) => point;
    screenToDipRect = (_window: unknown, rect: unknown) => rect;
  })(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  register: vi.fn<(key: string, callback: () => void) => boolean>(() => true),
  unregister: vi.fn(),
  liveCapture: vi.fn(),
  saveRecording: vi.fn(async () => true),
  copyRecording: vi.fn<(bytes: Uint8Array, format: string, isCurrent: () => boolean) => Promise<void>>(async () => {}),
}));
vi.mock('electron', () => ({
  app: {
    focus: mocks.focus,
    commandLine: {
      hasSwitch: (flag: string) => mocks.switches.has(flag),
      appendSwitch: (flag: string) => { mocks.switches.add(flag); },
      removeSwitch: (flag: string) => { mocks.switches.delete(flag); },
    },
  },
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  screen: mocks.screen,
  nativeTheme: { shouldUseDarkColors: false },
  globalShortcut: { register: mocks.register, unregister: mocks.unregister },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  nativeImage: {
    createFromBitmap: (
      data: Buffer,
      options: { width: number; height: number; scaleFactor: number },
    ) => ({
      // Electron ImageSkiaRep.GetWidth/GetHeight 返回 DIP，而 toBitmap 返回物理像素。
      getSize: () => ({
        width: options.width / options.scaleFactor,
        height: options.height / options.scaleFactor,
      }),
      toBitmap: () => data,
      isEmpty: () => false,
    }),
  },
  Menu: { buildFromTemplate: vi.fn() },
  ipcMain: { on: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn), handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn) },
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => mocks.ownerScope,
  isAppSessionBoundaryPending: () => mocks.boundary,
  onAppSessionInvalidated: (listener: () => void) => {
    mocks.invalidations.add(listener);
    return () => { mocks.invalidations.delete(listener); };
  },
}));
vi.mock('../pageWindow', () => ({ createScreenshotPageWindow: mocks.create }));
vi.mock('../compose', () => ({ handOffScreenshotToTask: vi.fn() }));
vi.mock('../save', () => ({ saveScreenshotImage: vi.fn(), saveRegionRecording: mocks.saveRecording }));
vi.mock('../recordingClipboard', () => ({ copyRegionRecording: mocks.copyRecording }));
vi.mock('../liveCapture', () => ({ captureLiveRegion: mocks.liveCapture, RegionVideoCapture: class { frame = mocks.liveCapture; stop() {} } }));
vi.mock('../../i18n', () => ({ getResolvedMainLocale: () => 'en', t: (key: string) => key }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
import { OverlayPool, hideScreenshotOverlay, showScreenshotOverlay } from '../overlays';
import { RegionScreenshotSession } from '../session';
import { acquireOverlayEscape } from '../../overlayEscape';
import { closeAllPins, openPin, registerPinIpc } from '../pins';
import { ScreenshotEditor } from '../editor';
import { RecordingPreview } from '../recordingPreview';
import { RECORDING_PREVIEW_CHANNEL as R } from '../../../shared/regionCapture';
import { REGION_SCREENSHOT_EDITOR_CHANNEL as E, REGION_SCREENSHOT_PIN_CHANNEL as P } from '../../../shared/regionScreenshot';

let nextId = 0;
function fakeWindow() {
  let destroyed = false;
  let visible = false;
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      id: ++nextId,
      mainFrame: {},
      isDestroyed: () => destroyed,
      send: vi.fn(),
      sendInputEvent: vi.fn(),
    }),
    isFocused: vi.fn(() => false),
    isMinimized: () => false, isMaximized: () => false, isFullScreen: () => false,
    setTitle: vi.fn(),
    minimize: vi.fn(),
    show: vi.fn(() => { visible = true; window.emit('show'); }),
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    getMediaSourceId: () => 'window:999:0',
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn(),
    setOpacity: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    showInactive: vi.fn(() => {
      visible = true;
      window.emit('show');
    }),
    hide: vi.fn(() => {
      visible = false;
      window.emit('hide');
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      window.emit('closed');
    }),
    close: vi.fn(() => window.destroy()),
  });
  return window;
}
const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  scaleFactor: 2,
} as Display;
const image = {
  getSize: () => ({ width: 2, height: 2 }),
  toBitmap: () => Buffer.alloc(16),
} as NativeImage;

// 测试价值：OverlayPool/Session/openPin 的真实入口保护首帧、故障退出和 IPC 来源。
// 旧代码没有窗口生命周期测试；最小输入为 unresponsive、未 PAINTED、2x 位图和 workArea 事件。
// tier: unit；Electron 由内存窗口替代，全部时序用假时钟。
describe('screenshot window lifecycle', () => {
  let pool: OverlayPool;
  let windows: ReturnType<typeof fakeWindow>[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.switches.clear();
    mocks.ownerScope = 'owner-a:1';
    mocks.boundary = false;
    windows = [];
    mocks.create.mockImplementation(() => {
      const window = fakeWindow();
      windows.push(window);
      return window;
    });
    mocks.screen.getAllDisplays.mockReturnValue([display]);
    pool = new OverlayPool();
  });
  afterEach(() => {
    pool.destroyAll();
    closeAllPins();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Region detection: native hit-testing can replace the transparent front
  // rectangle. Existing lifecycle tests never queried elements. Minimal input:
  // two overlapping windows on an offset display; unit, no OS UI or real waits.
  it('returns the corrected window in display coordinates and drops a query after the session closes', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    const monitor = { ...display, bounds: { x: -100, y: 100, width: 100, height: 100 } } as Display;
    const overlay = pool.ensure(monitor)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const captured = [
      { handle: 1, pid: 1, rect: [-100, 100, 0, 200] as [number, number, number, number], snapRects: [[-100, 120, 0, 200] as [number, number, number, number]] },
      { handle: 2, pid: 2, rect: [-90, 110, -10, 190] as [number, number, number, number] },
    ];
    const hit = vi.fn(async () => captured[1]);
    const elements = vi.fn(async () => ({ rects: [[-80, 120, -50, 150]], preferredRect: [-80, 120, -50, 150] }));
    const session = new RegionScreenshotSession({ pool, captures: [{ display: monitor, image }], helper: { windowAt: hit, elements } as unknown as SnapshotHelper, windows: captured, lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    // Snapshot defaults must reach the first paint on an offset display, before
    // any ELEMENTS_AT reply; previous coverage only inspected query conversion.
    const begin = vi.mocked(owner.send).mock.calls.find(([name]) => name === 'region-screenshot:begin')![1];
    expect(begin.windows[0].snapRects).toEqual([{ x: 0, y: 20, width: 100, height: 80 }]);
    await expect(session.elementsAt(owner, owner.mainFrame, session.token, 0, 25, 25)).resolves.toEqual({
      window: { id: 1, rect: { x: 10, y: 10, width: 80, height: 80 } },
      rects: [{ x: 20, y: 20, width: 30, height: 30 }],
      preferredRect: { x: 20, y: 20, width: 30, height: 30 },
    });
    expect(hit).toHaveBeenCalledWith(captured, -75, 125, [999]);
    expect(elements).toHaveBeenCalledWith(captured[1], -75, 125);
    hit.mockClear();
    await expect(session.elementsAt(owner, owner.mainFrame, 'old-token', 0, 25, 25)).resolves.toBeNull();
    await expect(session.elementsAt(owner, owner.mainFrame, session.token, 0, 125, 25)).resolves.toBeNull();
    expect(hit).not.toHaveBeenCalled();
    const pending = session.elementsAt(owner, owner.mainFrame, session.token, 0, 25, 25);
    session.cancel(owner, owner.mainFrame, session.token);
    await expect(pending).resolves.toBeNull();
    expect(elements).toHaveBeenCalledTimes(1);
  });

  // 用户反馈：打开截图时整屏缩放。实机验证 Aura 动画；unit 保护临时开关
  // 不泄漏到其它窗口、不清除用户启动参数，且异常也恢复。tier: unit。
  it.each([
    ['win32', false, false],
    ['win32', false, true],
    ['win32', true, false],
    ['darwin', false, false],
  ] as const)('scopes screenshot animations on %s (existing=%s, throws=%s)', (platform, existing, throws) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }));
    const flag = 'wm-window-animations-disabled';
    if (existing) mocks.switches.add(flag);
    // 隐藏也必须禁用动画，否则第二次显示仍保留 Aura 的透明层。
    for (const changeVisibility of [showScreenshotOverlay, hideScreenshotOverlay]) {
      let disabledDuringChange: boolean | undefined;
      const change = () => {
        disabledDuringChange = mocks.switches.has(flag);
        if (throws) throw new Error('window destroyed');
      };
      const window = { showInactive: change, hide: change } as BrowserWindow;
      if (throws) expect(() => changeVisibility(window)).toThrow('window destroyed');
      else changeVisibility(window);
      expect(disabledDuringChange).toBe(platform === 'win32');
      expect(mocks.switches.has(flag)).toBe(existing);
    }
  });

  // User report (macOS): the mode bar sat under the notch and live controls over the Dock.
  // The page only learns its chrome area from BEGIN; recording controls are placed in main.
  // Minimal input: a work area without menu bar / Dock plus a 32pt notch. tier: unit.
  it('gives macOS overlays a notch- and Dock-free chrome area for the toolbar and live controls', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    const notched = { ...display, bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 24, width: 1470, height: 862 }, scaleFactor: 1 } as Display;
    mocks.screen.getAllDisplays.mockReturnValue([notched]);
    const overlay = pool.ensure(notched)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const cropped = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => cropped };
    const source = { getSize: () => ({ width: 1470, height: 956 }), toBitmap: () => Buffer.alloc(1470 * 956 * 4), crop: () => cropped } as unknown as NativeImage;
    const helper = {} as SnapshotHelper;
    const session = new RegionScreenshotSession({ pool, captures: [{ display: notched, image: source }], helper, windows: [], lastRegions: new Map(), topInsets: new Map([[notched.id, 32]]), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    const begin = vi.mocked(owner.send).mock.calls.find(([name]) => name === 'region-screenshot:begin')![1];
    expect(begin.safeArea).toEqual({ x: 0, y: 32, width: 1470, height: 854 });
    session.painted(owner, owner.mainFrame, session.token);
    const selected = { x: 200, y: 300, width: 700, height: 530 };
    const live = session.startLive(owner, owner.mainFrame, session.token, 'video', selected)!;
    const controls = live.recordingLayout!.controls;
    expect(controls.y).toBeGreaterThanOrEqual(32);
    expect(controls.y + controls.height).toBeLessThanOrEqual(886);
    session.close();
  });

  // Phase 5/6: same trusted sender/token contract now guards continuing capture and clip export.
  // Existing static-image tests cannot observe a late frame after cancellation or native-dialog retry.
  // Minimal input: one live request, close before the capture promise resolves. tier: unit.
  it('rejects foreign live requests, drops late pixels after cancellation, and never starts key sampling by default', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const cropped = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => cropped };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => cropped } as unknown as NativeImage;
    const keys = vi.fn(async () => ['Ctrl', 'C']);
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: { keys } as unknown as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    const selected = { x: 0, y: 0, width: 400, height: 300 };
    expect(session.startLive(owner, {} as Electron.WebFrameMain, session.token, 'video', selected)).toBeNull();
    expect(session.startLive(owner, owner.mainFrame, 'stale', 'video', selected)).toBeNull();
    expect(session.startLive(owner, owner.mainFrame, session.token, 'video', selected)?.mode).toBe('video');
    let resolve!: (value: unknown) => void;
    mocks.liveCapture.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = session.liveFrame(owner, owner.mainFrame, session.token, false);
    expect(await session.liveFrame(owner, owner.mainFrame, session.token, true)).toBeNull();
    session.close();
    resolve({ width: 400, height: 300, data: new Uint8Array(400 * 300 * 4) });
    expect(await pending).toBeNull();
    expect(keys).not.toHaveBeenCalled();
    expect(await session.liveFrame(owner, owner.mainFrame, session.token, true)).toBeNull();
    expect(mocks.liveCapture).toHaveBeenCalledTimes(1);
  });

  // User regression: Edit restored a full-screen black overlay. A valid image must
  // transfer to the independent editor and retire the capture; rejected images retain it. tier: unit.
  it('hands the long image to a separate editor and retires the capture overlays', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const result = vi.fn();
    const openEditor = vi.fn<(image: RegionScreenshotBitmap, display: Display, selection: RegionRect) => boolean>(() => true);
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: result, openEditor });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    const selection = { x: 0, y: 0, width: 400, height: 300 };
    session.startLive(owner, owner.mainFrame, session.token, 'scroll', selection);
    expect(windows[0].setBounds).toHaveBeenLastCalledWith(largeDisplay.bounds, false);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    const long = { width: 400, height: 1500, data: new Uint8Array(400 * 1500 * 4) };
    expect(session.restoreEditor(owner, owner.mainFrame, 'stale', long)).toBe(false);
    expect(session.restoreEditor(owner, {} as Electron.WebFrameMain, session.token, long)).toBe(false);
    expect(session.restoreEditor(owner, owner.mainFrame, session.token, { ...long, data: new Uint8Array(4) })).toBe(false);
    expect(openEditor).not.toHaveBeenCalled();
    openEditor.mockReturnValueOnce(false);
    expect(session.restoreEditor(owner, owner.mainFrame, session.token, long)).toBe(false);
    expect(session.isClosed).toBe(false);
    expect(session.restoreEditor(owner, owner.mainFrame, session.token, long)).toBe(true);
    // Assert byte ownership directly; serializing millions of typed-array entries
    // in a call matcher made this lifecycle test time out on the Linux CI runner.
    const handedOff = openEditor.mock.calls.at(-1)!;
    expect({ width: handedOff[0].width, height: handedOff[0].height }).toEqual({ width: long.width, height: long.height });
    expect(handedOff[0].data).toBe(long.data);
    expect(handedOff[1]).toBe(largeDisplay);
    expect(handedOff[2]).toEqual(selection);
    expect(session.isClosed).toBe(true);
    expect(session.hasEditor).toBe(true);
    expect(windows[0].isVisible()).toBe(false);
    expect(await session.liveFrame(owner, owner.mainFrame, session.token, false)).toBeNull();
    expect(result).not.toHaveBeenCalled();
  });

  // Auto scrolling operates on the source app: stale tokens must never trigger it,
  // and stopping while a frame is pending must prevent the next wheel event. tier: unit.
  // A transparent desktop overlay can precede the browser in CGWindow order.
  // Unit: resolve the real input window, and cancel a pending resolution on Stop.
  it.each(['darwin', 'win32'])('confines automatic scrolling to the owner on %s and stops pending input', async (platform) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }));
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const bitmap = { width: 400, height: 300, data: new Uint8Array(400 * 300 * 4) };
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.from(bitmap.data), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const scroll = vi.fn(async () => true);
    const target = { handle: 99, pid: 1, rect: [0, 0, 1280, 900] as [number, number, number, number] };
    const scrollTarget = vi.fn(async () => target);
    const candidates = platform === 'darwin' ? [{ ...target, handle: 98, pid: 2 }, target] : [target];
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: { scroll, scrollTarget } as unknown as SnapshotHelper, windows: candidates, lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    session.startLive(owner, owner.mainFrame, session.token, 'scroll', { x: 100, y: 100, width: 400, height: 300 });
    expect(session.autoScroll(owner, owner.mainFrame, 'stale', true)).toBe(false);
    expect(session.autoScroll(owner, {} as Electron.WebFrameMain, session.token, true)).toBe(false);
    expect(session.autoScroll(owner, owner.mainFrame, session.token, true)).toBe(true);
    if (platform === 'darwin') {
      let resolveTarget!: (value: typeof target) => void;
      scrollTarget.mockImplementationOnce(() => new Promise(done => { resolveTarget = done; }));
      mocks.liveCapture.mockResolvedValueOnce(bitmap);
      const resolving = session.liveFrame(owner, owner.mainFrame, session.token, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.autoScroll(owner, owner.mainFrame, session.token, false)).toBe(true);
      resolveTarget(target);
      expect((await resolving)?.autoScrolling).toBe(false);
      expect(scroll).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(session.autoScroll(owner, owner.mainFrame, session.token, true)).toBe(true);
    }
    mocks.liveCapture.mockResolvedValueOnce(bitmap);
    expect((await session.liveFrame(owner, owner.mainFrame, session.token, false))?.autoScrolling).toBe(true);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(target, 300, 250, -60);
    await vi.advanceTimersByTimeAsync(200);
    let resolve!: (value: unknown) => void;
    mocks.liveCapture.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = session.liveFrame(owner, owner.mainFrame, session.token, false);
    session.holdCapture(owner, owner.mainFrame, session.token);
    resolve(bitmap);
    expect((await pending)?.autoScrolling).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(1);
    session.close();
    expect(session.autoScroll(owner, owner.mainFrame, session.token, true)).toBe(false);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  // 用户反馈开始录制时整屏抖动。Electron macOS 的 blur 会 orderOut 再 orderBack，
  // 现有首帧测试未覆盖开始采集时的层级切换。最小输入：已显示的面板开始采集。
  // tier: unit；内存窗口模拟原生 blur 的显隐，不能让采集开始重排正在显示的面板。
  it.each(['video', 'gif', 'scroll'] as const)('keeps the macOS capture panel continuously visible when starting %s', async (mode) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    try {
      await session.open();
      session.painted(owner, owner.mainFrame, session.token);
      const win = windows[0], visibility: string[] = [];
      win.on('hide', () => visibility.push('hide'));
      win.on('show', () => visibility.push('show'));
      win.blur.mockImplementation(() => { win.hide(); win.showInactive(); });
      win.setBounds.mockClear();
      expect(session.startLive(owner, owner.mainFrame, session.token, mode, { x: 100, y: 100, width: 400, height: 300 })).not.toBeNull();
      expect(visibility).toEqual([]);
      expect(win.isVisible()).toBe(true);
      expect(win.setBounds).not.toHaveBeenCalled();
    } finally { session.close(); }
  });

  it('keeps a finished recording available after a cancelled save and confines export to its chosen format', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const openRecording = vi.fn(() => false);
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn(), openRecording });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    session.startLive(owner, owner.mainFrame, session.token, 'video', { x: 0, y: 0, width: 400, height: 300 });
    const clip = new Uint8Array(20); clip.set([0x1a, 0x45, 0xdf, 0xa3]);
    // User-requested compact controls: dragging cannot cover source pixels;
    // foreign requests and a failed preview handoff must retain this capture. tier: unit.
    expect(session.updateRecordingControls(owner, {} as Electron.WebFrameMain, session.token, false, undefined, false)).toBeNull();
    expect(session.updateRecordingControls(owner, owner.mainFrame, session.token, false, { x: NaN, y: 0 }, false)).toBeNull();
    const moved = session.updateRecordingControls(owner, owner.mainFrame, session.token, false, { x: 0, y: 0 }, true)!;
    expect(moved.x >= 400 || moved.y >= 300).toBe(true);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    session.updateRecordingControls(owner, owner.mainFrame, session.token, false, moved, false);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(session.previewRecording(owner, owner.mainFrame, 'stale', clip, 'webm')).toBe(false);
    expect(session.previewRecording(owner, owner.mainFrame, session.token, clip, 'gif')).toBe(false);
    expect(session.previewRecording(owner, owner.mainFrame, session.token, clip, 'webm')).toBe(false);
    expect(session.isClosed).toBe(false);
    expect(await session.saveRecording(owner, owner.mainFrame, session.token, clip, 'gif')).toBe(false);
    expect(mocks.saveRecording).not.toHaveBeenCalled();
    mocks.saveRecording.mockResolvedValueOnce(false);
    expect(await session.saveRecording(owner, owner.mainFrame, session.token, clip, 'webm')).toBe(false);
    expect(session.isClosed).toBe(false);
    expect(await session.saveRecording(owner, owner.mainFrame, session.token, clip, 'webm')).toBe(true);
    openRecording.mockReturnValue(true);
    expect(session.previewRecording(owner, owner.mainFrame, session.token, clip, 'webm')).toBe(true);
    expect(session.isClosed).toBe(true);
    expect(session.hasEditor).toBe(true);
  });

  // 用户反馈：录屏预览留在后台，下一段被旧预览占用。现有测试只检查可见性，
  // 没有覆盖从不激活应用的采集面板交出焦点。最小输入：后台打开并收到 PAINTED。
  // tier: unit；真实 RecordingPreview 入口，预热和非当前文档均不得抢焦点。
  it.each(['darwin', 'win32'] as const)('activates clip preview only when presenting it on %s', (platform) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }));
    const preview = new RecordingPreview();
    const clip = new Uint8Array(20); clip.set([0x1a, 0x45, 0xdf, 0xa3]);
    preview.registerIpc(); preview.prewarm();
    const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const signal = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(event, ...args);
    try {
      signal(R.READY);
      expect(preview.open(clip, 'webm', display)).toBe(true);
      const doc = win.webContents.send.mock.calls.find(([name]) => name === R.BEGIN)![1];
      signal(R.PAINTED, 'stale');
      expect(mocks.focus).not.toHaveBeenCalled();
      expect(win.focus).not.toHaveBeenCalled();
      signal(R.PAINTED, doc.token);
      expect(win.isVisible()).toBe(true);
      expect(win.focus).toHaveBeenCalledOnce();
      if (platform === 'darwin') {
        expect(mocks.focus).toHaveBeenCalledExactlyOnceWith({ steal: true });
        expect(mocks.focus.mock.invocationCallOrder[0]).toBeLessThan(win.focus.mock.invocationCallOrder[0]);
      } else {
        expect(mocks.focus).not.toHaveBeenCalled();
      }
    } finally { preview.dispose(); }
  });

  // New preview IPC/lifetime contract (Electron rules §3.1): existing image tests
  // cannot cover clip save ownership, cancelled dialogs or replay after close.
  // Minimal input: stale token after reopening; failed native save. tier: unit.
  it('prewarms clip playback, validates its document owner and retains bytes after cancelling save', async () => {
    const preview = new RecordingPreview();
    const clip = new Uint8Array(20); clip.set([0x1a, 0x45, 0xdf, 0xa3]);
    preview.registerIpc(); preview.prewarm();
    const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const signal = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(event, ...args);
    try {
      expect(win.isVisible()).toBe(false);
      signal(R.READY);
      expect(preview.open(clip, 'webm', display)).toBe(true);
      const first = win.webContents.send.mock.calls.find(([name]) => name === R.BEGIN)![1];
      expect(win.isVisible()).toBe(false);
      mocks.handlers.get(R.PAINTED)!({ ...event, senderFrame: {} }, first.token);
      expect(win.isVisible()).toBe(false);
      signal(R.PAINTED, first.token);
      expect(win.isVisible()).toBe(true);
      expect(await mocks.handlers.get(R.SAVE)!({ ...event, sender: {} }, first.token)).toBe(false);
      expect(await signal(R.SAVE, 'stale')).toBe(false);
      expect(mocks.saveRecording).not.toHaveBeenCalled();
      mocks.saveRecording.mockResolvedValueOnce(false);
      expect(await signal(R.SAVE, first.token)).toBe(false);
      expect(win.isVisible()).toBe(true);
      expect(await signal(R.SAVE, first.token)).toBe(true);
      expect(mocks.saveRecording).toHaveBeenLastCalledWith(clip, 'webm', expect.any(Function));
      // Copy grants no path/payload input: only this preview's current document.
      expect(await mocks.handlers.get(R.COPY)!({ ...event, sender: {} }, first.token)).toBe(false);
      expect(await mocks.handlers.get(R.COPY)!({ ...event, senderFrame: {} }, first.token)).toBe(false);
      expect(await signal(R.COPY, 'stale')).toBe(false);
      expect(mocks.copyRecording).not.toHaveBeenCalled();
      mocks.copyRecording.mockRejectedValueOnce(new Error('clipboard busy'));
      expect(await signal(R.COPY, first.token)).toBe(false);
      expect(win.isVisible()).toBe(true);
      expect(await signal(R.COPY, first.token)).toBe(true);
      expect(mocks.copyRecording).toHaveBeenLastCalledWith(clip, 'webm', expect.any(Function));
      const stillCurrent = mocks.copyRecording.mock.calls.at(-1)![2] as () => boolean;
      expect(stillCurrent()).toBe(true);
      signal(R.CLOSE, first.token);
      expect(stillCurrent()).toBe(false);
      expect(win.isVisible()).toBe(false);
      expect(win.webContents.send).toHaveBeenCalledWith(R.END);
      expect(preview.open(clip, 'webm', display)).toBe(true);
      const next = win.webContents.send.mock.calls.filter(([name]) => name === R.BEGIN).at(-1)![1];
      signal(R.PAINTED, first.token);
      expect(win.isVisible()).toBe(false);
      signal(R.PAINTED, next.token);
      expect(win.isVisible()).toBe(true);
      expect(windows).toHaveLength(1);
    } finally { preview.dispose(); }
  });

  // PR #7300 owner boundary: existing token checks cannot reject a prior account's
  // clip. Unit: open after switching, then invalidate during save/copy; old pixels
  // must disappear and deferred export must be cancelled, while the next owner works.
  it.each([R.SAVE, R.COPY])('invalidates recording previews and pending %s on an owner boundary', async channel => {
    const preview = new RecordingPreview();
    const clip = new Uint8Array(20); clip.set([0x1a, 0x45, 0xdf, 0xa3]);
    preview.registerIpc(); preview.prewarm();
    const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const signal = (name: string, ...args: unknown[]) => mocks.handlers.get(name)!(event, ...args);
    try {
      signal(R.READY);
      expect(preview.open(clip, 'webm', display, 'old-owner')).toBe(false);
      mocks.boundary = true;
      expect(preview.open(clip, 'webm', display)).toBe(false);
      mocks.boundary = false;
      expect(preview.open(clip, 'webm', display)).toBe(true);
      const doc = win.webContents.send.mock.calls.find(([name]) => name === R.BEGIN)![1];
      signal(R.PAINTED, doc.token);
      let finish!: () => void;
      let isCurrent!: () => boolean;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      if (channel === R.COPY) mocks.copyRecording.mockImplementationOnce(async (_bytes, _format, current) => {
        isCurrent = current;
        await pending;
        if (!current()) throw new Error('cancelled');
      });
      else mocks.saveRecording.mockImplementationOnce(async (...args: unknown[]) => {
        isCurrent = args[2] as () => boolean;
        await pending;
        return isCurrent();
      });
      const exported = signal(channel, doc.token);
      expect(isCurrent()).toBe(true);
      for (const invalidate of mocks.invalidations) invalidate();
      mocks.ownerScope = 'owner-b:2';
      expect(win.isDestroyed()).toBe(true);
      expect(isCurrent()).toBe(false);
      finish();
      expect(await exported).toBe(false);
      expect(await signal(channel, doc.token)).toBe(false);
      expect(preview.open(clip, 'webm', display, 'owner-a:1')).toBe(false);
      expect(preview.open(clip, 'webm', display)).toBe(true);
    } finally { preview.dispose(); }
    expect(mocks.invalidations.size).toBe(0);
  });

  // 用户反馈再次截图不可见; 现有覆盖没有验证用过的透明浮层与下一次会话隔离。
  // 最小输入：上一轮导出后立即开启下一轮, 旧窗口随后销毁。tier: unit。
  it('retires a used overlay so the next screenshot never re-shows it', async () => {
    let active: RegionScreenshotSession;
    pool.setGoneHandler((overlay) => { if (active?.owns(overlay)) active.close(); });
    const run = async () => {
      const overlay = pool.ensure(display)!;
      const contents = overlay.window.webContents;
      pool.markShellReady(contents, contents.mainFrame);
      active = new RegionScreenshotSession({ pool, captures: [{ display, image }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
      await active.open();
      active.painted(contents, contents.mainFrame, active.token);
      return windows.find((window) => window.webContents.id === contents.id)!;
    };
    const first = await run();
    const contents = first.webContents as unknown as Electron.WebContents;
    expect(active!.export(contents, contents.mainFrame, active!.token, {
      action: 'copy', selection: { x: 0, y: 0, width: 2, height: 2 },
      image: { width: 4, height: 4, data: new Uint8Array(64) },
    })).toBe(true);
    expect(first.isVisible()).toBe(false);
    expect(first.isDestroyed()).toBe(false);
    expect(pool.forContents(contents)).toBeNull();
    const second = await run();
    expect(second).not.toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.isDestroyed()).toBe(true);
    expect(first.showInactive).toHaveBeenCalledTimes(1);
    expect(active!.isClosed).toBe(false);
    expect(second.isVisible()).toBe(true);
    expect(pool.forContents(second.webContents as unknown as Electron.WebContents)?.window.webContents.id).toBe(second.webContents.id);
    active!.close();
    pool.destroyAll();
    expect(second.isDestroyed()).toBe(true);
  });

  // Independent editor adds a new IPC owner and per-document readiness to the shared lifecycle.
  // Minimal input: close, reopen, then deliver stale or foreign document signals. tier: unit.
  // Frameless controls must minimize only their own current document (IPC ownership contract).
  it('prewarms an editor, waits for each image, reuses its window and rejects stale or foreign exports', () => {
    const result = vi.fn();
    const editor = new ScreenshotEditor(result);
    editor.registerIpc();
    editor.prewarm();
    const win = windows[0];
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const bitmap = { width: 4, height: 80, data: new Uint8Array(1280) };
    const selection = { x: 1, y: 2, width: 4, height: 8 };
    const signal = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(event, ...args);
    try {
      expect(win.isVisible()).toBe(false);
      signal(E.READY);
      expect(editor.open(bitmap, display, selection)).toBe(true);
      const first = win.webContents.send.mock.calls.find(([name]) => name === E.BEGIN)![1];
      expect(win.isVisible()).toBe(false);
      mocks.handlers.get(E.PAINTED)!({ ...event, senderFrame: {} }, first.token);
      expect(win.isVisible()).toBe(false);
      signal(E.PAINTED, first.token);
      expect(win.isVisible()).toBe(true);
      mocks.handlers.get(E.MINIMIZE)!({ ...event, sender: {} }, first.token);
      mocks.handlers.get(E.MINIMIZE)!({ ...event, senderFrame: {} }, first.token);
      signal(E.MINIMIZE, 'stale');
      expect(win.minimize).not.toHaveBeenCalled();
      signal(E.MINIMIZE, first.token);
      expect(win.minimize).toHaveBeenCalledOnce();
      expect(editor.open(bitmap, display, selection)).toBe(false);
      signal(E.CANCEL, first.token);
      expect(win.isVisible()).toBe(false);
      expect(win.isDestroyed()).toBe(false);
      expect(win.webContents.send).toHaveBeenCalledWith(E.END);
      expect(editor.open(bitmap, display, selection)).toBe(true);
      const second = win.webContents.send.mock.calls.filter(([name]) => name === E.BEGIN).at(-1)![1];
      expect(second.token).not.toBe(first.token);
      signal(E.PAINTED, first.token);
      expect(win.isVisible()).toBe(false);
      signal(E.PAINTED, second.token);
      expect(win.isVisible()).toBe(true);
      const payload = { action: 'copy', image: bitmap };
      expect(signal(E.EXPORT, first.token, payload)).toBe(false);
      expect(mocks.handlers.get(E.EXPORT)!({ ...event, sender: {} }, second.token, payload)).toBe(false);
      expect(signal(E.EXPORT, second.token, { ...payload, image: { ...bitmap, height: 8 } })).toBe(false);
      expect(signal(E.EXPORT, second.token, payload)).toBe(true);
      expect(result).toHaveBeenCalledOnce();
      expect(result.mock.calls[0][0].image.getSize()).toEqual({ width: 4, height: 80 });
      expect(result.mock.calls[0][0].selection).toEqual(selection);
      expect(windows).toHaveLength(1);
      expect(win.isVisible()).toBe(false);
    } finally { editor.dispose(); }
    expect(win.isDestroyed()).toBe(true);
  });

  // A failed React tree must not remain cached forever; retry once, then permit a fresh user open.
  it('recovers an editor rendering failure once and releases a document after repeated crashes', () => {
    const editor = new ScreenshotEditor(vi.fn());
    editor.registerIpc();
    const bitmap = { width: 2, height: 2, data: new Uint8Array(16) };
    const selection = { x: 0, y: 0, width: 2, height: 2 };
    const ready = (win: ReturnType<typeof fakeWindow>) => {
      const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
      mocks.handlers.get(E.READY)!(event);
      const payload = win.webContents.send.mock.calls.find(([name]) => name === E.BEGIN)![1];
      mocks.handlers.get(E.PAINTED)!(event, payload.token);
      return event;
    };
    try {
      expect(editor.open(bitmap, display, selection)).toBe(true);
      const first = ready(windows[0]);
      mocks.handlers.get(E.FAILED)!(first);
      expect(windows[0].isDestroyed()).toBe(true);
      expect(windows).toHaveLength(2);
      ready(windows[1]);
      expect(windows[1].isVisible()).toBe(true);
      windows[1].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      expect(windows[1].isDestroyed()).toBe(true);
      expect(windows).toHaveLength(2);
      expect(editor.open(bitmap, display, selection)).toBe(true);
      ready(windows[2]);
      expect(windows[2].isVisible()).toBe(true);
    } finally { editor.dispose(); }
  });

  it('prewarms without showing or transforming the macOS Dock identity, and reuses the shell', () => {
    pool.prewarm();
    pool.prewarm();
    expect(windows).toHaveLength(1);
    expect(windows[0].showInactive).not.toHaveBeenCalled();
    expect(windows[0].setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ skipTransformProcessType: true }),
    );
  });

  it('closes an unresponsive overlay and bounds repeated failures', () => {
    const gone = vi.fn();
    pool.setGoneHandler(gone);
    for (let i = 0; i < 4; i++) {
      pool.ensure(display);
      windows[i].emit('unresponsive');
      expect(windows[i].isDestroyed()).toBe(true);
    }
    expect(gone).toHaveBeenCalledTimes(4);
    expect(pool.ensure(display)).toBeNull();
  });

  it('accepts readiness only from the shell main frame and abandons unpainted screens', async () => {
    const overlay = pool.ensure(display)!;
    const contents = overlay.window.webContents;
    pool.markShellReady(contents, {} as Electron.WebFrameMain);
    expect(overlay.shellReady).toBe(false);
    pool.markShellReady(contents, contents.mainFrame);
    const closed = vi.fn();
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: closed,
      onResult: vi.fn(),
    });
    await session.open();
    expect(windows[0].setOpacity).not.toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.isClosed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(windows[0].isVisible()).toBe(false);
  });

  // Startup regression (unit): on two displays, the first renderer may paint
  // while the second shell is still loading. It must not reveal a frozen desktop
  // before the native windows have their final bounds and visibility.
  it('keeps both displays hidden until their startup geometry is established', async () => {
    const second = { ...display, id: display.id + 1, bounds: { ...display.bounds, x: display.bounds.width } };
    const firstOverlay = pool.ensure(display)!;
    const secondOverlay = pool.ensure(second)!;
    const first = firstOverlay.window.webContents;
    const other = secondOverlay.window.webContents;
    pool.markShellReady(first, first.mainFrame);
    const session = new RegionScreenshotSession({ pool, captures: [{ display, image }, { display: second, image }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    for (const [index, owner] of [first, other].entries()) {
      windows[index].webContents.send.mockImplementation((channel: string) => {
        if (channel === 'region-screenshot:begin') session.painted(owner, owner.mainFrame, session.token);
      });
    }
    const opening = session.open();
    try {
      await Promise.resolve();
      expect(windows[0].setOpacity).not.toHaveBeenCalledWith(1);
      pool.markShellReady(other, other.mainFrame);
      await opening;
      for (const [index, screen] of [display, second].entries()) {
        expect(windows[index].setBounds).toHaveBeenLastCalledWith(screen.bounds, false);
        expect(windows[index].setOpacity).toHaveBeenLastCalledWith(1);
      }
    } finally {
      pool.markShellReady(other, other.mainFrame);
      await opening;
      session.close();
    }
  });

  it('keeps screenshots on workArea changes but closes on scale changes', async () => {
    const overlay = pool.ensure(display)!;
    pool.markShellReady(overlay.window.webContents, overlay.window.webContents.mainFrame);
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: vi.fn(),
      onResult: vi.fn(),
    });
    await session.open();
    const change = mocks.screen.on.mock.calls.find(
      ([name]) => name === 'display-metrics-changed',
    )![1];
    change({}, display, ['workArea']);
    expect(session.isClosed).toBe(false);
    change({}, display, ['scaleFactor']);
    expect(session.isClosed).toBe(true);
  });

  it('sends pin pixel dimensions matching an exported 2x screenshot and only displays after painting', async () => {
    registerPinIpc();
    const overlay = pool.ensure(display)!;
    const contents = overlay.window.webContents;
    pool.markShellReady(contents, contents.mainFrame);
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: vi.fn(),
      onResult: ({ image: result }) => openPin(result, { x: 0, y: 0, width: 2, height: 2 }),
    });
    await session.open();
    expect(
      session.export(contents, contents.mainFrame, session.token, {
        action: 'pin',
        selection: { x: 0, y: 0, width: 2, height: 2 },
        image: { width: 4, height: 4, data: new Uint8Array(64) },
      }),
    ).toBe(true);
    const window = windows[1];
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    mocks.handlers.get(P.SHELL_READY)!(event);
    const init = window.webContents.send.mock.calls.find(([name]) => name === P.INIT)![1];
    expect(init.image.width * init.image.height * 4).toBe(init.image.data.byteLength);
    expect(window.isVisible()).toBe(false);
    mocks.handlers.get(P.PAINTED)!(event);
    expect(window.isVisible()).toBe(true);
  });

  // Unit: the editor retains the original selection, but a stitched bitmap must
  // keep its aspect ratio and fit the monitor instead of using that selection's height.
  it('pins a tall bitmap at its own aspect ratio without altering its pixels', () => {
    const screenSpy = vi.spyOn(mocks.screen, 'getDisplayMatching').mockReturnValue({
      workArea: { x: -800, y: 0, width: 800, height: 600 },
    });
    try {
      registerPinIpc();
      const pixels = Buffer.alloc(200 * 800 * 4);
      openPin({ getSize: () => ({ width: 200, height: 800 }), toBitmap: () => pixels } as NativeImage,
        { x: -200, y: 400, width: 200, height: 100 });
      const window = windows.at(-1)!;
      const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
      mocks.handlers.get(P.SHELL_READY)!(event);
      const init = window.webContents.send.mock.calls.find(([name]) => name === P.INIT)![1];
      expect({ width: init.image.width, height: init.image.height, bytes: init.image.data.byteLength })
        .toEqual({ width: 200, height: 800, bytes: pixels.byteLength });
      mocks.handlers.get(P.PAINTED)!(event);
      expect(window.setBounds).toHaveBeenCalledWith({ x: -200, y: 0, width: 150, height: 600 }, false);
    } finally { screenSpy.mockRestore(); }
  });

  it('destroys a pin that never paints instead of showing a black window', async () => {
    openPin(image, { x: 0, y: 0, width: 2, height: 2 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(windows[0].isDestroyed()).toBe(true);
    expect(windows[0].showInactive).not.toHaveBeenCalled();
  });

  it('shares Escape without unregistering voice cancellation when a screenshot closes', () => {
    const voice = vi.fn();
    const releaseVoice = acquireOverlayEscape(voice)!;
    const screenshot = vi.fn(() => releaseScreenshot());
    const releaseScreenshot = acquireOverlayEscape(screenshot, 10)!;
    const escape = mocks.register.mock.calls[0][1] as () => void;
    escape();
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(voice).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
    escape();
    expect(voice).toHaveBeenCalledTimes(1);
    releaseVoice();
    releaseScreenshot();
    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith('Escape');
  });

  it('contains synchronous window creation failures during prewarm', () => {
    mocks.create.mockImplementation(() => {
      throw new Error('window unavailable');
    });
    expect(() => pool.prewarm()).not.toThrow();
    expect(pool.ensure(display)).toBeNull();
  });

  it('forwards Escape to the focused editor without handing it to voice input', async () => {
    const voice = vi.fn();
    const releaseVoice = acquireOverlayEscape(voice)!;
    const overlay = pool.ensure(display)!;
    const contents = overlay.window.webContents;
    pool.markShellReady(contents, contents.mainFrame);
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: vi.fn(),
      onResult: vi.fn(),
    });
    await session.open();
    windows[0].isFocused.mockReturnValue(true);
    session.focused(contents, contents.mainFrame, session.token);
    const escape = mocks.register.mock.calls[0][1];
    escape();
    expect(windows[0].webContents.sendInputEvent).toHaveBeenCalledWith({
      type: 'keyDown',
      keyCode: 'Escape',
    });
    expect(session.isClosed).toBe(false);
    expect(voice).not.toHaveBeenCalled();
    session.close();
    escape();
    expect(voice).toHaveBeenCalledTimes(1);
    releaseVoice();
  });
});
