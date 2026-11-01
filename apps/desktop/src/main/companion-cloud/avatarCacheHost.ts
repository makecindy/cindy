/** Production wiring of the companion avatar cache (media store, device-link, guarded download). */
import { promises as fsp } from 'node:fs';

import { BOT_AVATAR_MAX_BYTES } from '../../shared/botAvatarValue.js';
import { rewriteToRemoteMediaOrigin } from '../../shared/remoteMediaUrl.js';
import { resolveSafe } from '../cindy-media/blobStore.js';
import { getActiveAppSession } from '../appSessionState.js';
import { integrationCacheGet, integrationCachePut } from '../cindy-media/integrationCache.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { captureRemoteMediaOwner } from '../device-link/remoteMediaPersistentCache.js';
import { fetchRemoteMediaImageBytes } from '../device-link/remoteMediaProtocol.js';
import { getDbClient } from '../localDb/client/current.js';
import { fetchPublicImageBytes } from '../im/publicImageFetch.js';
import { COMPANION_AVATAR_CACHE, createCompanionAvatarCache } from './avatarCache.js';

const AVATAR_FETCH_TIMEOUT_MS = 15_000;

export const companionAvatarCache = createCompanionAvatarCache({
  localBlob: async (url) => {
    // resolveSafe validates the address shape; the file must exist here.
    await fsp.access(resolveSafe(url).absPath);
    return url;
  },
  // The account and its database are captured before any download: late bytes never enter the next account.
  scope: () => {
    const session = getActiveAppSession();
    const assertCurrent = captureRemoteMediaOwner();
    const db = getDbClient().drizzle;
    return {
      key: `${session.mode}:${session.dataOwnerId ?? ''}`,
      get: async (cacheKey) => { assertCurrent(); return (await integrationCacheGet(cacheKey, db))?.url ?? null; },
      put: async (cacheKey, bytes, mimeType) => {
        assertCurrent();
        return (await integrationCachePut({ cacheKey, integration: COMPANION_AVATAR_CACHE, buffer: bytes, mimeType, assertStillValid: assertCurrent }, db)).url;
      },
    };
  },
  fetchFromDevice: (deviceId, url) => fetchRemoteMediaImageBytes(rewriteToRemoteMediaOrigin(url, { kind: 'device', deviceId })),
  fetchPublic: (url) => fetchPublicImageBytes(url, BOT_AVATAR_MAX_BYTES, undefined, { timeoutMs: AVATAR_FETCH_TIMEOUT_MS, allowProxyFakeIp: true }),
  sniff: (bytes) => sniffMediaMime(bytes),
});
