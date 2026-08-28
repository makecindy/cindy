import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  installWindowFullscreenStateBroadcast,
  readWindowFullscreenState,
  showMainWindowAndRestoreFullscreen,
} from '../mainWindowFullscreenStartup';

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    setFullScreen: vi.fn(),
    show: vi.fn(),
  };
}

describe('showMainWindowAndRestoreFullscreen', () => {
  it('restores macOS fullscreen after the window is shown', () => {
    const window = createWindow();
    const scheduled: Array<() => void> = [];

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'darwin',
      restoreFullscreen: true,
      schedule: (callback) => scheduled.push(callback),
    });

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.setFullScreen).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled[0]();

    expect(window.setFullScreen).toHaveBeenCalledWith(true);
  });

  it('does not restore fullscreen when macOS state is windowed', () => {
    const window = createWindow();
    const schedule = vi.fn();

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'darwin',
      restoreFullscreen: false,
      schedule,
    });

    expect(window.show).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('leaves fullscreen restoration to the state manager outside macOS', () => {
    const window = createWindow();
    const schedule = vi.fn();

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'win32',
      restoreFullscreen: true,
      schedule,
    });

    expect(window.show).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('skips delayed restoration after the window is destroyed', () => {
    const window = createWindow();
    const scheduled: Array<() => void> = [];

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'darwin',
      restoreFullscreen: true,
      schedule: (callback) => scheduled.push(callback),
    });
    window.isDestroyed.mockReturnValue(true);

    scheduled[0]();

    expect(window.setFullScreen).not.toHaveBeenCalled();
  });
});

function createFullscreenWindow(
  options: { fullscreen?: boolean; simpleFullscreen?: boolean } = {},
) {
  const listeners = new Map<string, () => void>();
  const window = {
    getBounds: vi.fn(() => ({ width: 1440, height: 900 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => options.fullscreen ?? false),
    isSimpleFullScreen: vi.fn(() => options.simpleFullscreen ?? false),
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
  return { listeners, window };
}

describe('window fullscreen state', () => {
  it('reads native and simple fullscreen state', () => {
    expect(readWindowFullscreenState(createFullscreenWindow({ fullscreen: true }).window)).toBe(
      true,
    );
    expect(
      readWindowFullscreenState(createFullscreenWindow({ simpleFullscreen: true }).window),
    ).toBe(true);
    expect(readWindowFullscreenState(createFullscreenWindow().window)).toBe(false);
  });

  it('publishes changes only to the window that changed', () => {
    const first = createFullscreenWindow();
    const second = createFullscreenWindow();
    installWindowFullscreenStateBroadcast(first.window as unknown as BrowserWindow);
    installWindowFullscreenStateBroadcast(second.window as unknown as BrowserWindow);

    first.listeners.get('enter-full-screen')?.();

    expect(first.window.webContents.send).toHaveBeenCalledWith('fullscreen-change', true);
    expect(second.window.webContents.send).not.toHaveBeenCalled();
  });

  it('publishes an early exit when fullscreen resize leaves the display bounds', () => {
    const target = createFullscreenWindow();
    installWindowFullscreenStateBroadcast(target.window as unknown as BrowserWindow, {
      getDisplayBounds: () => ({ width: 1728, height: 1117 }),
    });
    target.listeners.get('enter-full-screen')?.();
    target.window.webContents.send.mockClear();

    target.listeners.get('resize')?.();

    expect(target.window.webContents.send).toHaveBeenCalledWith('fullscreen-change', false);
    target.listeners.get('leave-full-screen')?.();
    expect(target.window.webContents.send).toHaveBeenCalledOnce();
  });
});
