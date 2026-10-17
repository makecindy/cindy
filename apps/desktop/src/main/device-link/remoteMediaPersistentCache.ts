import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseAttachmentOssRef, parsePeerAttachmentRef } from '@cindy/device-link';
import { blobUrl, extForMime } from '../cindy-media/blobStore';
import { getActiveAppSession } from '../appSessionState';
import { getDbClient } from '../localDb/client/current';
import { integrationCacheGet, integrationCachePut } from '../cindy-media/integrationCache';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';

export const REMOTE_MEDIA_INTEGRATION = 'remote-media';
let cacheGeneration = 0;
export function invalidateRemoteMediaPersistentWrites(): void {
  cacheGeneration++;
}

export function captureRemoteMediaOwner(): () => void {
  const owner = captureDataOwnerBroadcastScope();
  return () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
  };
}

export function captureRemoteMediaCacheValidity(): () => void {
  const assertOwner = captureRemoteMediaOwner();
  const generation = cacheGeneration;
  return () => {
    assertOwner();
    if (generation !== cacheGeneration) throw new Error('REMOTE_MEDIA_CACHE_CLEARED');
  };
}

/** Managed attachment identities are immutable. File-system URLs must be revalidated. */
export function isImmutableRemoteMedia(url: string): boolean {
  return (
    /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.[a-z0-9]+$/.test(url) ||
    /^xdt-image:\/\/[^/?#]+\/[^/?#]+$/.test(url)
  );
}

/** Seed the existing device/account cache with the actual upload, including compressed
 * images. Capture validity before uploading; account switches and cache clearing win. */
export function createSentImageRetainer(device: string) {
  const assertCurrent = captureRemoteMediaCacheValidity();
  return async (source: string | Buffer, ref: string): Promise<void> => {
    assertCurrent();
    const metadata = parseAttachmentOssRef(ref) ?? parsePeerAttachmentRef(ref);
    // Same bound as the remote protocol's buffered image path. Never read a large
    // non-image attachment into memory just to keep a preview.
    if (!metadata?.mimeType?.startsWith('image/') || !metadata.sha256 || !metadata.size
      || metadata.size > 64 * 1024 * 1024) return;
    let bytes: Buffer;
    if (typeof source === 'string') {
      const file = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== metadata.size) return;
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) return;
          offset += bytesRead;
        }
      } finally { await file.close(); }
    } else bytes = source;
    assertCurrent();
    if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) return;
    const mimeType = sniffMediaMime(bytes, metadata.mimeType);
    const ext = mimeType && extForMime(mimeType);
    if (!mimeType?.startsWith('image/') || !ext) return;
    await remoteMediaPersistentCache(device, blobUrl(metadata.sha256, ext))?.put(bytes, mimeType);
  };
}

/** Only an index adapter: bytes and references belong to the existing media warehouse.
 * No age/size eviction here. The owner explicitly clears these reusable copies in Storage.
 * Capture the database and owner before downloading so late work cannot enter a new account. */
export function remoteMediaPersistentCache(device: string, url: string) {
  if (!isImmutableRemoteMedia(url)) return null;
  const session = getActiveAppSession();
  if (!session.dataOwnerId) return null;
  const assertCurrent = captureRemoteMediaCacheValidity();
  const db = getDbClient().drizzle;
  const key = `${REMOTE_MEDIA_INTEGRATION}:${createHash('sha256')
    .update(JSON.stringify([session.mode, session.dataOwnerId, device, url]))
    .digest('hex')}`;
  return {
    async get(maxBytes: number) {
      assertCurrent();
      const hit = await integrationCacheGet(key, db);
      assertCurrent();
      if (!hit || !hit.mimeType.startsWith('image/')) return null;
      const file = await fs.open(hit.absPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxBytes) return null;
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) return null;
          offset += bytesRead;
        }
        assertCurrent();
        // A damaged cache is a miss, not an indefinitely broken image.
        if (
          bytes.length > maxBytes ||
          createHash('sha256').update(bytes).digest('hex') !== hit.hash
        )
          return null;
        return { bytes, mimeType: hit.mimeType };
      } finally {
        await file.close();
      }
    },
    async put(bytes: Buffer, mimeType: string) {
      assertCurrent();
      const verified = sniffMediaMime(bytes, mimeType);
      if (!verified?.startsWith('image/')) return;
      // Never attach bytes to a remote content hash that they do not actually match.
      if (
        url.startsWith('cindy-media://') &&
        createHash('sha256').update(bytes).digest('hex') !== url.split('/').pop()!.split('.')[0]
      )
        return;
      await integrationCachePut(
        {
          cacheKey: key,
          integration: REMOTE_MEDIA_INTEGRATION,
          buffer: bytes,
          mimeType: verified,
          assertStillValid: assertCurrent,
        },
        db,
      );
    },
  };
}
