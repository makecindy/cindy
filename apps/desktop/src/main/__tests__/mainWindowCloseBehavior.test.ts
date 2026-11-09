import { describe, expect, it, vi } from 'vitest';

import {
  applyLinuxMainWindowCloseBehavior,
  cancelPendingWindowHide,
  createCloseBehaviorPromptFallbackController,
  handleMainWindowCloseRequest,
  minimizeDesktopWindow,
  requestActiveTurnGuardedQuit,
  requestMainWindowCloseBehavior,
  type MainWindowClosePromptWindow,
} from '../mainWindowCloseBehavior';

function makePromptWindow(): MainWindowClosePromptWindow & {
  destroyed: boolean;
  minimized: boolean;
  visible: boolean;
  webContentsDestroyed: boolean;
} {
  const window = {
    destroyed: false,
    minimized: false,
    visible: true,
    webContentsDestroyed: false,
    focus: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isVisible() {
      return this.visible;
    },
    restore: vi.fn(() => {
      window.minimized = false;
    }),
    show: vi.fn(() => {
      window.visible = true;
    }),
    webContents: {
      isDestroyed: () => window.webContentsDestroyed,
      send: vi.fn(),
    },
  };
  return window;
}

function createFallbackHarness<TBehavior>(initialBehavior: TBehavior | null, fallback: TBehavior) {
  let behavior = initialBehavior;
  let scheduledCallback: (() => void) | null = null;
  const deps = {
    readBehavior: vi.fn(() => behavior),
    showRendererPrompt: vi.fn(),
    showNativePrompt: vi.fn(() => fallback),
    persistBehavior: vi.fn((next: TBehavior) => {
      behavior = next;
    }),
    applyBehavior: vi.fn(),
    schedule: vi.fn((callback: () => void) => {
      scheduledCallback = callback;
      return 42;
    }),
    cancel: vi.fn(),
  };
  return {
    deps,
    controller: createCloseBehaviorPromptFallbackController(deps, 2_000),
    fireFallback: () => scheduledCallback?.(),
    setBehavior: (next: TBehavior | null) => {
      behavior = next;
    },
  };
}

