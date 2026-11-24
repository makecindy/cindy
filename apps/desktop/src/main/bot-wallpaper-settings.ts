import { app } from 'electron';
import path from 'node:path';

import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import { normalizeBotWallpaperMap, type BotWallpaperMap } from '../shared/botWallpapers.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';

/**
 * 伙伴自定义壁纸：每位伙伴一张本机图片或视频。媒体文件与全局自定义壁纸同在
 * client-wallpaper 媒体库，回收由同一把锁和引用表决定，所以引用只能记在主进程。
 */
const filePath = () => path.join(app.getPath('userData'), 'bot-wallpapers.json');

export const botWallpaperStore = createOverrideSettingsFile<{ wallpapers: BotWallpaperMap }>({
  filePath,
  defaults: () => ({ wallpapers: {} }),
  normalize: (raw) => ({ wallpapers: normalizeBotWallpaperMap((raw as { wallpapers?: unknown } | null)?.wallpapers) }),
  log: createLogger('bot-wallpaper-settings'),
  label: 'bot-wallpapers',
  maxBytes: 256 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readBotWallpapers(): BotWallpaperMap {
  botWallpaperStore.invalidateIfChanged();
  return botWallpaperStore.read().wallpapers;
}

/**
 * 回收用：readStrict 在文件读不了时抛错，让本轮清理延后，绝不把读不了当成「没有引用」删掉用户的图。
 */
export function readReferencedBotWallpaperUrls(): string[] {
  return Object.values(botWallpaperStore.readStrict().wallpapers)
    .map((url) => normalizeCustomWallpaperUrl(url))
    .filter(Boolean);
}
