import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserWindow } from 'electron';

import type { VoiceInputShortcut } from '../../../shared/voiceInputData.js';
import type { GlobalVoiceInputIpcDeps } from '../global.js';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registeredShortcuts = new Map<string, () => void>();
  // 录制/挂起那两条 IPC 的合法发起方,同时也是 keys 转发的收件人 —— 建模成一个任务副窗口
  // （设置页在副窗口里照样打得开）。所以它要有顶层 frame 与 once,好过得了那道授权闸。
  const focusedWindowMainFrame = { url: 'http://localhost:5173/index.html' };
  const focusedWindow = {
    id: 10,
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    webContents: {
      id: 42,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      mainFrame: focusedWindowMainFrame,
      once: vi.fn(),
    },
  };
  const recordingEvent = {
    sender: focusedWindow.webContents,
    senderFrame: focusedWindowMainFrame,
  };
  // 主窗口 + 它的顶层 frame。弹系统授权窗那两条 IPC 只认这一对，右侧栏 / Ghost 面板
  // 虽然也在 appContentWindows 里，但 sender 对不上就会被拒。
  const mainWindowMainFrame = { url: 'http://localhost:5173/index.html' };
  // 单独留一份 Mock 引用，好在 beforeEach 里重置；断言成 BrowserWindow 后就取不到 Mock 了。
  const mainWindowIsDestroyed = vi.fn(() => false);
  // 弹系统授权窗那两条 IPC 还要求 sender 是**当前聚焦**的应用外壳窗口。
  const mainWindowIsFocused = vi.fn(() => true);
  const mainWindowWebContents = { id: 7, mainFrame: mainWindowMainFrame, once: vi.fn() };
  const mainWindow = {
    id: 1,
    isDestroyed: mainWindowIsDestroyed,
    isFocused: mainWindowIsFocused,
    webContents: mainWindowWebContents,
  };
  const settingsEvent = { sender: mainWindowWebContents, senderFrame: mainWindowMainFrame };
  // 「Open in New Window」开出来的会话副窗口:同一套路由,设置页在里面照样打得开。
  const secondaryAppWindowMainFrame = { url: 'http://localhost:5173/index.html' };
  const secondaryAppWindowWebContents = { id: 21, mainFrame: secondaryAppWindowMainFrame, once: vi.fn() };
  const secondaryAppWindowIsFocused = vi.fn(() => true);
  const secondaryAppWindow = {
    id: 3,
    isDestroyed: vi.fn(() => false),
    isFocused: secondaryAppWindowIsFocused,
    webContents: secondaryAppWindowWebContents,
  };
  const secondaryAppWindowEvent = {
    sender: secondaryAppWindowWebContents,
    senderFrame: secondaryAppWindowMainFrame,
  };
  // 默认只认 focusedWindow 是会话副窗口：录制那两条 IPC 的用例需要一个合法发起方,而
  // secondaryAppWindow 要留着专门验「isSecondaryAppWindow 说不是就拒」。
  const isSecondaryAppWindow = vi.fn((win: unknown) => win === focusedWindow);
  // 「另一个已登记的应用窗口」（右侧栏 / Ghost 面板就是这种）：通用闸放行，但它不承载路由,
  // 收窄闸必须拒。建模成一个完整窗口(有 send / once / 顶层 frame、也进 getAllWindows),这样
  // 「被拒」才是**唯一**能让调用失败的原因 —— 缺 once 的话 markModifierShortcutRecordingSession
  // 自己就会抛 TypeError,rejects 断言就通过得没有意义了(第一版正是如此)。
  const ghostPanelMainFrame = { url: 'http://localhost:5173/index.html' };
  const ghostPanelWindow = {
    id: 5,
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    webContents: {
      id: 99,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      mainFrame: ghostPanelMainFrame,
      once: vi.fn(),
    },
  };
  const secondaryWindowEvent = {
    sender: ghostPanelWindow.webContents,
    senderFrame: ghostPanelMainFrame,
  };
  const modifierSetShortcut = vi.fn();
  const modifierStop = vi.fn();
  const modifierReleaseShortcut = vi.fn();
  const modifierReleaseActiveTrigger = vi.fn();
  const modifierIsRunning = vi.fn();
  const modifierIsReady = vi.fn();
  const modifierStartKeyCapture = vi.fn();
  // 被顶掉的那一轮要顺着「接手链」等共享启动的落点, 所以这个访问器也得能被用例摆布。
  const modifierPendingStartResult = vi.fn((): Promise<unknown> | null => null);
  const inputMonitoringSnapshot = vi.fn();
  const requestInputMonitoring = vi.fn();
  const windowsSetShortcut = vi.fn();
  const windowsStop = vi.fn();
  const windowsReleaseActiveTrigger = vi.fn();
  const windowsIsReady = vi.fn();
  const quitDisposers: Array<{ name: string; fn: () => void }> = [];
  const onQuit = vi.fn((name: string, fn: () => void) => {
    quitDisposers.push({ name, fn });
  });
  const assertTrustedAppRenderer = vi.fn();
  const updateSettings = vi.fn();
  // 存盘里的快捷键。global-shortcut:set 只负责「让运行期对上存盘」,所以非 null 的同步
  // 必须与它一致 —— 用例要先声明存盘状态,再同步,跟 renderer 的真实用法一致。
  let storedShortcut: VoiceInputShortcut | null = null;
  const setStoredShortcut = (shortcut: VoiceInputShortcut | null): void => { storedShortcut = shortcut; };
  // 显式标注返回类型:不标的话会被推成 { shortcut: null },用例里塞真快捷键就编译不过。
  const getSettings = vi.fn((): { shortcut: VoiceInputShortcut | null } => ({ shortcut: storedShortcut }));
  // app.on 的回调要能被用例触发:授权兜底恢复挂在 browser-window-focus 上。
  const appListeners = new Map<string, (...args: unknown[]) => void>();
  // 闸只读 isDestroyed / webContents / mainFrame，没必要拼一整个 BrowserWindow，所以
  // 断言收窄在这一处；ipcDeps 本身用真实类型，这样 deps 形状变化会在编译期暴露。
  const getMainWindow = vi.fn(() => mainWindow as unknown as BrowserWindow);
  const ipcDeps: GlobalVoiceInputIpcDeps = {
    getMainWindow,
    isSecondaryAppWindow: isSecondaryAppWindow as unknown as GlobalVoiceInputIpcDeps['isSecondaryAppWindow'],
  };
  // 抓住 listener 构造时传入的 onKeys。转发名单是模块私有的，onKeys 往哪些窗口 send
  // 是它唯一的可观察代理 —— 用来验证「被顶掉的那一轮没有把别人的登记删掉」。
  const listenerOptions: {
    onKeys?: (keys: string[]) => void;
    onTrigger?: (phase: 'tap' | 'start' | 'end') => void;
    onRestartLimitReached?: () => void;
  } = {};
  const windowsListenerOptions: {
    onTrigger?: (phase: 'tap' | 'start' | 'end') => void;
    onRestartLimitReached?: () => void;
  } = {};
  const registerShortcut = vi.fn((accelerator: string) => {
    void accelerator;
    return true;
  });

  return {
    handlers,
    registeredShortcuts,
    focusedWindow,
    recordingEvent,
    mainWindow,
    mainWindowIsDestroyed,
    mainWindowIsFocused,
    secondaryAppWindowIsFocused,
    settingsEvent,
    secondaryWindowEvent,
    ghostPanelWindow,
    secondaryAppWindow,
    secondaryAppWindowWebContents,
    secondaryAppWindowEvent,
    isSecondaryAppWindow,
    modifierSetShortcut,
    modifierStop,
    modifierReleaseShortcut,
    modifierReleaseActiveTrigger,
    modifierIsRunning,
    modifierIsReady,
    modifierStartKeyCapture,
    modifierPendingStartResult,
    inputMonitoringSnapshot,
    requestInputMonitoring,
    windowsSetShortcut,
    windowsStop,
    windowsReleaseActiveTrigger,
    windowsIsReady,
    quitDisposers,
    onQuit,
    assertTrustedAppRenderer,
    getMainWindow,
    ipcDeps,
    listenerOptions,
    windowsListenerOptions,
    updateSettings,
    getSettings,
    setStoredShortcut,
    appListeners,
    registerShortcut,
  };
});

vi.mock('electron', () => ({
  app: {
    focus: vi.fn(),
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      mocks.appListeners.set(event, callback);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mocks.focusedWindow, mocks.mainWindow, mocks.ghostPanelWindow]),
    getFocusedWindow: vi.fn(() => mocks.focusedWindow),
    // 闸要从 sender 反查它所属的窗口,才能判断「是不是某个窗口自己的顶层 webContents」。
    fromWebContents: vi.fn((contents: unknown) => {
      if (contents === mocks.mainWindow.webContents) return mocks.mainWindow;
      if (contents === mocks.secondaryAppWindowWebContents) return mocks.secondaryAppWindow;
      if (contents === mocks.focusedWindow.webContents) return mocks.focusedWindow;
      if (contents === mocks.ghostPanelWindow.webContents) return mocks.ghostPanelWindow;
      return null;
    }),
  },
  clipboard: {},
  globalShortcut: {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (!mocks.registerShortcut(accelerator)) return false;
      mocks.registeredShortcuts.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      mocks.registeredShortcuts.delete(accelerator);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
  },
  shell: {
    openExternal: vi.fn(),
  },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
  },
}));

