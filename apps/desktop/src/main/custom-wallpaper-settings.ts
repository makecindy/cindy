import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import manifest from '../shared/wallpaper-video-manifest.json';
import { blobUrl } from './cindy-media/blobStore.desktop.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';
import { parsePluginAppearanceSource, type PluginAppearanceSource } from '../shared/pluginAppearance.js';

const filePath = () => path.join(app.getPath('userData'), 'custom-wallpaper.json');
let appearanceWallpaperReferences: () => string[] = () => [];
/** The appearance owner supplies selected and in-flight theme media references. */
export function configureAppearanceWallpaperReferences(read: () => string[]): void {
  appearanceWallpaperReferences = read;
}

// Like theme preferences, the media is shared by accounts in this Desktop profile.
export const customWallpaperStore = createOverrideSettingsFile<{ url: string; fallbackUrl?: string; pluginSource?: PluginAppearanceSource }>({
  filePath,
  defaults: { url: '' },
  normalize: (raw) => {
    const value = raw as { url?: unknown; fallbackUrl?: unknown; pluginSource?: unknown };
    const fallbackUrl = normalizeCustomWallpaperUrl(value?.fallbackUrl);
    const pluginSource = parsePluginAppearanceSource(value?.pluginSource);
    return { url: normalizeCustomWallpaperUrl(value?.url), ...(fallbackUrl ? { fallbackUrl } : {}), ...(pluginSource ? { pluginSource } : {}) };
  },
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

/** Both custom media and optional official downloads own references in this scope. */
export function readReferencedClientWallpaperUrls(): string[] {
  // Display reads may fall back to defaults; recycling must never interpret a
  // corrupt/unreadable preference as permission to delete the user's video.
  let customUrl = '';
  let fallbackUrl = '';
  let exists = true;
  try {
    fs.lstatSync(filePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) {
    const bytes = readBoundedFileNoFollowSync(filePath(), 4096);
    if (!bytes) throw new Error('Cannot read client wallpaper references');
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid client wallpaper references');
    const url = (raw as { url?: unknown }).url;
    customUrl = normalizeCustomWallpaperUrl(url);
    if (url !== undefined && url !== '' && !customUrl)
      throw new Error('Invalid client wallpaper reference');
    const fallback = (raw as { fallbackUrl?: unknown }).fallbackUrl;
    fallbackUrl = normalizeCustomWallpaperUrl(fallback);
    if (fallback !== undefined && fallback !== '' && !fallbackUrl) throw new Error('Invalid client wallpaper fallback');
  }
  return [
    customUrl,
    fallbackUrl,
    ...appearanceWallpaperReferences(),
    ...Object.values(manifest)
      .filter((item) => item.delivery === 'cdn')
      .flatMap((item) => [
        ...('sha256' in item ? [blobUrl(item.sha256, '.mp4', 'client-wallpaper')] : []),
        ...(item.image ? [blobUrl(item.image.sha256, '.webp', 'client-wallpaper')] : []),
      ]),
  ].filter(Boolean);
}
