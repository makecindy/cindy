import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockSecondaryWindowInstance {
  destroyed: boolean;
  focused: boolean;
  minimized: boolean;
  currentUrl: string;
  listeners: Map<string, Array<() => void>>;
  webContentsListeners: Map<string, Array<() => void>>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    getURL: () => string;
  };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isMinimized: () => boolean;
  emit: (event: string) => void;
  emitWebContents: (event: string) => void;
}

const mocks = vi.hoisted(() => ({
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  installWindowZoomRestoration: vi.fn(),
  createdWindows: [] as MockSecondaryWindowInstance[],
}));
vi.mock('electron', () => ({
  BrowserWindow: class {
    destroyed = false;
    focused = false;
    minimized = false;
    currentUrl = '';
    listeners = new Map<string, Array<() => void>>();
    webContentsListeners = new Map<string, Array<() => void>>();
    webContents = {
      on: vi.fn((event: string, listener: () => void) => {
        const list = this.webContentsListeners.get(event) ?? [];
        list.push(listener);
        this.webContentsListeners.set(event, list);
      }),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      getURL: () => this.currentUrl,
    };
    on = vi.fn((event: string, listener: () => void) => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    });
    once = vi.fn((event: string, listener: () => void) => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    });
    isDestroyed = () => this.destroyed;
    isFocused = () => this.focused;
    isMinimized = () => this.minimized;
    emit = (event: string) => {
      if (event === 'closed') this.destroyed = true;
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    };
    emitWebContents = (event: string) => {
      for (const listener of [...(this.webContentsListeners.get(event) ?? [])]) listener();
    };
    hookWindowMessage = vi.fn();
    loadURL = mocks.loadURL;
    loadFile = mocks.loadFile;
    constructor() {
      mocks.createdWindows.push(this);
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

import {
  findSecondaryWindowForGroupChat,
  findSecondaryWindowForSession,
  openSessionInNewWindow,
  updateSecondaryWindowVisibleSessions,
} from '../secondary-windows';
import type { BrowserWindow } from 'electron';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createdWindows.length = 0;
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
});
afterEach(() => {
  for (const win of mocks.createdWindows) {
    if (!win.destroyed) win.emit('closed');
  }
  mocks.createdWindows.length = 0;
  vi.unstubAllGlobals();
});

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
});

