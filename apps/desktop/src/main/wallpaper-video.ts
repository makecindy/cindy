import { createHash } from 'node:crypto';
import manifest from '../shared/wallpaper-video-manifest.json';
import { ingestClientWallpaper } from './cindy-media/ingest.js';
import { resolveHashRef, blobUrl } from './cindy-media/blobStore.js';
import { withClientWallpaperLock } from './cindy-media/clientWallpaperLock.js';
import { recycleClientWallpapers } from './cindy-media/recycler.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { getClientEndpoint } from './clientEndpointsService.js';
import { guardedOutboundFetch } from './maker-host/outbound-fetch.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { readReferencedClientWallpaperUrls } from './custom-wallpaper-settings.js';

type Scene = keyof typeof manifest;
type Asset = { sha256: string; bytes: number };
const RETRY_MS = 5 * 60_000;
const states = new Map<Scene, { pending?: Promise<string | null>; retryAt: number }>();

export function isWallpaperVideoScene(id: unknown): id is Scene {
  return typeof id === 'string' && Object.hasOwn(manifest, id);
}

export function matchesWallpaperVideo(bytes: Buffer, asset: Asset): boolean {
  return (
    bytes.length === asset.bytes &&
    createHash('sha256').update(bytes).digest('hex') === asset.sha256
  );
}

async function download(asset: Asset): Promise<Buffer> {
  const base = getClientEndpoint('cdnBaseUrl');
  if (!base) throw new Error('Wallpaper CDN unavailable');
  const url = new URL(base.replace(/\/+$/, '') + '/wallpapers/' + asset.sha256 + '.mp4');
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Invalid wallpaper CDN');
  const { response, release } = await guardedOutboundFetch(
    url.href,
    {
      signal: AbortSignal.timeout(30_000),
      credentials: 'omit',
      redirect: 'error',
    },
    () => {},
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!response.ok || !response.body) throw new Error('Wallpaper CDN unavailable');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== asset.bytes)
      throw new Error('Wallpaper size mismatch');
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.bytes) throw new Error('Wallpaper exceeds expected size');
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (!matchesWallpaperVideo(bytes, asset)) throw new Error('Wallpaper integrity mismatch');
    return bytes;
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    else await response.body?.cancel().catch(() => undefined);
    await release();
  }
}

/** Optional CDN assets share the client's lifecycle, including before login. */
export async function ensureWallpaperVideo(id: unknown): Promise<string | null> {
  if (!isWallpaperVideoScene(id)) throwIpcError('INVALID_PARAMS', 'Unsupported wallpaper video');
  if (manifest[id].delivery !== 'cdn') return null;
  const previous = states.get(id);
  if (previous?.pending) return previous.pending;
  if (previous && previous.retryAt > Date.now()) return null;
  const entry = { retryAt: 0, pending: undefined as Promise<string | null> | undefined };
  states.set(id, entry);
  entry.pending = (async () => {
    try {
      const asset = manifest[id];
      const url = blobUrl(asset.sha256, '.mp4', 'client-wallpaper');
      const cachedPath = resolveHashRef(asset.sha256, '.mp4', 'client-wallpaper').absPath;
      const cached = await readBoundedFileNoFollow(cachedPath, asset.bytes).catch(() => null);
      if (cached && matchesWallpaperVideo(cached, asset)) return url;
      const bytes = await download(asset);
      return await withClientWallpaperLock(async () => {
        const media = await ingestClientWallpaper({ buffer: bytes, mimeType: 'video/mp4' });
        await recycleClientWallpapers(readReferencedClientWallpaperUrls(), '.mp4').catch(
          () => undefined,
        );
        return media.url;
      });
    } catch {
      entry.retryAt = Date.now() + RETRY_MS;
      return null;
    }
  })().finally(() => {
    entry.pending = undefined;
  });
  return entry.pending;
}

export const __testing = { reset: () => states.clear() };
