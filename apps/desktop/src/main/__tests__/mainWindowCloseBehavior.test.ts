import { describe, expect, it, vi } from 'vitest';

import {
  applyLinuxMainWindowCloseBehavior,
  cancelPendingWindowHide,
  createActiveTurnQuitGuard,
  createCloseBehaviorPromptFallbackController,
  handleMainWindowCloseRequest,
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

// Native closes (Alt+F4, taskbar "Close window", Linux WM close) with behavior "quit" used to
// call app.quit() straight from bootstrap's close handler, skipping the active-turn
// confirmation that only the title-bar X (renderer) and tray Quit applied; the renderer and
// tray also disagreed on a failed busy probe (idle vs busy). The Electron close handler and the
// 'window-close' IPC now run handleMainWindowCloseRequest with the guard's requestQuit, which is
// what this matrix drives. Before the fix the busy/throws rows quit without confirmQuit.
// Unit tier: all side effects are in-memory spies; owners are plain strings standing in for
// the main window's webContents.
type Busy = 'idle' | 'busy' | 'throws';

function guardHarness(initial: { busy: Busy; confirm?: boolean; onScreen?: boolean }) {
  const state = { confirm: false, onScreen: true, ...initial };
  const deps = {
    hasActiveTurn: vi.fn(() => {
      if (state.busy === 'throws') throw new Error('No handler registered');
      return state.busy === 'busy';
    }),
    confirmQuit: vi.fn(() => state.confirm),
    quit: vi.fn(),
    canShowInAppConfirmation: vi.fn(() => state.onScreen),
    revealInAppConfirmation: vi.fn(),
  };
  return { state, deps, guard: createActiveTurnQuitGuard<string>(deps) };
}

type Guard = ReturnType<typeof guardHarness>['guard'];

function closeWithQuitBehavior(guard: Guard): void {
  handleMainWindowCloseRequest(closePolicyDeps({ platform: 'win32', windowsBehavior: 'quit' }), () =>
    guard.requestQuit(),
  );
}

function closePolicyDeps(options: {
  platform: NodeJS.Platform;
  windowsBehavior?: 'quit' | 'tray' | null;
  linuxBehavior?: 'quit' | 'minimize' | null;
}) {
  return {
    platform: options.platform,
    readWindowsCloseBehavior: () => options.windowsBehavior ?? null,
    readLinuxCloseBehavior: () => options.linuxBehavior ?? null,
    requestWindowsCloseBehavior: vi.fn(),
    requestLinuxCloseBehavior: vi.fn(),
    hideToTray: vi.fn(),
    minimize: vi.fn(),
  };
}

describe('main window close request quit guard', () => {
  it.each([
    // [platform, windows behavior, linux behavior, busy, user confirms, quits, prompted]
    ['win32', 'quit', null, 'idle', false, true, false],
    ['win32', 'quit', null, 'busy', false, false, true],
    ['win32', 'quit', null, 'busy', true, true, true],
    ['win32', 'quit', null, 'throws', false, false, true],
    ['linux', null, 'quit', 'busy', false, false, true],
    ['linux', null, 'quit', 'throws', true, true, true],
    ['freebsd', null, null, 'busy', false, false, true],
  ] as const)(
    '%s windows=%s linux=%s busy=%s confirm=%s -> quit=%s prompted=%s',
    (platform, windowsBehavior, linuxBehavior, busy, confirm, quits, prompted) => {
      const policy = closePolicyDeps({ platform, windowsBehavior, linuxBehavior });
      const { deps, guard } = guardHarness({ busy, confirm });

      handleMainWindowCloseRequest(policy, () => guard.requestQuit());

      expect(deps.quit).toHaveBeenCalledTimes(quits ? 1 : 0);
      expect(deps.confirmQuit).toHaveBeenCalledTimes(prompted ? 1 : 0);
      expect(policy.hideToTray).not.toHaveBeenCalled();
      expect(policy.minimize).not.toHaveBeenCalled();
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
      const policy = closePolicyDeps({ platform, windowsBehavior, linuxBehavior });
      const { deps, guard } = guardHarness({ busy: 'busy', confirm: true });

      handleMainWindowCloseRequest(policy, () => guard.requestQuit());

      expect(policy[action]).toHaveBeenCalledTimes(1);
      expect(deps.hasActiveTurn).not.toHaveBeenCalled();
      expect(deps.quit).not.toHaveBeenCalled();
    },
  );

  // The native confirm is a synchronous message box with a nested message loop on Windows, so
  // an Alt+F4, a title-bar X or a renderer answer can re-enter the guard while a tray Quit
  // confirmation is still open. Without the latch the nested close stacked a second prompt and
  // a renderer "confirmed" quit underneath the open dialog; only the first prompt may decide.
  it.each([false, true])(
    'ignores quit requests that arrive while the native confirmation is open (confirm=%s)',
    (confirm) => {
      const { deps, guard } = guardHarness({ busy: 'busy', confirm });
      const nested: unknown[] = [];
      deps.confirmQuit.mockImplementationOnce(() => {
        closeWithQuitBehavior(guard);
        nested.push(guard.requestInAppQuit('main'), guard.resolveInAppConfirmation('main', true));
        return confirm;
      });

      guard.requestQuit();

      expect(deps.confirmQuit).toHaveBeenCalledTimes(1);
      expect(nested).toEqual(['none', 'none']);
      expect(deps.quit).toHaveBeenCalledTimes(confirm ? 1 : 0);
    },
  );

  // Review finding (PR #9779): the X used to probe busy in one IPC and quit in a later one, so a
  // task starting in between was killed without a prompt. requestInAppQuit reads and acts in the
  // same call: idle quits right there without any confirmation, busy (or a throwing probe)
  // records the in-app confirmation and neither quits nor opens the native one.
  it.each([
    ['idle', 'quitting', 1],
    ['busy', 'confirm', 0],
    ['throws', 'confirm', 0],
  ] as const)('title-bar X with %s quits only under its own read (%s)', (busy, outcome, quits) => {
    const { deps, guard } = guardHarness({ busy, confirm: true });

    expect(guard.requestInAppQuit('main')).toBe(outcome);

    expect(deps.hasActiveTurn).toHaveBeenCalledTimes(1);
    expect(deps.quit).toHaveBeenCalledTimes(quits);
    expect(deps.confirmQuit).not.toHaveBeenCalled();
  });

  // Review finding (PR #9779): 'window-close' took a renderer-supplied activeTurnChecked flag as
  // authority to skip main's confirmation, so any script in the renderer could quit mid-task.
  // A renderer "confirmed" answer now skips the native confirmation only against the record main
  // made for that same owner when it read busy, and only once; anything else re-reads the busy
  // state and runs main's own confirmation.
  it.each([
    // [label, record made for, answer from, busy at answer, native answer, outcome, prompted]
    ['no record, busy, user cancels', null, 'main', 'busy', false, 'none', 1],
    ['no record, busy, user confirms', null, 'main', 'busy', true, 'quitting', 1],
    ['no record, idle', null, 'main', 'idle', false, 'quitting', 0],
    // Another owner's answer is a competing route: the open confirmation stays in charge.
    ['record for another owner', 'main', 'other', 'busy', false, 'none', 0],
    ['record for this owner', 'main', 'main', 'busy', false, 'quitting', 0],
  ] as const)(
    'renderer confirmation with %s',
    (_label, recordFor, answerFrom, busyAtAnswer, nativeAnswer, outcome, prompted) => {
      const { state, deps, guard } = guardHarness({ busy: 'busy', confirm: nativeAnswer });
      if (recordFor) expect(guard.requestInAppQuit(recordFor)).toBe('confirm');
      state.busy = busyAtAnswer;

      expect(guard.resolveInAppConfirmation(answerFrom, true)).toBe(outcome);

      expect(deps.confirmQuit).toHaveBeenCalledTimes(prompted);
      expect(deps.quit).toHaveBeenCalledTimes(outcome === 'quitting' ? 1 : 0);
    },
  );

  it('consumes the in-app confirmation record on use', () => {
    const { deps, guard } = guardHarness({ busy: 'busy', confirm: false });
    guard.requestInAppQuit('main');

    expect(guard.resolveInAppConfirmation('main', true)).toBe('quitting');
    expect(guard.resolveInAppConfirmation('main', true)).toBe('none');

    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(deps.confirmQuit).toHaveBeenCalledTimes(1);
  });

  // Review finding (PR #9779, Greptile): with the X's in-app confirmation open, Alt+F4 or tray
  // Quit opened a second, native confirmation; cancelling it left the in-app one on screen. A
  // competing route now only brings the window with the open confirmation to the front. When
  // the user cannot be looking at it (hidden, minimized, renderer gone), the record is dropped
  // and the route asks natively, so the record can never make the app unquittable.
  it.each([
    [true, 0, 1],
    [false, 1, 0],
  ] as const)(
    'competing quit route while the in-app confirmation is pending (on screen=%s)',
    (onScreen, prompted, revealed) => {
      const { deps, guard } = guardHarness({ busy: 'busy', confirm: false, onScreen });
      guard.requestInAppQuit('main');

      closeWithQuitBehavior(guard);

      expect(deps.confirmQuit).toHaveBeenCalledTimes(prompted);
      expect(deps.revealInAppConfirmation).toHaveBeenCalledTimes(revealed);
      expect(deps.quit).not.toHaveBeenCalled();
      // A dropped record no longer lets the renderer answer skip main's confirmation.
      guard.resolveInAppConfirmation('main', true);
      expect(deps.confirmQuit).toHaveBeenCalledTimes(prompted + (onScreen ? 0 : 1));
    },
  );

  // Cancelling (any dismissal) and the renderer resets (navigation, crash, hang, destruction)
  // clear the record, after which a competing route gets the native confirmation again; a
  // reset for another owner leaves it in place.
  it.each([
    ['cancel', (guard: Guard) => guard.resolveInAppConfirmation('main', false), 1],
    ['reset', (guard: Guard) => guard.dropInAppConfirmation('main'), 1],
    ['reset of another owner', (guard: Guard) => guard.dropInAppConfirmation('other'), 0],
  ] as const)('after %s a competing route asks natively %s time(s)', (_label, clear, prompted) => {
    const { deps, guard } = guardHarness({ busy: 'busy', confirm: false });
    guard.requestInAppQuit('main');

    clear(guard);
    closeWithQuitBehavior(guard);

    expect(deps.confirmQuit).toHaveBeenCalledTimes(prompted);
    expect(deps.revealInAppConfirmation).toHaveBeenCalledTimes(1 - prompted);
    expect(deps.quit).not.toHaveBeenCalled();
  });
});
