import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

const mocks = vi.hoisted(() => ({
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  installWindowZoomRestoration: vi.fn(),
  windowOptions: [] as Array<Record<string, unknown>>,
  windows: [] as Array<{
    webContents: { on: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn> };
    once: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  }>,
}));
vi.mock('electron', () => ({
  BrowserWindow: class {
    static fromWebContents(contents: unknown) {
      return mocks.windows.find((w) => w.webContents === contents) ?? null;
    }
    webContents = { on: vi.fn(), once: vi.fn(), setWindowOpenHandler: vi.fn() };
    once = vi.fn();
    hookWindowMessage = vi.fn();
    unhookWindowMessage = vi.fn();
    removeListener = vi.fn();
    isDestroyed = () => false;
    loadURL = mocks.loadURL;
    loadFile = mocks.loadFile;
    constructor(options: Record<string, unknown>) {
      mocks.windowOptions.push(options);
      mocks.windows.push(this as never);
    }
  },
  app: { isPackaged: false },
  nativeTheme: { shouldUseDarkColors: false },
  screen: {},
  shell: {},
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock('../app-shortcuts/new-maker-window-shortcut.js', () => ({
  installNewMakerWindowShortcut: vi.fn(),
}));
vi.mock('../windowFocusClassifier.js', () => ({
  markAppContentWindow: vi.fn(),
  isAppContentWindow: vi.fn(),
}));
vi.mock('../window-behavior-settings-store.js', () => ({
  readWindowBehaviorSettings: () => ({ swallowActivationClick: false }),
}));
vi.mock('../selection-context-menu.js', () => ({ installSelectionContextMenu: vi.fn() }));
vi.mock('../appearance-settings-ipc.js', () => ({
  applyAppearanceToWindow: vi.fn(),
  installWindowZoomRestoration: mocks.installWindowZoomRestoration,
}));
vi.mock('../mainWindowFullscreenStartup.js', () => ({
  installWindowFullscreenStateBroadcast: vi.fn(),
}));
vi.mock('../window-theme-mode-store.js', () => ({ readWindowThemeSnapshot: () => null }));

import { openSessionInNewWindow, shouldKeepCapturedPopupHost } from '../secondary-windows';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windowOptions.length = 0;
  mocks.windows.length = 0;
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
});
afterEach(() => vi.unstubAllGlobals());

describe('session window link targets', () => {
  it('encodes remote device and message anchors into the development window URL', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
    openSessionInNewWindow('task/1', null, 'remote-device', undefined, 'message/1?x=2&y=3');
    const url = new URL(mocks.loadURL.mock.calls[0]![0]);
    expect(url.hash).toBe('#/cc-agent/boot');
    expect(url.searchParams.get('bootSession')).toBe('task/1');
    expect(url.searchParams.get('bootDevice')).toBe('remote-device');
    expect(url.searchParams.get('bootMessage')).toBe('message/1?x=2&y=3');
    expect(url.searchParams.get('y')).toBeNull();
  });

  it('passes the same target to packaged windows and keeps existing callers compatible', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    openSessionInNewWindow('task', null, 'remote-device', undefined, 'message');
    expect(mocks.loadFile.mock.calls[0]![1]).toEqual({
      query: {
        secondaryWindow: '1',
        bootSession: 'task',
        bootDevice: 'remote-device',
        bootMessage: 'message',
      },
      hash: '/cc-agent/boot',
    });
    openSessionInNewWindow('local-task', null);
    expect(mocks.loadFile.mock.calls[1]![1].query).toEqual({
      secondaryWindow: '1',
      bootSession: 'local-task',
    });
  });

  // 副窗从 /cc-agent/boot 导航到 canonical route（以及后续切换任务）都是页面内
  // hash 导航，不会触发 did-finish-load。漏装这个 hook 的后果是副窗切任务后
  // 缩放掉回该 URL 的旧记录，用户看到字体变小。
  it('installs zoom restoration for the boot-route in-page navigation', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    openSessionInNewWindow('task', null);
    expect(mocks.installWindowZoomRestoration).toHaveBeenCalledOnce();
  });

  // 副窗 webPreferences 漏 webviewTag 时,右侧栏浏览器的 <webview> 永不
  // attach,副窗侧栏空白且一直加载。主窗(bootstrap-electron)与右侧栏子窗口都
  // 显式开启;副窗加载同一套 renderer,必须一致。
  it('enables webviewTag so the sidebar browser renders in secondary windows', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    openSessionInNewWindow('task', null);
    const options = mocks.windowOptions.at(-1);
    expect(options?.webPreferences).toMatchObject({ webviewTag: true });
  });

  // 副窗登录弹窗:popup 路由必须把会话副窗当原宿主保留 —— 原生弹窗面的
  // owner 校验只认挂载 webview 的那扇窗口,改投主窗会让 claimSurface 收到
  // PERMISSION_DENIED,副窗里 window.open 的登录弹窗在哪个窗口都出不来。
  it('keeps the secondary session window as its own popup host', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    openSessionInNewWindow('task', null);
    const win = mocks.windows.at(-1)!;
    const host = win.webContents as unknown as WebContents;
    // 页签弹出窗宿主照旧保留(既有行为);副窗自己的 webContents 同样保留
    expect(shouldKeepCapturedPopupHost(host, true)).toBe(true);
    expect(shouldKeepCapturedPopupHost(host, false)).toBe(true);
    // 不属于任何会话副窗的 webContents 不保留,由调用方转投 RSB 宿主
    expect(shouldKeepCapturedPopupHost({} as WebContents, false)).toBe(false);
    // 副窗关闭后不再保留(触发全部 'closed' 回调,模拟真实关窗:透明标题栏
    // dispose 与 secondaryWindows.delete 都会执行)
    for (const [evt, cb] of win.once.mock.calls as Array<[string, () => void]>) {
      if (evt === 'closed') cb();
    }
    expect(shouldKeepCapturedPopupHost(host, false)).toBe(false);
  });
});
