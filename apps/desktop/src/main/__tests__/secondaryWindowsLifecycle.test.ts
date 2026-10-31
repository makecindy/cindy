import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ windows: [] as unknown[], warn: vi.fn() }));

class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), send: vi.fn() });
  destroyed = false;
  show = vi.fn();
  setBackgroundColor = vi.fn();
  setVibrancy = vi.fn();
  rejectLoad!: (error: unknown) => void;
  resolveLoad!: () => void;
  load = new Promise<void>((resolve, reject) => {
    this.resolveLoad = resolve;
    this.rejectLoad = reject;
  });
  loadURL = vi.fn((_url: string) => this.load);
  loadFile = vi.fn((_path: string, _options: unknown) => this.load);
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('closed');
  });
  isDestroyed() { return this.destroyed; }
  constructor(readonly options: Record<string, unknown>) {
    super();
    harness.windows.push(this);
  }
  fail(code = -105, mainFrame = true) {
    this.webContents.emit('did-fail-load', {}, code, 'private error description', 'file:///private/entry.html', mainFrame);
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class { constructor(options: Record<string, unknown>) { return new FakeWindow(options); } },
  app: { isPackaged: false },
  nativeTheme: { shouldUseDarkColors: false },
  screen: {},
  shell: { openExternal: vi.fn() },
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: harness.warn }) }));
vi.mock('../app-shortcuts/new-maker-window-shortcut.js', () => ({ installNewMakerWindowShortcut: vi.fn() }));
vi.mock('../windowFocusClassifier.js', () => ({ markAppContentWindow: vi.fn(), isAppContentWindow: vi.fn() }));
vi.mock('../window-behavior-settings-store.js', () => ({ readWindowBehaviorSettings: () => ({ swallowActivationClick: false }) }));
vi.mock('../selection-context-menu.js', () => ({ installSelectionContextMenu: vi.fn() }));
vi.mock('../appearance-settings-ipc.js', () => ({ applyAppearanceToWindow: vi.fn() }));
vi.mock('../mainWindowFullscreenStartup.js', () => ({ installWindowFullscreenStateBroadcast: vi.fn() }));
vi.mock('../window-theme-mode-store.js', () => ({ readWindowThemeSnapshot: () => null }));

import { applyVibrancyToSecondaryWindows, isSecondaryAppWindow, openSessionInNewWindow } from '../secondary-windows.js';

function open(dev: boolean) {
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', dev ? 'http://localhost:5173/' : undefined);
  openSessionInNewWindow('session & id', null, 'device id');
  const win = harness.windows.at(-1) as FakeWindow;
  expect(win.options.show).toBe(false);
  return win;
}

beforeEach(() => {
  harness.windows.length = 0;
  harness.warn.mockClear();
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'index');
});
afterEach(() => {
  for (const win of harness.windows as FakeWindow[]) {
    win.resolveLoad();
    if (!win.destroyed) win.destroy();
  }
  vi.unstubAllGlobals();
});

describe.each([true, false])('secondary window lifecycle (dev=%s)', (dev) => {
  it('keeps the boot route and load API intact', () => {
    const win = open(dev);
    if (dev) {
      expect(win.loadFile).not.toHaveBeenCalled();
      const url = new URL(win.loadURL.mock.calls[0][0]);
      expect(url.searchParams.get('bootSession')).toBe('session & id');
      expect(url.searchParams.get('bootDevice')).toBe('device id');
      expect(url.searchParams.get('secondaryWindow')).toBe('1');
      expect(url.hash).toBe('#/cc-agent/boot');
    } else {
      expect(win.loadURL).not.toHaveBeenCalled();
      expect(win.loadFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('renderer', 'index', 'index.html')),
        { query: { secondaryWindow: '1', bootSession: 'session & id', bootDevice: 'device id' }, hash: '/cc-agent/boot' },
      );
    }
  });

  it('destroys an unshown window once when event and Promise report the same failure', async () => {
    const win = open(dev);
    expect(isSecondaryAppWindow(win as never)).toBe(true);
    win.fail();
    win.rejectLoad({ errno: -105, code: 'ERR_NAME_NOT_RESOLVED', url: 'file:///private/entry.html' });
    await Promise.resolve();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(isSecondaryAppWindow(win as never)).toBe(false);
    // Collection cleanup must also remove it from appearance updates.
    win.destroyed = false;
    applyVibrancyToSecondaryWindows('cindy', false);
    expect(win.setBackgroundColor).not.toHaveBeenCalled();
    expect(harness.warn.mock.calls.every(([, fields]) =>
      Object.keys(fields).sort().join(',') === 'errorCode,sessionId',
    )).toBe(true);
  });

  it('handles a Promise-only initial failure and ignores late show events', async () => {
    const win = open(dev);
    win.rejectLoad(new Error('private path / missing file'));
    await Promise.resolve();
    win.emit('ready-to-show');
    win.webContents.emit('did-finish-load');
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
  });

  it.each([{ errno: -3 }, { code: 'ERR_ABORTED' }])('keeps cancelled loads available for later success (%j)', async (error) => {
    const win = open(dev);
    win.fail(-3);
    win.rejectLoad(error);
    await Promise.resolve();
    expect(win.destroy).not.toHaveBeenCalled();
    win.webContents.emit('did-finish-load');
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('ignores subframe failures', () => {
    const win = open(dev);
    win.fail(-105, false);
    expect(win.destroy).not.toHaveBeenCalled();
    win.emit('ready-to-show');
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it.each(['ready-to-show', 'did-finish-load'])('shows once with %s first and retains later reload failures', async (first) => {
    const win = open(dev);
    if (first === 'ready-to-show') win.emit(first);
    win.webContents.emit('did-finish-load');
    win.emit('ready-to-show');
    expect(win.show).toHaveBeenCalledTimes(1);
    // No isVisible check: a previously shown but currently hidden window is retained.
    win.fail();
    win.rejectLoad({ errno: -105 });
    await Promise.resolve();
    expect(win.destroy).not.toHaveBeenCalled();
    expect(isSecondaryAppWindow(win as never)).toBe(true);
  });
});
