import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import manifest from '../shared/wallpaper-video-manifest.json';
import type { WallpaperDownloadProgress } from '../shared/appearanceSettings.js';
import { ingestClientWallpaper } from './cindy-media/ingest.js';
import { resolveHashRef, blobUrl } from './cindy-media/blobStore.js';
import { withClientWallpaperLock } from './cindy-media/clientWallpaperLock.js';
import { recycleClientWallpapers } from './cindy-media/recycler.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { getClientEndpoint } from './clientEndpointsService.js';
import { guardedOutboundFetch } from './maker-host/outbound-fetch.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { readReferencedClientWallpaperUrls } from './custom-wallpaper-settings.js';
import { createDownloader } from './downloader/index.js';
import { createLogger } from './logger.js';

type OfficialWallpaper = keyof typeof manifest;
type Asset = { sha256: string; bytes: number };
type ProgressBytes = Pick<WallpaperDownloadProgress, 'loaded' | 'total'>;
type Transfer = {
  promise: Promise<string | null>;
  progress: ProgressBytes;
  listeners: Set<(progress: ProgressBytes) => void>;
};
type ProgressListener = (progress: WallpaperDownloadProgress) => void;
const pending = new Map<string, Transfer>();
const download = createDownloader();
const log = createLogger('wallpaper-assets');

function isOfficialWallpaper(id: unknown): id is OfficialWallpaper {
  return typeof id === 'string' && Object.hasOwn(manifest, id);
}

export function matchesWallpaperVideo(bytes: Buffer, asset: Asset): boolean {
  return (
    bytes.length === asset.bytes &&
    createHash('sha256').update(bytes).digest('hex') === asset.sha256
  );
}

/** The cache key is the content hash, never the app version or account. Upgrades reuse it offline. */
async function ensureWallpaperAsset(
  id: unknown,
  kind: 'image' | 'video',
  onProgress?: ProgressListener,
): Promise<string | null> {
  if (!isOfficialWallpaper(id)) throwIpcError('INVALID_PARAMS', 'Unsupported wallpaper');
  const entry = manifest[id];
  if (entry.delivery !== 'cdn') return null;
  const asset = kind === 'image' ? entry.image : 'sha256' in entry ? entry : null;
  if (!asset) return null;
  const ext = kind === 'image' ? '.webp' : '.mp4';
  const key = asset.sha256 + ext;
  let transfer = pending.get(key);
  if (!transfer) {
    const progress: ProgressBytes = { loaded: 0, total: asset.bytes };
    const listeners = new Set<(progress: ProgressBytes) => void>();
    const report = (loaded: number) => {
      progress.loaded = Number.isFinite(loaded) ? Math.max(0, Math.min(loaded, asset.bytes)) : 0;
      for (const listener of listeners) listener({ ...progress });
    };
    const operation = (async () => {
      let temporaryDirectory: string | undefined;
      try {
        const url = blobUrl(asset.sha256, ext, 'client-wallpaper');
        const cachedPath = resolveHashRef(asset.sha256, ext, 'client-wallpaper').absPath;
        const cached = await readBoundedFileNoFollow(cachedPath, asset.bytes).catch(() => null);
        // Check durable media before even resolving the CDN: offline upgrades need no network config.
        if (cached && matchesWallpaperVideo(cached, asset)) {
          report(asset.bytes);
          return url;
        }

        const base = getClientEndpoint('cdnBaseUrl');
        if (!base) throw new Error('Wallpaper CDN unavailable');
        const source = new URL(base.replace(/\/+$/, '') + '/wallpapers/' + key);
        if (source.protocol !== 'https:' || source.username || source.password)
          throw new Error('Invalid wallpaper CDN');
        temporaryDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'cindy-wallpaper-'));
        const targetPath = path.join(temporaryDirectory, key);
        await download({
          url: source.href,
          targetPath,
          sha256: asset.sha256,
          expectedSize: asset.bytes,
          maxBytes: asset.bytes,
          redirect: 'error',
          isUrlAllowed: (candidate) => candidate === source.href,
          request: (url, init) =>
            guardedOutboundFetch(url, { ...init, credentials: 'omit' }, () => {}),
          resume: false,
          retry: { maxAttempts: 3 },
          timeout: { totalMs: 120_000 },
          logger: log,
          onProgress: ({ loaded }) => report(loaded),
          // These small files restart from zero after a failed attempt; report that truthfully.
          onRetry: () => report(0),
        });
        const bytes = await readBoundedFileNoFollow(targetPath, asset.bytes);
        if (!bytes || !matchesWallpaperVideo(bytes, asset))
          throw new Error('Invalid wallpaper download');
        const published = await withClientWallpaperLock(async () => {
          const media = await ingestClientWallpaper({
            buffer: bytes,
            mimeType: kind === 'image' ? 'image/webp' : 'video/mp4',
          });
          await recycleClientWallpapers(readReferencedClientWallpaperUrls(), ext).catch(
            () => undefined,
          );
          return media.url;
        });
        report(asset.bytes);
        return published;
      } catch {
        log.warn('Wallpaper unavailable; keeping the preview');
        return null;
      } finally {
        if (temporaryDirectory)
          await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    })().finally(() => pending.delete(key));
    transfer = { promise: operation, progress, listeners };
    pending.set(key, transfer);
  }
  const notify = (progress: ProgressBytes) => {
    try {
      onProgress?.({ wallpaperId: id, kind, ...progress });
    } catch {
      // A closing requester must not interrupt the shared transfer or other windows.
    }
  };
  if (onProgress) {
    transfer.listeners.add(notify);
    notify({ ...transfer.progress });
  }
  try {
    return await transfer.promise;
  } finally {
    transfer.listeners.delete(notify);
  }
}

export const ensureWallpaperVideo = (
  id: unknown,
  onProgress?: ProgressListener,
): Promise<string | null> => ensureWallpaperAsset(id, 'video', onProgress);
export const ensureWallpaperImage = (
  id: unknown,
  onProgress?: ProgressListener,
): Promise<string | null> => ensureWallpaperAsset(id, 'image', onProgress);

export const __testing = { reset: () => pending.clear() };
