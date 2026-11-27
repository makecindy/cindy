// Verifies the toolbar screenshot IPC handler (`capture-screenshot`):
//  - happy path: capturePage → clipboard.writeImage → {ok:true}
//  - unknown / dead tab → [NOT_FOUND]
//  - webview not hosted by the sender → [INVALID_PARAMS](防跨 renderer 抓图)
//  - capturePage throws → [INTERNAL]
//  - empty capture → [INTERNAL](不写空图进剪贴板)
// And the browser-comment variant (`capture-screenshot-data`):
//  - happy path: capturePage → toPNG bytes 返回、不碰剪贴板
//  - 与 capture-screenshot 共用的安全门 / 空图错误路径

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const ipcMainHandlers = new Map<string, (e: unknown, payload: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
        ipcMainHandlers.set(channel, fn);
      }),
      __handlers: ipcMainHandlers,
    },
    webContents: { fromId: vi.fn() },
    clipboard: { writeImage: vi.fn() },
  };
});

import { clipboard, ipcMain } from 'electron';

import {
  RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_CHANNEL,
  RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL,
} from '../../../shared/rsbBrowserBridge.js';
import { registerRsbBrowserBridgeIpc, _resetRsbBrowserBridgeIpcForTests } from '../ipc.js';
import type { TabRegistry } from '../registry.js';

/** 只实现 capture 路径会碰到的 registry 面;其余方法不会被调用。 */
function fakeRegistry(overrides: { getWebContentsByTabId?: (tabId: string) => unknown }) {
  return {
    getWebContentsByTabId: overrides.getWebContentsByTabId ?? (() => null),
    onPinChange: () => () => undefined,
  } as unknown as TabRegistry;
}

interface FakeImage {
  isEmpty: () => boolean;
  toPNG?: () => Uint8Array;
}