// 测试价值:
// - 生产入口与可观察结果: openSessionInNewWindow / findSecondaryWindowForSession / findSecondaryWindowForGroupChat / updateSecondaryWindowVisibleSessions;
//   验证灵动岛或其它入口按任务、远程任务、伙伴、群聊与分屏查回已拖出的副窗口并按状态排序。
// - Bug／规则依据: 灵动岛点击任务或消息时应优先打开已拖出的副窗口而非主窗口。
// - 现有覆盖缺口: 此前 secondary-windows.test.ts 仅覆盖建窗启动参数，未覆盖副窗口目标索引与匹配优先级。
// - 最小失败输入: 拖出任务或群聊后副窗口仍在启动、已导航离开、含分屏或多开重复窗口。
// - tier: unit（纯内存 Electron mock）。
describe('secondary window target matching', () => {
  it('matches booting, navigated, Orca worker, companion, and group secondary windows', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');

    openSessionInNewWindow('task/1', null, 'remote-mac');
    const remoteTaskWin = mocks.createdWindows.at(-1)!;
    // 刚建窗尚未 load 完时应通过 boot 参数命中且隔离设备归属
    expect(findSecondaryWindowForSession({ sessionId: 'task/1', deviceId: 'remote-mac' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'booting',
    });
    expect(findSecondaryWindowForSession({ sessionId: 'task/1' })).toBeNull();
    expect(findSecondaryWindowForSession({ sessionId: 'task/1', deviceId: 'other-mac' })).toBeNull();

    // 导航到 canonical route 后切换为 direct 命中；导航去其它任务后不再命中旧任务
    remoteTaskWin.currentUrl =
      'http://localhost:5173/?secondaryWindow=1&bootSession=task%2F1&bootDevice=remote-mac#/cc-agent/task%2F1';
    expect(findSecondaryWindowForSession({ sessionId: 'task/1', deviceId: 'remote-mac' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'direct',
    });
    remoteTaskWin.currentUrl =
      'http://localhost:5173/?secondaryWindow=1&bootSession=task%2F1&bootDevice=remote-mac#/cc-agent/other-task';
    expect(findSecondaryWindowForSession({ sessionId: 'task/1', deviceId: 'remote-mac' })).toBeNull();
    expect(findSecondaryWindowForSession({ sessionId: 'other-task' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'direct',
    });

    // Orca worker 路由 (?worker=<workerSessionId>) 与分屏上报命中
    remoteTaskWin.currentUrl =
      'http://localhost:5173/?secondaryWindow=1&bootSession=lead-1#/cc-agent/lead-1?worker=worker-1';
    expect(findSecondaryWindowForSession({ sessionId: 'worker-1' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'direct',
    });
    updateSecondaryWindowVisibleSessions(remoteTaskWin as unknown as BrowserWindow, ['lead-1', 'split-2']);
    expect(findSecondaryWindowForSession({ sessionId: 'split-2' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'navigate',
    });

    // 文件浏览页聊天栏折叠（未上报可见会话）需要导航切回对话；聊天栏展开时保持 direct
    remoteTaskWin.currentUrl =
      'http://localhost:5173/?secondaryWindow=1&bootSession=file-task#/cc-agent/files/file-task';
    updateSecondaryWindowVisibleSessions(remoteTaskWin as unknown as BrowserWindow, null);
    expect(findSecondaryWindowForSession({ sessionId: 'file-task' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'navigate',
    });
    updateSecondaryWindowVisibleSessions(remoteTaskWin as unknown as BrowserWindow, 'file-task');
    expect(findSecondaryWindowForSession({ sessionId: 'file-task' })).toEqual({
      window: remoteTaskWin,
      matchKind: 'direct',
    });

    // 远程伙伴拖出后 URL 不含 sessionId，按 companion 身份命中
    openSessionInNewWindow('/bots/remote/studio/bot%2Fa', null);
    const companionWin = mocks.createdWindows.at(-1)!;
    companionWin.currentUrl =
      'http://localhost:5173/?secondaryWindow=1&bootSession=%2Fbots%2Fremote%2Fstudio%2Fbot%252Fa#/bots/remote/studio/bot%2Fa';
    expect(
      findSecondaryWindowForSession({
        sessionId: 'bot-session-1',
        deviceId: 'studio',
        companion: { botId: 'bot/a', deviceId: 'studio' },
      }),
    ).toEqual({ window: companionWin, matchKind: 'direct' });

    // 群聊与直聊区分 conversationKind
    openSessionInNewWindow('/bots/groups/group-1', null);
    const groupWin = mocks.createdWindows.at(-1)!;
    expect(findSecondaryWindowForGroupChat({ groupId: 'group-1' })).toEqual({
      window: groupWin,
      isBooting: true,
    });
    groupWin.currentUrl =
      'http://localhost:5173/?secondaryWindow=1&bootSession=%2Fbots%2Fgroups%2Fgroup-1#/bots/groups/group-1';
    expect(findSecondaryWindowForGroupChat({ groupId: 'group-1' })).toEqual({
      window: groupWin,
      isBooting: false,
    });
    expect(
      findSecondaryWindowForGroupChat({ groupId: 'group-1', conversationKind: 'direct' }),
    ).toBeNull();

    // 关窗后立即从索引移除
    groupWin.emit('closed');
    expect(findSecondaryWindowForGroupChat({ groupId: 'group-1' })).toBeNull();
  });

  it('prefers focused, non-minimized, and most recently focused duplicate secondary windows', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');

    openSessionInNewWindow('shared-task', null);
    const first = mocks.createdWindows.at(-1)!;
    first.currentUrl = 'http://localhost:5173/?secondaryWindow=1&bootSession=shared-task#/cc-agent/shared-task';

    openSessionInNewWindow('shared-task', null);
    const second = mocks.createdWindows.at(-1)!;
    second.currentUrl = 'http://localhost:5173/?secondaryWindow=1&bootSession=shared-task#/cc-agent/shared-task';

    // 默认最近创建/聚焦的 second 优先
    expect(findSecondaryWindowForSession({ sessionId: 'shared-task' })?.window).toBe(second);

    // 重新聚焦 first 后，first 优先
    first.emit('focus');
    expect(findSecondaryWindowForSession({ sessionId: 'shared-task' })?.window).toBe(first);

    // first 最小化而 second 可见时，优先非最小化的 second
    first.minimized = true;
    expect(findSecondaryWindowForSession({ sessionId: 'shared-task' })?.window).toBe(second);

    // 当前正处于焦点中的窗口始终优先
    first.minimized = false;
    first.focused = true;
    expect(findSecondaryWindowForSession({ sessionId: 'shared-task' })?.window).toBe(first);
  });
});
