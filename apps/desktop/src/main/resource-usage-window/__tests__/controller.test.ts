import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import {
  RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL,
  RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
} from '../../../shared/resourceUsageWindow.js';
import { ResourceUsageWindowController } from '../controller.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isFullScreen: () => boolean;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  webContents: WebContents;
  send: ReturnType<typeof vi.fn>;
  emitClosed: () => void;
  emitWebContents: (event: string, ...args: unknown[]) => void;
  emitWindow: (event: string) => void;
  setFullscreenState: (fullscreen: boolean) => void;
}

function fakeWindow(id: number, minimized = false): FakeWindow {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
  let destroyed = false;
  let visible = false;
  let fullscreen = false;
  const send = vi.fn();
  const webContents = {
    id,
    isDestroyed: () => destroyed,
    send,
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      webContentsListeners.set(event, callback);
    }),
  } as unknown as WebContents;
  const win: FakeWindow = {
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, callback);
    }),
    once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, (...args: unknown[]) => {
        listeners.delete(event);
        callback(...args);
      });
    }),
    close: vi.fn(() => {
      let prevented = false;
      listeners.get('close')?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      if (prevented) return;
      destroyed = true;
      visible = false;
      listeners.get('closed')?.();
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      visible = false;
      listeners.get('closed')?.();
    }),
    hide: vi.fn(() => {
      visible = false;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    restore: vi.fn(),
    setFullScreen: vi.fn((nextFullscreen: boolean) => {
      fullscreen = nextFullscreen;
    }),
    setTitle: vi.fn(),
    isMinimized: () => minimized,
    isFullScreen: () => fullscreen,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    webContents,
    send,
    emitClosed: () => {
      destroyed = true;
      visible = false;
      listeners.get('closed')?.();
    },
    emitWebContents: (event, ...args) => webContentsListeners.get(event)?.(...args),
    emitWindow: (event) => listeners.get(event)?.(),
    setFullscreenState: (nextFullscreen) => {
      fullscreen = nextFullscreen;
    },
  };
  return win;
}

function makeHarness(
  timeoutMs = 5000,
  prewarmTimeoutMs = 10_000,
  recoveryStabilityMs = 30_000,
  platform: NodeJS.Platform = 'linux',
  leaveTimeoutMs = 2000,
) {
  const windows: FakeWindow[] = [];
  const mainSender = { id: 100 } as WebContents;
  const controller = new ResourceUsageWindowController({
    createWindow: () => {
      const win = fakeWindow(windows.length + 1);
      windows.push(win);
      return win as unknown as BrowserWindow;
    },
    isOpenSender: (sender) => sender === mainSender,
    openTimeoutMs: timeoutMs,
    prewarmTimeoutMs,
    recoveryStabilityMs,
    leaveTimeoutMs,
    platform,
  });
  return { controller, windows, mainSender };
}