function fakeGuestWc(opts: {
  hostId?: number;
  capture?: () => Promise<FakeImage>;
}): unknown {
  return {
    hostWebContents: opts.hostId == null ? undefined : { id: opts.hostId },
    capturePage: opts.capture ?? (async () => ({ isEmpty: () => false })),
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function getHandler(channel: string = RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_CHANNEL) {
  const handlers = (
    ipcMain as unknown as {
      __handlers: Map<string, (e: unknown, payload: unknown) => unknown>;
    }
  ).__handlers;
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`capture handler not registered for ${channel}`);
  return fn;
}

function register(registry: TabRegistry, extra?: { captureTimeoutMs?: number }) {
  registerRsbBrowserBridgeIpc({
    registry,
    getHostWebContents: () => null,
    logger: logger(),
    ...extra,
  });
}

const senderEvent = { sender: { id: 7 } };

beforeEach(() => {
  _resetRsbBrowserBridgeIpcForTests();
  (ipcMain as unknown as { __handlers: Map<string, unknown> }).__handlers.clear();
  (ipcMain.handle as ReturnType<typeof vi.fn>).mockClear();
  (clipboard.writeImage as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  _resetRsbBrowserBridgeIpcForTests();
});

describe('capture-screenshot handler', () => {
  it('captures the page and writes the image to the clipboard', async () => {
    const image: FakeImage = { isEmpty: () => false };
    register(
      fakeRegistry({
        getWebContentsByTabId: (tabId) =>
          tabId === 't1' ? fakeGuestWc({ hostId: 7, capture: async () => image }) : null,
      }),
    );

    const result = await getHandler()(senderEvent, { tabId: 't1' });

    expect(result).toEqual({ ok: true });
    expect(clipboard.writeImage).toHaveBeenCalledTimes(1);
    expect(clipboard.writeImage).toHaveBeenCalledWith(image);
  });

  it('rejects with NOT_FOUND when the tab has no live webContents', async () => {
    register(fakeRegistry({ getWebContentsByTabId: () => null }));

    await expect(getHandler()(senderEvent, { tabId: 'gone' })).rejects.toThrow(
      /\[NOT_FOUND\]/,
    );
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects with INVALID_PARAMS when the webview is hosted by another renderer', async () => {
    register(
      fakeRegistry({
        getWebContentsByTabId: () => fakeGuestWc({ hostId: 999 }),
      }),
    );

    await expect(getHandler()(senderEvent, { tabId: 't1' })).rejects.toThrow(
      /\[INVALID_PARAMS\]/,
    );
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects with INTERNAL when capturePage throws', async () => {
    register(
      fakeRegistry({
        getWebContentsByTabId: () =>
          fakeGuestWc({
            hostId: 7,
            capture: async () => {
              throw new Error('render process gone');
            },
          }),
      }),
    );

    await expect(getHandler()(senderEvent, { tabId: 't1' })).rejects.toThrow(/\[INTERNAL\]/);
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects with INTERNAL when the captured image is empty', async () => {
    register(
      fakeRegistry({
        getWebContentsByTabId: () =>
          fakeGuestWc({ hostId: 7, capture: async () => ({ isEmpty: () => true }) }),
      }),
    );

    await expect(getHandler()(senderEvent, { tabId: 't1' })).rejects.toThrow(/\[INTERNAL\]/);
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects with INVALID_PARAMS on a malformed payload', async () => {
    register(fakeRegistry({}));

    await expect(getHandler()(senderEvent, { tabId: 42 })).rejects.toThrow(
      /\[INVALID_PARAMS\]/,
    );
  });

  // Regression (P0-2): capturePage() on a hidden guest webview can hang forever without timeout.
  // Production entry: RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_CHANNEL IPC handler (unit tier, fake timers).
  it('rejects with INTERNAL timeout when capturePage hangs', async () => {
    vi.useFakeTimers();
    try {
      register(
        fakeRegistry({
          getWebContentsByTabId: () =>
            fakeGuestWc({
              hostId: 7,
              capture: () => new Promise<FakeImage>(() => {}),
            }),
        }),
        { captureTimeoutMs: 1000 },
      );

      const pending = Promise.resolve(getHandler()(senderEvent, { tabId: 't1' }));
      const rejection = expect(pending).rejects.toThrow(/\[INTERNAL\] capturePage timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(clipboard.writeImage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when target webContents is destroyed while capturePage is pending', async () => {
    const listeners = new Map<string, Array<() => void>>();
    const guest = {
      hostWebContents: { id: 7 },
      isDestroyed: () => false,
      capturePage: () => new Promise<FakeImage>(() => {}),
      once: (event: string, fn: () => void) => {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
      },
      removeListener: (event: string, fn: () => void) => {
        const list = listeners.get(event);
        if (list) listeners.set(event, list.filter((f) => f !== fn));
      },
    };
    register(fakeRegistry({ getWebContentsByTabId: () => guest }), { captureTimeoutMs: 60_000 });

    const pending = Promise.resolve(getHandler()(senderEvent, { tabId: 't1' }));
    const rejection = expect(pending).rejects.toThrow(/\[INTERNAL\] capturePage failed/);
    for (const fn of listeners.get('destroyed') ?? []) fn();
    await rejection;
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });
});

describe('capture-screenshot-data handler', () => {
  it('returns PNG bytes and never touches the clipboard', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const image: FakeImage = { isEmpty: () => false, toPNG: () => png };
    register(
      fakeRegistry({
        getWebContentsByTabId: (tabId) =>
          tabId === 't1' ? fakeGuestWc({ hostId: 7, capture: async () => image }) : null,
      }),
    );

    const result = await getHandler(RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL)(
      senderEvent,
      { tabId: 't1' },
    );

    expect(result).toEqual({ ok: true, data: png });
    expect(clipboard.writeImage).not.toHaveBeenCalled();
  });

  it('rejects with NOT_FOUND when the tab has no live webContents', async () => {
    register(fakeRegistry({ getWebContentsByTabId: () => null }));

    await expect(
      getHandler(RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL)(senderEvent, {
        tabId: 'gone',
      }),
    ).rejects.toThrow(/\[NOT_FOUND\]/);
  });

  it('rejects with INVALID_PARAMS when the webview is hosted by another renderer', async () => {
    register(
      fakeRegistry({ getWebContentsByTabId: () => fakeGuestWc({ hostId: 999 }) }),
    );

    await expect(
      getHandler(RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL)(senderEvent, {
        tabId: 't1',
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });

  it('rejects with INTERNAL when the captured image is empty', async () => {
    register(
      fakeRegistry({
        getWebContentsByTabId: () =>
          fakeGuestWc({ hostId: 7, capture: async () => ({ isEmpty: () => true }) }),
      }),
    );

    await expect(
      getHandler(RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL)(senderEvent, {
        tabId: 't1',
      }),
    ).rejects.toThrow(/\[INTERNAL\]/);
  });
});
