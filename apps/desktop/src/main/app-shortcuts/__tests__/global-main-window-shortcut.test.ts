import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppShortcutCombo } from '../../../shared/appShortcuts';
import {
  GlobalMainWindowShortcutController,
  toggleMainWindowVisibility,
  type MainWindowShortcutTarget,
} from '../global-main-window-shortcut';

function combo(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

function fakeWindow(
  options: {
    focused?: boolean;
    visible?: boolean;
    minimized?: boolean;
    fullscreen?: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
  } = {},
) {
  let focused = options.focused ?? false;
  let visible = options.visible ?? true;
  let minimized = options.minimized ?? false;
  let fullscreen = options.fullscreen ?? false;
  let bounds = options.bounds ?? { x: 100, y: 100, width: 1200, height: 800 };
  let leaveFullscreen: (() => void) | null = null;
  const window = {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => focused),
    isVisible: vi.fn(() => visible),
    isMinimized: vi.fn(() => minimized),
    isFullScreen: vi.fn(() => fullscreen),
    restore: vi.fn(() => {
      minimized = false;
      visible = true;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    hide: vi.fn(() => {
      visible = false;
      focused = false;
    }),
    focus: vi.fn(() => {
      focused = true;
    }),
    setFullScreen: vi.fn((next: boolean) => {
      fullscreen = next;
    }),
    once: vi.fn((_event: 'leave-full-screen', listener: () => void) => {
      leaveFullscreen = listener;
    }),
    getBounds: vi.fn(() => bounds),
    setBounds: vi.fn((next) => {
      bounds = next;
    }),
  } satisfies MainWindowShortcutTarget;
  return {
    window,
    emitLeaveFullscreen: () => leaveFullscreen?.(),
  };
}

const primaryDisplay = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

describe('toggleMainWindowVisibility', () => {
  const focusApp = vi.fn();
  const screen = {
    getAllDisplays: vi.fn(() => [primaryDisplay]),
    getDisplayNearestPoint: vi.fn(() => primaryDisplay),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides only when the main window is already focused', () => {
    const focused = fakeWindow({ focused: true });
    toggleMainWindowVisibility(focused.window, { screen, focusApp });
    expect(focused.window.hide).toHaveBeenCalledOnce();
    expect(focused.window.focus).not.toHaveBeenCalled();

    const background = fakeWindow({ focused: false, visible: true });
    toggleMainWindowVisibility(background.window, { screen, focusApp });
    expect(background.window.hide).not.toHaveBeenCalled();
    expect(background.window.focus).toHaveBeenCalledOnce();
    expect(focusApp).toHaveBeenCalledOnce();
  });

  it('restores a minimized window without losing its existing page state', () => {
    const target = fakeWindow({ minimized: true, visible: false });
    toggleMainWindowVisibility(target.window, { screen, focusApp });
    expect(target.window.restore).toHaveBeenCalledOnce();
    expect(target.window.focus).toHaveBeenCalledOnce();
    expect(target.window.hide).not.toHaveBeenCalled();
  });

  it('leaves full screen before hiding the focused window', () => {
    const target = fakeWindow({ focused: true, fullscreen: true });
    toggleMainWindowVisibility(target.window, { screen, focusApp });
    expect(target.window.setFullScreen).toHaveBeenCalledWith(false);
    expect(target.window.hide).not.toHaveBeenCalled();
    target.emitLeaveFullscreen();
    expect(target.window.hide).toHaveBeenCalledOnce();
  });

  it('moves a fully off-screen window onto the nearest visible display', () => {
    const target = fakeWindow({
      focused: false,
      bounds: { x: 5000, y: 4000, width: 2400, height: 1400 },
    });
    toggleMainWindowVisibility(target.window, { screen, focusApp });
    expect(target.window.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(target.window.focus).toHaveBeenCalledOnce();
  });
});

describe('GlobalMainWindowShortcutController', () => {
  function setup() {
    const registered = new Map<string, () => void>();
    const blocked = new Set<string>();
    const target = fakeWindow({ focused: false, visible: false });
    const availability = vi.fn();
    const unregister = vi.fn((accelerator: string) => registered.delete(accelerator));
    const register = vi.fn((accelerator: string, callback: () => void) => {
      if (blocked.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    });
    const recording = { active: false };
    const controller = new GlobalMainWindowShortcutController({
      platform: 'win32',
      globalShortcut: { register, unregister },
      screen: {
        getAllDisplays: () => [primaryDisplay],
        getDisplayNearestPoint: () => primaryDisplay,
      },
      getMainWindow: () => target.window,
      focusApp: vi.fn(),
      isRecording: () => recording.active,
      onAvailabilityChanged: availability,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    return {
      availability,
      blocked,
      controller,
      registered,
      recording,
      register,
      target,
      unregister,
    };
  }

  it('registers the effective shortcut and ignores activations while recording', () => {
    const env = setup();
    env.controller.initialize(combo('Space', { ctrl: true, shift: true }));
    const callback = env.registered.get('Ctrl+Shift+Space');
    expect(callback).toBeTypeOf('function');

    env.recording.active = true;
    callback?.();
    expect(env.target.window.show).not.toHaveBeenCalled();

    env.recording.active = false;
    callback?.();
    callback?.();
    expect(env.target.window.show).toHaveBeenCalledOnce();
    expect(env.target.window.focus).toHaveBeenCalledOnce();
    expect(env.target.window.hide).not.toHaveBeenCalled();
  });

  it('keeps the old shortcut registered when a replacement is unavailable', () => {
    const env = setup();
    env.controller.initialize(combo('Space', { ctrl: true, shift: true }));
    env.blocked.add('Ctrl+Alt+K');
    const prepared = env.controller.prepare(combo('KeyK', { ctrl: true, alt: true }));
    expect(prepared).toEqual({ ok: false, reason: 'unavailable' });
    expect(env.registered.has('Ctrl+Shift+Space')).toBe(true);
    expect(env.unregister).not.toHaveBeenCalled();
  });

  it('switches registrations only on commit and releases the candidate on rollback', () => {
    const env = setup();
    env.controller.initialize(combo('Space', { ctrl: true, shift: true }));

    const replacement = env.controller.prepare(combo('KeyK', { ctrl: true, alt: true }));
    expect(replacement.ok).toBe(true);
    expect(env.registered.has('Ctrl+Shift+Space')).toBe(true);
    expect(env.registered.has('Ctrl+Alt+K')).toBe(true);
    if (replacement.ok) replacement.commit();
    expect(env.registered.has('Ctrl+Shift+Space')).toBe(false);
    expect(env.registered.has('Ctrl+Alt+K')).toBe(true);

    const failedWrite = env.controller.prepare(combo('KeyL', { ctrl: true, alt: true }));
    expect(failedWrite.ok).toBe(true);
    if (failedWrite.ok) failedWrite.rollback();
    expect(env.registered.has('Ctrl+Alt+K')).toBe(true);
    expect(env.registered.has('Ctrl+Alt+L')).toBe(false);
  });

  it('publishes startup registration failure and clears it after disabling the shortcut', () => {
    const env = setup();
    env.blocked.add('Ctrl+Shift+Space');
    env.controller.initialize(combo('Space', { ctrl: true, shift: true }));
    expect(env.availability).toHaveBeenCalledWith(true);

    const disabled = env.controller.prepare(null);
    expect(disabled.ok).toBe(true);
    if (disabled.ok) disabled.commit();
    expect(env.availability).toHaveBeenLastCalledWith(false);
  });
});
