import { createHash } from 'node:crypto';
import { getBackgroundVisibility } from '../shared/appearanceSettings.js';
import { readAppearanceSettings } from './appearance-settings-store.js';
import { getResolvedMainLocale } from './i18n.desktop.js';
import { bingWallpaperMarket, fetchBingImage, fetchBingMetadata } from './bing-wallpaper-source.js';
import { createBingWallpaperService } from './bing-wallpaper-service.js';
import {
  bingWallpaperStore,
  readBingWallpaperCache,
  setBingWallpaperStatus,
} from './bing-wallpaper-settings.js';
import { withClientWallpaperLock } from './cindy-media/clientWallpaperLock.js';
import { ingestClientWallpaper } from './cindy-media/ingest.js';
import { parseClientWallpaperUrl, resolveHashRef } from './cindy-media/blobStore.desktop.js';
import { recycleClientWallpapers } from './cindy-media/recycler.js';
import { readReferencedClientWallpaperUrls } from './custom-wallpaper-settings.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { createLogger } from './logger.js';

const log = createLogger('bing-wallpaper');
let service: ReturnType<typeof createBingWallpaperService> | undefined;

/** Explicit startup after app ready. No timers, requests or filesystem writes on import. */
export function startBingWallpaperService(onChanged: () => void): void {
  if (service) return;
  service = createBingWallpaperService({
    activeMarket: () => {
      const settings = readAppearanceSettings();
      const visible =
        getBackgroundVisibility(settings, false) > 0 || getBackgroundVisibility(settings, true) > 0;
      return settings.wallpaperId === 'bing-daily' && visible
        ? bingWallpaperMarket(getResolvedMainLocale())
        : null;
    },
    readCache: readBingWallpaperCache,
    validate: async (image) => {
      const parsed = parseClientWallpaperUrl(image.url);
      if (!parsed) return false;
      const bytes = await readBoundedFileNoFollow(
        resolveHashRef(parsed.hash, '.webp', 'client-wallpaper').absPath,
        20 * 1024 * 1024,
      ).catch(() => null);
      return !!bytes && createHash('sha256').update(bytes).digest('hex') === parsed.hash;
    },
    metadata: fetchBingMetadata,
    image: fetchBingImage,
    publish: (metadata, bytes, checkedAt, nextCheckAt, isCurrent, expectedCache) =>
      withClientWallpaperLock(async () => {
        if (!isCurrent()) return;
        const existing = readBingWallpaperCache();
        // Wall time can move backwards. Detect a competing write by comparing
        // the cache observed before fetching, not by ordering wall-clock values.
        if (
          existing.checkedAt !== expectedCache.checkedAt ||
          existing.nextCheckAt !== expectedCache.nextCheckAt ||
          existing.current?.url !== expectedCache.current?.url ||
          existing.current?.imageKey !== expectedCache.current?.imageKey ||
          existing.previous?.url !== expectedCache.previous?.url
        ) throw new Error('Bing wallpaper cache changed during refresh');
        if (!bytes && existing.current?.imageKey !== metadata.imageKey)
          throw new Error('Bing wallpaper changed during refresh');
        const media = bytes
          ? await ingestClientWallpaper({ buffer: bytes, mimeType: 'image/webp' })
          : null;
        const url = media?.url ?? existing.current?.url;
        if (!url) throw new Error('No Bing wallpaper');
        const { imageUrl: _remote, ...info } = metadata;
        void _remote;
        const image = { ...info, url };
        try {
          await bingWallpaperStore.updateAtomic(() => {
            if (!isCurrent()) throw new Error('Bing wallpaper update cancelled');
            return {
              current: image,
              previous: existing.current?.url !== url ? existing.current : existing.previous,
              checkedAt,
              nextCheckAt,
            };
          });
        } finally {
          // Includes custom and official references. An unreadable reference forbids all cleanup.
          try {
            await recycleClientWallpapers(readReferencedClientWallpaperUrls(), '.webp');
          } catch {
            log.warn('Client wallpaper cleanup deferred');
          }
        }
        onChanged();
      }),
    status: (status) => {
      setBingWallpaperStatus(status);
      onChanged();
    },
  });
  service.reconcile();
}

export function reconcileBingWallpaper(): void {
  service?.reconcile();
}
export async function refreshBingWallpaper(): Promise<void> {
  await service?.refresh();
}
export function stopBingWallpaperService(): void {
  service?.dispose();
  service = undefined;
  setBingWallpaperStatus('idle');
}
