import { describe, expect, it, vi } from 'vitest';

import {
  applyLinuxMainWindowCloseBehavior,
  createCloseBehaviorPromptFallbackController,
  hideToTrayWithFallback,
  isWaylandSession,
  minimizeRequestMapsToTray,
  requestMainWindowCloseBehavior,
  resolveLinuxKeepRunningSurface,
  type LinuxCloseBehaviorActions,
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
  it('delegates the keep-running choice to the injected action on Linux', () => {
    const window = { hide: vi.fn(), minimize: vi.fn() };
    const actions: LinuxCloseBehaviorActions = {
      quit: vi.fn(),
      keepRunning: vi.fn(),
    };

    applyLinuxMainWindowCloseBehavior(window, 'minimize', actions);

    expect(actions.keepRunning).toHaveBeenCalledWith(window);
    expect(actions.quit).not.toHaveBeenCalled();
  });

  it('quits via the injected action when Linux is configured to exit', () => {
    const window = { hide: vi.fn(), minimize: vi.fn() };
    const actions: LinuxCloseBehaviorActions = {
      quit: vi.fn(),
      keepRunning: vi.fn(),
    };

    applyLinuxMainWindowCloseBehavior(window, 'quit', actions);

    expect(actions.quit).toHaveBeenCalledTimes(1);
    expect(actions.keepRunning).not.toHaveBeenCalled();
  });

  it.each([
    ['wayland session', { XDG_SESSION_TYPE: 'wayland' }],
    ['wayland display fallback', { WAYLAND_DISPLAY: 'wayland-0' }],
    ['tty session on a wayland compositor', { XDG_SESSION_TYPE: 'tty', WAYLAND_DISPLAY: 'wayland-1' }],
    ['unclassified session on a wayland compositor', { XDG_SESSION_TYPE: 'mir', WAYLAND_DISPLAY: 'wayland-1' }],
  ])('detects a %s', (_label, env) => {
    expect(isWaylandSession(env)).toBe(true);
  });

  it.each([
    ['x11 session', { XDG_SESSION_TYPE: 'x11' }],
    ['tty session without a wayland display', { XDG_SESSION_TYPE: 'tty' }],
    ['session type unset without wayland display', {}],
  ])('does not treat %s as Wayland', (_label, env) => {
    expect(isWaylandSession(env)).toBe(false);
  });

  it('prefers an explicit x11 session over WAYLAND_DISPLAY when both are set', () => {
    expect(
      isWaylandSession({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }),
    ).toBe(false);
  });

  it.each([
    [true, 'tray'],
    [false, 'minimize'],
  ])('parks the keep-running main window on the %s surface', (wayland, surface) => {
    expect(resolveLinuxKeepRunningSurface(wayland)).toBe(surface);
  });

  it.each([
    ['wayland main window', true, true, true],
    ['x11 main window', false, true, false],
    ['wayland secondary window', true, false, false],
  ])('maps the minimize request of a %s to tray=%s', (_label, wayland, isMainWindow, expected) => {
    expect(minimizeRequestMapsToTray(wayland, isMainWindow)).toBe(expected);
  });

  it('hides to tray when the tray icon exists', () => {
    const window = {};
    const deps = {
      ensureTray: vi.fn(() => true),
      hideToTray: vi.fn(),
      reportTrayError: vi.fn(),
    };

    hideToTrayWithFallback(window, deps);

    expect(deps.hideToTray).toHaveBeenCalledWith(window);
    expect(deps.reportTrayError).not.toHaveBeenCalled();
  });

  it('keeps the window open and reports when tray creation fails', () => {
    const window = {};
    const deps = {
      ensureTray: vi.fn(() => false),
      hideToTray: vi.fn(),
      reportTrayError: vi.fn(),
    };

    hideToTrayWithFallback(window, deps);

    expect(deps.hideToTray).not.toHaveBeenCalled();
    expect(deps.reportTrayError).toHaveBeenCalledWith(window);
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
