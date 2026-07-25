// Verifies the `force-kill` IPC handler:
//  - registry hit + host match → forcefullyCrashRenderer + {ok:true}
//  - registry miss + valid fallback webContentsId(webview guest、宿主为 sender)
//    → 兜底解析后 kill(页面在首个 dom-ready 前锁死 renderer 的场景)
//  - fallback 指向非 webview / 宿主不符 → 拒绝(不放松 report 同款信任模型)
//  - forcefullyCrashRenderer 抛 → [INTERNAL](TOCTOU 竞态转统一 IPC 错误协议)

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
    app: { getAppMetrics: vi.fn(() => []) },
  };
});

import { ipcMain, webContents as electronWebContents } from 'electron';

import { RSB_BROWSER_BRIDGE_FORCE_KILL_CHANNEL } from '../../../shared/rsbBrowserBridge.js';
import { registerRsbBrowserBridgeIpc, _resetRsbBrowserBridgeIpcForTests } from '../ipc.js';
import type { TabRegistry } from '../registry.js';

function fakeRegistry(overrides: { getWebContentsByTabId?: (tabId: string) => unknown }) {
  return {
    getWebContentsByTabId: overrides.getWebContentsByTabId ?? (() => null),
    onPinChange: () => () => undefined,
    listAll: () => [],
    isPinned: () => false,
  } as unknown as TabRegistry;
}

interface FakeGuestOpts {
  hostId?: number;
  type?: string;
  destroyed?: boolean;
  killThrows?: boolean;
}

function fakeGuestWc(opts: FakeGuestOpts) {
  return {
    hostWebContents: opts.hostId == null ? undefined : { id: opts.hostId },
    getType: () => opts.type ?? 'webview',
    isDestroyed: () => opts.destroyed === true,
    forcefullyCrashRenderer: vi.fn(() => {
      if (opts.killThrows) throw new Error('boom');
    }),
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function register(registry: TabRegistry) {
  registerRsbBrowserBridgeIpc({
    registry,
    getHostWebContents: () => null,
    logger: logger(),
  });
  const handlers = (ipcMain as unknown as {
    __handlers: Map<string, (e: unknown, payload: unknown) => unknown>;
  }).__handlers;
  const handler = handlers.get(RSB_BROWSER_BRIDGE_FORCE_KILL_CHANNEL);
  if (!handler) throw new Error('force-kill handler not registered');
  return handler;
}

const senderEvent = { sender: { id: 10, once: vi.fn() } };

describe('rsb-browser-bridge force-kill IPC', () => {
  beforeEach(() => {
    _resetRsbBrowserBridgeIpcForTests();
    vi.mocked(electronWebContents.fromId).mockReset();
  });

  afterEach(() => {
    _resetRsbBrowserBridgeIpcForTests();
    vi.clearAllMocks();
  });

  it('kills a registry-resolved guest hosted by the sender', () => {
    const guest = fakeGuestWc({ hostId: 10 });
    const handler = register(fakeRegistry({ getWebContentsByTabId: () => guest }));

    expect(handler(senderEvent, { tabId: 't1' })).toEqual({ ok: true });
    expect(guest.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });

  it('falls back to the reported webContentsId when the registry has no row', () => {
    const guest = fakeGuestWc({ hostId: 10 });
    vi.mocked(electronWebContents.fromId).mockReturnValue(guest as never);
    const handler = register(fakeRegistry({}));

    expect(handler(senderEvent, { tabId: 't1', webContentsId: 77 })).toEqual({ ok: true });
    expect(electronWebContents.fromId).toHaveBeenCalledWith(77);
    expect(guest.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });

  it('rejects a fallback id that is not a webview guest', () => {
    const notWebview = fakeGuestWc({ hostId: 10, type: 'window' });
    vi.mocked(electronWebContents.fromId).mockReturnValue(notWebview as never);
    const handler = register(fakeRegistry({}));

    expect(() => handler(senderEvent, { tabId: 't1', webContentsId: 77 })).toThrow(
      /NOT_FOUND/,
    );
    expect(notWebview.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  it('rejects a fallback guest hosted by a different renderer', () => {
    const foreign = fakeGuestWc({ hostId: 99 });
    vi.mocked(electronWebContents.fromId).mockReturnValue(foreign as never);
    const handler = register(fakeRegistry({}));

    expect(() => handler(senderEvent, { tabId: 't1', webContentsId: 77 })).toThrow(
      /INVALID_PARAMS/,
    );
    expect(foreign.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  it('rejects when neither registry nor fallback resolves', () => {
    const handler = register(fakeRegistry({}));
    expect(() => handler(senderEvent, { tabId: 't1' })).toThrow(/NOT_FOUND/);
  });

  it('converts forcefullyCrashRenderer failures into [INTERNAL]', () => {
    const guest = fakeGuestWc({ hostId: 10, killThrows: true });
    const handler = register(fakeRegistry({ getWebContentsByTabId: () => guest }));

    expect(() => handler(senderEvent, { tabId: 't1' })).toThrow(/INTERNAL/);
  });
});
