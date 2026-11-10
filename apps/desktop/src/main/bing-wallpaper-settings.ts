import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeBingWallpaperImage,
  type BingWallpaperImage,
  type BingWallpaperSnapshot,
  type BingWallpaperStatus,
} from '../shared/bingWallpaper.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';
import { createLogger } from './logger.js';

/** Reference metadata only; image bytes remain in the existing client-wallpaper scope. */
export interface BingWallpaperCache {
  current: BingWallpaperImage | null;
  previous: BingWallpaperImage | null;
  checkedAt: number;
  nextCheckAt: number;
}

const MAX_CACHE_BYTES = 16 * 1024;
const defaults: BingWallpaperCache = {
  current: null,
  previous: null,
  checkedAt: 0,
  nextCheckAt: 0,
};
const filePath = () => path.join(app.getPath('userData'), 'bing-wallpaper.json');

function parseCache(raw: unknown): BingWallpaperCache {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Bing cache');
  const value = raw as Record<string, unknown>;
  const image = (key: string) => {
    if (value[key] === undefined || value[key] === null) return null;
    const parsed = normalizeBingWallpaperImage(value[key]);
    if (!parsed) throw new Error('Invalid Bing wallpaper reference');
    return parsed;
  };
  const timestamp = (key: string) => {
    const v = value[key] ?? 0;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      throw new Error('Invalid Bing cache timestamp');
    return v;
  };
  return {
    current: image('current'),
    previous: image('previous'),
    checkedAt: timestamp('checkedAt'),
    nextCheckAt: timestamp('nextCheckAt'),
  };
}

export const bingWallpaperStore = createOverrideSettingsFile<BingWallpaperCache>({
  filePath,
  defaults,
  normalize: parseCache,
  maxBytes: MAX_CACHE_BYTES,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  label: 'bing-wallpaper',
  log: createLogger('bing-wallpaper-settings'),
});

let status: BingWallpaperStatus = 'idle';
export function setBingWallpaperStatus(next: BingWallpaperStatus): void {
  status = next;
}

export function readBingWallpaperCache(): BingWallpaperCache {
  bingWallpaperStore.invalidateIfChanged();
  return bingWallpaperStore.read();
}

export function readBingWallpaperSnapshot(): BingWallpaperSnapshot {
  return { image: status === 'failed' ? null : readBingWallpaperCache().current, status };
}

/** Re-read durable references under the shared publication lock. Corruption forbids deletion. */
export function readReferencedBingWallpaperUrls(): string[] {
  try {
    fs.lstatSync(filePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const bytes = readBoundedFileNoFollowSync(filePath(), MAX_CACHE_BYTES);
  if (!bytes) throw new Error('Cannot read Bing wallpaper references');
  const cache = parseCache(JSON.parse(bytes.toString('utf8')));
  return [cache.current?.url, cache.previous?.url].filter((url): url is string => Boolean(url));
}
