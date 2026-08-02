import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: {
    pinnedOrder: [] as string[],
    hiddenProjectKeys: [] as string[],
  },
  storeOptions: undefined as unknown,
  storeSet: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  sendSecond: vi.fn(),
  untrustedSend: vi.fn(),
  destroyedSend: vi.fn(),
  assertTrusted: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { appContent: true, isDestroyed: () => false, webContents: { send: harness.send } },
      { appContent: true, isDestroyed: () => false, webContents: { send: harness.sendSecond } },
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
    constructor(options: unknown) {
      harness.storeOptions = options;
    }

    get(key: string, fallback: string[]) {
      return (harness.settings as Record<string, string[]>)[key] ?? fallback;
    }

    set(key: string, value: string[]) {
      const snapshot = Array.from(value);
      harness.storeSet(key, snapshot);
      (harness.settings as Record<string, string[]>)[key] = snapshot;
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
    harness.settings.pinnedOrder = [];
    harness.settings.hiddenProjectKeys = [];
    harness.storeOptions = undefined;
    harness.storeSet.mockReset();
    harness.handlers.clear();
    harness.listeners.clear();
    harness.send.mockReset();
    harness.sendSecond.mockReset();
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
    expect(harness.settings.pinnedOrder).toEqual(order);
    expect(harness.send).toHaveBeenCalledWith('sidebar-settings:pinned-order-changed', order);
    expect(harness.sendSecond).toHaveBeenCalledWith('sidebar-settings:pinned-order-changed', order);
    expect(harness.untrustedSend).not.toHaveBeenCalled();
    expect(harness.destroyedSend).not.toHaveBeenCalled();
  });

  it('rejects malformed pinned-order payloads without persisting or broadcasting', () => {
    const handler = harness.handlers.get('sidebar-settings:save-pinned-order');

    expect(() => handler?.({}, ['valid', 42])).toThrow(
      '[INVALID_PARAMS] invalid sidebar pinned order',
    );
    expect(harness.settings.pinnedOrder).toEqual([]);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('guards and returns the persisted order for the synchronous initial read', () => {
    harness.settings.pinnedOrder = ['project:local:/workspace/a'];
    const listener = harness.listeners.get('sidebar-settings:load-pinned-order-sync');
    const event: { returnValue?: string[] } = {};

    listener?.(event);

    expect(harness.assertTrusted).toHaveBeenCalledWith(event);
    expect(event.returnValue).toEqual(harness.settings.pinnedOrder);
  });

  it('persists a normalized hidden-project intent and broadcasts only to app content windows', () => {
    const handler = harness.handlers.get('sidebar-settings:set-project-hidden');
    const event = {};

    expect(handler?.(event, 'C:\\workspace\\alpha\\', true)).toBe(true);

    expect(harness.assertTrusted).toHaveBeenCalledWith(event);
    expect(harness.settings.hiddenProjectKeys).toEqual(['local:C:/workspace/alpha']);
    expect(harness.storeSet).toHaveBeenCalledWith('hiddenProjectKeys', [
      'local:C:/workspace/alpha',
    ]);
    expect(harness.send).toHaveBeenCalledWith('sidebar-settings:hidden-project-keys-changed', [
      'local:C:/workspace/alpha',
    ]);
    expect(harness.sendSecond).toHaveBeenCalledWith(
      'sidebar-settings:hidden-project-keys-changed',
      ['local:C:/workspace/alpha'],
    );
    expect(harness.untrustedSend).not.toHaveBeenCalled();
    expect(harness.destroyedSend).not.toHaveBeenCalled();
  });

  it.each([
    [42, true],
    ['', true],
    ['x'.repeat(4_097), true],
    ['device:missing-working-dir', true],
    ['local:/workspace/alpha', 'true'],
  ])('rejects an invalid project-hidden intent (%j, %j)', (projectKey, hidden) => {
    const handler = harness.handlers.get('sidebar-settings:set-project-hidden');

    expect(() => handler?.({}, projectKey, hidden)).toThrow('[INVALID_PARAMS]');
    expect(harness.settings.hiddenProjectKeys).toEqual([]);
    expect(harness.storeSet).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('treats repeated intents as no-ops and preserves pinned settings', () => {
    harness.settings.pinnedOrder = ['project:local:/workspace/alpha', 'session-b'];
    harness.settings.hiddenProjectKeys = ['local:/workspace/alpha'];
    const handler = harness.handlers.get('sidebar-settings:set-project-hidden');

    expect(handler?.({}, 'local:/workspace/alpha/', true)).toBe(false);

    expect(harness.storeSet).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.settings.pinnedOrder).toEqual(['project:local:/workspace/alpha', 'session-b']);

    expect(handler?.({}, 'local:/workspace/alpha', false)).toBe(true);

    expect(harness.settings.hiddenProjectKeys).toEqual([]);
    expect(harness.storeSet).toHaveBeenCalledTimes(1);
    expect(harness.storeSet).toHaveBeenCalledWith('hiddenProjectKeys', []);
    expect(harness.settings.pinnedOrder).toEqual(['project:local:/workspace/alpha', 'session-b']);
  });

  it('merges sequential window intents against the latest main-process snapshot', () => {
    const handler = harness.handlers.get('sidebar-settings:set-project-hidden');

    handler?.({ sender: 'window-a' }, 'local:/workspace/alpha', true);
    handler?.({ sender: 'window-b' }, 'local:/workspace/beta', true);

    expect(harness.settings.hiddenProjectKeys).toEqual([
      'local:/workspace/alpha',
      'local:/workspace/beta',
    ]);
    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      'sidebar-settings:hidden-project-keys-changed',
      ['local:/workspace/alpha', 'local:/workspace/beta'],
    );
  });

  it('rejects hiding another project after the persisted limit is reached', () => {
    harness.settings.hiddenProjectKeys = Array.from(
      { length: 10_000 },
      (_, index) => `local:/workspace/${index}`,
    );
    const handler = harness.handlers.get('sidebar-settings:set-project-hidden');

    expect(() => handler?.({}, 'local:/workspace/overflow', true)).toThrow(
      '[INVALID_PARAMS] too many hidden sidebar projects',
    );
    expect(harness.storeSet).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('guards and returns a normalized hidden-project snapshot for the synchronous initial read', () => {
    harness.settings.hiddenProjectKeys = [
      'local:/workspace/alpha/',
      'local:/workspace/alpha',
      'remote:host-a:/workspace/beta/',
    ];
    const listener = harness.listeners.get('sidebar-settings:load-hidden-project-keys-sync');
    const event: { returnValue?: string[] } = {};

    listener?.(event);

    expect(harness.assertTrusted).toHaveBeenCalledWith(event);
    expect(event.returnValue).toEqual(['local:/workspace/alpha', 'remote:host-a:/workspace/beta']);
    expect(harness.storeOptions).toMatchObject({
      defaults: { pinnedOrder: [], hiddenProjectKeys: [] },
      schema: {
        hiddenProjectKeys: {
          type: 'array',
          maxItems: 10_000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
      },
    });
  });

  it('checks the trusted sender before accepting a project-hidden intent', () => {
    const handler = harness.handlers.get('sidebar-settings:set-project-hidden');
    harness.assertTrusted.mockImplementationOnce(() => {
      throw new Error('untrusted renderer');
    });

    expect(() => handler?.({}, 'local:/workspace/alpha', true)).toThrow('untrusted renderer');
    expect(harness.storeSet).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });
});
