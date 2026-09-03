import { describe, expect, it, vi } from 'vitest';

import {
  installMainWindowMaximizeRecovery,
  readPersistedWindowMaximized,
  type DisplayChangeEvent,
} from '../mainWindowMaximizeRecovery';

describe('readPersistedWindowMaximized', () => {
  it('reads the flag from the raw window-state file', () => {
    const read = vi.fn(() => JSON.stringify({ width: 1280, height: 812, isMaximized: true }));
    expect(readPersistedWindowMaximized('state.json', read)).toBe(true);
    expect(read).toHaveBeenCalledWith('state.json', 'utf8');
  });

  it('is false for a windowed, malformed or missing file', () => {
    expect(readPersistedWindowMaximized('x', () => JSON.stringify({ isMaximized: false }))).toBe(false);
    expect(readPersistedWindowMaximized('x', () => JSON.stringify({ isMaximized: 'yes' }))).toBe(false);
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
  const state = { visible: true, maximized: false, minimized: false, fullscreen: false, destroyed: false };

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

  const dispose = installMainWindowMaximizeRecovery(win, screen, {
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

  return { state, win, screen, log, timers, dispose, runTimers, advance, fireDisplay, osUnmaximize, windowListeners, screenListeners };
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
