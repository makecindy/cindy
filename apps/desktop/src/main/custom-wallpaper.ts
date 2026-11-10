import { dialog, type BrowserWindow } from 'electron';
import { prepareWallpaperImage } from './wallpaper-image.js';

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

const log = createLogger('custom-wallpaper');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export { prepareWallpaperImage } from './wallpaper-image.js';

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
  return withClientWallpaperLock(async () => {
    const media = await ingestClientWallpaper({
      buffer,
      mimeType: isVideo ? 'video/mp4' : 'image/webp',
    });
    try {
      await customWallpaperStore.writePatchAtomic({ url: media.url });
    } catch (error) {
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
