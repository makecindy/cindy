import { describe, expect, it, vi } from 'vitest';

import {
  installMainWindowMaximizeRecovery,
  installMainWindowNativeRestoreIntent,
  readPersistedWindowMaximized,
  type DisplayChangeEvent,
  type MaximizeRecoveryNativeWindow,
} from '../mainWindowMaximizeRecovery';

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
    const removeListener = vi.fn((event: string) => windowListeners.delete(event));
    const removeWebContentsListener = vi.fn((event: string) => webContentsListeners.delete(event));
    const unhookWindowMessage = vi.fn((message: number) => windowMessageListeners.delete(message));
    const win = {
      isDestroyed: () => false,
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
      windowListeners,
      webContentsListeners,
      windowMessageListeners,
      removeListener,
      removeWebContentsListener,
      unhookWindowMessage,
    };
  }

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