vi.mock('../index.js', () => ({
  prewarmVoiceInputProvider: vi.fn(() => Promise.resolve()),
}));

vi.mock('../MacModifierShortcutListener.js', () => ({
  MacModifierShortcutListener: vi
    .fn()
    .mockImplementation(
      (options: {
        onKeys?: (keys: string[]) => void;
        onTrigger?: (phase: 'tap' | 'start' | 'end') => void;
      }) => {
        mocks.listenerOptions.onKeys = options?.onKeys;
        mocks.listenerOptions.onTrigger = options?.onTrigger;
        mocks.listenerOptions.onRestartLimitReached = (
          options as { onRestartLimitReached?: () => void }
        )?.onRestartLimitReached;
        return {
          setShortcut: mocks.modifierSetShortcut,
          isRunning: mocks.modifierIsRunning,
          isReady: mocks.modifierIsReady,
          stop: mocks.modifierStop,
          releaseShortcutKeepingCapture: mocks.modifierReleaseShortcut,
          releaseActiveTrigger: mocks.modifierReleaseActiveTrigger,
          stopKeyCapture: vi.fn(),
          startKeyCapture: mocks.modifierStartKeyCapture,
          pendingStartResult: mocks.modifierPendingStartResult,
        };
      },
    ),
  getMacInputMonitoringPermissionSnapshot: mocks.inputMonitoringSnapshot,
  requestMacInputMonitoringPermission: mocks.requestInputMonitoring,
}));

vi.mock('../WindowsFunctionKeyShortcutListener.js', () => ({
  WindowsFunctionKeyShortcutListener: vi
    .fn()
    .mockImplementation((options: { onTrigger?: (phase: 'tap' | 'start' | 'end') => void }) => {
      mocks.windowsListenerOptions.onTrigger = options?.onTrigger;
      mocks.windowsListenerOptions.onRestartLimitReached = (
        options as { onRestartLimitReached?: () => void }
      )?.onRestartLimitReached;
      return {
        setShortcut: mocks.windowsSetShortcut,
        isReady: mocks.windowsIsReady,
        stop: mocks.windowsStop,
        releaseActiveTrigger: mocks.windowsReleaseActiveTrigger,
      };
    }),
}));

