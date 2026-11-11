import { ipcRenderer } from 'electron';
import {
  WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL,
  type WallpaperDownloadProgress,
  type WallpaperId,
} from '../shared/appearanceSettings';

/** Only trusted app-content hosts expose this fixed official-media capability. */
export function createWallpaperAssetsBridge() {
  return {
    ensureWallpaperImage: (id: WallpaperId): Promise<string | null> =>
      ipcRenderer.invoke('appearance-settings:ensure-wallpaper-image', id),
    ensureWallpaperVideo: (id: WallpaperId): Promise<string | null> =>
      ipcRenderer.invoke('appearance-settings:ensure-wallpaper-video', id),
    onWallpaperDownloadProgress: (callback: (progress: WallpaperDownloadProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: WallpaperDownloadProgress) =>
        callback(progress);
      ipcRenderer.on(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL, listener);
    },
  };
}
