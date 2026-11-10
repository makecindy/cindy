import { describe, expect, it, vi } from 'vitest';

import {
  installMainWindowMaximizeRecovery,
  installMainWindowNativeRestoreIntent,
  readPersistedWindowMaximized,
  type DisplayChangeEvent,
  type MaximizeRecoveryNativeWindow,
} from '../mainWindowMaximizeRecovery';
import {
  commitReplacedNormalBounds,
  manageWindowStatePreservingNormalBounds,
  planWindowRestore,
  type PersistableWindow,
  type WorkAreaRect,
  type WorkAreaScreen,
} from '../mainWindowWorkAreaBounds';

/**
 * 测试价值
 * - 生产入口与可观察结果：commitReplacedNormalBounds。窗口已按默认尺寸建好、还没最大化时
 *   调 keeper.saveState，退出记下的是这份尺寸和原来的 x/y；最大化之后再保存只改标记。
 *   下次启动因此不再把整块工作区当成还原目标。
 * - Bug／规则依据：PR #9572 最后一条评审。只改 BrowserWindow 构造参数时，keeper 闭包里仍是
 *   工作区矩形；maximize() 之后它不再改宽高，退出就把旧矩形和 isMaximized=true 存回去。
 * - 现有覆盖缺口：mainWindowWorkAreaBounds 的假 manage 直接读窗口，没有先保存再最大化
 *   这条时序；本文件原来只覆盖显示器抖动后的重新最大化。
 * - 最小失败输入：已保存的合法工作区矩形 + isMaximized=false，窗口先处在替换尺寸，
 *   不调 saveState 就 maximize，然后关窗。
 * - tier：unit。不启 Electron。写入规则与 electron-window-state 的 updateState 相同：
 *   普通窗口才覆盖宽高，已最大化只更新标记。
 * - 实测耗时：随本文件一起跑，pnpm --dir apps/desktop exec vitest run
 *   src/main/__tests__/mainWindowMaximizeRecovery.test.ts。
 */

interface KeeperWindow extends PersistableWindow {
  on(event: string, listener: () => void): void;
  maximize(): void;
  close(): void;
}

/**
 * Listeners fire in registration order, the same way Electron does, so a maximize
 * that happens after manage() is visible to the keeper's resize handler.
 */
function createKeeperWindow(initial: {
  x: number;
  y: number;
  width: number;
  height: number;
}): KeeperWindow {
  let bounds = { ...initial };
  let maximized = false;
  const listeners = new Map<string, Array<() => void>>();
  const emit = (event: string): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener();
  };
  return {
    isMaximized: () => maximized,
    isMinimized: () => false,
    isFullScreen: () => false,
    getBounds: () => bounds,
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    maximize: () => {
      if (maximized) return;
      maximized = true;
      bounds = { x: 0, y: 0, width: 1536, height: 864 };
      emit('maximize');
      emit('resize');
    },
    close: () => {
      emit('close');
    },
  };
}

interface SavedWindowState extends WorkAreaRect {
  isMaximized: boolean;
  isFullScreen: boolean;
}

/**
 * The write inside electron-window-state `updateState`: a normal window replaces the
 * rectangle, a maximized one does not. `saveState` and the `manage` listeners both
 * end there, which is the whole bug.
 */
function applyKeeperUpdate(saved: SavedWindowState, win: PersistableWindow): void {
  if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
    Object.assign(saved, win.getBounds());
  }
  saved.isMaximized = win.isMaximized();
  saved.isFullScreen = win.isFullScreen();
}