function markPrewarmed(controller: ResourceUsageWindowController, win: FakeWindow): void {
  expect(controller.markRendererReady(win.webContents)).toBe(true);
  expect(controller.markPresentationReady(win.webContents)).toBe(true);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ResourceUsageWindowController', () => {
  it('keeps Windows prewarm sampling paused until the user explicitly opens the window', () => {
    const { controller, windows, mainSender } = makeHarness(5000, 10_000, 30_000, 'win32');

    controller.prewarm();
    expect(controller.allowsProcessMonitorSampling(windows[0]!.webContents)).toBe(false);
    expect(controller.markRendererReady(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.send).toHaveBeenLastCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );

    windows[0]?.emitWebContents('did-start-loading');
    expect(windows[0]?.send).toHaveBeenLastCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );
    expect(controller.markRendererReady(windows[0]!.webContents)).toBe(true);

    expect(controller.open(mainSender)).toBe(true);
    expect(controller.allowsProcessMonitorSampling(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.send).toHaveBeenLastCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      true,
    );
    expect(windows[0]?.show).not.toHaveBeenCalled();

    expect(controller.markPresentationReady(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.show).toHaveBeenCalledOnce();
  });

  it('prewarms a complete presentation without showing or focusing it', () => {
    const { controller, windows } = makeHarness();

    controller.prewarm();
    markPrewarmed(controller, windows[0]!);

    expect(windows).toHaveLength(1);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(windows[0]?.focus).not.toHaveBeenCalled();
    expect(windows[0]?.setTitle).toHaveBeenCalled();
    expect(windows[0]?.send).toHaveBeenLastCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );
  });

  it('opens a prewarmed presentation immediately and resumes sampling', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    vi.clearAllMocks();

    controller.open(mainSender);

    expect(windows).toHaveLength(1);
    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      true,
    );
    expect(windows[0]?.show).toHaveBeenCalledOnce();
    expect(windows[0]?.focus).toHaveBeenCalledOnce();
  });

  it('sends locale changes to an already prewarmed window', () => {
    const { controller, windows } = makeHarness();
    controller.prewarm();

    controller.setLocale('zh-CN');

    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL,
      'zh-CN',
    );
  });

  it('replays the latest locale after the renderer becomes ready', () => {
    const { controller, windows } = makeHarness();
    controller.setLocale('ja');
    controller.prewarm();
    vi.clearAllMocks();

    controller.markRendererReady(windows[0]!.webContents);

    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL,
      'ja',
    );
  });

  it('applies the last locale when prewarming starts after the preference change', () => {
    const { controller, windows } = makeHarness();
    controller.setLocale('ja');

    controller.prewarm();

    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL,
      'ja',
    );
  });

  it('waits for the first committed presentation before showing a cold window', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.open(mainSender);

    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(controller.markRendererReady(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(controller.markPresentationReady(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.show).toHaveBeenCalledOnce();
    expect(windows[0]?.focus).toHaveBeenCalledOnce();
  });

  it('ignores readiness from any other Cindy window', () => {
    const { controller, windows } = makeHarness();
    controller.prewarm();
    const other = { id: 99 } as WebContents;

    expect(controller.markRendererReady(other)).toBe(false);
    expect(controller.markPresentationReady(other)).toBe(false);
    expect(windows[0]?.show).not.toHaveBeenCalled();
  });

  it('accepts open only from the main window and close only from the resource window', () => {
    const { controller, windows, mainSender } = makeHarness();
    const other = { id: 99 } as WebContents;

    expect(controller.open(other)).toBe(false);
    expect(windows).toHaveLength(0);

    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    expect(controller.open(mainSender)).toBe(true);
    expect(controller.close(other)).toBe(false);
    expect(windows[0]?.hide).not.toHaveBeenCalled();
    expect(controller.close(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
  });

  it("opens as a regular window in the owner's macOS fullscreen Space", () => {
    const windows: FakeWindow[] = [];
    const mainSender = { id: 100 } as WebContents;
    const owner = {
      isDestroyed: () => false,
      isFullScreen: () => true,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: (sender) => sender === mainSender,
      getOwnerWindow: () => owner,
      platform: 'darwin',
    });
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);

    expect(controller.open(mainSender)).toBe(true);
    expect(windows[0]?.show).toHaveBeenCalledOnce();
    expect(windows[0]?.focus).toHaveBeenCalledOnce();
    expect(windows[0]?.setFullScreen).not.toHaveBeenCalled();
    expect(owner.isFullScreen()).toBe(true);

    expect(controller.close(windows[0]!.webContents)).toBe(true);
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    expect(windows[0]?.setFullScreen).not.toHaveBeenCalled();
    expect(owner.show).toHaveBeenCalledOnce();
    expect(owner.focus).toHaveBeenCalledOnce();
  });

  it('updates the native window title when the application locale changes', () => {
    const windows: FakeWindow[] = [];
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: () => true,
      resolveNativeTitle: (locale) => (locale === 'zh-CN' ? '资源监视器' : 'Activity Monitor'),
    });
    controller.prewarm();
    expect(windows[0]?.setTitle).toHaveBeenCalledWith('Activity Monitor');
    windows[0]?.setTitle.mockClear();
    controller.setLocale('zh-CN');
    expect(windows[0]?.setTitle).toHaveBeenCalledWith('资源监视器');
  });

  it('keeps the localized native title when the renderer reports Cindy as the page title', () => {
    const windows: FakeWindow[] = [];
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: () => true,
      resolveNativeTitle: (locale) => (locale === 'zh-CN' ? '资源监视器' : 'Activity Monitor'),
    });
    controller.prewarm();
    windows[0]?.setTitle.mockClear();

    const firstLoad = { preventDefault: vi.fn() };
    windows[0]?.emitWebContents('page-title-updated', firstLoad, 'Cindy');
    expect(firstLoad.preventDefault).toHaveBeenCalled();
    expect(windows[0]?.setTitle).toHaveBeenCalledWith('Activity Monitor');

    controller.setLocale('zh-CN');
    windows[0]?.setTitle.mockClear();
    const reload = { preventDefault: vi.fn() };
    windows[0]?.emitWebContents('page-title-updated', reload, 'Cindy');
    expect(reload.preventDefault).toHaveBeenCalled();
    expect(windows[0]?.setTitle).toHaveBeenCalledWith('资源监视器');
  });

  it('hides with the owner without restoring a hidden Cindy window', () => {
    const windows: FakeWindow[] = [];
    const mainSender = { id: 100 } as WebContents;
    const ownerListeners = new Map<string, () => void>();
    const owner = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        ownerListeners.set(event, listener);
      }),
    };
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: (sender) => sender === mainSender,
      getOwnerWindow: () => owner,
      platform: 'linux',
    });
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    expect(controller.open(mainSender)).toBe(true);
    owner.show.mockClear();
    owner.focus.mockClear();

    ownerListeners.get('hide')?.();
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    expect(owner.show).not.toHaveBeenCalled();
    expect(owner.focus).not.toHaveBeenCalled();
  });

  it('tracks a pending macOS fullscreen entry without hiding the resource window', () => {
    const windows: FakeWindow[] = [];
    const mainSender = { id: 100 } as WebContents;
    const ownerListeners = new Map<string, () => void>();
    const owner = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        ownerListeners.set(event, listener);
      }),
    };
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: (sender) => sender === mainSender,
      getOwnerWindow: () => owner,
      platform: 'darwin',
    });
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    expect(controller.open(mainSender)).toBe(true);
    windows[0]?.hide.mockClear();

    expect(ownerListeners.has('hide')).toBe(true);
    ownerListeners.get('hide')?.();
    expect(windows[0]?.hide).not.toHaveBeenCalled();

    windows[0]?.close();
    expect(windows[0]?.setFullScreen).toHaveBeenCalledWith(false);
    expect(windows[0]?.hide).not.toHaveBeenCalled();

    windows[0]?.emitWindow('leave-full-screen');
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
  });

  it('stops a hidden prewarm that cannot produce a presentation', () => {
    const { controller, windows } = makeHarness(5000, 1000);
    controller.prewarm();

    vi.advanceTimersByTime(999);
    expect(windows[0]?.send).not.toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );
    vi.advanceTimersByTime(1);
    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );

    vi.clearAllMocks();
    controller.markRendererReady(windows[0]!.webContents);
    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );
  });

  it('invalidates readiness across a renderer reload', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);

    windows[0]?.emitWebContents('did-start-loading');
    controller.open(mainSender);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    controller.markRendererReady(windows[0]!.webContents);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    controller.markPresentationReady(windows[0]!.webContents);
    expect(windows[0]?.show).toHaveBeenCalledOnce();
  });

  it('replaces a failed renderer while preserving a pending open', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.open(mainSender);

    windows[0]?.emitWebContents(
      'did-fail-load',
      undefined,
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'http://localhost:5173',
      true,
    );

    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows).toHaveLength(2);
    expect(windows[1]?.show).not.toHaveBeenCalled();
    controller.markPresentationReady(windows[1]!.webContents);
    expect(windows[1]?.show).toHaveBeenCalledOnce();
  });

  it('keeps a replacement monitor regular when its owner is fullscreen', () => {
    const windows: FakeWindow[] = [];
    const mainSender = { id: 100 } as WebContents;
    const owner = {
      isDestroyed: () => false,
      isFullScreen: () => true,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: (sender) => sender === mainSender,
      getOwnerWindow: () => owner,
      platform: 'darwin',
    });
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    expect(controller.open(mainSender)).toBe(true);

    windows[0]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });
    markPrewarmed(controller, windows[1]!);
    expect(windows[1]?.show).toHaveBeenCalledOnce();
    expect(windows[1]?.setFullScreen).not.toHaveBeenCalled();
    expect(owner.isFullScreen()).toBe(true);
  });

  it('does not keep a leaked hide listener on the previous owner after automatic replacement', () => {
    const windows: FakeWindow[] = [];
    const firstSender = { id: 100 } as WebContents;
    const secondSender = { id: 101 } as WebContents;
    const firstOwnerListeners = new Map<string, Array<() => void>>();
    const secondOwnerListeners = new Map<string, Array<() => void>>();
    const firstOwner = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        const list = firstOwnerListeners.get(event) ?? [];
        list.push(listener);
        firstOwnerListeners.set(event, list);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        firstOwnerListeners.set(
          event,
          (firstOwnerListeners.get(event) ?? []).filter((item) => item !== listener),
        );
      }),
    };
    const secondOwner = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        const list = secondOwnerListeners.get(event) ?? [];
        list.push(listener);
        secondOwnerListeners.set(event, list);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        secondOwnerListeners.set(
          event,
          (secondOwnerListeners.get(event) ?? []).filter((item) => item !== listener),
        );
      }),
    };
    const controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = fakeWindow(windows.length + 1);
        windows.push(win);
        return win as unknown as BrowserWindow;
      },
      isOpenSender: (sender) => sender === firstSender || sender === secondSender,
      getOwnerWindow: (sender) => (sender === secondSender ? secondOwner : firstOwner),
      platform: 'linux',
    });
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    expect(controller.open(firstSender)).toBe(true);
    windows[0]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });
    markPrewarmed(controller, windows[1]!);
    expect(controller.open(secondSender)).toBe(true);
    windows[1]?.hide.mockClear();

    for (const listener of firstOwnerListeners.get('hide') ?? []) listener();
    expect(windows[1]?.hide).not.toHaveBeenCalled();
  });

  it('bounds automatic replacement when renderer loading keeps failing', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.open(mainSender);

    for (let index = 0; index < 2; index += 1) {
      windows[index]?.emitWebContents(
        'did-fail-load',
        undefined,
        -105,
        'ERR_NAME_NOT_RESOLVED',
        'http://localhost:5173',
        true,
      );
    }

    expect(windows).toHaveLength(2);
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows[1]?.destroy).toHaveBeenCalledOnce();
    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(windows[1]?.show).not.toHaveBeenCalled();

    controller.open(mainSender);
    expect(windows).toHaveLength(3);
  });

  it('does not reset the recovery limit until a replacement remains stable', () => {
    const { controller, windows, mainSender } = makeHarness(5000, 10_000, 30_000);
    controller.open(mainSender);
    markPrewarmed(controller, windows[0]!);

    windows[0]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });
    markPrewarmed(controller, windows[1]!);
    windows[1]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });

    expect(windows).toHaveLength(2);
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows[1]?.destroy).toHaveBeenCalledOnce();
  });

  it('allows a later recovery after a replacement remains stable', () => {
    const { controller, windows, mainSender } = makeHarness(5000, 10_000, 30_000);
    controller.open(mainSender);
    markPrewarmed(controller, windows[0]!);

    windows[0]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });
    markPrewarmed(controller, windows[1]!);
    vi.advanceTimersByTime(30_000);
    windows[1]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });

    expect(windows).toHaveLength(3);
  });

  it('contains synchronous window creation failures', () => {
    const mainSender = { id: 100 } as WebContents;
    const createWindow = vi.fn(() => {
      throw new Error('construction failed');
    });
    const controller = new ResourceUsageWindowController({
      createWindow,
      isOpenSender: (sender) => sender === mainSender,
    });

    expect(() => controller.prewarm()).not.toThrow();
    expect(controller.open(mainSender)).toBe(false);
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(controller.isOpen()).toBe(false);
  });

  it('contains synchronous replacement creation failures', () => {
    const firstWindow = fakeWindow(1);
    const mainSender = { id: 100 } as WebContents;
    const createWindow = vi
      .fn<() => BrowserWindow>()
      .mockReturnValueOnce(firstWindow as unknown as BrowserWindow)
      .mockImplementation(() => {
        throw new Error('replacement failed');
      });
    const controller = new ResourceUsageWindowController({
      createWindow,
      isOpenSender: (sender) => sender === mainSender,
    });
    controller.open(mainSender);

    expect(() =>
      firstWindow.emitWebContents('render-process-gone', undefined, { reason: 'crashed' }),
    ).not.toThrow();
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(controller.isOpen()).toBe(false);
  });

  it('rebuilds a renderer that never mounts instead of showing a blank window', () => {
    const { controller, windows, mainSender } = makeHarness(1000);
    controller.open(mainSender);

    vi.advanceTimersByTime(1000);
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(windows).toHaveLength(2);

    controller.markRendererReady(windows[1]!.webContents);
    vi.advanceTimersByTime(1000);
    expect(windows[1]?.show).toHaveBeenCalledOnce();
  });

  it('recovers a visible resource renderer without exposing an incomplete replacement', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);

    windows[0]?.emitWebContents('render-process-gone', undefined, { reason: 'crashed' });
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows).toHaveLength(2);
    expect(windows[1]?.show).not.toHaveBeenCalled();

    controller.markPresentationReady(windows[1]!.webContents);
    expect(windows[1]?.show).toHaveBeenCalledOnce();
  });

  it('does not reshow a cold open after a native hide cancels presentation', () => {
    const { controller, windows, mainSender } = makeHarness(1000);
    controller.open(mainSender);
    windows[0]?.emitWindow('hide');

    controller.markPresentationReady(windows[0]!.webContents);
    vi.advanceTimersByTime(1000);

    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(windows[0]?.focus).not.toHaveBeenCalled();
  });

  it('pauses and resumes sampling for native minimize and restore events', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);
    vi.clearAllMocks();

    windows[0]?.emitWindow('minimize');
    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );
    windows[0]?.emitWindow('restore');
    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      true,
    );
  });

  it('shows a loading fallback only after the renderer shell has mounted', () => {
    const { controller, windows, mainSender } = makeHarness(2500);
    controller.open(mainSender);
    controller.markRendererReady(windows[0]!.webContents);

    vi.advanceTimersByTime(2499);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(windows[0]?.show).toHaveBeenCalledOnce();

    controller.close(windows[0]!.webContents);
    vi.clearAllMocks();
    controller.open(mainSender);
    vi.advanceTimersByTime(2499);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(windows[0]?.show).toHaveBeenCalledOnce();
  });

  it('hides on user close and reuses the same renderer on the next open', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);
    vi.clearAllMocks();

    controller.close(windows[0]!.webContents);

    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    expect(windows[0]?.close).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(true);
    expect(windows[0]?.send).toHaveBeenCalledWith(
      RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
      false,
    );

    controller.open(mainSender);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.show).toHaveBeenCalledOnce();
  });

  it('turns a native close request into hide', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);
    vi.clearAllMocks();

    windows[0]?.close();

    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    expect(controller.isOpen()).toBe(true);
  });

  it('exits macOS native fullscreen before a native close hides the cached window', () => {
    const { controller, windows, mainSender } = makeHarness(5000, 10_000, 30_000, 'darwin');
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);
    windows[0]!.setFullscreenState(true);
    vi.clearAllMocks();

    windows[0]!.close();

    expect(windows[0]?.setFullScreen).toHaveBeenCalledWith(false);
    expect(windows[0]?.hide).not.toHaveBeenCalled();

    windows[0]?.emitWindow('leave-full-screen');
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    expect(controller.isOpen()).toBe(true);
  });

  it('falls back to hiding when macOS does not emit leave-full-screen', () => {
    const { controller, windows, mainSender } = makeHarness(5000, 10_000, 30_000, 'darwin');
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);
    windows[0]!.setFullscreenState(true);
    vi.clearAllMocks();

    windows[0]!.close();
    vi.advanceTimersByTime(1999);
    expect(windows[0]?.hide).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    windows[0]?.emitWindow('leave-full-screen');
    expect(windows[0]?.hide).toHaveBeenCalledOnce();
    expect(controller.isOpen()).toBe(true);
  });

  it('does not hide a reopened macOS window when leave-full-screen arrives late', () => {
    const { controller, windows, mainSender } = makeHarness(5000, 10_000, 30_000, 'darwin');
    controller.prewarm();
    markPrewarmed(controller, windows[0]!);
    controller.open(mainSender);
    windows[0]!.setFullscreenState(true);
    controller.close(windows[0]!.webContents);
    vi.clearAllMocks();

    controller.open(mainSender);
    windows[0]?.emitWindow('leave-full-screen');
    vi.advanceTimersByTime(2000);

    expect(windows[0]?.hide).not.toHaveBeenCalled();
    expect(windows[0]?.show).toHaveBeenCalledOnce();
  });

  it('destroys the cached child with its main window and may prewarm a replacement', () => {
    const { controller, windows } = makeHarness();
    controller.prewarm();

    controller.destroyWindow();
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(controller.isOpen()).toBe(false);

    controller.prewarm();
    expect(windows).toHaveLength(2);
  });

  it('permanently stops creating windows after app disposal', () => {
    const { controller, windows, mainSender } = makeHarness();
    controller.prewarm();

    controller.dispose();
    controller.prewarm();
    controller.open(mainSender);

    expect(windows).toHaveLength(1);
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(controller.isOpen()).toBe(false);
  });

  it('clears a pending open timeout when the window is unexpectedly destroyed', () => {
    const { controller, windows, mainSender } = makeHarness(1000);
    controller.open(mainSender);
    windows[0]?.emitClosed();

    vi.advanceTimersByTime(1000);
    expect(windows[0]?.show).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
  });
});
