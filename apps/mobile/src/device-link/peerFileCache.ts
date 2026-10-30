import { Directory, File, Paths } from "expo-file-system";
import { sniffImageMimeFromBase64 } from "@/session/imageAnnotationModel";
import {
  CryptoDigestAlgorithm,
  digestStringAsync,
  randomUUID,
} from "expo-crypto";
import { FILE_INLINE_MAX_BYTES, validFileVersion, type DeviceFileResult } from "@cindy/device-link";
import { createRemoteMediaDiskCache } from "@/session/remoteMediaDiskCache";
import { createExpoRemoteMediaDiskCacheIO, downloadRemoteMediaShareTemp, withDownloadedRemoteMediaFile } from "@/session/remoteMediaDiskCacheExpo";
import {
  PEER_FILE_DISK_RESERVE_BYTES,
  recordPeerMedia,
  peerMediaUri,
  releasePeerMedia,
  type LocalPeerMedia,
} from "./peerFileRegistry";

type Metadata = Pick<DeviceFileResult, "size" | "mimeType" | "version">;
/** Reuses the existing disk cache. Stable realm/account identity survives restarts;
 * auth generations belong to the caller's cancellation guard, never the disk key. */
const caches = new Map<string, ReturnType<typeof openPeerFileCache>>();
export function createPeerFileCache(owner: string) {
  let cache = caches.get(owner);
  if (!cache) {
    cache = openPeerFileCache(owner);
    caches.set(owner, cache);
    void cache.catch(() => {
      if (caches.get(owner) === cache) caches.delete(owner);
    });
  }
  return cache;
}
async function openPeerFileCache(owner: string) {
  const namespace = `files-${await digestStringAsync(CryptoDigestAlgorithm.SHA256, owner)}`;
  const cache = createRemoteMediaDiskCache(
    createExpoRemoteMediaDiskCacheIO(namespace),
    {
      availableBytes: () => Paths.availableDiskSpace,
      reserveBytes: PEER_FILE_DISK_RESERVE_BYTES,
      persistAccess: true,
    },
  );
  const api = {
    // Blob and public companion avatar URLs change with the image content. Reuse
    // the account/realm's existing disk cache, independent of device presence.
    lookupAvatar: (identity: string) => cache.lookup(`companion-avatar:${identity}`),
    storeAvatar: async (identity: string, uri: string, mime: string, active: () => boolean) => {
      // A peer file is still owned by its visible consumer. Do not release that
      // source if persistence fails; the regular staging lifetime remains intact.
      if (uri.startsWith('file://')) {
        const file = new File(uri);
        return active() && file.exists && file.size > 0 && file.size <= 5 * 1024 * 1024
          ? cache.store(`companion-avatar:${identity}`, uri, mime, file.size) : false;
      }
      return withDownloadedRemoteMediaFile(uri, mime, 5 * 1024 * 1024, async file => {
        const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy');
        const head = await readAsStringAsync(file.uri, { encoding: EncodingType.Base64, position: 0, length: 16 });
        const actualMime = sniffImageMimeFromBase64(head);
        return active() && actualMime ? cache.store(`companion-avatar:${identity}`, file.uri, actualMime, file.size) : false;
      },
      new AbortController().signal);
    },
    async readLatest(device: string, url: string, active: () => boolean): Promise<DeviceFileResult | null> {
      const hit = await cache.lookup(JSON.stringify([device, url]));
      if (!active() || !hit || !validFileVersion(hit.version)) return null;
      const metadata = { size: hit.size, mimeType: hit.mimeType, version: hit.version };
      return hit.size <= FILE_INLINE_MAX_BYTES
        ? api.readInline(device, url, metadata, active)
        : api.read(device, url, metadata, active);
    },
    /** A completed OSS fallback joins the same version cache as direct downloads. */
    async download(device: string, url: string, metadata: Metadata, downloadUrl: string,
      active: () => boolean, signal?: AbortSignal): Promise<LocalPeerMedia | null> {
      if (!active() || !validFileVersion(metadata.version) || !(await api.prune(device, url, metadata.size))) return null;
      const uri = await downloadRemoteMediaShareTemp(downloadUrl, metadata.mimeType, undefined, signal);
      if (!uri) return null;
      const file = new File(uri);
      const dispose = () => { if (file.exists) file.delete(); };
      if (!active() || signal?.aborted || file.size !== metadata.size) { dispose(); return null; }
      const result = { ossKey: '', ...metadata };
      if (!recordPeerMedia(result, uri, dispose)) { dispose(); return null; }
      await api.store(device, url, metadata, result).catch(() => undefined);
      if (!active() || signal?.aborted) { releasePeerMedia(uri); return null; }
      return result;
    },
    async readInline(device: string, url: string, metadata: Metadata, active: () => boolean) {
      if (!validFileVersion(metadata.version) || metadata.size > FILE_INLINE_MAX_BYTES) return null;
      const hit = await cache.lookup(JSON.stringify([device, url]), metadata.version);
      if (!active() || !hit || hit.size !== metadata.size) return null;
      const inlineBase64 = await new File(hit.uri).base64();
      if (!active()) return null;
      return { ossKey: '', ...metadata, inlineBase64 };
    },
    async storeInline(device: string, url: string, result: DeviceFileResult) {
      if (!validFileVersion(result.version) || typeof result.inlineBase64 !== 'string'
        || result.size > FILE_INLINE_MAX_BYTES) return;
      await cache.store(JSON.stringify([device, url]),
        `data:${result.mimeType};base64,${result.inlineBase64}`, result.mimeType, result.size, result.version);
    },
    prune: (device: string, url: string, size: number) => cache.prune(2 * size, JSON.stringify([device, url])),
    // HTML previews deliberately allow a last-known copy before remote stat.
    // Keep these keys separate from the strictly versioned transfer cache.
    lookupPreview: async (identity: string, previousTransfer?: { device: string; url: string }) =>
      await cache.lookup(`html-preview:${identity}`) ?? (previousTransfer
        ? cache.lookup(JSON.stringify([previousTransfer.device, previousTransfer.url])) : null),
    storePreview: (identity: string, uri: string, mime: string, size: number) =>
      cache.store(`html-preview:${identity}`, uri, mime, size),
    invalidate: (device: string, url: string) =>
      cache.remove(JSON.stringify([device, url])),
    async read(
      device: string,
      url: string,
      metadata: Metadata | undefined,
      active: () => boolean,
    ) {
      if (!metadata || !validFileVersion(metadata.version)) return null;
      const source = JSON.stringify([device, url]);
      const hit = await cache.lookup(source, metadata.version);
      if (!active() || !hit || hit.size !== metadata.size) return null;
      // Only the consumer copy needs new space; keep its source during eviction.
      if (!(await cache.prune(metadata.size, source)) || !active()) return null;
      // The consumer owns a separate staging file; cache eviction never removes it.
      const directory = new Directory(
        Paths.cache,
        "remote-media-share",
        "file-peer",
      );
      directory.create({ intermediates: true, idempotent: true });
      const copy = new File(directory, randomUUID());
      const dispose = () => {
        if (copy.exists) copy.delete();
      };
      try {
        await new File(hit.uri).copy(copy);
        if (!active() || copy.size !== metadata.size) {
          dispose();
          return null;
        }
        const result = { ossKey: "", ...metadata };
        if (recordPeerMedia(result, copy.uri, dispose)) return result;
      } catch {
        /* A missing or evicted cache file is a miss. */
      }
      dispose();
      return null;
    },
    async store(
      device: string,
      url: string,
      metadata: Metadata | undefined,
      result: LocalPeerMedia,
    ) {
      if (
        !metadata ||
        !validFileVersion(metadata.version) ||
        result.version !== metadata.version ||
        result.size !== metadata.size
      )
        return;
      const uri = peerMediaUri(result);
      // Account for both the durable copy and the consumer's upcoming copy.
      if (!uri || !(await api.prune(device, url, result.size))) return;
      await cache.store(
        JSON.stringify([device, url]),
        uri,
        result.mimeType,
        result.size,
        metadata.version,
      );
    },
  };
  return api;
}