describe('commitReplacedNormalBounds', () => {
  const workArea = { x: 1920, y: 40, width: 1536, height: 864 };
  const keeperScreen: WorkAreaScreen = {
    getPrimaryDisplay: () => ({ bounds: workArea, workArea }),
    getDisplayMatching: () => ({ bounds: workArea, workArea }),
  };

  it('keeps the replaced restore size when launch maximizes and quit never unmaximizes', () => {
    const saved: SavedWindowState = {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      isMaximized: false,
      isFullScreen: false,
    };
    expect(planWindowRestore(saved, keeperScreen, { platform: 'win32' })).toEqual({
      restoreMaximized: true,
      replaceWithDefaultSize: true,
    });

    const replaced = { x: saved.x, y: saved.y, width: 1280, height: 800 };
    const win = createKeeperWindow(replaced);
    const keeper = {
      saveState: (target: PersistableWindow) => applyKeeperUpdate(saved, target),
      manage: (target: PersistableWindow) => {
        target.on?.('resize', () => applyKeeperUpdate(saved, target));
        target.on?.('close', () => applyKeeperUpdate(saved, target));
      },
    };

    manageWindowStatePreservingNormalBounds(keeper, win, keeperScreen, 'win32');
    commitReplacedNormalBounds(keeper, win);
    expect(saved).toMatchObject({ ...replaced, isMaximized: false });

    win.maximize();
    expect(win.isMaximized()).toBe(true);
    win.close();

    expect(saved).toMatchObject({ ...replaced, isMaximized: true });
    expect(saved.width).not.toBe(workArea.width);
    expect(
      planWindowRestore(saved, keeperScreen, { platform: 'win32' }),
    ).toEqual({ restoreMaximized: true, replaceWithDefaultSize: false });
    expect({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }).toEqual(replaced);
  });
});

describe('readPersistedWindowMaximized', () => {
  it('reads the flag from the raw window-state file', () => {
    const read = vi.fn(() => JSON.stringify({ width: 1280, height: 812, isMaximized: true }));
    expect(readPersistedWindowMaximized('state.json', read)).toBe(true);
    expect(read).toHaveBeenCalledWith('state.json', 'utf8');
  });

  it('is false for a windowed, malformed or missing file', () => {
    expect(readPersistedWindowMaximized('x', () => JSON.stringify({ isMaximized: false }))).toBe(
      false,
    );
    expect(readPersistedWindowMaximized('x', () => JSON.stringify({ isMaximized: 'yes' }))).toBe(
      false,
    );
    expect(readPersistedWindowMaximized('x', () => '[]')).toBe(false);
    expect(readPersistedWindowMaximized('x', () => 'not json')).toBe(false);
    expect(
      readPersistedWindowMaximized('x', () => {
        throw new Error('ENOENT');
      }),
    ).toBe(false);
  });
});

type Timer = { callback: () => void; ms: number; cleared: boolean };

function createHarness(options: { armed?: boolean } = {}) {
  let nowMs = 0;
  const timers: Timer[] = [];
  const windowListeners = new Map<string, () => void>();
  const screenListeners = new Map<string, () => void>();
  const state = {
    visible: true,
    maximized: false,
    minimized: false,
    fullscreen: false,
    destroyed: false,
  };

  const win = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMaximized: () => state.maximized,
    isMinimized: () => state.minimized,
    isFullScreen: () => state.fullscreen,
    maximize: vi.fn(() => {
      state.maximized = true;
      windowListeners.get('maximize')?.();
    }),
    on: vi.fn((event: string, listener: () => void) => windowListeners.set(event, listener)),
    removeListener: vi.fn((event: string) => windowListeners.delete(event)),
  };
  const screen = {
    on: vi.fn((event: string, listener: () => void) => screenListeners.set(event, listener)),
    removeListener: vi.fn((event: string) => screenListeners.delete(event)),
  };
  const log = { info: vi.fn() };

  const recovery = installMainWindowMaximizeRecovery(win, screen, {
    armed: options.armed ?? true,
    log,
    now: () => nowMs,
    setTimer: (callback, ms) => {
      const timer: Timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).cleared = true;
    },
    settleMs: 300,
    graceMs: 2_000,
  });

  const runTimers = (): void => {
    for (const timer of timers.splice(0)) {
      if (!timer.cleared) timer.callback();
    }
  };
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  const fireDisplay = (event: DisplayChangeEvent = 'display-metrics-changed'): void => {
    screenListeners.get(event)?.();
  };
  const osUnmaximize = (): void => {
    state.maximized = false;
    windowListeners.get('unmaximize')?.();
  };
  const userUnmaximize = (): void => {
    recovery.notifyUserUnmaximizeIntent();
    state.maximized = false;
    windowListeners.get('unmaximize')?.();
  };
  const showWindow = (): void => {
    state.visible = true;
    windowListeners.get('show')?.();
  };
  const restoreWindow = (): void => {
    state.minimized = false;
    windowListeners.get('restore')?.();
  };
  const leaveFullscreen = (): void => {
    state.fullscreen = false;
    windowListeners.get('leave-full-screen')?.();
  };

  return {
    state,
    win,
    screen,
    log,
    timers,
    recovery,
    dispose: recovery.dispose,
    runTimers,
    advance,
    fireDisplay,
    osUnmaximize,
    userUnmaximize,
    showWindow,
    restoreWindow,
    leaveFullscreen,
    windowListeners,
    screenListeners,
  };
}

