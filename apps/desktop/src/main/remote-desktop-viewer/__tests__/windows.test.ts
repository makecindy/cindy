import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  windows: [] as any[],
  handlers: new Map<string, Function>(),
  calls: [] as any[],
  owner: 'a:1',
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { readText: () => '', writeText: vi.fn() },
  ipcMain: { handle: (name: string, fn: Function) => fixture.handlers.set(name, fn) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => fixture.owner,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../appCapabilities', () => ({
  getAppCapabilities: () => ({ canUseDeviceLink: true }),
}));
vi.mock('../../i18n', () => ({ t: (s: string) => s }));
vi.mock('../../device-link/index', () => ({
  getSelfDeviceId: () => 'local',
  remoteInvoke: vi.fn(async (...args: any[]) => {
    args[3]?.preSend?.();
    fixture.calls.push(args);
    return { ok: true, result: { lease: 'lease-' + args[0] } };
  }),
}));
vi.mock('../../remote-desktop/iceConfig', () => ({ loadDesktopIceServers: async () => [] }));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => {},
  isTrustedTopLevelCindyRendererEvent: (event: any) => event.senderFrame === event.sender.mainFrame,
  isTrustedCindyRendererWindow: () => true,
}));
vi.mock('../../utils/ipcValidate', () => ({
  throwIpcError: (_code: string, message: string) => {
    throw new Error(message);
  },
}));
vi.mock('../../resource-usage-window/window', () => ({
  createResourceUsageWindow: () => {
    const window: any = new EventEmitter();
    const contents: any = new EventEmitter();
    let visible = false,
      destroyed = false;
    Object.assign(contents, {
      id: fixture.windows.length + 1,
      mainFrame: {},
      isDestroyed: () => destroyed,
      send: vi.fn(),
      setIgnoreMenuShortcuts: vi.fn(),
    });
    Object.assign(window, {
      webContents: contents,
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => false,
      isFullScreen: () => false,
      setTitle: vi.fn(),
      setFullScreen: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      isFocused: () => visible,
      show: () => {
        visible = true;
        window.emit('show');
      },
      hide: () => {
        visible = false;
        window.emit('hide');
      },
      destroy: () => {
        destroyed = true;
        window.emit('closed');
      },
    });
    fixture.windows.push(window);
    return window;
  },
}));
import { RemoteDesktopViewerWindows } from '../windows';
import { REMOTE_VIEWER } from '../../../shared/remoteDesktopViewer';
let manager: RemoteDesktopViewerWindows;
afterEach(() => {
  manager?.reset();
  fixture.windows = [];
  fixture.calls = [];
  fixture.handlers.clear();
  fixture.owner = 'a:1';
});
const event = (win: any) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
const call = (channel: string, win: any, ...args: unknown[]) =>
  fixture.handlers.get(channel)!(event(win), ...args);
it('routes native close and the close shortcut to confirmation without ending the lease', () => {
  const sender: any = { id: 100 };
  manager = new RemoteDesktopViewerWindows((value) => value === sender);
  manager.register();
  manager.open(sender, { deviceId: 'a', name: 'A' });
  const win = fixture.windows[0];
  call(REMOTE_VIEWER.READY, win);
  call(REMOTE_VIEWER.PRESENTED, win);
  const state = call(REMOTE_VIEWER.STATE, win);
  const preventDefault = vi.fn();
  win.emit('close', { preventDefault });
  win.webContents.emit(
    'before-input-event',
    { preventDefault },
    {
      type: 'keyDown',
      code: 'KeyW',
      control: true,
    },
  );
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(win.webContents.send).toHaveBeenCalledWith(
    REMOTE_VIEWER.CLOSE_REQUESTED,
    state.generation,
  );
  expect(win.isVisible()).toBe(true);
  expect(call(REMOTE_VIEWER.STATE, win).active).toBe(true);
  call(REMOTE_VIEWER.CLOSE, win, state.generation - 1);
  expect(win.isVisible()).toBe(true);
  call(REMOTE_VIEWER.CLOSE, win, state.generation);
  expect(win.isVisible()).toBe(false);
  manager.open(sender, { deviceId: 'a', name: 'A' });
  call(REMOTE_VIEWER.CLOSE, win, state.generation);
  expect(call(REMOTE_VIEWER.STATE, win).active).toBe(true);
  expect(win.isVisible()).toBe(true);
});
it('prewarms without network or focus, reuses the target window and cleans only its lease', async () => {
  const sender: any = { id: 100 };
  manager = new RemoteDesktopViewerWindows((value) => value === sender);
  manager.register();
  manager.prewarm();
  const a = fixture.windows[0];
  call(REMOTE_VIEWER.READY, a);
  call(REMOTE_VIEWER.PRESENTED, a);
  expect(fixture.calls).toHaveLength(0);
  expect(a.focus).not.toHaveBeenCalled();
  expect(a.isVisible()).toBe(false);
  manager.open(sender, { deviceId: 'a', name: 'A' });
  const size = fixture.windows.length;
  manager.open(sender, { deviceId: 'a', name: 'A' });
  expect(fixture.windows).toHaveLength(size);
  const aState = call(REMOTE_VIEWER.STATE, a);
  await call(REMOTE_VIEWER.REQUEST, a, aState.generation, { op: 'start', displayId: 'screen' });
  manager.open(sender, { deviceId: 'b', name: 'B' });
  const b = fixture.windows[1];
  call(REMOTE_VIEWER.READY, b);
  call(REMOTE_VIEWER.PRESENTED, b);
  const bState = call(REMOTE_VIEWER.STATE, b);
  await call(REMOTE_VIEWER.REQUEST, b, bState.generation, { op: 'start', displayId: 'screen' });
  call(REMOTE_VIEWER.CLOSE, a, aState.generation);
  await Promise.resolve();
  expect(call(REMOTE_VIEWER.STATE, b).active).toBe(true);
  expect(fixture.calls.filter((c) => c[2][0].op === 'stop').map((c) => c[0])).toEqual(['a']);
  expect(a.isDestroyed()).toBe(false);
});
it('rejects subframes and stale window/account generations even with a valid channel', async () => {
  const sender: any = { id: 100 };
  manager = new RemoteDesktopViewerWindows((value) => value === sender);
  manager.register();
  manager.open(sender, { deviceId: 'a', name: 'A' });
  const a = fixture.windows[0];
  call(REMOTE_VIEWER.READY, a);
  call(REMOTE_VIEWER.PRESENTED, a);
  await expect(
    fixture.handlers.get(REMOTE_VIEWER.REQUEST)!({ sender: a.webContents, senderFrame: {} }, 1, {
      op: 'capabilities',
    }),
  ).rejects.toThrow('Invalid viewer');
  const state = call(REMOTE_VIEWER.STATE, a);
  fixture.owner = 'b:2';
  await expect(
    call(REMOTE_VIEWER.REQUEST, a, state.generation, { op: 'capabilities' }),
  ).rejects.toThrow('DESKTOP_STOPPED');
  expect(fixture.calls).toHaveLength(0);
});
