import { ipcRenderer } from 'electron';
import type { AppearanceSettings } from '../shared/appearanceSettings';
import { createWallpaperAssetsBridge } from './wallpaperAssets';

/** Only the current selected font role, never a renderer-provided path or plugin ID. */
export function createPluginFontReader() {
  return { loadPluginFont: (role: string): Promise<{ family: string; bytes: ArrayBuffer }> => ipcRenderer.invoke('appearance-settings:plugin-font', role) };
}

/** Read-only appearance for lazy detached renderers; no settings mutation IPC. */
export function createAppearanceSnapshotBridge(options: { wallpaperAssets?: boolean } = {}) {
  let current = ipcRenderer.sendSync('appearance-settings:get-sync') as AppearanceSettings | null;
  // Keep listening even with no renderer subscribers (startup, hidden or HMR).
  ipcRenderer.on('appearance-settings:changed', (_event, next: AppearanceSettings) => {
    current = next;
  });
  return {
    ...createPluginFontReader(),
    // Only app-content hosts opt in. Utility appearance readers keep their narrower bridge.
    ...(options.wallpaperAssets ? createWallpaperAssetsBridge() : {}),
    getSync: (): AppearanceSettings | null => current,
    onChanged: (callback: (settings: AppearanceSettings) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, next: AppearanceSettings) =>
        callback(next);
      ipcRenderer.on('appearance-settings:changed', listener);
      // Also closes the render -> effect gap after getSync has already run.
      if (current) callback(current);
      return () => ipcRenderer.removeListener('appearance-settings:changed', listener);
    },
  };
}
