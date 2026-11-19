import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    app: { getAppMetrics: vi.fn(() => []) },
    clipboard: { writeImage: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
      __handlers: handlers,
    },
    webContents: { fromId: vi.fn() },
  };
});

import { ipcMain, webContents, type WebContents } from 'electron';
import {
  RSB_BROWSER_BRIDGE_PIN_CHANNEL,
  RSB_BROWSER_BRIDGE_RELEASE_CHANNEL,
  RSB_FILE_PREVIEW_OPENER_CHANNEL,
} from '../../../shared/rsbBrowserBridge.js';
import { _resetRsbBrowserBridgeIpcForTests, registerRsbBrowserBridgeIpc } from '../ipc.js';
import { TabRegistry } from '../registry.js';

function handler(channel: string) {
  const handlers = (ipcMain as unknown as {
    __handlers: Map<string, (event: unknown, payload: unknown) => unknown>;
  }).__handlers;
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`missing handler: ${channel}`);
  return registered;
}

function fakeGuest(ownerId: number) {
  return {
    id: 101,
    hostWebContents: { id: ownerId },
    isDestroyed: () => false,
    getType: () => 'webview',
  };
}

function makeRegistry(target: unknown) {
  let pinListener: ((tabId: string, pinned: boolean) => void) | undefined;
  return {
    registry: {
      getWebContentsByTabId: () => target,
      release: vi.fn(),
      onPinChange: (listener: (tabId: string, pinned: boolean) => void) => {
        pinListener = listener;
        return () => undefined;
      },
      listAll: () => [],
      isPinned: () => false,
    } as unknown as TabRegistry,
    emitPin: (tabId: string, pinned: boolean) => pinListener?.(tabId, pinned),
  };
}

function register(registry: TabRegistry) {
  registerRsbBrowserBridgeIpc({
    registry,
    getHostWebContents: () => null,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

beforeEach(() => {
  _resetRsbBrowserBridgeIpcForTests();
  (ipcMain as unknown as { __handlers: Map<string, unknown> }).__handlers.clear();
});

afterEach(() => {
  _resetRsbBrowserBridgeIpcForTests();
});

describe('RSB browser bridge ownership routing', () => {
  // #11392, unit: preview links need task attribution without exposing local
  // documents as browser automation targets. Exercise the real IPC and registry.
  it('attributes preview links to their host for the lifetime of the guest', () => {
    const mockGuest = fakeGuest(7);
    const guest = mockGuest as unknown as WebContents;
    vi.mocked(webContents.fromId).mockReturnValue(guest);
    const registry = new TabRegistry({ lookupWebContents: webContents.fromId, logger: { info: vi.fn(), warn: vi.fn() } });
    register(registry);
    const report = handler(RSB_FILE_PREVIEW_OPENER_CHANNEL);
    const record = { sessionId: 'source-task', tabId: 'file-preview', webContentsId: 101 };
    const notify = vi.fn();
    registry.onReport(notify);
    expect(() => report({ sender: { id: 9 } }, record)).toThrow(/INVALID_PARAMS/);
    expect(registry.findByWebContentsId(101)).toBeNull();
    report({ sender: { id: 7 } }, record);
    expect(notify).toHaveBeenCalledWith(record);
    expect(registry.findByWebContentsId(101)).toEqual(record);
    expect(registry.listBySession('source-task')).toEqual([]);
    expect(registry.getWebContentsByTabId('file-preview')).toBeNull();
    mockGuest.isDestroyed = () => true;
    expect(registry.findByWebContentsId(101)).toBeNull();
    vi.mocked(webContents.fromId).mockReset();
  });

  it('routes pin changes to the renderer that owns the tab', () => {
    const guest = fakeGuest(7);
    const owner = { id: 7, send: vi.fn(), isDestroyed: () => false };
    const harness = makeRegistry(guest);
    (guest as { hostWebContents: unknown }).hostWebContents = owner;
    register(harness.registry);

    harness.emitPin('tab-a', true);

    expect(owner.send).toHaveBeenCalledWith(RSB_BROWSER_BRIDGE_PIN_CHANNEL, { tabId: 'tab-a' });
  });

  it('rejects release from a renderer that does not own the tab', () => {
    const guest = fakeGuest(7);
    const harness = makeRegistry(guest);
    register(harness.registry);

    expect(() =>
      handler(RSB_BROWSER_BRIDGE_RELEASE_CHANNEL)(
        { sender: { id: 9 } },
        { tabId: 'tab-a', webContentsId: guest.id },
      ),
    ).toThrow(/INVALID_PARAMS/);
  });

  it('allows release from the current tab owner', () => {
    const guest = fakeGuest(7);
    const harness = makeRegistry(guest);
    register(harness.registry);

    expect(
      handler(RSB_BROWSER_BRIDGE_RELEASE_CHANNEL)(
        { sender: { id: 7 } },
        { tabId: 'tab-a', webContentsId: guest.id },
      ),
    ).toEqual({ ok: true });
  });
});
