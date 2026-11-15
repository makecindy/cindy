import { describe, expect, it, vi } from 'vitest';

import {
  applyLinuxMainWindowCloseBehavior,
  cancelPendingWindowHide,
  createCloseBehaviorPromptFallbackController,
  minimizeDesktopWindow,
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
