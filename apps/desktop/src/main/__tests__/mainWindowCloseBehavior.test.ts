import { describe, expect, it, vi } from 'vitest';

import {
  applyLinuxMainWindowCloseBehavior,
  createCloseBehaviorPromptFallbackController,
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
