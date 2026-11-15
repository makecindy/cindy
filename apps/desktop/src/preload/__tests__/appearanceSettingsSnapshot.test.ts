import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../../shared/appearanceSettings';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  expose: vi.fn(),
  sendSync: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  webUtils: { getPathForFile: vi.fn() },
  ipcRenderer: {
    sendSync: mocks.sendSync,
    invoke: mocks.invoke,
    send: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const listeners = mocks.listeners.get(channel) ?? new Set();
      listeners.add(listener);
      mocks.listeners.set(channel, listeners);
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      mocks.listeners.get(channel)?.delete(listener);
    },
  },
}));

interface AppearanceBridge {
  getSync(): AppearanceSettings | null;
  onChanged: ((callback: (settings: AppearanceSettings) => void) => () => void) & {
    __reset?: () => void;
  };
}

describe.each(['main', 'sidebar'] as const)('%s preload appearance snapshot', (kind) => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.expose.mockClear();
    mocks.invoke.mockReset();
    mocks.sendSync.mockReset().mockImplementation((channel) => {
      if (channel === 'appearance-settings:get-sync') return { ...DEFAULT_APPEARANCE_SETTINGS };
      if (channel === 'app-locale:get-preferred-system-locale-sync') return 'en';
      return {};
    });
  });

  it('keeps late mounts and remounts current, updates before consumers, and strips Electron events', async () => {
    if (kind === 'main') await import('../preload');
    else await import('../sidebarWindowPreload');
    const exposed = mocks.expose.mock.calls.find(([name]) => name === 'electronAPI')?.[1];
    const bridge = exposed.appearanceSettings as AppearanceBridge;
    const privilegedEvent = { sender: { send: vi.fn() } };
    const emit = (settings: AppearanceSettings) => {
      for (const listener of mocks.listeners.get('appearance-settings:changed') ?? []) {
        listener(privilegedEvent, settings);
      }
    };

    expect(bridge.getSync()).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    const changed = { ...DEFAULT_APPEARANCE_SETTINGS, terminalFamily: 'Menlo', terminalSize: 18 };
    emit(changed); // No renderer subscription exists yet.
    expect(bridge.getSync()).toEqual(changed);

    const callback = vi.fn((settings: AppearanceSettings) => {
      expect(bridge.getSync()).toEqual(settings);
    });
    const unsubscribe = bridge.onChanged(callback);
    if (kind === 'sidebar') {
      expect(callback.mock.calls).toEqual([[changed]]);
      callback.mockClear();
    }
    const next = { ...changed, terminalSize: 21 };
    emit(next);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toEqual(next);
    expect(callback.mock.calls[0]).not.toContain(privilegedEvent);
    expect(mocks.invoke).not.toHaveBeenCalled();

    unsubscribe();
    bridge.onChanged.__reset?.(); // HMR may dispose every renderer listener.
    emit({ ...next, terminalSize: 13 });
    expect(callback).toHaveBeenCalledOnce();
    expect(bridge.getSync()?.terminalSize).toBe(13);
    expect(mocks.sendSync.mock.calls.filter(([channel]) => channel === 'appearance-settings:get-sync'))
      .toHaveLength(1);

    if (kind === 'sidebar') {
      expect(Object.keys(bridge).sort()).toEqual([
        'ensureWallpaperImage', 'ensureWallpaperVideo', 'getSync', 'loadPluginFont', 'onChanged',
        'onWallpaperDownloadProgress',
      ]);
      // Plugin picker regression: a parallel profile without a migration-complete marker needs
      // Main's owner lease to publish the catalog (localCatalogSnapshot shared-profile cases).
      // Exercise the real exposed sidebar IPC methods, not a hand-written renderer stub. Tier: unit.
      const claim = { dataOwnerId: 'owner-a', ownerGeneration: 7, canWriteOwnerScoped: true,
        claimed: true, claimedByOtherOwner: false, canInitialize: false, profileOrigin: 'existing' };
      mocks.sendSync.mockReturnValueOnce(claim);
      expect(exposed.maker.claimLegacyModelVisibilityOwner()).toEqual(claim);
      expect(mocks.sendSync).toHaveBeenLastCalledWith('maker:model-visibility:legacy-owner-claim-sync');
      const hidden = { 'pi:xd:hidden': false };
      const policy = { followCatalogKeys: [] };
      await exposed.maker.syncModelVisibility('owner-a', 7, hidden, policy);
      expect(mocks.invoke).toHaveBeenLastCalledWith('maker:model-visibility:sync', 'owner-a', 7, hidden, policy);
      mocks.sendSync.mockReturnValueOnce({});
      expect(exposed.maker.claimLegacyModelVisibilityOwner().canWriteOwnerScoped).toBe(false);
    } else {
      expect(Object.keys(bridge).sort()).toEqual([
        'ensureWallpaperImage', 'ensureWallpaperVideo', 'get', 'getSync', 'importWallpaper', 'loadPluginFont',
        'onChanged', 'onWallpaperDownloadProgress', 'removeWallpaper', 'reset', 'resetFields', 'selectTheme', 'setPatch',
      ]);
      // Full themes add only trusted app-content mutations; sidebar above stays
      // read-only. Exercise the real preload routing, not a handwritten bridge.
      const selection = { mode: 'dark', familyId: 'theme-local' };
      await exposed.appearanceSettings.selectTheme(selection);
      expect(mocks.invoke).toHaveBeenLastCalledWith('appearance-settings:select-theme', selection);
      await exposed.appearanceSettings.selectTheme(null);
      expect(mocks.invoke).toHaveBeenLastCalledWith('appearance-settings:select-theme', null);
      await exposed.appearanceSettings.resetFields(['terminalSize']);
      expect(mocks.invoke).toHaveBeenLastCalledWith('appearance-settings:reset-fields', ['terminalSize']);
    }
  });
});