vi.mock('../VoiceInputDataStore.js', () => ({
  voiceInputDataStore: {
    updateSettings: mocks.updateSettings,
    getSettings: mocks.getSettings,
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRenderer,
}));

vi.mock('../../lifecycle.js', () => ({
  onQuit: mocks.onQuit,
}));

let setTimeoutSpy: { mockRestore: () => void } | null = null;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('voice input global shortcut registration', () => {
  beforeEach(() => {
    vi.resetModules();
    setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    mocks.handlers.clear();
    mocks.registeredShortcuts.clear();
    mocks.focusedWindow.webContents.send.mockClear();
    mocks.ghostPanelWindow.webContents.send.mockClear();
    mocks.modifierSetShortcut.mockReset();
    mocks.modifierSetShortcut.mockResolvedValue({ ok: true });
    mocks.modifierIsRunning.mockReset();
    mocks.modifierIsRunning.mockReturnValue(true);
    // 默认「已就绪」:既有用例断言的是正常运行态。
    mocks.modifierPendingStartResult.mockReset();
    mocks.modifierPendingStartResult.mockReturnValue(null);
    mocks.modifierIsReady.mockReset();
    // 真实实现是 `ready && isRunning()`,所以默认让它跟着 isRunning —— 固定成 true 的话用例能
    // 造出「没在跑却已就绪」这种真机上不存在的状态,断言就会测到一条不存在的路径(复用条件从
    // isRunning 改成 isReady 时正是这个 mock 让新用例假绿)。要单独表达「进程在、还没报 ready」
    // 的用例照旧显式覆盖它。
    mocks.modifierIsReady.mockImplementation(() => mocks.modifierIsRunning() as boolean);
    mocks.modifierStop.mockClear();
    mocks.modifierReleaseShortcut.mockClear();
    mocks.modifierReleaseActiveTrigger.mockClear();
    mocks.modifierStartKeyCapture.mockReset();
    mocks.modifierStartKeyCapture.mockResolvedValue({ ok: true });
    // 默认已授权:既有用例断言的是「拿得到权限时」的注册行为。
    mocks.inputMonitoringSnapshot.mockReset();
    mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
    mocks.requestInputMonitoring.mockReset();
    mocks.requestInputMonitoring.mockResolvedValue({ ok: true, status: 'granted' });
    mocks.windowsSetShortcut.mockReset();
    mocks.windowsSetShortcut.mockResolvedValue({ ok: true });
    mocks.windowsStop.mockClear();
    mocks.windowsReleaseActiveTrigger.mockClear();
    mocks.windowsIsReady.mockReset();
    mocks.windowsIsReady.mockReturnValue(true);
    // 默认放行通用 sender 闸；需要验证它本身时在用例里让它抛。
    mocks.assertTrustedAppRenderer.mockReset();
    mocks.mainWindowIsDestroyed.mockReset();
    mocks.mainWindowIsDestroyed.mockReturnValue(false);
    mocks.mainWindowIsFocused.mockReset();
    mocks.mainWindowIsFocused.mockReturnValue(true);
    mocks.secondaryAppWindowIsFocused.mockReset();
    mocks.secondaryAppWindowIsFocused.mockReturnValue(true);
    mocks.getMainWindow.mockReset();
    mocks.getMainWindow.mockReturnValue(mocks.mainWindow as unknown as BrowserWindow);
    mocks.isSecondaryAppWindow.mockReset();
    mocks.isSecondaryAppWindow.mockImplementation((win: unknown) => win === mocks.focusedWindow);
    mocks.secondaryAppWindowWebContents.once.mockReset();
    mocks.mainWindow.webContents.once.mockReset();
    mocks.getSettings.mockClear();
    mocks.setStoredShortcut(null);
    mocks.appListeners.clear();
    mocks.updateSettings.mockReset();
    mocks.updateSettings.mockImplementation((patch: unknown) => ({ shortcut: null, ...(patch as object) }));
    mocks.registerShortcut.mockReset();
    mocks.registerShortcut.mockReturnValue(true);
    mocks.onQuit.mockClear();
    mocks.quitDisposers.length = 0;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setTimeoutSpy?.mockRestore();
    setTimeoutSpy = null;
  });

  it('uses the macOS native listener for F16 phases and Electron only to reserve the key', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const f16Shortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    };

    mocks.setStoredShortcut(f16Shortcut);
    await setShortcut?.({}, f16Shortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(f16Shortcut);
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);

    // The Electron callback only owns reservation/suppression.
    mocks.registeredShortcuts.get('F16')?.();
    expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalled();

    // Press/release phases come from the native listener.
    mocks.listenerOptions.onTrigger?.('start');

    expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
      'voice-input:global-shortcut-trigger',
      expect.objectContaining({ id: expect.any(String), phase: 'start' }),
    );
  });

  it('uses the Windows low-level listener for F16 and Electron only to reserve the key', async () => {
    setPlatform('win32');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    const f16Shortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    mocks.setStoredShortcut(f16Shortcut);
    await setShortcut?.({}, f16Shortcut);

    expect(mocks.windowsSetShortcut).toHaveBeenCalledWith(f16Shortcut);
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);

    mocks.registeredShortcuts.get('F16')?.();
    expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalled();

    mocks.windowsListenerOptions.onTrigger?.('start');
    expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
      'voice-input:global-shortcut-trigger',
      expect.objectContaining({ id: expect.any(String), phase: 'start' }),
    );
  });

  it('rejects a Windows F-key that another app already owns', async () => {
    setPlatform('win32');
    mocks.registerShortcut.mockImplementationOnce(() => false);
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    const f16Shortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    mocks.setStoredShortcut(f16Shortcut);
    const result = await setShortcut?.({}, f16Shortcut);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.windowsSetShortcut).not.toHaveBeenCalled();
    expect(mocks.registeredShortcuts.has('F16')).toBe(false);
  });

  it('releases both native listener states on system power transitions', async () => {
    setPlatform('darwin');
    const { releaseActiveGlobalVoiceInputShortcut } = await import('../global.js');

    releaseActiveGlobalVoiceInputShortcut();

    expect(mocks.modifierReleaseActiveTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.windowsReleaseActiveTrigger).toHaveBeenCalledTimes(1);
  });

  it('releases a reserved Windows F-key when the helper restart budget is exhausted', async () => {
    setPlatform('win32');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    const f16Shortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    mocks.setStoredShortcut(f16Shortcut);
    await setShortcut?.({}, f16Shortcut);
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);

    mocks.windowsListenerOptions.onRestartLimitReached?.();
    expect(mocks.registeredShortcuts.has('F16')).toBe(false);
  });

  it('stops both native listeners through the quit disposer, not will-quit', async () => {
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    expect(mocks.onQuit).toHaveBeenCalledWith('voice-input-global-shortcut', expect.any(Function));
    mocks.quitDisposers[0]?.fn();
    expect(mocks.modifierStop).toHaveBeenCalledTimes(1);
    expect(mocks.windowsStop).toHaveBeenCalledTimes(1);
  });

  it('does not re-register an unchanged native macOS shortcut from multiple windows', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const fnShortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'KeyA',
      key: 'a',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    };

    mocks.setStoredShortcut(fnShortcut);
    await setShortcut?.({}, fnShortcut);
    await setShortcut?.({}, fnShortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(1);
  });

  it('re-registers an unchanged native macOS shortcut when the listener is not running', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const fnShortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'KeyA',
      key: 'a',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    };

    mocks.modifierIsRunning.mockReturnValueOnce(false).mockReturnValueOnce(false);

    mocks.setStoredShortcut(fnShortcut);
    await setShortcut?.({}, fnShortcut);
    await setShortcut?.({}, fnShortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous Electron shortcut registered when the replacement is rejected', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');

    const first: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };
    const replacement: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F17',
      key: 'F17',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    mocks.setStoredShortcut(first);
    await setShortcut?.({}, first);
    mocks.registerShortcut.mockReturnValueOnce(false);
    mocks.setStoredShortcut(replacement);
    const result = await setShortcut?.({}, replacement);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);
    expect(mocks.registeredShortcuts.has('F17')).toBe(false);
  });

  // 未授权时用户是设不上裸修饰键的:注册失败 → 设置不落盘 → 权限徽章(显示条件依赖已保存的
  // shortcut)永远不出现 → 没有授权入口。所以「缺权限」必须与真故障区分开,并且照样存盘。
  describe('input monitoring permission handling', () => {
    const bareRightOption: VoiceInputShortcut = {
      trigger: 'modifier',
      code: 'AltRight',
      key: 'AltRight',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    it('reports a permission error code when the native listener cannot start without Input Monitoring', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      mocks.setStoredShortcut(bareRightOption);
      const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'permission' });
    });

    it('still persists the shortcut when only Input Monitoring is missing', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: true, pendingInputMonitoring: true });
      expect(mocks.updateSettings).toHaveBeenCalledWith({ shortcut: bareRightOption });
    });

    // 存盘就等于宣布「当前快捷键是这个新的」,那旧的必须同时失效。旧 accelerator 的注销
    // 只写在成功路径上,缺权限时在那之前就返回了 —— 于是设置页显示「右 Option 待授权」,
    // 而按 F16 整个任务里仍会触发语音输入。
    it('deactivates the previously registered accelerator when persisting a pending shortcut', async () => {
      setPlatform('darwin');
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      mocks.setStoredShortcut({
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      });
      await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      });
      expect(mocks.registeredShortcuts.has('F16')).toBe(true);

      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: true, pendingInputMonitoring: true });
      expect(mocks.registeredShortcuts.has('F16')).toBe(false);
    });

    // 两次提交交错时,旧的那次会拿着过时的选择走完后半段:注销掉新那次刚注册成功的
    // accelerator,再把自己存盘覆盖用户最新的选择。handler 内部有多个 await,而 Electron
    // 不替我们排队,录制按钮在第一次提交 await 期间也仍可点,所以这个交错是真能发生的。
    it('does not let an overlapping stale shortcut update overwrite a newer successful one', async () => {
      setPlatform('darwin');
      const f16: VoiceInputShortcut = {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      };
      // 第一次提交卡在启动 listener 上,由用例决定何时返回。
      let settleFirstStart: (result: unknown) => void = () => {};
      mocks.modifierSetShortcut.mockImplementationOnce(
        () => new Promise((resolve) => { settleFirstStart = resolve; }),
      );
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const update = mocks.handlers.get('voice-input:settings:update-shortcut');
      const stale = update?.({}, bareRightOption);
      const newer = update?.({}, f16);

      // 等第一次变更真正跑到「await 启动 listener」那一步:串行队列按微任务派发,
      // 不给它一次事件循环的话 settleFirstStart 还是那个空实现。
      await new Promise((resolve) => { setImmediate(resolve); });
      settleFirstStart({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      await stale;
      await newer;

      // 用户最后选的是 F16:它必须仍然注册着,存盘也必须是它。
      expect(mocks.registeredShortcuts.has('F16')).toBe(true);
      expect(mocks.updateSettings).toHaveBeenLastCalledWith({ shortcut: f16 });
    });

    // 设置页是条件渲染的:用户切走 tab(或关掉设置页)再去系统设置里打开开关,设置页那条
    // 权限 effect 压根不会跑。所以兜底恢复必须挂在 app 生命周期上,否则快捷键要等到下次
    // 进语音输入 tab 或重启 Cindy 才生效 —— 而我们对用户的说法是「授权后自动生效」。
    describe('pending shortcut recovery outside the settings page', () => {
      async function focusWindow(): Promise<void> {
        const onFocus = mocks.appListeners.get('browser-window-focus');
        expect(onFocus).toBeTypeOf('function');
        onFocus?.();
        await new Promise((resolve) => { setImmediate(resolve); });
      }

      it('re-registers a pending native shortcut when a window regains focus after the grant', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 还没授权就起 helper = 白起一个必然失败的进程,而 preflight 只查不弹窗,所以这里
      // 必须先看快照再决定。
      it('does not start the helper on focus while the permission is still denied', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // preflight 那次 await 期间用户完全可能把快捷键改成别的。拿 await 之前抓的那份去
      // 注册,就会在用户的新变更之后把旧的修饰键装回去 —— 存盘/界面停在 Ctrl+F16,实际生效的
      // 却是旧那个。所以要注册的那个必须在队列里现读现校验。
      it('re-reads the stored shortcut inside the queue instead of using the pre-await snapshot', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        // preflight 卡住,期间用户改成了 Ctrl+F16(不需要 native listener)。
        let settlePreflight: (snapshot: unknown) => void = () => {};
        mocks.inputMonitoringSnapshot.mockImplementationOnce(
          () => new Promise((resolve) => { settlePreflight = resolve; }),
        );
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const onFocus = mocks.appListeners.get('browser-window-focus');
        onFocus?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        mocks.setStoredShortcut({
          trigger: 'keyboard',
          code: 'F16',
          key: 'F16',
          modifiers: { meta: false, ctrl: true, alt: false, shift: false, fn: false },
        });
        settlePreflight({ ok: true, status: 'granted' });
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 这条恢复存在的前提就是设置页不在(它的 toast 也就不在)。只写日志等于用户被告知
      // 「授权后自动生效」之后什么都没发生、也无处得知,所以要推给常挂载的 renderer。
      it('pushes a recovery failure to the renderer when the helper still cannot start', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith('voice-input:shortcut-recovery-failed');
      });

      // 预筛通过之后、队列内那次执行之前,用户完全可以开始录制。队列内只重校验了快捷键
      // 而没重校验录制状态的话,就会在录制期把全局快捷键装回去 —— 用户按键试录会真的触发
      // 语音输入,并发的 listener 启动还会把 Fn capture 顶掉。
      it('rechecks the recording state inside the queue, not only before the preflight', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        let settlePreflight: (snapshot: unknown) => void = () => {};
        mocks.inputMonitoringSnapshot.mockImplementationOnce(
          () => new Promise((resolve) => { settlePreflight = resolve; }),
        );
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        mocks.appListeners.get('browser-window-focus')?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        // preflight 还没回来,用户开始录制。
        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        await start?.(mocks.recordingEvent);
        mocks.modifierSetShortcut.mockClear();

        settlePreflight({ ok: true, status: 'granted' });
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 恢复可能发生在 MainLayout 挂载之前(登录门 / 数据库门还在前面),那时 fan-out 没有
      // 订阅者、推送就没了。状态必须留在 main 等 renderer 来取,取走才清。
      it('keeps the recovery failure pending until a renderer consumes it', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume).toBeTypeOf('function');
        // 同一个 renderer 取第二次就没了 —— 同一个窗口不会被弹两次。
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 每个应用窗口(含会话副窗口)都挂着 MainLayout,都会来取。全局取一次就清的话,一个在
      // 后台、被挡住的副窗口就可能吞掉这唯一一次提示,用户正看着的窗口反而什么都没有。
      it('lets each renderer consume the failure once instead of clearing it globally', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.secondaryAppWindowEvent)).toEqual({ failed: true });
        // 副窗口先取走了,主窗口照样要能拿到。
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
      });

      // isRunning() 在 spawn 之后立刻为 true, 早于 helper 报 ready。启动期间来一次聚焦, 只看
      // isRunning 会判成「已经在跑、没事可做」直接返回; 而那次启动随后可能超时或起来就退(调用
      // 方只写一行日志), 于是快捷键一直不生效、连提示都没有, 要等下一个 focus 事件。
      it('waits for an in-flight listener start and retries once it settles', async () => {
        setPlatform('darwin');
        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          mocks.setStoredShortcut(bareRightOption);
          // helper 已 spawn(isRunning=true)但还没报 ready —— 此刻没有任何注册记录。
          mocks.modifierIsRunning.mockReturnValue(true);
          const { registerGlobalVoiceInputIpc } = await import('../global.js');
          registerGlobalVoiceInputIpc(mocks.ipcDeps);

          mocks.appListeners.get('browser-window-focus')?.();
          await vi.advanceTimersByTimeAsync(0);
          // 不并发再起一次,也不查权限。
          expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();
          expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();

          // 那次启动失败收场(child 已死)。尾跑必须自己回来补上。
          mocks.modifierIsRunning.mockReturnValue(false);
          await vi.advanceTimersByTimeAsync(5_000);

          expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
        } finally {
          vi.useRealTimers();
        }
      });

      // 已经为这个快捷键注册成功、helper 也活着:真的没事可做,别排尾跑空转。
      it('does nothing when the stored shortcut is already registered and running', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 先正常注册一次(存盘一致的同步),此后 helper 保持存活。
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);
        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(true);
        mocks.modifierSetShortcut.mockClear();
        mocks.inputMonitoringSnapshot.mockClear();

        await focusWindow();

        expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();
        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // preflight 走的是同一个 helper: 二进制缺失 / spawn 失败 / swiftc 失败都会让权限状态
      // 压根查不出来(unknown)。那是真故障而不是「还没授权」—— 而下面那条通知原先只在 preflight
      // 成功后才够得着, 于是这种情况下用户什么提示都收不到、「待授权」说明又已随授权消失。
      it('reports a recovery failure when the permission status cannot be read at all', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.inputMonitoringSnapshot.mockResolvedValue({
          ok: false,
          status: 'unknown',
          error: 'helper unavailable',
        });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        // 没去起 helper(权限都没查出来),但用户拿到了可行动的提示。
        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
      });

      // preflight 期间用户把快捷键换成 Ctrl+F16(不需要监听权限)并成功存盘 —— 那条失败态已经被清掉,
      // 迟到的 unknown 不该再凭一个已经不存在的目标重新造一条「重启 Cindy 再试」。
      it('does not publish a preflight failure after the pending shortcut was replaced', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        let settlePreflight: (snapshot: unknown) => void = () => {};
        mocks.inputMonitoringSnapshot.mockImplementationOnce(
          () => new Promise((resolve) => { settlePreflight = resolve; }),
        );
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        mocks.appListeners.get('browser-window-focus')?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        // 期间用户改成 Ctrl+F16 并成功存盘。
        const ctrlF16: VoiceInputShortcut = {
          trigger: 'keyboard',
          code: 'F16',
          key: 'F16',
          modifiers: { meta: false, ctrl: true, alt: false, shift: false, fn: false },
        };
        mocks.setStoredShortcut(ctrlF16);
        await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, ctrlF16);

        // preflight 这才带着 unknown 迟到返回。
        settlePreflight({ ok: false, status: 'unknown', error: 'helper unavailable' });
        await new Promise((resolve) => { setImmediate(resolve); });

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // helper 退出后 scheduleRestart 会起一个替补: 那段时间 isRunning 已是 true、而注册记录还是
      // 旧的(重启不经过 setShortcut)。只看这两个会把「替补正在起」误判成一切正常 —— 替补及其重试
      // 全失败时只写日志, 这次聚焦恢复又被丢掉, 快捷键就一直不生效、也没有提示。
      it('waits for a matching restart to report ready instead of assuming all is well', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 先正常注册一次(此后 registeredNativeShortcutKey 与存盘一致)。这一步刻意放在切换假
        // 定时器**之前**:假定时器会连 queueMicrotask 一起接管, 那之后直接 await handler 会卡住。
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);
        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);

        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          // helper 挂了又被 scheduleRestart 顶上来: 进程在, 但还没报 ready。
          mocks.modifierIsRunning.mockReturnValue(true);
          mocks.modifierIsReady.mockReturnValue(false);
          mocks.modifierSetShortcut.mockClear();
          mocks.inputMonitoringSnapshot.mockClear();

          mocks.appListeners.get('browser-window-focus')?.();
          await vi.advanceTimersByTimeAsync(0);
          // 不当作「一切正常」直接返回, 也不并发再起一次。
          expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();
          expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();

          // 替补最终失败收场 → 尾跑回来补注册。
          mocks.modifierIsRunning.mockReturnValue(false);
          mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.advanceTimersByTimeAsync(0);

          expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
        } finally {
          vi.useRealTimers();
        }
      });

      // preflight 返回 unknown, 但此刻有一次 renderer 发起的启动正在飞: 它可能成功(不该报错),
      // 也可能超时/起来就退(调用方只写一行日志)。两种都不能在这里下结论 —— 必须排尾跑等它落定,
      // 不能和「恢复目标已经没了」走同一个静默返回。
      it('schedules a retry when the post-preflight recheck finds an in-flight start', async () => {
        setPlatform('darwin');
        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          mocks.setStoredShortcut(bareRightOption);
          mocks.modifierIsRunning.mockReturnValue(false);
          let settlePreflight: (snapshot: unknown) => void = () => {};
          mocks.inputMonitoringSnapshot.mockImplementationOnce(
            () => new Promise((resolve) => { settlePreflight = resolve; }),
          );
          const { registerGlobalVoiceInputIpc } = await import('../global.js');
          registerGlobalVoiceInputIpc(mocks.ipcDeps);

          mocks.appListeners.get('browser-window-focus')?.();
          await vi.advanceTimersByTimeAsync(0);

          // preflight 期间 renderer 起了 helper(spawn 了但还没报 ready:没有任何注册记录)。
          mocks.modifierIsRunning.mockReturnValue(true);
          settlePreflight({ ok: false, status: 'unknown', error: 'helper unavailable' });
          await vi.advanceTimersByTimeAsync(0);

          // 不下结论:既不报故障, 也不当作没事发生。
          const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
          expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });

          // 那次启动失败收场 → 尾跑必须自己回来再查一遍。
          mocks.modifierIsRunning.mockReturnValue(false);
          mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
          await vi.advanceTimersByTimeAsync(5_000);

          expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
        } finally {
          vi.useRealTimers();
        }
      });

      // 早期一次瞬时 helper 故障之后, 后来的同步注册成功了 —— 那条失败就过期了。不清的话此后
      // 每开一个应用外壳窗口都会取到它、弹一次「重启 Cindy 再试」, 而快捷键其实是活的。
      it('clears a stale recovery failure once a matching sync registers successfully', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValueOnce({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();
        // 先确认失败态真的置上了(否则下面那条断言会空转)。
        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith('voice-input:shortcut-recovery-failed');

        // 之后 renderer 的同步注册成功了。
        mocks.modifierSetShortcut.mockResolvedValue({ ok: true });
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 会话只被挂起登记过、capture 从没启动的状态: stop 必须照样能摘掉它, 否则随后的恢复同步
      // 会被「录制中」守卫一直拒掉、快捷键一直停用。
      //
      // 动机来自 Windows —— 那里 recording:start 是 darwin-only 的, 只有挂起会登记会话。但这个
      // 状态本身不是 Windows 独占: darwin 上 capture 启动失败也一样。而 win32 下裸修饰键会在
      // global.ts 的平台守卫处就被判为不支持、压根走不到会话登记, 所以只能在 darwin 上构造它。
      it('releases the recording session on stop even when no capture was ever started', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 只发挂起(没有 recording:start), 再 stop。
        await mocks.handlers.get('voice-input:global-shortcut:set')?.(mocks.recordingEvent, null, { suspend: true });
        await mocks.handlers.get('voice-input:modifier-shortcut-recording:stop')?.(mocks.recordingEvent);
        mocks.modifierSetShortcut.mockClear();

        // 恢复同步必须能落地。
        await mocks.handlers.get('voice-input:global-shortcut:set')?.(mocks.recordingEvent, bareRightOption);

        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 注册失败后会「回滚到上一个快捷键」。而对得上存盘的同步里, 上一个就是请求的那一个 ——
      // 这时的回滚其实是同键重试。它成功了就说明请求的快捷键此刻真的在监听, 再报失败会让失败态
      // 不被清掉、界面还弹一句「重启 Cindy 再试」, 而快捷键本身是好的。
      it('reports success when the rollback retried the same shortcut and it started', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 先成功注册一次, 让 registeredShortcut / registeredNativeShortcutKey 都是这一个。
        mocks.modifierIsRunning.mockReturnValue(false);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        // 造一条持久失败态, 用来观察它有没有被清掉。
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        await focusWindow();
        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');

        // 替补在起、还没就绪 → 同步落不到快路; 第一次 setShortcut 撞上那次失败的启动, 紧接着的
        // 同键重试成功。
        mocks.modifierIsRunning.mockReturnValue(true);
        mocks.modifierIsReady.mockReturnValue(false);
        mocks.modifierSetShortcut.mockReset();
        mocks.modifierSetShortcut
          .mockResolvedValueOnce({ ok: false, error: 'Modifier shortcut listener did not start.' })
          .mockResolvedValue({ ok: true });

        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(result).toMatchObject({ ok: true });
        // 报成功之后失败态也就过期了。
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 防止把上面那条修成「回滚成功就算成功」: 回滚到**另一个**快捷键时, 用户请求的那个确实没
      // 注册上, 必须照旧报失败 —— 否则他以为换成功了。
      it('still reports a failure when the rollback restored a different shortcut', async () => {
        setPlatform('darwin');
        const otherBareModifier: VoiceInputShortcut = {
          trigger: 'modifier',
          code: 'ControlRight',
          key: 'ControlRight',
          modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
        };
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 当前注册着的是右 Option。
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.setStoredShortcut(bareRightOption);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        // 换成右 Control: 新的起不来, 回滚到右 Option 成功。
        mocks.modifierSetShortcut.mockReset();
        mocks.modifierSetShortcut
          .mockResolvedValueOnce({ ok: false, error: 'spawn ENOENT' })
          .mockResolvedValue({ ok: true });

        const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, otherBareModifier);

        expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      });

      // scheduleRestart 起的替补不经过 setShortcut, 所以 registeredNativeShortcutKey 一直是旧值。
      // 复用条件只看「进程在跑」的话, 替补还没报 ready 时一次对得上存盘的同步就会被判成功, 于是
      // 持久失败态被清掉 —— 而替补及其重试全失败时只写日志、不会重新发布失败态, 用户就只剩一个
      // 静静不工作的快捷键。
      it('keeps the recovery failure when a matching sync arrives before the restarted listener is ready', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 先成功注册一次, 让 registeredNativeShortcutKey 与存盘对上。
        mocks.modifierIsRunning.mockReturnValue(false);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        // helper 挂了、兜底恢复也没救回来 → 记下持久失败态。
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        await focusWindow();
        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');

        // 替补被 scheduleRestart 拉起来了: 进程在, 但还没报 ready。此刻来一次对得上存盘的同步。
        mocks.modifierIsRunning.mockReturnValue(true);
        mocks.modifierIsReady.mockReturnValue(false);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        // 关键: 失败态还在, 那条「重启 Cindy 再试」的提示不能凭一个未就绪的替补被擦掉。
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
      });

      // 防止把上面那条修成「永远不清」: 替补真的就绪之后, 对得上存盘的同步照旧要清掉失败态,
      // 否则用户会一直看到一条早已过期的错误提示。
      it('still clears the recovery failure once the listener is ready', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        mocks.modifierIsRunning.mockReturnValue(false);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        await focusWindow();
        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');

        // 替补起来了并且报了 ready。
        mocks.modifierIsRunning.mockReturnValue(true);
        mocks.modifierIsReady.mockReturnValue(true);
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 挂起是录制期的临时状态,不该清掉失败态。
      it('keeps the recovery failure across a recording suspend', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValueOnce({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.recordingEvent,
          null,
          { suspend: true },
        );

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
      });

      // 授权可能在 preflight(granted)之后、注册完成之前又被撤掉: 那仍是「等授权」这个正常状态,
      // 能修好它的只有重新授权。报 listenerUnavailable 会让用户去重启 Cindy —— 指错方向, 而且
      // 这条通知记下来之后, 新开的窗口还会重复这个错误建议。
      it('does not report a helper failure when the permission is revoked mid-registration', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        // preflight 说已授权, 但真正注册时 listener 起不来, 且此刻权限已是 denied。
        mocks.inputMonitoringSnapshot
          .mockResolvedValueOnce({ ok: true, status: 'granted' })
          .mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
        mocks.modifierSetShortcut.mockResolvedValue({
          ok: false,
          error: 'Could not listen for modifier shortcuts.',
        });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 真故障(权限没问题但 helper 起不来)照旧要提示 —— 别把上面那条写成「什么都不报」。
      it('still reports a helper failure when the permission is fine', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
      });

      // denied 是正常等待状态(用户还没在系统设置里打开),不该弹故障提示。
      it('does not report a recovery failure while the permission is merely denied', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 限流窗口内的那次聚焦可能正是「用户刚授权完切回来」的那一次,而应用此后一直在前台、
      // 不会再有第二个 focus 事件。直接丢掉就等于快捷键一直不生效。
      it('schedules a trailing retry when a focus lands inside the throttle window', async () => {
        setPlatform('darwin');
        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          mocks.setStoredShortcut(bareRightOption);
          mocks.modifierIsRunning.mockReturnValue(false);
          mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
          const { registerGlobalVoiceInputIpc } = await import('../global.js');
          registerGlobalVoiceInputIpc(mocks.ipcDeps);

          const onFocus = mocks.appListeners.get('browser-window-focus');
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          // 限流窗口内又来一次聚焦：不该立刻查,但也不能丢。
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          await vi.advanceTimersByTimeAsync(5_000);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // 缺权限时 capture 起不来, keys 转发名单会被清掉 —— 但录制框还开着(裸修饰键走 DOM
      // 事件, 此时照样能录)。拿转发名单当「有没有在录制」用就会判成「没在录」, 于是恢复把
      // 已保存的全局快捷键装回去, 用户按键试录会真的触发语音输入。
      it('still treats recording as active after a permission-blocked capture start', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        // capture 因缺权限起不来。
        mocks.modifierStartKeyCapture.mockResolvedValue({
          ok: false,
          error: 'Could not listen for modifier shortcuts.',
        });
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        const startResult = await start?.(mocks.recordingEvent);
        expect(startResult).toMatchObject({ ok: false, errorCode: 'permission' });

        // 用户去系统设置里打开开关后切回来:此刻录制框仍开着,不该注册全局快捷键。
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        mocks.modifierSetShortcut.mockClear();
        await focusWindow();

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 失败之后用户把快捷键换成 Ctrl+F16(或清空), 兜底恢复再也不会跑(没有需要监听权限的快捷键
      // 了), 这条失败就永远挂着 —— 此后每开一个应用外壳窗口都会取到它, 弹一条与当前状态无关
      // 的「重启 Cindy 再试」。
      it('clears a stale recovery failure once the user changes the shortcut', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        // 用户改成 Ctrl+F16:走 Electron accelerator,压根不需要监听权限。
        const update = await mocks.handlers.get('voice-input:settings:update-shortcut')?.(
          {},
          {
            trigger: 'keyboard',
            code: 'F16',
            key: 'F16',
            modifiers: { meta: false, ctrl: true, alt: false, shift: false, fn: false },
          },
        );
        expect(update).toMatchObject({ ok: true });

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 在飞的那次检查可能刚好在用户点开开关**之前**读到 denied,而这次被丢掉的聚焦正是他
      // 授权完切回来的那一次 —— 应用此后一直在前台,不会再有下一个 focus 事件。
      it('schedules a trailing retry when a focus arrives during an in-flight recovery', async () => {
        setPlatform('darwin');
        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          mocks.setStoredShortcut(bareRightOption);
          mocks.modifierIsRunning.mockReturnValue(false);
          // 第一次检查卡住,由用例决定它何时返回(且返回的是授权前那个 denied)。
          let settleFirstPreflight: (snapshot: unknown) => void = () => {};
          mocks.inputMonitoringSnapshot.mockImplementationOnce(
            () => new Promise((resolve) => { settleFirstPreflight = resolve; }),
          );
          mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
          const { registerGlobalVoiceInputIpc } = await import('../global.js');
          registerGlobalVoiceInputIpc(mocks.ipcDeps);

          const onFocus = mocks.appListeners.get('browser-window-focus');
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          // 用户在系统设置里打开开关后切回来:这次聚焦落在「上一次还在飞」上。
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          // 在飞那次带着授权前的 denied 收尾,什么都没注册。
          settleFirstPreflight({ ok: false, status: 'denied', error: 'denied' });
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();

          // 尾跑必须补上这一次,否则快捷键一直不生效。
          await vi.advanceTimersByTimeAsync(5_000);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(2);
          expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
        } finally {
          vi.useRealTimers();
        }
      });

      // 录制期间全局快捷键是刻意挂起的。这里重新注册会把它顶回来,而用户此刻正在按键试录,
      // 会真的触发一次语音输入。
      it('does not re-register while a shortcut recording is in progress', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        await start?.(mocks.recordingEvent);

        await focusWindow();

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });
    });

    // 权限没问题却起不来 = swiftc 编译失败 / 二进制缺失 / 启动超时,是真故障。
    // 这种情况存盘会骗用户「设上了,等授权就好」,所以必须走回原来的失败路径。
    it('treats a listener failure with granted permission as a real failure and does not persist', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    });

    // listener 不只会返回 { ok: false }，还会抛：dev 下 helper 源码缺失直接 throw、
    // swiftc 失败时 execFile 的 reject 带 stderr，两者都含内部绝对路径。不接住的话
    // handler 直接 reject，原始消息过桥给 renderer，errorCode 分支也走不到。
    const INTERNAL_PATH = '/Users/someone/Library/Application Support/Cindy/voice-input/helper';

    it('does not leak internal paths when the listener throws while setting a shortcut', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockRejectedValue(
        new Error(`Modifier shortcut listener source missing at ${INTERNAL_PATH}`),
      );
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      mocks.setStoredShortcut(bareRightOption);
      const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      expect((result as { error: string }).error).toBe('Could not start the voice input shortcut listener.');
    });

    it('does not leak internal paths when the listener throws while starting key capture', async () => {
      setPlatform('darwin');
      mocks.modifierStartKeyCapture.mockRejectedValue(new Error(`spawn ${INTERNAL_PATH} ENOENT`));
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:modifier-shortcut-recording:start')?.(mocks.recordingEvent);

      expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      expect((result as { error: string }).error).toBe('Could not start the voice input shortcut listener.');
    });

    // 两个窗口的录制框可以同时开着。A 的 capture 启动被 B 顶掉后, 原来只拿到一个 renderer 会静默
    // 丢弃的 'superseded' —— 而这只在 B **成功**时说得过去。B 失败时 A 既没有 helper 送 Fn, 界面上
    // 也没有任何解释, 正是本 PR 要消灭的那种沉默。
    it('reports the shared failure to a recorder whose start was superseded', async () => {
      setPlatform('darwin');
      // 两个窗口都算合法的应用外壳窗口。
      mocks.isSecondaryAppWindow.mockImplementation(
        (win: unknown) => win === mocks.focusedWindow || win === mocks.secondaryAppWindow,
      );
      // 缺监听权限 —— A 应该被告知这一点, 好让录制框说明「Fn 需要监听权限」。
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
      let settleA: (result: unknown) => void = () => {};
      mocks.modifierStartKeyCapture.mockImplementationOnce(
        () => new Promise((resolve) => { settleA = resolve; }),
      );
      // B 是更晚那一轮, 它自己起不来。
      mocks.modifierStartKeyCapture.mockResolvedValueOnce({ ok: false, error: 'spawn ENOENT' });

      const a = start?.(mocks.recordingEvent);
      const b = await start?.(mocks.secondaryAppWindowEvent);
      expect(b).toMatchObject({ ok: false, errorCode: 'permission' });

      // B 已经落定(失败), 所以 A 醒来时没有在飞的启动, 也没有就绪的 helper。
      mocks.modifierIsRunning.mockReturnValue(false);
      settleA({
        ok: false,
        error: 'Modifier shortcut listener start was superseded.',
        superseded: true,
      });

      // 关键: A 拿到的是真实结果, 而不是被静默丢弃的 'superseded'。
      expect(await a).toMatchObject({ ok: false, errorCode: 'permission' });

      // 也不该继续留在转发名单里 —— 没有 helper 可转发; 授权后 renderer 会重新登记。
      mocks.focusedWindow.webContents.send.mockClear();
      mocks.listenerOptions.onKeys?.(['Fn']);
      expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalled();
    });

    // 防止把上面那条修成「被顶掉就一律报失败」: 接手那轮还在飞时要等它, 它成功则被顶掉的这轮
    // 同样算成功(共享 helper 在跑, 名单也没动过)。
    it('reports success to a superseded recorder when the in-flight shared start succeeds', async () => {
      setPlatform('darwin');
      mocks.isSecondaryAppWindow.mockImplementation(
        (win: unknown) => win === mocks.focusedWindow || win === mocks.secondaryAppWindow,
      );
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
      let settleA: (result: unknown) => void = () => {};
      mocks.modifierStartKeyCapture.mockImplementationOnce(
        () => new Promise((resolve) => { settleA = resolve; }),
      );

      const a = start?.(mocks.recordingEvent);
      // 接手那一轮还在飞, 随后成功。
      mocks.modifierPendingStartResult.mockReturnValue(Promise.resolve({ ok: true }));
      mocks.modifierIsRunning.mockReturnValue(true);

      settleA({
        ok: false,
        error: 'Modifier shortcut listener start was superseded.',
        superseded: true,
      });

      expect(await a).toMatchObject({ ok: true });
      // 权限没问题也没故障, 不该去查权限状态。
      expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();
      // 登记还在, keys 送得到。
      mocks.focusedWindow.webContents.send.mockClear();
      mocks.listenerOptions.onKeys?.(['Fn']);
      expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
        'voice-input:modifier-shortcut-keys',
        { keys: ['Fn'] },
      );
    });

    // 录制登记按 sender id 记账，而同一个设置页连续两轮录制用的是同一个 id。第一轮在
    // 启动 listener 期间被第二轮顶掉后，如果仍走「失败就清理」分支，就会把第二轮刚登记
    // 的那条删掉——helper 起来了却没人收 keys，用户按 Fn 毫无反应。
    it('keeps the recording registration when a start is superseded by a later one', async () => {
      setPlatform('darwin');
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
      // sender 必须对上 BrowserWindow mock 的 webContents.id，onKeys 才转发得到它。

      // 复现真实交错：第一轮卡在启动 listener 上，第二轮期间成功登记，第一轮才带着
      // superseded 迟到返回。顺序调用测不到这个 bug——每次 start 都会先 add 一次，
      // 误删会被下一次 add 自动掩盖。
      let settleFirst: (result: unknown) => void = () => {};
      mocks.modifierStartKeyCapture.mockImplementationOnce(
        () => new Promise((resolve) => { settleFirst = resolve; }),
      );
      mocks.modifierStartKeyCapture.mockResolvedValueOnce({ ok: true });

      const first = start?.(mocks.recordingEvent);
      const second = await start?.(mocks.recordingEvent);
      expect(second).toMatchObject({ ok: true });

      // 第二轮成功 = 共享 helper 真的在跑。mock 要跟着反映这一点, 否则会造出「接手那轮成功了、
      // 可 listener 又没在跑」这种自相矛盾的状态。
      mocks.modifierIsRunning.mockReturnValue(true);

      settleFirst({
        ok: false,
        error: 'Modifier shortcut listener start was superseded.',
        superseded: true,
      });
      // 接手那轮成功, 被顶掉的这轮也就有 helper 可用 —— 报成功而不是让 renderer 静默丢弃一个
      // 'superseded'(那样它的录制框既收不到 Fn 提示、也不知道到底成没成)。
      expect(await first).toMatchObject({ ok: true });
      // 被顶掉不是故障，所以不该去问权限状态、也不该报成 permission / failed。
      expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();

      // 第二轮的登记必须还在：onKeys 能送到这个窗口，才说明名单没被迟到的那轮删掉。
      mocks.focusedWindow.webContents.send.mockClear();
      mocks.listenerOptions.onKeys?.(['Fn']);
      expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
        'voice-input:modifier-shortcut-keys',
        { keys: ['Fn'] },
      );
    });

    it('reports a superseded shortcut registration without rolling back or classifying', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({
        ok: false,
        error: 'Modifier shortcut listener start was superseded.',
        superseded: true,
      });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'superseded' });
      // 顶掉它的那一轮负责最终状态：这里不回滚（只调用了一次 setShortcut）、不查权限、
      // 也不落盘。
      expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(1);
      expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    });

    // 录制期的 key capture 只服务 Fn 检测。renderer 靠这个 errorCode 决定「安静地说明 Fn
    // 不可用」还是「报错」——裸修饰键走 DOM 事件,缺权限时照样录得上。
    it('tags a permission-blocked recording start so the renderer can explain Fn instead of erroring', async () => {
      setPlatform('darwin');
      mocks.modifierStartKeyCapture.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:modifier-shortcut-recording:start')?.(mocks.recordingEvent);

      expect(result).toMatchObject({ ok: false, errorCode: 'permission' });
    });

    // 两个设置页可以同时开着录制框:一边提交的那一刻另一边还在录。危险堵在**触发投递**而不是
    // 堵在注册 —— 推迟注册会让「F16 被别的应用占了」这类失败没法在提交时报给用户, 界面和存盘
    // 就留着一个永远不生效的快捷键。
    describe('trigger suppression while a recorder is open', () => {
      const f16: VoiceInputShortcut = {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      };
      const ctrlF16: VoiceInputShortcut = {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: true, alt: false, shift: false, fn: false },
      };

      // 构造真实状态: 另一个窗口在录(会话活跃), 这边提交 F16 —— 按本轮改动注册会照常发生,
      // 于是 accelerator 确实是注册着的。直接在挂起之后去取回调是空转断言:挂起会把 accelerator
      // 注销掉, 回调压根取不到, 「没触发」自然成立却什么都没测到(我第一版就是这么写的)。
      async function recordElsewhereThenCommitF16(): Promise<void> {
        await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.settingsEvent,
          null,
          { suspend: true },
        );
        await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, f16);
        expect(mocks.registeredShortcuts.has('F16')).toBe(true);
      }

      it('drops native F-key activations while another window is recording', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await recordElsewhereThenCommitF16();
        mocks.focusedWindow.webContents.send.mockClear();

        mocks.listenerOptions.onTrigger?.('start');

        expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          expect.anything(),
        );
      });

      it('resumes native F-key activations once the recorder closes', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await recordElsewhereThenCommitF16();
        await mocks.handlers.get('voice-input:modifier-shortcut-recording:stop')?.(mocks.settingsEvent);
        mocks.focusedWindow.webContents.send.mockClear();

        mocks.listenerOptions.onTrigger?.('start');

        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          expect.objectContaining({ id: expect.any(String), phase: 'start' }),
        );
      });

      // 同一个 helper 既服务常驻监听也服务录制页的 Fn 检测。一边提交 Ctrl+F16(走 accelerator 路径,
      // 会停掉 native listener)时不能把另一边的 keys 来源一起杀掉 —— 那个窗口的录制框还开着,
      // 却再也收不到 Fn, 只能关掉重开。
      it('keeps the shared capture alive for other recorders when committing an accelerator', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 另一个窗口的录制框开着,且 capture 真的起来了(转发名单里有它)。
        await mocks.handlers.get('voice-input:modifier-shortcut-recording:start')?.(mocks.recordingEvent);
        mocks.modifierStop.mockClear();

        await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, ctrlF16);

        // 关键:没有 stop 掉共享 helper,只放弃了快捷键。
        expect(mocks.modifierStop).not.toHaveBeenCalled();
        expect(mocks.modifierReleaseShortcut).toHaveBeenCalled();

        // 那个窗口照样收得到 keys。
        mocks.focusedWindow.webContents.send.mockClear();
        mocks.listenerOptions.onKeys?.(['Fn']);
        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
          'voice-input:modifier-shortcut-keys',
          { keys: ['Fn'] },
        );
      });

      // 没有窗口在录时照旧 stop —— 别把 helper 永久留着。
      it('stops the listener when no recorder needs the shared capture', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        mocks.modifierStop.mockClear();

        await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, ctrlF16);

        expect(mocks.modifierStop).toHaveBeenCalled();
        expect(mocks.modifierReleaseShortcut).not.toHaveBeenCalled();
      });

      // 按住说话的会话可能在录制框打开**之前**就已经 start 了; 挂起/替换 listener 会调
      // endActiveTriggerIfNeeded() 补发一次 end。把这个 end 也丢掉, 那个任务就永远停不下来 ——
      // listener 已经停了, 它还在录。所以只挡新激活。
      it('still delivers end while recording but drops new activations', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 有一个正在跑的 inline 语音输入会话 —— start / end 都会路由给它, 这既是可观察的投递
        // 代理, 也正是「孤立的 end」会误伤的那个对象。
        const { registerActiveInlineVoiceInputWebContents } = await import('../global.js');
        registerActiveInlineVoiceInputWebContents(
          mocks.focusedWindow.webContents as unknown as Parameters<typeof registerActiveInlineVoiceInputWebContents>[0],
        );

        // 按住说话的那次必须发生在录制框打开**之前** —— 这才是这条用例要守的场景。原来它在挂起
        // 之后才发 start, 模拟出来的其实是「被挡掉的 start」, 于是这条用例反而把「孤立的 end 也
        // 照送」钉成了正确行为(下面那条用例就是它漏掉的那个 bug)。
        mocks.listenerOptions.onTrigger?.('start');
        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          expect.objectContaining({ phase: 'start' }),
        );

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.settingsEvent,
          null,
          { suspend: true },
        );
        mocks.focusedWindow.webContents.send.mockClear();

        // 录制期间的新激活照旧挡掉。
        mocks.listenerOptions.onTrigger?.('tap');
        expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          expect.anything(),
        );

        // 而先前那次按住的 end 必须送到 —— 挂起会调 endActiveTriggerIfNeeded() 补发它, 丢掉
        // 那个任务就永远停不下来。
        mocks.listenerOptions.onTrigger?.('end');
        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          { phase: 'end' },
        );
      });

      // listener 的 triggered 是它自己的内部时序: 被投递层挡掉的 start, 用户按住过阈值再松手照样
      // 会给出一条 end。而 end 在下游就是「停止并提交」—— 正在跑的 inline 语音输入会话会被这条
      // 没有配对 start 的 end 直接提交掉, 用户只是按了一下本该被吞掉的键。
      it('drops the end of an activation whose start was suppressed', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc, registerActiveInlineVoiceInputWebContents } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        // 有它在, 一条孤立的 end 会被真的投递出去 —— 断言因此有区分力。
        registerActiveInlineVoiceInputWebContents(
          mocks.focusedWindow.webContents as unknown as Parameters<typeof registerActiveInlineVoiceInputWebContents>[0],
        );

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.settingsEvent,
          null,
          { suspend: true },
        );
        mocks.focusedWindow.webContents.send.mockClear();

        // 录制期间按下 → start 被挡; 按住过阈值再松手 → listener 照样发 end。
        mocks.listenerOptions.onTrigger?.('start');
        mocks.listenerOptions.onTrigger?.('end');

        expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          expect.anything(),
        );
      });

      // 配对判据不能退化成「此刻还在不在录制」: 录制框关掉之后姗姗来迟的那条 end, 只要它的 start
      // 被挡过, 就同样不该送。
      it('drops a late end from a suppressed start even after the recording stopped', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc, registerActiveInlineVoiceInputWebContents } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        registerActiveInlineVoiceInputWebContents(
          mocks.focusedWindow.webContents as unknown as Parameters<typeof registerActiveInlineVoiceInputWebContents>[0],
        );

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.settingsEvent,
          null,
          { suspend: true },
        );
        mocks.listenerOptions.onTrigger?.('start');
        await mocks.handlers.get('voice-input:modifier-shortcut-recording:stop')?.(mocks.settingsEvent);
        mocks.focusedWindow.webContents.send.mockClear();

        mocks.listenerOptions.onTrigger?.('end');

        expect(mocks.focusedWindow.webContents.send).not.toHaveBeenCalledWith(
          'voice-input:global-shortcut-trigger',
          expect.anything(),
        );
      });

      // 这条是本轮的核心:另一个窗口在录的时候提交, 注册照常发生, 所以注册失败(F16 被别的应用
      // 占了)当场就能报给用户 —— 而不是存下一个永远不生效的快捷键、只在日志里留一行。
      it('still reports a registration failure while another window is recording', async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.settingsEvent,
          null,
          { suspend: true },
        );
        // 系统里已被别的应用占用。
        mocks.registerShortcut.mockReturnValue(false);

        const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, f16);

        expect(result).toMatchObject({ ok: false });
        expect(mocks.updateSettings).not.toHaveBeenCalled();
      });
    });

    // 录制期那两条 IPC 会改动全局监听状态,所以要挡住低信任 renderer。Ghost 面板装的是插件
    // 内容,却同样带着完整 preload —— 用 secondaryWindowEvent 冒充它(fromWebContents 查不到
    // 对应窗口)。
    describe('recording IPC sender authorization', () => {
      // 挂起会把 sender 登记成「正在录制」,而这个登记只在它自己发 stop 或窗口销毁时才摘掉:
      // 期间快捷键被注销、同步与兜底恢复都会被「录制中」守卫拒掉。一次调用就能让语音快捷键
      // 在那个窗口的整个生命周期里失效。
      it('rejects a suspend from a renderer that is not an app shell window', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get('voice-input:global-shortcut:set')?.(
            mocks.secondaryWindowEvent,
            null,
            { suspend: true },
          ),
        ).rejects.toThrow(/app shell windows/);

        // 关键:被拒的调用不能留下录制会话,否则合法的同步会一直被「录制中」守卫拒掉。
        mocks.modifierSetShortcut.mockClear();
        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);
        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 这条比上面那条严重:登记进 keys 转发名单就会收到 helper 的 keys 事件,而它不止修饰键
      // —— 非修饰键会以 `KeyCode:<n>` 一起发出来,等于一路系统级按键流。
      it('rejects a recording start from a renderer that is not an app shell window', async () => {
        setPlatform('darwin');
        mocks.modifierStartKeyCapture.mockResolvedValue({ ok: true });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get('voice-input:modifier-shortcut-recording:start')?.(mocks.secondaryWindowEvent),
        ).rejects.toThrow(/app shell windows/);

        // 真正要守的后果:它没进 keys 转发名单。这个窗口在 getAllWindows 里查得到,所以一旦
        // 登记成功 onKeys 就会真的往它 send —— 断言因此有区分力。
        mocks.listenerOptions.onKeys?.(['Fn']);
        expect(mocks.ghostPanelWindow.webContents.send).not.toHaveBeenCalled();
      });

      // 防止把闸修成「谁都拒」:合法的会话副窗口照样能录、照样收得到 keys。
      it('still lets an app shell window record and receive keys', async () => {
        setPlatform('darwin');
        mocks.modifierStartKeyCapture.mockResolvedValue({ ok: true });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const result = await mocks.handlers
          .get('voice-input:modifier-shortcut-recording:start')?.(mocks.recordingEvent);

        expect(result).toMatchObject({ ok: true });
        mocks.listenerOptions.onKeys?.(['Fn']);
        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
          'voice-input:modifier-shortcut-keys',
          { keys: ['Fn'] },
        );
      });

      // 不带 suspend 的同步是「让运行期对上存盘」的回声,右侧栏里的 ChatInput、overlay 都会发。
      // 把它一起关掉会让那些窗口的回声全变成异常,所以这道闸只管挂起。
      it('does not gate the plain sync echo', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const result = await mocks.handlers
          .get('voice-input:global-shortcut:set')?.(mocks.secondaryWindowEvent, bareRightOption);

        expect(result).toMatchObject({ ok: true });
      });
    });

    // useVoiceInputSettings 里有个 effect:settings.shortcut 一变就 sync 一次,每个挂载它的
    // 窗口都会回声。两次提交交错时,先落地那次广播的是**旧**快捷键,后台窗口(渲染被节流、
    // effect 跑得晚)的回声就可能排在更晚那次提交之后,把旧的重新注册上 —— 存盘和界面显示
    // 新的、实际生效的是旧那个。
    describe('stale global shortcut sync echoes', () => {
      const f16: VoiceInputShortcut = {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      };

      it('ignores a non-null sync that does not match the persisted shortcut', async () => {
        setPlatform('darwin');
        // 存盘里已经是用户最后选的 F16。
        mocks.setStoredShortcut(f16);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 迟到的回声还带着旧的裸右 Option。
        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(result).toMatchObject({ ok: true });
        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      it('still applies a sync that matches the persisted shortcut', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 挂起(null)是这条 channel 的另一个正当用途,永远放行 —— 录制期就靠它。
      it('always applies an explicit suspend request', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 挂起故意与存盘不同,所以必须显式带 intent 才放行。
        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.(
          mocks.recordingEvent,
          null,
          { suspend: true },
        );

        expect(result).toMatchObject({ ok: true });
        expect(mocks.modifierStop).toHaveBeenCalled();
      });

      // 录制 effect 是先等挂起返回、再发 recording:start 的(顺序反过来会让挂起里的
      // listener.stop() 把 capture 刚起的 helper 一起杀掉)。那两步之间, 排在挂起之后的兜底
      // 恢复会看到「没在录制」而把已保存的快捷键装回去; 随后 startKeyCapture 看见 child 已在
      // 跑就直接返回成功、不清掉那个 shortcut —— 用户在录制框里按键会真的触发语音输入。
      it('blocks recovery from the moment an explicit suspend arrives, before recording:start', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(mocks.recordingEvent, null, { suspend: true });
        mocks.modifierSetShortcut.mockClear();

        // recording:start 还没发出来就来了一次聚焦。
        mocks.appListeners.get('browser-window-focus')?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 录制结束(stop)之后,兜底恢复必须重新可用 —— 否则挂起那一下会把它永久堵死。
      it('lets recovery resume after the recording stops', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await mocks.handlers.get('voice-input:global-shortcut:set')?.(mocks.recordingEvent, null, { suspend: true });
        await mocks.handlers.get('voice-input:modifier-shortcut-recording:stop')?.(mocks.recordingEvent);
        mocks.modifierSetShortcut.mockClear();

        mocks.appListeners.get('browser-window-focus')?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 「清空快捷键」那次提交广播出的 null 回声, 迟到落地就会把更晚一次提交刚注册好的快捷键
      // 直接关掉 —— 存盘和界面显示新快捷键, 实际却什么都不响应。所以 null 也要按存盘校验。
      it('ignores a stale null sync that is not an explicit suspend', async () => {
        setPlatform('darwin');
        // 存盘里已经是用户最后选的那个。
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        mocks.modifierStop.mockClear();

        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, null);

        expect(result).toMatchObject({ ok: true });
        expect(mocks.modifierStop).not.toHaveBeenCalled();
      });

      // 存盘本来就是空的(用户清掉了快捷键): 这条 null 同步与存盘一致, 该照常落地。
      it('still applies a null sync when the persisted shortcut is also null', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(null);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        mocks.modifierStop.mockClear();

        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, null);

        expect(mocks.modifierStop).toHaveBeenCalled();
      });

      // 录制期间是刻意挂起的:别的窗口的回声即便与存盘一致,这时也不能把它装回来。
      it('ignores a matching sync while a shortcut recording is in progress', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        await start?.(mocks.recordingEvent);
        mocks.modifierSetShortcut.mockClear();

        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });
    });

    // 这两条 handler 会弹系统级授权窗。语音浮窗、词典 toast、右侧栏窗口、Ghost 面板装的
    // 都是同一份 preload，而后两者还会 markAppContentWindow —— 所以只靠「是不是受信应用
    // 窗口」不够，必须收窄到承载路由的应用外壳窗口(主窗口 + 会话副窗口)，否则那些窗口被
    // XSS 拿下就能在设置流程外弹权限窗。
    for (const channel of [
      'voice-input:request-input-monitoring-permission',
      'voice-input:open-input-monitoring-settings',
    ]) {
      it(`rejects ${channel} from another registered app window`, async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 通用闸放行（模拟右侧栏 / Ghost 面板这种已登记窗口），只有主窗口收窄闸拦下它。
        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryWindowEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
        expect(mocks.requestInputMonitoring).not.toHaveBeenCalled();
      });

      // 「Open in New Window」的会话副窗口跑同一套路由,设置页在里面照样打得开。只认主窗口
      // 的话:用户在副窗口里点授权入口只会得到失败,存盘后的自动请求还会静默失效。
      it(`accepts ${channel} from a session window opened in a new window`, async () => {
        setPlatform('darwin');
        mocks.isSecondaryAppWindow.mockReturnValue(true);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryAppWindowEvent),
        ).resolves.toMatchObject({ ok: true });
      });

      // 同样形状的顶层窗口,但不是会话副窗口(右侧栏 / Ghost 面板就是这种):必须拒。
      it(`rejects ${channel} from a top-level window that is not an app shell window`, async () => {
        setPlatform('darwin');
        mocks.isSecondaryAppWindow.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryAppWindowEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
        expect(mocks.requestInputMonitoring).not.toHaveBeenCalled();
      });

      // 窗口身份挡不住「外壳窗口里的会话内容被 XSS 拿下」——主窗口同样承载会话内容(/settings
      // 与 /cc-agent 是同一 router 下的兄弟路由)。但要求 sender 是**当前聚焦**的窗口, 后台或
      // 被遮住的窗口就再也弹不出系统权限窗; 而合法路径(点徽章、录完快捷键)永远发生在用户正
      // 看着的那个窗口里。
      it(`rejects ${channel} from an unfocused app shell window`, async () => {
        setPlatform('darwin');
        mocks.mainWindowIsFocused.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.settingsEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
        expect(mocks.requestInputMonitoring).not.toHaveBeenCalled();
      });

      it(`rejects ${channel} from an unfocused session window`, async () => {
        setPlatform('darwin');
        mocks.isSecondaryAppWindow.mockReturnValue(true);
        mocks.secondaryAppWindowIsFocused.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryAppWindowEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
      });

      it(`rejects ${channel} when the generic trusted-renderer gate fails`, async () => {
        setPlatform('darwin');
        mocks.assertTrustedAppRenderer.mockImplementation(() => {
          throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
        });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.settingsEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
        expect(mocks.requestInputMonitoring).not.toHaveBeenCalled();
      });
    }

    // denied 是正常结果(用户还没在系统设置里打开)，不该当故障抛。
    it('returns the denied status instead of throwing when the user has not granted yet', async () => {
      setPlatform('darwin');
      mocks.requestInputMonitoring.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:request-input-monitoring-permission')?.(
        mocks.settingsEvent,
      );

      expect(result).toEqual({ ok: true, status: 'denied' });
      expect(mocks.assertTrustedAppRenderer).toHaveBeenCalled();
    });

    // helper 跑不起来时它的 error 里带 swiftc / execFile 的内部绝对路径，既不能当成
    // 「权限被拒」，也不能原样过桥给 renderer。
    it('throws a sanitized IPC error when the permission status cannot be read at all', async () => {
      setPlatform('darwin');
      mocks.requestInputMonitoring.mockResolvedValue({
        ok: false,
        status: 'unknown',
        error: 'spawn /Users/someone/Library/Application Support/Cindy/voice-input/helper ENOENT',
      });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const call = mocks.handlers.get('voice-input:request-input-monitoring-permission')?.(
        mocks.settingsEvent,
      );

      // 用 ^...$ 锚定完整消息，而不是断言「不含某个路径」——后者容易写成永远为真的空转
      // 断言。锚定后一旦 helper 的原始 error（含内部绝对路径）被拼进去就会失败。
      await expect(call).rejects.toThrow(
        /^\[INTERNAL\] Could not request the Input Monitoring permission\.$/,
      );
    });

    it('persists normally when the native listener starts', async () => {
      setPlatform('darwin');
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty('pendingInputMonitoring');
      expect(mocks.updateSettings).toHaveBeenCalledWith({ shortcut: bareRightOption });
    });
  });

  it('rejects settings navigation from a non-overlay sender with a typed IPC error', async () => {
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const openSettings = mocks.handlers.get('voice-input:open-settings');

    await expect(openSettings?.({ sender: mocks.focusedWindow.webContents }, 'providers'))
      .rejects.toThrow('[PERMISSION_DENIED]');
  });

  it('suppresses paste-target focus restore for settings navigation', async () => {
    const { shouldRestoreOverlayPasteTarget } = await import('../global.js');

    expect(shouldRestoreOverlayPasteTarget({ restorePasteTarget: false }, 'darwin')).toBe(false);
    expect(shouldRestoreOverlayPasteTarget(undefined, 'darwin')).toBe(true);
    expect(shouldRestoreOverlayPasteTarget(undefined, 'win32')).toBe(false);
  });

  // helper 会在最终结果之前先流式吐出前台窗口 frame(浮窗选屏只等这一行),所以
  // 结果解析必须认最后一行,不能把第一行进度事件当成命令结果。
  describe('parseMacTextInsertionHelperResult', () => {
    it('多行输出时取最后一行作为结果', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      const stdout = [
        '{"event":"focused-window-frame","frame":{"x":0,"y":0,"width":800,"height":600},"frameSource":"ax"}',
        '{"ok":true,"target":{"processName":"Chrome","bundleId":"com.google.Chrome","pid":42}}',
        '',
      ].join('\n');

      const result = parseMacTextInsertionHelperResult(stdout);
      expect(result.ok).toBe(true);
      expect(result.event).toBeUndefined();
      expect(result.target?.processName).toBe('Chrome');
    });

    it('单行输出保持原行为', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      expect(parseMacTextInsertionHelperResult('{"ok":true,"outcome":"verified_success"}\n').ok)
        .toBe(true);
    });

    it('空输出与非法 JSON 抛错(由调用方转成 PasteCommandError)', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      expect(() => parseMacTextInsertionHelperResult('   \n\n')).toThrow();
      expect(() => parseMacTextInsertionHelperResult('not json')).toThrow();
    });
  });

  // 词典 toast 锚点按「请求到达顺序」绑定:renderer 收到证据会立刻发起 advisor 请求,
  // 所以请求到达顺序 == 证据发布顺序,并发只发生在响应上。取走必须是 FIFO 且一次性。
  describe('takeOverlayDictionaryToastAnchor', () => {
    it('没有待取锚点时返回 null', async () => {
      const { takeOverlayDictionaryToastAnchor } = await import('../global.js');
      expect(takeOverlayDictionaryToastAnchor()).toBeNull();
    });
  });
});
