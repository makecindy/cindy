import { dialog, type BrowserWindow } from 'electron';
import sharp from 'sharp';

import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { ingestClientWallpaper } from './cindy-media/ingest.js';
import { recycleClientWallpapers } from './cindy-media/recycler.js';
import { withClientWallpaperLock } from './cindy-media/clientWallpaperLock.js';
import { customWallpaperStore, readCustomWallpaperUrl } from './custom-wallpaper-settings.js';
import { createLogger } from './logger.js';

const log = createLogger('custom-wallpaper');
const MAX_BYTES = 20 * 1024 * 1024;

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
    filters: [{ name: 'PNG / JPEG / WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return false;
  let bytes: Buffer;
  try {
    const read = await readBoundedFileNoFollow(selected.filePaths[0], MAX_BYTES, {
      nonBlocking: true,
    });
    if (!read) throw new Error('Unreadable image');
    bytes = read;
  } catch {
    throwIpcError('INVALID_PARAMS', 'Cannot read image; choose a local image up to 20 MB');
  }
  const buffer = await prepareWallpaperImage(bytes);
  return withClientWallpaperLock(async () => {
    const media = await ingestClientWallpaper({ buffer, mimeType: 'image/webp' });
    await customWallpaperStore.writePatchAtomic({ url: media.url });
    // Recycle only after successful publication. Unreadable settings or a failed
    // write must not delete the previous image; a later successful operation also
    // collects bytes left by interrupted/failed imports.
    await recycleUnusedImages();
    return true;
  });
}

export async function removeCustomWallpaper(): Promise<void> {
  return withClientWallpaperLock(async () => {
    await customWallpaperStore.resetAtomic();
    await recycleUnusedImages();
  });
}

async function recycleUnusedImages(): Promise<void> {
  try {
    await recycleClientWallpapers([readCustomWallpaperUrl()], '.webp');
  } catch {
    log.warn('Unused client wallpaper cleanup deferred');
  }
}