describe('installMainWindowMaximizeRecovery', () => {
  it('re-maximizes a windowed main window after the display settles', () => {
    const h = createHarness();

    h.fireDisplay('display-added');
    expect(h.win.maximize).not.toHaveBeenCalled();
    expect(h.timers.at(-1)?.ms).toBe(300);

    h.runTimers();
    expect(h.win.maximize).toHaveBeenCalledOnce();
    expect(h.log.info).toHaveBeenCalledWith('re-applying maximized state after display change');
  });

  it('coalesces a burst of display events into a single re-apply', () => {
    const h = createHarness();

    h.fireDisplay('display-removed');
    h.fireDisplay('display-added');
    h.fireDisplay('display-metrics-changed');
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('does nothing while the window is already maximized', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.runTimers();

    expect(h.win.maximize).not.toHaveBeenCalled();
  });

  it.each([
    ['hidden', { visible: false }],
    ['minimized', { minimized: true }],
    ['fullscreen', { fullscreen: true }],
    ['destroyed', { destroyed: true }],
  ])('leaves a %s window alone', (_label, patch) => {
    const h = createHarness();
    Object.assign(h.state, patch);

    h.fireDisplay();
    h.runTimers();

    expect(h.win.maximize).not.toHaveBeenCalled();
  });

  it('keeps recovery armed when the OS unmaximizes right around a display change', () => {
    const h = createHarness();
    h.state.maximized = true;

    // Unmaximize first (Windows re-layout), display event shortly after.
    h.osUnmaximize();
    h.advance(500);
    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).toHaveBeenCalledOnce();

    // Display event first, unmaximize inside the grace window.
    h.advance(10_000);
    h.fireDisplay();
    h.advance(1_000);
    h.osUnmaximize();
    h.runTimers();
    expect(h.win.maximize).toHaveBeenCalledTimes(2);
  });

  it('retries when the OS unmaximizes after the first settle timer', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();

    h.advance(1_000);
    h.osUnmaximize();
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('honors an explicit user restore during the display-change grace window', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.userUnmaximize();
    h.runTimers();

    expect(h.win.maximize).not.toHaveBeenCalled();

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();
  });

  it('keeps recovery armed when a native restore intent is not followed by unmaximize', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();

    h.recovery.notifyUserUnmaximizeIntent();
    h.advance(600);
    h.osUnmaximize();
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('cancels a late OS re-apply when native restore intent follows unmaximize', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.runTimers();
    h.advance(1_000);
    h.osUnmaximize();
    h.recovery.notifyUserUnmaximizeIntent('after-unmaximize');
    h.runTimers();

    expect(h.win.maximize).not.toHaveBeenCalled();

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();
  });

  it('does not pair a late title-bar intent with an earlier OS unmaximize', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.runTimers();
    h.advance(1_000);
    h.osUnmaximize();
    h.recovery.notifyUserUnmaximizeIntent('before-unmaximize');
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('does not let a pre-display native intent confirm the display re-layout', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.recovery.notifyUserUnmaximizeIntent();
    h.advance(100);
    h.fireDisplay();
    h.runTimers();
    h.osUnmaximize();
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('keeps a native intent created during a display burst across later events', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.advance(100);
    h.recovery.notifyUserUnmaximizeIntent();
    h.advance(100);
    h.fireDisplay();
    h.osUnmaximize();
    h.runTimers();

    expect(h.win.maximize).not.toHaveBeenCalled();
  });

  it('expires a native intent before a later display burst', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.fireDisplay();
    h.advance(2_500);
    h.recovery.notifyUserUnmaximizeIntent();
    h.advance(100);
    h.fireDisplay();
    h.osUnmaximize();
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('disarms after the user unmaximizes away from any display change', () => {
    const h = createHarness();
    h.state.maximized = true;

    h.advance(60_000);
    h.osUnmaximize();
    h.advance(2_000);
    h.runTimers();

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();
  });

  it.each([
    ['hidden', { visible: false }, 'showWindow'],
    ['minimized', { minimized: true }, 'restoreWindow'],
  ])('retries after a %s window becomes available', (_label, patch, makeAvailable) => {
    const h = createHarness();
    h.state.maximized = true;
    Object.assign(h.state, patch);

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();

    h.osUnmaximize();
    h.runTimers();
    h.state.maximized = false;
    if (makeAvailable === 'showWindow') h.showWindow();
    else h.restoreWindow();
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('retries after leaving fullscreen when a display recovery was pending', () => {
    const h = createHarness();
    h.state.maximized = true;
    h.state.fullscreen = true;

    h.fireDisplay();
    h.runTimers();
    h.osUnmaximize();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();

    h.leaveFullscreen();
    h.runTimers();

    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('re-arms when the user maximizes again', () => {
    const h = createHarness({ armed: false });

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();

    h.windowListeners.get('maximize')?.();
    h.state.maximized = false;
    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).toHaveBeenCalledOnce();
  });

  it('tears down its listeners on close and on dispose', () => {
    const h = createHarness();
    h.windowListeners.get('closed')?.();

    expect(h.screen.removeListener).toHaveBeenCalledTimes(3);
    expect(h.win.removeListener).toHaveBeenCalledWith('maximize', expect.any(Function));
    expect(h.win.removeListener).toHaveBeenCalledWith('unmaximize', expect.any(Function));
    expect(h.win.removeListener).toHaveBeenCalledWith('show', expect.any(Function));
    expect(h.win.removeListener).toHaveBeenCalledWith('restore', expect.any(Function));
    expect(h.win.removeListener).toHaveBeenCalledWith('leave-full-screen', expect.any(Function));
    expect(h.screenListeners.size).toBe(0);

    h.fireDisplay();
    h.runTimers();
    expect(h.win.maximize).not.toHaveBeenCalled();

    const again = createHarness();
    again.fireDisplay();
    again.dispose();
    again.runTimers();
    expect(again.win.maximize).not.toHaveBeenCalled();
  });
});

describe('installMainWindowNativeRestoreIntent', () => {
  function createNativeHarness() {
    type Listener = (...args: unknown[]) => void;
    const windowListeners = new Map<string, Listener>();
    const webContentsListeners = new Map<string, Listener>();
    const windowMessageListeners = new Map<number, (wParam: Buffer, lParam: Buffer) => void>();
    const native = { destroyed: false };
    const assertAlive = () => {
      if (native.destroyed) throw new TypeError('Object has been destroyed');
    };
    const removeListener = vi.fn((event: string) => windowListeners.delete(event));
    const removeWebContentsListener = vi.fn((event: string) => webContentsListeners.delete(event));
    const unhookWindowMessage = vi.fn((message: number) => {
      assertAlive();
      return windowMessageListeners.delete(message);
    });
    const win = {
      isDestroyed: () => native.destroyed,
      isVisible: () => true,
      isMaximized: () => true,
      isMinimized: () => false,
      isFullScreen: () => false,
      maximize: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => windowListeners.set(event, listener)),
      removeListener,
      hookWindowMessage: vi.fn(
        (message: number, listener: (wParam: Buffer, lParam: Buffer) => void) =>
          windowMessageListeners.set(message, listener),
      ),
      unhookWindowMessage,
      webContents: {
        on: vi.fn((event: string, listener: Listener) => webContentsListeners.set(event, listener)),
        removeListener: removeWebContentsListener,
      },
    } as unknown as MaximizeRecoveryNativeWindow;
    return {
      win,
      native,
      windowListeners,
      webContentsListeners,
      windowMessageListeners,
      removeListener,
      removeWebContentsListener,
      unhookWindowMessage,
    };
  }

  // The main window disposes this from its 'closed' event, after the native window is gone.
  // Touching it then threw "Object has been destroyed" as an uncaughtException during the
  // Windows update relaunch (forceQuit destroys every window).
  it('disposes without touching a window that is already destroyed', () => {
    const h = createNativeHarness();
    const dispose = installMainWindowNativeRestoreIntent(h.win, vi.fn(), 'win32');

    h.native.destroyed = true;

    expect(() => dispose()).not.toThrow();
    expect(h.unhookWindowMessage).not.toHaveBeenCalled();
  });

  it('marks Windows native restore gestures before unmaximize', () => {
    const h = createNativeHarness();
    const notify = vi.fn();
    const dispose = installMainWindowNativeRestoreIntent(h.win, notify, 'win32');

    h.windowListeners.get('will-move')?.();
    h.windowListeners.get('will-resize')?.();
    h.webContentsListeners.get('before-mouse-event')?.(
      {},
      {
        type: 'mouseDown',
        button: 'left',
        clickCount: 2,
        y: 24,
      },
    );
    h.webContentsListeners.get('before-input-event')?.(
      {},
      {
        type: 'keyDown',
        key: 'ArrowDown',
        meta: true,
        isAutoRepeat: false,
        modifiers: ['meta'],
      },
    );
    const restoreCommand = Buffer.alloc(8);
    restoreCommand.writeUInt32LE(0xf120, 0);
    h.windowMessageListeners.get(0x0112)?.(restoreCommand, Buffer.alloc(8));

    expect(notify).toHaveBeenCalledTimes(5);

    dispose();
    expect(h.removeListener).toHaveBeenCalledWith('will-move', expect.any(Function));
    expect(h.removeListener).toHaveBeenCalledWith('will-resize', expect.any(Function));
    expect(h.removeWebContentsListener).toHaveBeenCalledWith(
      'before-mouse-event',
      expect.any(Function),
    );
    expect(h.removeWebContentsListener).toHaveBeenCalledWith(
      'before-input-event',
      expect.any(Function),
    );
    expect(h.unhookWindowMessage).toHaveBeenCalledWith(0x0112);
    expect(h.windowListeners.size).toBe(0);
    expect(h.webContentsListeners.size).toBe(0);
    expect(h.windowMessageListeners.size).toBe(0);
  });

  it('ignores unrelated input and non-Windows platforms', () => {
    const h = createNativeHarness();
    const notify = vi.fn();
    const dispose = installMainWindowNativeRestoreIntent(h.win, notify, 'darwin');

    expect(h.windowListeners.size).toBe(0);
    expect(h.webContentsListeners.size).toBe(0);

    dispose();
    expect(notify).not.toHaveBeenCalled();

    const windows = createNativeHarness();
    const windowsNotify = vi.fn();
    installMainWindowNativeRestoreIntent(windows.win, windowsNotify, 'win32');
    windows.webContentsListeners.get('before-mouse-event')?.(
      {},
      {
        type: 'mouseDown',
        button: 'right',
        clickCount: 2,
        y: 24,
      },
    );
    windows.webContentsListeners.get('before-mouse-event')?.(
      {},
      {
        type: 'mouseDown',
        button: 'left',
        clickCount: 2,
        y: 60,
      },
    );
    windows.webContentsListeners.get('before-input-event')?.(
      {},
      {
        type: 'keyDown',
        key: 'ArrowDown',
        meta: false,
        isAutoRepeat: false,
        modifiers: [],
      },
    );
    expect(() =>
      windows.webContentsListeners.get('before-input-event')?.(
        {},
        {
          type: 'keyDown',
          key: 'a',
          meta: false,
          isAutoRepeat: false,
        },
      ),
    ).not.toThrow();
    windows.webContentsListeners.get('before-input-event')?.(
      {},
      {
        type: 'keyDown',
        key: 'ArrowDown',
        meta: true,
        isAutoRepeat: true,
        modifiers: ['meta'],
      },
    );
    const minimizeCommand = Buffer.alloc(8);
    minimizeCommand.writeUInt32LE(0xf020, 0);
    windows.windowMessageListeners.get(0x0112)?.(minimizeCommand, Buffer.alloc(8));

    expect(windowsNotify).not.toHaveBeenCalled();
  });
});
