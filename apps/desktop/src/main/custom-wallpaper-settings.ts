import { app } from 'electron';
import path from 'node:path';
import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';

const filePath = () => path.join(app.getPath('userData'), 'custom-wallpaper.json');

// Like theme preferences, the image is shared by accounts in this Desktop profile.
export const customWallpaperStore = createOverrideSettingsFile<{ url: string }>({
  filePath,
  defaults: { url: '' },
  normalize: (raw) => ({
    url: normalizeCustomWallpaperUrl((raw as { url?: unknown })?.url),
  }),
  log: createLogger('custom-wallpaper-settings'),
  label: 'custom-wallpaper',
  maxBytes: 4096,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readCustomWallpaperUrl(): string {
  customWallpaperStore.invalidateIfChanged();
  return customWallpaperStore.read().url;
}
