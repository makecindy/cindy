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

import { ipcMain } from 'electron';
import { webContents as electronWebContents } from 'electron';
import {
  RSB_BROWSER_BRIDGE_PIN_CHANNEL,
  RSB_BROWSER_BRIDGE_RELEASE_CHANNEL,
  RSB_BROWSER_BRIDGE_REPORT_CHANNEL,
  RSB_BROWSER_BRIDGE_SNAPSHOT_CHANNEL,
} from '../../../shared/rsbBrowserBridge.js';
import type { PreviewTabIndex } from '../previewTabs.js';
import { _resetRsbBrowserBridgeIpcForTests, registerRsbBrowserBridgeIpc } from '../ipc.js';
import type { TabRegistry } from '../registry.js';

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

describe('RSB browser bridge · previewRequestId 透传', () => {
  function registerWithPreview() {
    const guest = fakeGuest(7);
    const report = vi.fn();
    const registry = {
      ...makeRegistry(guest).registry,
      report,
      reconcile: vi.fn(() => ({ dropped: [], kept: 0, pinnedTabIds: [] })),
    } as unknown as TabRegistry;
    const previewTabs = { bind: vi.fn(), pruneTabs: vi.fn() };
    registerRsbBrowserBridgeIpc({
      registry,
      previewTabs: previewTabs as unknown as PreviewTabIndex,
      getHostWebContents: () => null,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    vi.mocked(electronWebContents.fromId).mockReturnValue(guest as never);
    return { report, previewTabs };
  }

  it('report 把 previewRequestId 交给索引裁决,registry 记录里不含它', () => {
    const { report, previewTabs } = registerWithPreview();
    const id = 'A'.repeat(43);
    expect(
      handler(RSB_BROWSER_BRIDGE_REPORT_CHANNEL)(
        { sender: { id: 7 } },
        { sessionId: 's1', tabId: 'tab-a', webContentsId: 101, previewRequestId: id },
      ),
    ).toEqual({ ok: true });
    const record = { sessionId: 's1', tabId: 'tab-a', webContentsId: 101 };
    expect(report).toHaveBeenCalledWith(record);
    expect(previewTabs.bind).toHaveBeenCalledWith(record, id);
  });

  it('归属校验先于索引:非宿主 renderer 的 report 被拒,索引不被调用', () => {
    const { report, previewTabs } = registerWithPreview();
    expect(() =>
      handler(RSB_BROWSER_BRIDGE_REPORT_CHANNEL)(
        { sender: { id: 9 } },
        { sessionId: 's1', tabId: 'tab-a', webContentsId: 101, previewRequestId: 'A'.repeat(43) },
      ),
    ).toThrow(/INVALID_PARAMS/);
    expect(report).not.toHaveBeenCalled();
    expect(previewTabs.bind).not.toHaveBeenCalled();
  });

  it('snapshot 对账后让索引清理不存活标签的 grant', () => {
    const { previewTabs } = registerWithPreview();
    handler(RSB_BROWSER_BRIDGE_SNAPSHOT_CHANNEL)({ sender: { id: 7 } }, { liveTabIds: ['a', 'b'] });
    expect(previewTabs.pruneTabs).toHaveBeenCalledWith(['a', 'b']);
  });
});
