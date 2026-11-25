import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import {
  BOT_WALLPAPERS_CHANGED_CHANNEL,
  isBotWallpaperKey,
  normalizeBotWallpaperMap,
  type BotWallpaperMap,
} from '../shared/botWallpapers.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { isTrustedAppearanceSettingsReadWindow } from './appearance-settings-reader.js';

/**
 * 伙伴自定义壁纸：每位伙伴一张本机图片或视频。媒体文件与全局自定义壁纸同在
 * client-wallpaper 媒体库，回收由同一把锁和引用表决定，所以引用只能记在主进程。
 */
const MAX_BYTES = 256 * 1024;
const filePath = () => path.join(app.getPath('userData'), 'bot-wallpapers.json');

export const botWallpaperStore = createOverrideSettingsFile<{ wallpapers: BotWallpaperMap }>({
  filePath,
  defaults: () => ({ wallpapers: {} }),
  normalize: (raw) => ({ wallpapers: normalizeBotWallpaperMap((raw as { wallpapers?: unknown } | null)?.wallpapers) }),
  log: createLogger('bot-wallpaper-settings'),
  label: 'bot-wallpapers',
  maxBytes: MAX_BYTES,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readBotWallpapers(): BotWallpaperMap {
  botWallpaperStore.invalidateIfChanged();
  return botWallpaperStore.read().wallpapers;
}

/**
 * 回收用：只有「文件不存在」算没有引用。文件读不了、不是对象、`wallpapers` 不是对象，或任何
 * 一项不是合法的伙伴 ID + 媒体 URL，都抛错让本轮清理延后，绝不因为内容不对就把伙伴的图当成
 * 没人用而永久删掉。
 */
export function readReferencedBotWallpaperUrls(): string[] {
  try {
    fs.lstatSync(filePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const bytes = readBoundedFileNoFollowSync(filePath(), MAX_BYTES);
  if (!bytes) throw new Error('Cannot read teammate wallpaper references');
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid teammate wallpaper references');
  const wallpapers = (raw as { wallpapers?: unknown }).wallpapers;
  if (wallpapers === undefined) return [];
  if (!wallpapers || typeof wallpapers !== 'object' || Array.isArray(wallpapers))
    throw new Error('Invalid teammate wallpaper references');
  return Object.entries(wallpapers as Record<string, unknown>).map(([botId, url]) => {
    const valid = normalizeCustomWallpaperUrl(url);
    if (!isBotWallpaperKey(botId) || !valid) throw new Error('Invalid teammate wallpaper reference');
    return valid;
  });
}

/** Tell every app window the teammate wallpaper map changed; returns the map sent. */
export function broadcastBotWallpapers(): BotWallpaperMap {
  const wallpapers = readBotWallpapers();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppearanceSettingsReadWindow(win)) continue;
    try {
      win.webContents.send(BOT_WALLPAPERS_CHANGED_CHANNEL, wallpapers);
    } catch {
      // A window may be torn down between enumeration and send.
    }
  }
  return wallpapers;
}
