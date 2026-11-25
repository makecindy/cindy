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
import { readBoundedFileNoFollow, readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';

/**
 * 伙伴自定义壁纸：每位伙伴一张本机图片或视频。媒体文件与全局自定义壁纸同在
 * client-wallpaper 媒体库，回收由同一把锁和引用表决定，所以引用只能记在主进程。
 */
const MAX_BYTES = 256 * 1024;
const filePath = () => path.join(app.getPath('userData'), 'bot-wallpapers.json');

const botWallpaperStore = createOverrideSettingsFile<{ wallpapers: BotWallpaperMap }>({
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

/**
 * What IPC handlers and broadcasts serve: an in-memory copy, loaded once without blocking
 * main and replaced after every write. Keyed by file so a different userData never reuses it.
 */
let snapshot: { file: string; wallpapers: BotWallpaperMap } | undefined;
let loading: { file: string; done: Promise<BotWallpaperMap> } | undefined;

async function loadFromDisk(file: string): Promise<BotWallpaperMap> {
  let wallpapers: BotWallpaperMap = {};
  try {
    const bytes = await readBoundedFileNoFollow(file, MAX_BYTES);
    if (bytes) wallpapers = normalizeBotWallpaperMap((JSON.parse(bytes.toString('utf8')) as { wallpapers?: unknown } | null)?.wallpapers);
  } catch {
    // Missing or unreadable: nothing to show. Recycling reads strictly on its own.
  }
  // A write that finished meanwhile is newer than this read.
  if (snapshot?.file !== file) snapshot = { file, wallpapers };
  return snapshot.wallpapers;
}

export function loadBotWallpapers(): Promise<BotWallpaperMap> {
  const file = filePath();
  if (snapshot?.file === file) return Promise.resolve(snapshot.wallpapers);
  if (loading?.file !== file) {
    const done = loadFromDisk(file).finally(() => {
      if (loading?.done === done) loading = undefined;
    });
    loading = { file, done };
  }
  return loading.done;
}

/** The only write path: updates the file under its lock, then the in-memory copy. */
export async function updateBotWallpapers(
  updater: (current: BotWallpaperMap) => BotWallpaperMap | null,
): Promise<void> {
  const file = filePath();
  const value = await botWallpaperStore.updateAtomic(({ value: current }) => {
    const next = updater(current.wallpapers);
    return next ? { wallpapers: next } : null;
  });
  snapshot = { file, wallpapers: value.wallpapers };
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

/**
 * Tell every app-content window the teammate wallpaper map changed; returns the map sent.
 * Font-only utility windows are appearance readers too, but never receive custom media URLs.
 */
export function broadcastBotWallpapers(): BotWallpaperMap {
  const wallpapers = snapshot?.file === filePath() ? snapshot.wallpapers : {};
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(win)) continue;
    try {
      win.webContents.send(BOT_WALLPAPERS_CHANGED_CHANNEL, wallpapers);
    } catch {
      // A window may be torn down between enumeration and send.
    }
  }
  return wallpapers;
}
