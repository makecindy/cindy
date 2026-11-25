import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import {
  BOT_WALLPAPERS_CHANGED_CHANNEL,
  MAX_BOT_WALLPAPERS,
  isBotWallpaperKey,
  type BotWallpaperMap,
} from '../shared/botWallpapers.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { withCrossProcessLock } from './device-link/crossProcessLock.js';
import { isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';

/**
 * 伙伴自定义壁纸：每位伙伴一张本机图片或视频。媒体文件与全局自定义壁纸同在
 * client-wallpaper 媒体库，回收由同一把锁和引用表决定，所以引用只能记在主进程。
 *
 * 所有读写都是异步的（IPC 路径不做同步 I/O），而且只有一种读法：严格读取。只有「文件不存在」
 * 算空表；读不了、不是对象、`wallpapers` 不是对象，或任何一项不是合法的伙伴 ID + 媒体 URL
 * 都抛错。显示时读取失败按「没有伙伴壁纸」处理但不缓存；写入和回收遇到失败则放弃本次操作，
 * 绝不因为内容不对就把表当成空的覆盖掉，或把伙伴的图当成没人用而删掉。
 */
const MAX_BYTES = 256 * 1024;
const filePath = () => path.join(app.getPath('userData'), 'bot-wallpapers.json');

async function readStrict(file: string): Promise<BotWallpaperMap> {
  let bytes: Buffer | null;
  try {
    bytes = await readBoundedFileNoFollow(file, MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!bytes) throw new Error('Cannot read teammate wallpaper references');
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid teammate wallpaper references');
  const wallpapers = (raw as { wallpapers?: unknown }).wallpapers;
  if (wallpapers === undefined) return {};
  if (!wallpapers || typeof wallpapers !== 'object' || Array.isArray(wallpapers))
    throw new Error('Invalid teammate wallpaper references');
  const entries = Object.entries(wallpapers as Record<string, unknown>).map(([botId, url]): [string, string] => {
    const valid = normalizeCustomWallpaperUrl(url);
    if (!isBotWallpaperKey(botId) || !valid) throw new Error('Invalid teammate wallpaper reference');
    return [botId, valid];
  });
  if (entries.length > MAX_BOT_WALLPAPERS) throw new Error('Too many teammate wallpapers');
  // fromEntries defines own properties, so an ID such as "__proto__" stays plain data.
  return Object.fromEntries(entries);
}

/**
 * What IPC handlers and broadcasts serve: an in-memory copy of the last successful read or
 * write. Keyed by file so a different userData never reuses it.
 */
let snapshot: { file: string; wallpapers: BotWallpaperMap } | undefined;
let loading: { file: string; done: Promise<BotWallpaperMap> } | undefined;

async function loadFromDisk(file: string): Promise<BotWallpaperMap> {
  let wallpapers: BotWallpaperMap;
  try {
    wallpapers = await readStrict(file);
  } catch {
    // Not cached: a failed read is not knowledge, so the next subscription reads again.
    return {};
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

/**
 * The only write path. Under the file's cross-process lock: read the table strictly, apply
 * the change, replace the file atomically, then update the in-memory copy. A table that
 * cannot be read reliably is left as is and the write fails.
 */
export async function updateBotWallpapers(
  updater: (current: BotWallpaperMap) => BotWallpaperMap | null,
): Promise<void> {
  const file = filePath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await withCrossProcessLock(`${file}.lock`, { label: 'bot-wallpapers-settings', waitMs: 12_000 }, async (status) => {
    if (!status.held) throw new Error('Teammate wallpaper references are busy in another process');
    const current = await readStrict(file);
    const next = updater(current);
    if (!next) {
      snapshot = { file, wallpapers: current };
      return;
    }
    if (Object.keys(next).length > MAX_BOT_WALLPAPERS) throw new Error('Too many teammate wallpapers');
    const serialized = JSON.stringify({ wallpapers: next }, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('Teammate wallpaper references are too large');
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, serialized, 'utf8');
    await fs.promises.rename(tmp, file);
    snapshot = { file, wallpapers: Object.freeze({ ...next }) };
  });
}

/** For recycling: every media URL a teammate references. Rejects when the table is not reliable. */
export async function readReferencedBotWallpaperUrls(): Promise<string[]> {
  return Object.values(await readStrict(filePath()));
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
