import { dialog, type BrowserWindow } from 'electron';
import sharp from 'sharp';
import { MAX_WALLPAPER_IMAGE_BYTES as MAX_BYTES } from '../shared/appearanceSettings.js';

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
import { readAppearanceSettings, writeAppearanceSettingsPatch } from './appearance-settings-store.js';

const log = createLogger('custom-wallpaper');
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
  const isVideo = sniffMediaMime(bytes) === 'video/mp4';
  const buffer = isVideo ? bytes : await prepareWallpaperImage(bytes);
  return saveWallpaper(buffer, isVideo ? 'video/mp4' : 'image/webp');
}

/** Plugin bytes follow the native decoder/storage path; authorization is rechecked at commit. */
export async function setCustomWallpaperImage(
  bytes: Buffer,
  assertCurrent: () => void,
): Promise<void> {
  const buffer = await prepareWallpaperImage(bytes);
  await saveWallpaper(buffer, 'image/webp', assertCurrent);
}

async function saveWallpaper(
  buffer: Buffer,
  mimeType: 'image/webp' | 'video/mp4',
  assertCurrent?: () => void,
): Promise<boolean> {
  return withClientWallpaperLock(async () => {
    assertCurrent?.();
    const previous = assertCurrent ? readAppearanceSettings() : undefined;
    const media = await ingestClientWallpaper({ buffer, mimeType });
    try {
      assertCurrent?.();
      await customWallpaperStore.writePatchAtomic({ url: media.url });
      assertCurrent?.();
      if (previous && previous.wallpaperId !== 'custom') {
        assertCurrent?.();
        await writeAppearanceSettingsPatch({ wallpaperId: 'custom' });
        assertCurrent?.();
      }
    } catch (error) {
      // The previous blob has not been recycled yet. Restore its reference on
      // failed plugin activation (including revocation while waiting for IO).
      if (previous) {
        try {
          await customWallpaperStore.writePatchAtomic({ url: previous.customWallpaperUrl ?? '' });
          if (previous.wallpaperId !== 'custom' && readAppearanceSettings().wallpaperId === 'custom')
            await writeAppearanceSettingsPatch({ wallpaperId: previous.wallpaperId });
        } catch {
          // Keep both blobs if compensation fails; do not risk deleting the old image.
          throw error;
        }
      }
      // A reported failure may follow publication: re-read durable references.
      // Unreadable references defer cleanup rather than risking the current media.
      await recycleUnusedWallpapers();
      throw error;
    }
    await recycleUnusedWallpapers();
    return true;
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
