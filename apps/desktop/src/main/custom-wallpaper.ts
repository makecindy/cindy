import { dialog, type BrowserWindow } from 'electron';
import sharp from 'sharp';

import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { ingestClientWallpaper } from './cindy-media/ingest.js';
import { recycleClientWallpapers } from './cindy-media/recycler.js';
import { withClientWallpaperLock } from './cindy-media/clientWallpaperLock.js';
import {
  customWallpaperStore,
  readReferencedClientWallpaperUrls,
} from './custom-wallpaper-settings.js';
import { sniffMediaMime } from './cindy-media/sniffMediaMime.js';
import { createLogger } from './logger.js';
import type { PluginAppearanceSource } from '../shared/pluginAppearance.js';

const log = createLogger('custom-wallpaper');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Decode real raster bytes, apply orientation, strip metadata and retain a static 4K preview. */
export async function prepareWallpaperImage(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_BYTES)
    throwIpcError('INVALID_PARAMS', 'Choose a PNG, JPEG or WebP image up to 20 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? ''))
      throw new Error('Unsupported image');
    return await image
      .rotate()
      .resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    throwIpcError('INVALID_PARAMS', 'Choose a valid PNG, JPEG or WebP image up to 40 megapixels');
  }
}

/** Paths come only from this native picker, never from the renderer or remote peers. */
export async function importCustomWallpaper(parent: BrowserWindow): Promise<boolean> {
  const selected = await dialog.showOpenDialog(parent, {
    properties: ['openFile'],
    filters: [
      { name: 'PNG / JPEG / WebP / MP4', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4'] },
    ],
  });
  if (selected.canceled || !selected.filePaths[0]) return false;
  let bytes: Buffer;
  try {
    const read = await readBoundedFileNoFollow(selected.filePaths[0], MAX_VIDEO_BYTES, {
      nonBlocking: true,
      // Reject known oversized images before allocating their full contents.
      // Unknown prefixes retain the outer limit (e.g. a large ftyp box);
      // full-byte sniffing and image decoding still validate them below.
      maxBytesForPrefix: (prefix) =>
        sniffMediaMime(prefix)?.startsWith('image/') ? MAX_BYTES : MAX_VIDEO_BYTES,
    });
    if (!read) throw new Error('Unreadable wallpaper');
    bytes = read;
  } catch {
    throwIpcError('INVALID_PARAMS', 'Choose a local image up to 20 MB or MP4 video up to 100 MB');
  }
  await setCustomWallpaperBytes(bytes);
  return true;
}

/** Bytes only: the caller already resolved a native selection or an owned resource. */
export async function setCustomWallpaperBytes(bytes: Buffer, options: {
  fallback?: Buffer; pluginSource?: PluginAppearanceSource; assertCurrent?: () => void;
} = {}): Promise<{ url: string; fallbackUrl?: string }> {
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) throwIpcError('INVALID_PARAMS', 'Wallpaper exceeds size limit');
  options.assertCurrent?.();
  const isVideo = sniffMediaMime(bytes) === 'video/mp4';
  const buffer = isVideo ? bytes : await prepareWallpaperImage(bytes);
  const fallback = options.fallback ? await prepareWallpaperImage(options.fallback) : undefined;
  return withClientWallpaperLock(async () => {
    options.assertCurrent?.();
    const media = await ingestClientWallpaper({
      buffer,
      mimeType: isVideo ? 'video/mp4' : 'image/webp',
    });
    const still = fallback ? await ingestClientWallpaper({ buffer: fallback, mimeType: 'image/webp' }) : undefined;
    try {
      const patch = { url: media.url, fallbackUrl: still?.url, pluginSource: options.pluginSource };
      if (options.assertCurrent) {
        await customWallpaperStore.updateAtomic(() => { options.assertCurrent!(); return patch; });
      } else await customWallpaperStore.writePatchAtomic(patch);
    } catch (error) {
      // A reported failure may follow publication: re-read durable references.
      // Unreadable references defer cleanup rather than risking the current media.
      await recycleUnusedWallpapers();
      throw error;
    }
    await recycleUnusedWallpapers();
    return { url: media.url, ...(still ? { fallbackUrl: still.url } : {}) };
  });
}

/** Revocation never removes a wallpaper that has since been replaced by the user. */
export async function revokePluginWallpaper(isCurrent: (source: PluginAppearanceSource) => boolean): Promise<boolean> {
  const source = customWallpaperStore.read().pluginSource;
  if (!source || isCurrent(source)) return false;
  return withClientWallpaperLock(async () => {
    let removed = false;
    await customWallpaperStore.updateAtomic(current => {
      if (!current.value.pluginSource || isCurrent(current.value.pluginSource)) return {};
      removed = true;
      return { url: '', fallbackUrl: undefined, pluginSource: undefined };
    });
    if (removed) await recycleUnusedWallpapers();
    return removed;
  });
}

export async function removeCustomWallpaper(): Promise<void> {
  return withClientWallpaperLock(async () => {
    await customWallpaperStore.resetAtomic();
    await recycleUnusedWallpapers();
  });
}

async function recycleUnusedWallpapers(): Promise<void> {
  try {
    const keep = readReferencedClientWallpaperUrls();
    await recycleClientWallpapers(keep, '.webp');
    await recycleClientWallpapers(keep, '.mp4');
  } catch {
    log.warn('Unused client wallpaper cleanup deferred');
  }
}
