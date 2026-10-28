import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Value: real IPC boundary with injected Electron, including first-use permission
// and native window restoration. No desktop pixels or system permissions involved.
type Handler = (event: { sender: unknown }, value?: unknown) => unknown;
const env = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  permission: 'not-determined',
  settings: {
    allowScreen: true,
    passThroughBackground: true,
    passThroughUserMessages: true,
    passThroughAssistantMessages: true,
    passThroughComposer: false,
  },
  shortcutCombo: { code: 'KeyH', meta: true, ctrl: false, alt: false, shift: true } as
    object | null,
  shortcutListeners: new Set<() => void>(),
  recordingListeners: new Set<(active: boolean) => void>(),
  shortcuts: new Map<string, () => void>(),
  shortcutAvailable: true,
  windowState: { bounds: null as { x: number; y: number; width: number; height: number } | null },
}));
vi.mock('../../app-shortcuts', () => ({
  getAppShortcutStore: () => ({
    getEffectiveCombos: () => (env.shortcutCombo ? [env.shortcutCombo] : []),
    subscribe: (listener: () => void) => env.shortcutListeners.add(listener),
  }),
  isAppShortcutRecordingActive: () => false,
  subscribeAppShortcutRecording: (listener: (active: boolean) => void) =>
    env.recordingListeners.add(listener),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/hud-test' },
  ipcMain: { handle: (name: string, fn: Handler) => env.handlers.set(name, fn) },
  globalShortcut: {
    isRegistered: (key: string) => env.shortcuts.has(key),
    register: (key: string, callback: () => void) => {
      if (!env.shortcutAvailable) return false;
      env.shortcuts.set(key, callback);
      return true;
    },
    unregister: (key: string) => env.shortcuts.delete(key),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 500 }),
    getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
  },
  systemPreferences: { getMediaAccessStatus: () => env.permission },
  shell: { openExternal: vi.fn() },
  desktopCapturer: {
    getSources: vi.fn(async () => [
      { display_id: '1', thumbnail: { isEmpty: () => false, toPNG: () => new Uint8Array([42]) } },
    ]),
  },
}));
vi.mock('../../maker-host/override-settings-file', () => ({
  createOverrideSettingsFile: ({ label }: { label: string }) => ({
    invalidateIfChanged() {},
    read: () => (label === 'hud-window' ? env.windowState : env.settings),
    writePatch: (patch: object) =>
      Object.assign(label === 'hud-window' ? env.windowState : env.settings, patch),
    reset() {},
  }),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({}) }));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../utils/ipcValidate', () => ({
  throwIpcError: (_code: string, message: string) => {
    throw new Error(message);
  },
}));
import { attachHudWindow, registerHudIpc, rememberHudAppearance } from '../ipc';
import { desktopCapturer, type BrowserWindow } from 'electron';
function windowMock() {
  const events = new Map<string, () => void>();
  return {
    events,
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    getNormalBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    getMinimumSize: () => [500, 400],
    getBackgroundColor: () => '#fff',
    setAlwaysOnTop: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    setWindowButtonVisibility: vi.fn(),
    setMinimumSize: vi.fn(),
    setBackgroundColor: vi.fn(),
    setVibrancy: vi.fn(),
    setBounds: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isVisible: () => true,
    hide: vi.fn(),
    showInactive: vi.fn(),
    on: (name: string, fn: () => void) => events.set(name, fn),
    webContents: { isDestroyed: () => false, send: vi.fn(), on: vi.fn() },
  };
}
registerHudIpc();
describe('HUD native IPC lifecycle', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeAll(() =>
    Object.defineProperty(process, 'platform', { configurable: true, get: () => 'darwin' }),
  );
  afterAll(() => Object.defineProperty(process, 'platform', platform));
  it('rejects HUD activation on unsupported platforms without changing the window', async () => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const win = windowMock();
      attachHudWindow(win as unknown as BrowserWindow);
      await expect(
        env.handlers.get('hud:active')!({ sender: win.webContents }, true),
      ).rejects.toThrow('HUD_UNSUPPORTED');
      expect(win.setBounds).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
    env.permission = 'not-determined';
    env.settings.allowScreen = true;
    env.windowState.bounds = null;
    env.shortcutAvailable = true;
    env.shortcutCombo = { code: 'KeyH', meta: true, ctrl: false, alt: false, shift: true };
    env.shortcuts.clear();
    env.settings.passThroughBackground = true;
    env.settings.passThroughUserMessages = true;
    env.settings.passThroughAssistantMessages = true;
    env.settings.passThroughComposer = false;
    vi.clearAllMocks();
  });
  it('preserves the pre-maximize rectangle after HUD exits and the user unmaximizes', async () => {
    const normal = { x: 80, y: 90, width: 900, height: 650 };
    const zoomed = { x: 0, y: 0, width: 1440, height: 900 };
    let bounds = zoomed;
    let normalBounds = normal;
    let maximized = true;
    const win = windowMock();
    win.getBounds = () => bounds;
    win.getNormalBounds = () => normalBounds;
    win.isMaximized = () => maximized;
    win.setBounds.mockImplementation((value) => {
      bounds = value;
      if (!maximized) normalBounds = value;
    });
    win.unmaximize.mockImplementation(() => {
      maximized = false;
      bounds = normalBounds;
    });
    win.maximize.mockImplementation(() => {
      normalBounds = bounds;
      maximized = true;
      bounds = zoomed;
    });
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    await env.handlers.get('hud:active')!(event, false);
    expect(maximized).toBe(true);
    win.unmaximize();
    expect(bounds).toEqual(normal);
  });
  it('waits for other global shortcuts to release their old keys when restoring defaults', async () => {
    env.shortcutCombo = { code: 'KeyA', meta: false, ctrl: true, alt: false, shift: true };
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    env.handlers.get('hud:pointer-region')!(event, 'background');
    env.shortcuts.get('Ctrl+Shift+A')!();
    const screenshot = vi.fn();
    env.shortcuts.set('Shift+Command+H', screenshot);
    env.shortcutCombo = { code: 'KeyH', meta: true, ctrl: false, alt: false, shift: true };
    env.shortcutListeners.forEach((fn) => fn());
    // The screenshot subscriber runs later in the same store notification.
    env.shortcuts.delete('Shift+Command+H');
    env.shortcuts.set('Ctrl+Shift+A', screenshot);
    await Promise.resolve();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: true });
    expect(env.shortcuts.has('Shift+Command+H')).toBe(true);
    env.shortcuts.get('Shift+Command+H')!();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: false });
    env.shortcuts.get('Ctrl+Shift+A')!();
    expect(screenshot).toHaveBeenCalledOnce();
    await env.handlers.get('hud:active')!(event, false);
  });

  it('hot-swaps the configured shortcut, pauses recording, and fails closed on removal/conflict', async () => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    env.handlers.get('hud:pointer-region')!(event, 'background');
    const oldCallback = [...env.shortcuts.values()][0];
    oldCallback();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: true });
    env.shortcutCombo = { code: 'KeyJ', meta: true, ctrl: false, alt: false, shift: true };
    env.shortcutListeners.forEach((fn) => fn());
    await Promise.resolve();
    expect([...env.shortcuts.keys()]).toEqual(['Shift+Command+J']);
    oldCallback(); // queued old registration must not toggle the new one
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: true });
    env.recordingListeners.forEach((fn) => fn(true));
    expect(env.shortcuts.size).toBe(0);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    env.recordingListeners.forEach((fn) => fn(false));
    expect([...env.shortcuts.keys()]).toEqual(['Shift+Command+J']);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    env.shortcutCombo = null;
    env.shortcutListeners.forEach((fn) => fn());
    await Promise.resolve();
    expect(env.shortcuts.size).toBe(0);
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: false });
    env.shortcutCombo = { code: 'KeyH', meta: true, ctrl: false, alt: false, shift: true };
    env.shortcutListeners.forEach((fn) => fn());
    await Promise.resolve();
    [...env.shortcuts.values()][0]();
    env.shortcutAvailable = false;
    env.shortcutCombo = { code: 'KeyK', meta: true, ctrl: false, alt: false, shift: true };
    env.shortcutListeners.forEach((fn) => fn());
    await Promise.resolve();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: false });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    await env.handlers.get('hud:active')!(event, false);
  });
  async function runCapture(close: boolean) {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    env.handlers.get('hud:active')!(event, true);
    const pending = env.handlers.get('hud:capture')!(event, {
      text: '这个界面说的是什么？',
      explicit: false,
    });
    const outcome = Promise.resolve(pending).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (close) win.events.get('close')!();
    await vi.runAllTimersAsync();
    const result = await outcome;
    env.handlers.get('hud:active')!(event, false);
    return { win, result };
  }
  it('allows the first authorized capture to reach the OS permission prompt', async () => {
    const { win, result } = await runCapture(false);
    expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: new Uint8Array([42]) });
    expect(win.showInactive).toHaveBeenCalledTimes(1);
  });
  it('rejects denied OS permission before hiding or reading pixels', async () => {
    env.permission = 'denied';
    const { win, result } = await runCapture(false);
    expect('error' in result && result.error.message).toBe('HUD_SCREEN_PERMISSION');
    expect(win.hide).not.toHaveBeenCalled();
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
  });
  it('does not reopen a window closed during capture and discards its pixels', async () => {
    const { win, result } = await runCapture(true);
    expect('error' in result && result.error.message).toBe('HUD_INACTIVE');
    expect(win.showInactive).not.toHaveBeenCalled();
  });
  // Cancel during the hide animation: an off/on pair must not start an OS
  // screenshot for the old request. Earlier coverage only checked delivered bytes.
  it.each(['exit', 'reopen', 'permission'] as const)('does not read pixels after cancellation during capture delay: %s', async change => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    const pending = Promise.resolve(env.handlers.get('hud:capture')!(event, {
      text: '这个界面说的是什么？', explicit: false,
    })).then(() => null, error => error);
    if (change === 'permission') {
      env.handlers.get('hud:settings')!(event, { allowScreen: false });
      env.handlers.get('hud:settings')!(event, { allowScreen: true });
    } else {
      await env.handlers.get('hud:active')!(event, false);
      if (change === 'reopen') await env.handlers.get('hud:active')!(event, true);
    }
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ active: change !== 'exit', capturing: false });
    await env.handlers.get('hud:active')!(event, false);
  });
  it('restores the window after native capture failure and allows the next request', async () => {
    vi.mocked(desktopCapturer.getSources).mockRejectedValueOnce(new Error('WindowServer unavailable'));
    const first = await runCapture(false);
    expect('error' in first.result && first.result.error.message).toBe('HUD_CAPTURE_FAILED');
    expect(first.win.showInactive).toHaveBeenCalledOnce();
    const retry = await runCapture(false);
    expect(retry.result).toEqual({ value: new Uint8Array([42]) });
    expect(retry.win.showInactive).toHaveBeenCalledOnce();
  });
  it('restores the latest authoritative theme instead of hard-coding vibrancy', async () => {
    rememberHudAppearance({ vibrancy: null, backgroundColor: '#1f1f1e' });
    const { win } = await runCapture(false);
    expect(win.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#1f1f1e');
  });
  // Regression: the HUD entry used to reject macOS fullscreen outright.
  it('leaves fullscreen before entering HUD and restores fullscreen on exit', async () => {
    const win = windowMock();
    let fullscreen = true;
    win.isFullScreen = () => fullscreen;
    const nativeWin = Object.assign(win, {
      once: (name: string, fn: () => void) => win.events.set(name, fn),
      removeListener: (name: string) => win.events.delete(name),
      setFullScreen: vi.fn((value: boolean) => {
        fullscreen = value;
        if (!value) win.events.get('leave-full-screen')?.();
      }),
    });
    attachHudWindow(nativeWin as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    expect(fullscreen).toBe(false);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
    await env.handlers.get('hud:active')!(event, false);
    expect(fullscreen).toBe(true);
  });
  // PR #7336: a timed-out native transition must not leak restoration state
  // into a later HUD visit. Real IPC entry, fake OS event/timer (unit).
  it('does not restore stale fullscreen after a timed-out entry and retry', async () => {
    const win = windowMock();
    let fullscreen = true;
    win.isFullScreen = () => fullscreen;
    const nativeWin = Object.assign(win, {
      once: (name: string, fn: () => void) => win.events.set(name, fn),
      removeListener: (name: string) => win.events.delete(name),
      setFullScreen: vi.fn((value: boolean) => { fullscreen = value; }),
    });
    attachHudWindow(nativeWin as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    const result = Promise.resolve(env.handlers.get('hud:active')!(event, true))
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('HUD_FULLSCREEN');
    expect(win.events.has('leave-full-screen')).toBe(false);
    await env.handlers.get('hud:active')!(event, true);
    await env.handlers.get('hud:active')!(event, false);
    expect(fullscreen).toBe(false);
    expect(nativeWin.setFullScreen).not.toHaveBeenCalledWith(true);
    expect(env.shortcuts.size).toBe(0);
  });
  it('cancels pending fullscreen entry when the macOS window is closed', async () => {
    const win = windowMock();
    let fullscreen = true;
    win.isFullScreen = () => fullscreen;
    const nativeWin = Object.assign(win, {
      once: (name: string, fn: () => void) => win.events.set(name, fn),
      removeListener: (name: string) => win.events.delete(name),
      setFullScreen: (value: boolean) => {
        fullscreen = value;
      },
    });
    attachHudWindow(nativeWin as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    const pending = env.handlers.get('hud:active')!(event, true);
    const outcome = Promise.resolve(pending).then(
      () => 'entered',
      (error) => error.message,
    );
    win.events.get('close')!();
    win.events.get('leave-full-screen')!();
    expect(await outcome).toBe('HUD_INACTIVE');
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ active: false });
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });
  // Unit: real IPC entry; missing coverage for native layer changes, bounds and restoration.
  // Minimal input: one upward step from the default floating layer.
  it('honors a rapid exit while native fullscreen entry is still waiting', async () => {
    const win = windowMock();
    let fullscreen = true;
    win.isFullScreen = () => fullscreen;
    const nativeWin = Object.assign(win, {
      once: (name: string, fn: () => void) => win.events.set(name, fn),
      removeListener: (name: string) => win.events.delete(name),
      setFullScreen: vi.fn((value: boolean) => { fullscreen = value; }),
    });
    attachHudWindow(nativeWin as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    const enter = env.handlers.get('hud:active')!(event, true);
    const exit = env.handlers.get('hud:active')!(event, false);
    win.events.get('leave-full-screen')!();
    await Promise.all([enter, exit]);
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ active: false, passThrough: false });
    expect(fullscreen).toBe(true);
    expect(env.shortcuts.size).toBe(0);
  });
  it('steps native window levels within bounds and restores the original window on exit', async () => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ layer: 1 });
    const shift = (step: number) => env.handlers.get('hud:layer')!(event, step);
    expect(shift(1)).toMatchObject({ layer: 2 });
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'modal-panel');
    expect(shift(1)).toMatchObject({ layer: 2 });
    expect(shift(-1)).toMatchObject({ layer: 1 });
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
    expect(shift(-1)).toMatchObject({ layer: 0 });
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(shift(-1)).toMatchObject({ layer: 0 });
    shift(1);
    await env.handlers.get('hud:active')!(event, false);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });
  it('rejects invalid, inactive and secondary-window layer requests without native changes', async () => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    const shift = env.handlers.get('hud:layer')!;
    expect(() => shift(event, 1)).toThrow('HUD_INACTIVE');
    await env.handlers.get('hud:active')!(event, true);
    win.setAlwaysOnTop.mockClear();
    for (const invalid of [0, 2, '1', null]) {
      expect(() => shift(event, invalid)).toThrow('Invalid HUD layer step');
    }
    expect(() => shift({ sender: {} }, 1)).toThrow('HUD_PRIMARY_WINDOW_ONLY');
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    await env.handlers.get('hud:active')!(event, false);
  });
  // Unit: native move/resize through real IPC lifecycle; prior coverage did not
  // preserve HUD geometry or clear transient motion after idle/exit.
  it('remembers HUD geometry across windows, without saving restored main-window bounds', async () => {
    const win = windowMock();
    let bounds = { x: 0, y: 0, width: 1000, height: 700 };
    win.getBounds = () => bounds;
    win.setBounds.mockImplementation((value) => {
      bounds = value;
    });
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    bounds = { x: 130, y: 150, width: 600, height: 400 };
    win.events.get('move')?.();
    win.events.get('resize')?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(env.windowState.bounds).toEqual(bounds);
    await env.handlers.get('hud:active')!(event, false);
    expect(bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    const next = windowMock();
    attachHudWindow(next as unknown as BrowserWindow);
    const nextEvent = { sender: next.webContents };
    await env.handlers.get('hud:active')!(nextEvent, true);
    expect(next.setBounds).toHaveBeenLastCalledWith({ x: 130, y: 150, width: 600, height: 400 });
    await env.handlers.get('hud:active')!(nextEvent, false);
  });
  it('restores offscreen remembered bounds into the current display work area', async () => {
    env.windowState.bounds = { x: 5000, y: -400, width: 1800, height: 900 };
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    await env.handlers.get('hud:active')!(event, false);
  });
  it('keeps moving state until idle, clears it on exit and never rewrites transparency settings', async () => {
    const win = windowMock();
    let bounds = { x: 0, y: 0, width: 1000, height: 700 };
    win.getBounds = () => bounds;
    win.setBounds.mockImplementation((value) => {
      bounds = value;
    });
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    const settings = { ...env.settings };
    bounds = { ...bounds, x: 20 };
    win.events.get('move')?.();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ moving: true });
    await vi.advanceTimersByTimeAsync(100);
    bounds = { ...bounds, x: 40 };
    win.events.get('move')?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ moving: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ moving: false });
    bounds = { ...bounds, x: 60 };
    win.events.get('move')?.();
    await env.handlers.get('hud:active')!(event, false);
    await vi.runAllTimersAsync();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ moving: false, active: false });
    expect(env.settings).toEqual(settings);
    expect(env.windowState.bounds?.x).toBe(60);
  });
  // Unit: primary IPC + native boundary. Protects selective hit testing and the
  // recovery path; previous HUD tests had no click-through/shortcut coverage.
  it('passes selected regions through but keeps the composer usable until explicitly selected', async () => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    expect(env.handlers.get('hud:pass-through')!(event, true)).toMatchObject({ passThrough: true });
    env.handlers.get('hud:pointer-region')!(event, 'background');
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    env.handlers.get('hud:pointer-region')!(event, 'composer');
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    env.handlers.get('hud:settings')!(event, { passThroughComposer: true });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    env.handlers.get('hud:pointer-region')!(event, 'controls');
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    await env.handlers.get('hud:active')!(event, false);
    expect(env.shortcuts.size).toBe(0);
  });
  it('toggles pass-through in both directions with one shortcut until HUD exits', async () => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    expect(env.shortcuts.size).toBe(1);
    const toggle = Array.from(env.shortcuts.values())[0];
    env.handlers.get('hud:pointer-region')!(event, 'background');
    toggle();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: true });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    toggle();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ active: true, passThrough: false });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(env.shortcuts.size).toBe(1);
    toggle();
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: true });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await env.handlers.get('hud:active')!(event, false);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(env.shortcuts.size).toBe(0);
    toggle(); // A queued native key event after HUD exit must not re-enable it.
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: false });
  });
  it('refuses an unsafe editing shortcut at the native registration boundary', async () => {
    env.shortcutCombo = { code: 'KeyY', meta: true, ctrl: false, alt: false, shift: false };
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    await env.handlers.get('hud:active')!(event, true);
    try {
      expect(env.shortcuts.has('Command+Y')).toBe(false);
      expect(() => env.handlers.get('hud:pass-through')!(event, true)).toThrow(
        'HUD_SHORTCUT_UNAVAILABLE',
      );
      expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: false });
    } finally {
      await env.handlers.get('hud:active')!(event, false);
    }
  });

  it('does not enable without a recovery shortcut and rejects untrusted region reports', async () => {
    const win = windowMock();
    attachHudWindow(win as unknown as BrowserWindow);
    const event = { sender: win.webContents };
    env.shortcutAvailable = false;
    await env.handlers.get('hud:active')!(event, true);
    expect(() => env.handlers.get('hud:pass-through')!(event, true)).toThrow(
      'HUD_SHORTCUT_UNAVAILABLE',
    );
    expect(env.handlers.get('hud:get')!(event)).toMatchObject({ passThrough: false });
    expect(() => env.handlers.get('hud:pointer-region')!(event, 'anything')).toThrow(
      'Invalid HUD pointer region',
    );
    expect(() => env.handlers.get('hud:pointer-region')!({ sender: {} }, 'background')).toThrow(
      'HUD_PRIMARY_WINDOW_ONLY',
    );
    await env.handlers.get('hud:active')!(event, false);
  });
  it('rejects secondary renderers', () => {
    expect(() => env.handlers.get('hud:get')!({ sender: {} })).toThrow('HUD_PRIMARY_WINDOW_ONLY');
  });
});