describe('main window close behavior prompt', () => {
  // #6091: minimize is a no-op on Hyprland. Exercise the production policy with
  // that exact window behavior; previous coverage only asserted minimize calls.
  // Unit tier: visible state, fullscreen events and tray failures are in-memory.
  // Standalone Vitest duration: 0.158s (macOS, 2026-10-30).
  function hyprlandHarness() {
    const listeners = new Map<string, Set<() => void>>();
    const window = {
      visible: true,
      fullscreen: false,
      destroyed: false,
      leaveFullscreen: () => {},
      hide() {
        this.visible = false;
      },
      minimize: vi.fn(), // Hyprland intentionally does nothing.
      isDestroyed() {
        return this.destroyed;
      },
      isFullScreen() {
        return this.fullscreen;
      },
      once(event: 'leave-full-screen' | 'show' | 'focus' | 'closed', listener: () => void) {
        if (event === 'leave-full-screen') this.leaveFullscreen = listener;
        const callbacks = listeners.get(event) ?? new Set();
        callbacks.add(listener);
        listeners.set(event, callbacks);
      },
      removeListener(event: string, listener: () => void) {
        listeners.get(event)?.delete(listener);
      },
      emit(event: string) {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          listeners.get(event)?.delete(listener);
          listener();
        }
      },
      setFullScreen(value: boolean) {
        this.fullscreen = value;
      },
    };
    const options = {
      platform: 'linux' as NodeJS.Platform,
      env: { XDG_CURRENT_DESKTOP: 'Hyprland' } as NodeJS.ProcessEnv,
      isMainWindow: true,
      ensureTray: vi.fn(() => true),
      onTrayError: vi.fn(),
    };
    return { window, options, listeners };
  }

  // PR #8051 review: reopen before leave-full-screen must override the old hide.
  // The earlier fullscreen coverage only tested completion/destruction, not reopening.
  it.each(['explicit reopen', 'show', 'focus', 'closed'])(
    'invalidates a pending fullscreen hide on %s',
    (event) => {
      const { window, options, listeners } = hyprlandHarness();
      window.fullscreen = true;
      minimizeDesktopWindow(window, options);
      const stale = window.leaveFullscreen;
      if (event === 'explicit reopen') cancelPendingWindowHide(window);
      else window.emit(event);
      stale();
      expect(window.visible).toBe(true);
      expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    },
  );

  it('does not let an old hide consume a newer fullscreen request', () => {
    const { window, options } = hyprlandHarness();
    window.fullscreen = true;
    minimizeDesktopWindow(window, options);
    const stale = window.leaveFullscreen;
    cancelPendingWindowHide(window);
    window.fullscreen = true;
    minimizeDesktopWindow(window, options);
    stale();
    expect(window.visible).toBe(true);
    window.leaveFullscreen();
    expect(window.visible).toBe(false);
  });

  it.each(['minimize', 'close'] as const)(
    'hides the Hyprland main window on %s without quitting',
    (action) => {
      const { window, options } = hyprlandHarness();
      const quit = vi.fn();
      const minimize = () => minimizeDesktopWindow(window, options);
      if (action === 'close') applyLinuxMainWindowCloseBehavior(window, 'minimize', quit, minimize);
      else minimize();
      expect(window.visible).toBe(false);
      expect(window.minimize).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
    },
  );

  it('leaves the window accessible when Linux tray initialization fails', () => {
    const { window, options } = hyprlandHarness();
    options.ensureTray.mockReturnValue(false);
    minimizeDesktopWindow(window, options);
    expect(window.visible).toBe(true);
    expect(window.minimize).not.toHaveBeenCalled();
    expect(options.onTrayError).toHaveBeenCalledOnce();
  });

  it.each([false, true])('waits for fullscreen exit and respects destroyed=%s', (destroyed) => {
    const { window, options } = hyprlandHarness();
    window.fullscreen = true;
    minimizeDesktopWindow(window, options);
    expect(window.fullscreen).toBe(false);
    expect(window.visible).toBe(true);
    window.destroyed = destroyed;
    window.leaveFullscreen();
    expect(window.visible).toBe(destroyed);
  });

  it.each([
    { XDG_CURRENT_DESKTOP: ' Hyprland:wlroots ' },
    { XDG_SESSION_DESKTOP: 'hyprland' },
    { DESKTOP_SESSION: 'Hyprland' },
    { HYPRLAND_INSTANCE_SIGNATURE: 'instance' },
  ])('supports desktop identity fallbacks: %j', (env) => {
    const { window, options } = hyprlandHarness();
    minimizeDesktopWindow(window, { ...options, env });
    expect(window.visible).toBe(false);
  });

  it.each([
    { platform: 'win32' as const },
    { platform: 'darwin' as const },
    { isMainWindow: false },
    { env: { XDG_CURRENT_DESKTOP: 'GNOME', HYPRLAND_INSTANCE_SIGNATURE: 'stale' } },
    { env: { XDG_CURRENT_DESKTOP: 'KDE', DESKTOP_SESSION: 'Hyprland' } },
    { env: { XDG_CURRENT_DESKTOP: 'not-hyprland' } },
    { env: {} },
  ])('preserves native minimization outside the affected main window: %j', (override) => {
    const { window, options } = hyprlandHarness();
    minimizeDesktopWindow(window, { ...options, ...override });
    expect(window.minimize).toHaveBeenCalledOnce();
    expect(options.ensureTray).not.toHaveBeenCalled();
  });

  it('minimizes instead of quitting when Linux keeps the app running', () => {
    const window = { minimize: vi.fn() };
    const quit = vi.fn();

    applyLinuxMainWindowCloseBehavior(window, 'minimize', quit);

    expect(window.minimize).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it('quits instead of minimizing when Linux is configured to exit', () => {
    const window = { minimize: vi.fn() };
    const quit = vi.fn();

    applyLinuxMainWindowCloseBehavior(window, 'quit', quit);

    expect(quit).toHaveBeenCalledTimes(1);
    expect(window.minimize).not.toHaveBeenCalled();
  });

  it('restores and reveals the main window before requesting the custom dialog', () => {
    const window = makePromptWindow();
    window.minimized = true;
    window.visible = false;

    requestMainWindowCloseBehavior(window, 'window-behavior:close-requested');

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith('window-behavior:close-requested');
  });

  it('does not request the custom dialog after the renderer is destroyed', () => {
    const window = makePromptWindow();
    window.webContentsDestroyed = true;

    requestMainWindowCloseBehavior(window, 'window-behavior:close-requested');

    expect(window.focus).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it.each(['tray', 'minimize'] as const)(
    'persists and applies the %s fallback when no renderer ACK arrives',
    (fallback) => {
      const harness = createFallbackHarness(null, fallback);

      harness.controller.request();
      harness.fireFallback();

      expect(harness.deps.showNativePrompt).toHaveBeenCalledTimes(1);
      expect(harness.deps.persistBehavior).toHaveBeenCalledWith(fallback);
      expect(harness.deps.applyBehavior).toHaveBeenCalledWith(fallback);
    },
  );

  it('cancels the native fallback when the renderer confirms the dialog mounted', () => {
    const harness = createFallbackHarness<'quit' | 'minimize'>(null, 'minimize');

    harness.controller.request();
    harness.controller.acknowledge();

    expect(harness.deps.showRendererPrompt).toHaveBeenCalledTimes(1);
    expect(harness.deps.schedule).toHaveBeenCalledWith(expect.any(Function), 2_000);
    expect(harness.deps.cancel).toHaveBeenCalledWith(42);
    expect(harness.deps.showNativePrompt).not.toHaveBeenCalled();
  });

  it('does not prompt natively if another path configured the behavior before timeout', () => {
    const harness = createFallbackHarness<'quit' | 'minimize'>(null, 'minimize');

    harness.controller.request();
    harness.setBehavior('quit');
    harness.fireFallback();

    expect(harness.deps.showNativePrompt).not.toHaveBeenCalled();
    expect(harness.deps.applyBehavior).not.toHaveBeenCalled();
  });

  it('keeps one fallback timer across repeated native close requests', () => {
    const harness = createFallbackHarness<'quit' | 'minimize'>(null, 'minimize');

    harness.controller.request();
    harness.controller.request();

    expect(harness.deps.showRendererPrompt).toHaveBeenCalledTimes(2);
    expect(harness.deps.schedule).toHaveBeenCalledTimes(1);
  });
});

// Native closes (Alt+F4, taskbar "Close window", Linux WM close) with behavior "quit" used to
// call app.quit() straight from bootstrap's close handler, skipping the active-turn
// confirmation that only the title-bar X (renderer) and tray Quit applied; the renderer and
// tray also disagreed on a failed busy probe (idle vs busy). handleMainWindowCloseRequest is
// what the Electron close handler and the 'window-close' IPC both call now, so this matrix
// covers each distinct outcome of that one policy. Before the fix the busy/throws rows quit
// without confirmQuit. Unit tier: all side effects are in-memory spies.
type Busy = 'idle' | 'busy' | 'throws';

function closeRequestHarness(options: {
  platform: NodeJS.Platform;
  windowsBehavior?: 'quit' | 'tray' | null;
  linuxBehavior?: 'quit' | 'minimize' | null;
  busy: Busy;
  confirm: boolean;
}) {
  const deps = {
    platform: options.platform,
    readWindowsCloseBehavior: () => options.windowsBehavior ?? null,
    readLinuxCloseBehavior: () => options.linuxBehavior ?? null,
    requestWindowsCloseBehavior: vi.fn(),
    requestLinuxCloseBehavior: vi.fn(),
    hideToTray: vi.fn(),
    minimize: vi.fn(),
    quitGuard: {
      hasActiveTurn: vi.fn(() => {
        if (options.busy === 'throws') throw new Error('No handler registered');
        return options.busy === 'busy';
      }),
      confirmQuit: vi.fn(() => options.confirm),
      quit: vi.fn(),
    },
  };
  return deps;
}

describe('main window close request quit guard', () => {
  it.each([
    // [platform, windows behavior, linux behavior, busy, user confirms, renderer checked, quits, prompted]
    ['win32', 'quit', null, 'idle', false, false, true, false],
    ['win32', 'quit', null, 'busy', false, false, false, true],
    ['win32', 'quit', null, 'busy', true, false, true, true],
    ['win32', 'quit', null, 'throws', false, false, false, true],
    ['win32', 'quit', null, 'busy', false, true, true, false],
    ['linux', null, 'quit', 'busy', false, false, false, true],
    ['linux', null, 'quit', 'throws', true, false, true, true],
    ['linux', null, 'quit', 'busy', false, true, true, false],
    ['freebsd', null, null, 'busy', false, false, false, true],
  ] as const)(
    '%s windows=%s linux=%s busy=%s confirm=%s checked=%s -> quit=%s prompted=%s',
    (platform, windowsBehavior, linuxBehavior, busy, confirm, activeTurnChecked, quits, prompted) => {
      const deps = closeRequestHarness({ platform, windowsBehavior, linuxBehavior, busy, confirm });

      handleMainWindowCloseRequest(deps, { activeTurnChecked });

      expect(deps.quitGuard.quit).toHaveBeenCalledTimes(quits ? 1 : 0);
      expect(deps.quitGuard.confirmQuit).toHaveBeenCalledTimes(prompted ? 1 : 0);
      expect(deps.hideToTray).not.toHaveBeenCalled();
      expect(deps.minimize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['win32', 'tray', null, 'hideToTray'],
    ['linux', null, 'minimize', 'minimize'],
    ['win32', null, null, 'requestWindowsCloseBehavior'],
    ['linux', null, null, 'requestLinuxCloseBehavior'],
  ] as const)(
    'keeps running without probing on %s windows=%s linux=%s',
    (platform, windowsBehavior, linuxBehavior, action) => {
      const deps = closeRequestHarness({
        platform,
        windowsBehavior,
        linuxBehavior,
        busy: 'busy',
        confirm: true,
      });

      handleMainWindowCloseRequest(deps);

      expect(deps[action]).toHaveBeenCalledTimes(1);
      expect(deps.quitGuard.hasActiveTurn).not.toHaveBeenCalled();
      expect(deps.quitGuard.quit).not.toHaveBeenCalled();
    },
  );

  // Tray Quit and the first-close chooser fallback call the guard directly; a throwing probe
  // there was already fail-closed and must stay so (it is now the shared readActiveTurnForQuit).
  it('confirms instead of quitting when the probe throws on a direct quit request', () => {
    const { quitGuard } = closeRequestHarness({ platform: 'win32', busy: 'throws', confirm: false });

    requestActiveTurnGuardedQuit(quitGuard);

    expect(quitGuard.confirmQuit).toHaveBeenCalledTimes(1);
    expect(quitGuard.quit).not.toHaveBeenCalled();
  });
});
