import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  backingOrder: [] as string[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  untrustedSend: vi.fn(),
  destroyedSend: vi.fn(),
  assertTrusted: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { appContent: true, isDestroyed: () => false, webContents: { send: harness.send } },
      {
        appContent: false,
        isDestroyed: () => false,
        webContents: { send: harness.untrustedSend },
      },
      {
        appContent: true,
        isDestroyed: () => true,
        webContents: { send: harness.destroyedSend },
      },
    ],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      harness.listeners.set(channel, listener);
    },
  },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string, fallback: string[]) {
      return harness.backingOrder ?? fallback;
    }

    set(_key: string, value: string[]) {
      harness.backingOrder = Array.from(value);
    }
  },
}));

vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
}));

vi.mock('../windowFocusClassifier', () => ({
  isAppContentWindow: (window: { appContent?: boolean; isDestroyed: () => boolean }) =>
    window.appContent === true && !window.isDestroyed(),
}));

describe('sidebarSettingsStore', () => {
  beforeEach(async () => {
    harness.backingOrder = [];
    harness.handlers.clear();
    harness.listeners.clear();
    harness.send.mockReset();
    harness.untrustedSend.mockReset();
    harness.destroyedSend.mockReset();
    harness.assertTrusted.mockReset();
    vi.resetModules();

    const { registerSidebarSettingsIpc } = await import('../sidebarSettingsStore');
    registerSidebarSettingsIpc();
  });

  it('broadcasts a validated pinned-order snapshot to every live window', () => {
    const handler = harness.handlers.get('sidebar-settings:save-pinned-order');
    const event = {};
    const order = ['project:local:/workspace/a', 'session-b'];

    expect(handler).toBeDefined();
    handler?.(event, order);

    expect(harness.assertTrusted).toHaveBeenCalledWith(event);
    expect(harness.backingOrder).toEqual(order);
    expect(harness.send).toHaveBeenCalledWith(
      'sidebar-settings:pinned-order-changed',
      order,
    );
    expect(harness.untrustedSend).not.toHaveBeenCalled();
    expect(harness.destroyedSend).not.toHaveBeenCalled();
  });

  it('rejects malformed pinned-order payloads without persisting or broadcasting', () => {
    const handler = harness.handlers.get('sidebar-settings:save-pinned-order');

    expect(() => handler?.({}, ['valid', 42])).toThrow(
      '[INVALID_PARAMS] invalid sidebar pinned order',
    );
    expect(harness.backingOrder).toEqual([]);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('guards and returns the persisted order for the synchronous initial read', () => {
    harness.backingOrder = ['project:local:/workspace/a'];
    const listener = harness.listeners.get('sidebar-settings:load-pinned-order-sync');
    const event: { returnValue?: string[] } = {};

    listener?.(event);

    expect(harness.assertTrusted).toHaveBeenCalledWith(event);
    expect(event.returnValue).toEqual(harness.backingOrder);
  });
});
