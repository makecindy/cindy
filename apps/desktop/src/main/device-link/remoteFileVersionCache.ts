import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { validFileVersion, type DeviceFileResult } from '@cindy/device-link';
import { getActiveAppSession } from '../appSessionState';
import { getDbClient } from '../localDb/client/current';
import {
  integrationCacheGet,
  integrationCachePut,
  supportedMime,
} from '../cindy-media/integrationCache';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime';
import { scanCache, evictCacheBlobs, CACHE_LIMIT_BYTES } from '../cindy-media/recycler';
import {
  readVersionedRemoteFile,
  removeVersionedRemoteFile,
  writeVersionedRemoteFile,
} from '../file-browser/remote-file-cache';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { getIntegrationCacheBytes, removeRefs } from '../cindy-media/ledger';
import { captureRemoteMediaCacheValidity, isImmutableRemoteMedia, REMOTE_MEDIA_INTEGRATION } from './remoteMediaPersistentCache';

const INTEGRATION = 'remote-file';
export type FileVersionMetadata = Pick<DeviceFileResult, 'version' | 'size' | 'mimeType'> & {
  skipCache?: boolean;
  /** Local-only guard captured before host preparation, never sent over the wire. */
  assertCacheCurrent?: () => void;
};

/** An adapter to the existing media warehouse / ordinary-file LRU, not another byte store.
 * Versions originate from host authorization/stat; same-owner previews may reuse
 * the previous version while revalidating in the background.
 * Generations guard in-flight work; stable owner IDs key the durable cache across restarts. */
export function remoteFileVersionCache(
  device: string,
  url: string,
  metadata?: FileVersionMetadata,
) {
  if (!metadata || !validFileVersion(metadata.version)) return null;
  const owner = captureDataOwnerBroadcastScope();
  const session = getActiveAppSession();
  if (!session.dataOwnerId || !isDataOwnerBroadcastScopeCurrent(owner)) return null;
  const { version, size, mimeType } = metadata;
  const source = createHash('sha256')
    .update(JSON.stringify([session.mode, session.dataOwnerId, device, url]))
    .digest('hex');
  // Direct and OSS image downloads share one index and one cleanup owner.
  const retained = mimeType.startsWith('image/') && isImmutableRemoteMedia(url);
  const integration = retained ? REMOTE_MEDIA_INTEGRATION : INTEGRATION;
  const key = retained ? `${integration}:${source}` : `${integration}:${source}:${version}`;
  const assertRetained = retained ? captureRemoteMediaCacheValidity() : () => {};
  const media = /^(image|audio|video|model)\//.test(mimeType);
  const db = media ? getDbClient().drizzle : undefined;
  const assertCurrent = () => {
    metadata.assertCacheCurrent?.();
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
    assertRetained();
  };
  return {
    async invalidate(): Promise<void> {
      assertCurrent();
      if (!media) return removeVersionedRemoteFile(source, version);
      const hit = await integrationCacheGet(key, db);
      assertCurrent();
      if (hit)
        await evictCacheBlobs(
          {
            hashes: [hit.hash],
            live: new Set(),
            integration,
            assertStillValid: assertCurrent,
          },
          db,
        );
      // Shared/pinned bytes survive the conditional eviction; remove only our index.
      assertCurrent();
      await removeRefs({ refKind: 'integration-cache', refId: key }, db);
    },
    async get(): Promise<string | null> {
      assertCurrent();
      if (!media) {
        const file = await readVersionedRemoteFile(source, version, size);
        assertCurrent();
        return file;
      }
      const hit = await integrationCacheGet(key, db);
      assertCurrent();
      if (!hit || (retained && url.startsWith('cindy-media://')
        && hit.hash !== url.split('/').pop()!.split('.')[0])) return null;
      const stat = await fs.lstat(hit.absPath).catch(() => null);
      assertCurrent();
      if (!stat?.isFile() || stat.size !== size) return null;
      if (retained) {
        // A preview miss must not hit the same corrupt bytes through filePeer.
        const file = await fs.open(hit.absPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
        if (!file) return null;
        try {
          const hash = createHash('sha256');
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            assertCurrent();
            hash.update(chunk);
          }
          if (hash.digest('hex') !== hit.hash) return null;
        } finally {
          await file.close();
        }
        assertCurrent();
      }
      return hit.absPath;
    },
    async put(file: string | Buffer): Promise<void> {
      assertCurrent();
      if (Buffer.isBuffer(file) && file.length !== size) return;
      if (!media) return writeVersionedRemoteFile(source, version, file, size, assertCurrent);
      // A copy that cannot fit the existing cache budget would evict everything
      // else and immediately be evicted itself. It remains available to its consumer.
      if (!retained && size > CACHE_LIMIT_BYTES) return;
      // Bounded sniff; never load a large media file into main-process memory.
      let verified: string | null;
      if (Buffer.isBuffer(file)) {
        verified = sniffMediaMime(file.subarray(0, 4096), mimeType);
      } else {
        const handle = await fs.open(file, 'r');
        try {
          const probe = Buffer.alloc(Math.min(size, 4096));
          const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
          verified = sniffMediaMime(probe.subarray(0, bytesRead), mimeType);
        } finally {
          await handle.close();
        }
      }
      assertCurrent();
      if (!verified || !supportedMime(verified)) return;
      const written = await integrationCachePut(
        {
          cacheKey: key,
          integration,
          ...(typeof file === 'string' ? { filePath: file } : { buffer: file }),
          mimeType: verified,
          assertStillValid: assertCurrent,
        },
        db,
      );
      assertCurrent();
      if (retained) {
        if (url.startsWith('cindy-media://') && written.hash !== url.split('/').pop()!.split('.')[0])
          await written.rollbackRef();
        return;
      }
      // Use the warehouse's existing byte budget. Only this integration's cache
      // is eligible: attachments, pinned media and other integrations stay protected.
      // The consumer owns the input file, not this warehouse copy. Even the
      // newest copy must be evictable when other integrations fill the budget.
      const live = new Set<string>();
      // Long-lived copies are manually managed and must not consume the automatic budget.
      const retainedBytes = await getIntegrationCacheBytes(REMOTE_MEDIA_INTEGRATION, db);
      assertCurrent();
      const scan = await scanCache({ live, integration: INTEGRATION, limitBytes: CACHE_LIMIT_BYTES + retainedBytes }, db);
      assertCurrent();
      await evictCacheBlobs(
        {
          hashes: scan.evictable.map((entry) => entry.hash),
          live,
          integration: INTEGRATION,
          assertStillValid: assertCurrent,
        },
        db,
      );
    },
  };
}
