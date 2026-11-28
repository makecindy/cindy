import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import {
  getMobileAuthOwner,
  subscribeMobileAuthOwner,
} from '@/auth/authOwnerGeneration';
import { clearAttachmentIntrinsicSizes } from '@/session/attachmentIntrinsicSizeCache';

/** Bounded in-memory LRU cap for authorized Chat Server attachment metadata/URLs. */
export const CHAT_SERVER_MEDIA_CACHE_MAX = 256;

/** Fallback TTL when a signed URL does not carry a standard expiry query parameter. */
export const DEFAULT_SIGNED_URL_TTL_MS = 5 * 60_000;

/** Upper bound so short-lived authorizations are never retained indefinitely. */
export const MAX_SIGNED_URL_TTL_MS = 30 * 60_000;

/** Renew proactively before a signed URL actually expires (aligned with remoteMedia.ts). */
export const SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS = 60_000;

export const CHAT_SERVER_MEDIA_CACHE_KEY_PREFIX = 'chat-media:v1:';

export interface CachedChatServerMediaEntry {
  attachment: BotGroupAttachment;
  expiresAtMs: number;
  expired: boolean;
  cacheKey: string;
}

interface StoredMediaEntry {
  owner: string;
  roomId: string;
  mediaId: string;
  attachment: BotGroupAttachment;
  expiresAtMs: number;
  staleUntilMs: number;
}

const mediaCache = new Map<string, StoredMediaEntry>();
const roomEpochs = new Map<string, number>();
const invalidationListeners = new Set<(roomId: string | null) => void>();

let globalEpoch = 0;
let activeCacheOwner: string | null = null;
let nativeImageCacheClearer: (() => void) | null = null;
let lastSignedInAccountKey = getMobileAuthOwner().accountKey;

function entryKey(owner: string, roomId: string, mediaId: string): string {
  return `${encodeURIComponent(owner)}\0${encodeURIComponent(roomId)}\0${encodeURIComponent(mediaId)}`;
}

function clearNativeImageCachesBestEffort(): void {
  try {
    nativeImageCacheClearer?.();
  } catch {
    /* Best-effort native image cache clear must never break auth/revocation cleanup. */
  }
}

function notifyInvalidation(roomId: string | null): void {
  for (const listener of invalidationListeners) {
    try {
      listener(roomId);
    } catch {
      /* Isolate listener failures from cleanup. */
    }
  }
}

/**
 * Registers the native `expo-image` cache clearer from a UI module so this
 * cache module stays free of React Native / Expo runtime imports.
 */
export function registerChatServerNativeImageCacheClearer(
  clearer: (() => void) | null,
): void {
  nativeImageCacheClearer = clearer;
}

export function subscribeChatServerMediaInvalidation(
  listener: (roomId: string | null) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/**
 * Canonical owner key fenced to the current signed-in account, realm and generation.
 * Returns `null` when logged out, mid-account-switch, or when React state disagrees
 * with the synchronous auth owner fence.
 */
export function resolveChatServerMediaOwner(
  userId: string | null | undefined,
  accountGeneration: number,
): string | null {
  const authOwner = getMobileAuthOwner();
  if (authOwner.switching) return null;
  if (userId === null) return null;
  const normalizedUser = typeof userId === 'string' ? userId.trim() : undefined;
  if (normalizedUser === '') return null;
  if (authOwner.accountId) {
    if (normalizedUser !== undefined && normalizedUser !== authOwner.accountId) {
      return null;
    }
    return `${authOwner.accountKey}:${accountGeneration}`;
  }
  if (normalizedUser !== undefined) {
    return `${normalizedUser}:${accountGeneration}`;
  }
  return `gen:${accountGeneration}`;
}

export function chatServerMediaRoomEpoch(roomId: string): number {
  return globalEpoch * 1_000_000 + (roomEpochs.get(roomId) ?? 0);
}

/**
 * Stable cache key for `expo-image` and `attachmentIntrinsicSizeCache`.
 * Stable across signed URL rotations within the same session and room epoch;
 * isolated across accounts, realms, rooms and post-revocation rejoins.
 */
export function chatServerMediaCacheKey(
  owner: string,
  roomId: string,
  mediaId: string,
): string {
  const epoch = chatServerMediaRoomEpoch(roomId);
  return `${CHAT_SERVER_MEDIA_CACHE_KEY_PREFIX}${encodeURIComponent(owner)}:${encodeURIComponent(roomId)}:${epoch}:${encodeURIComponent(mediaId)}`;
}

export function isChatServerMediaCacheKeyForRoom(
  key: string,
  roomId: string,
): boolean {
  if (!key.startsWith(CHAT_SERVER_MEDIA_CACHE_KEY_PREFIX)) return false;
  const parts = key.slice(CHAT_SERVER_MEDIA_CACHE_KEY_PREFIX.length).split(':');
  return parts.length === 4 && parts[1] === encodeURIComponent(roomId);
}

function parseCompactUtcTimestamp(raw: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  const ms = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  return Number.isFinite(ms) ? ms : null;
}

function queryParamCaseInsensitive(
  params: URLSearchParams,
  targetLower: string,
): string | null {
  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === targetLower) return value;
  }
  return null;
}

/**
 * Computes the effective cache expiry deadline (ms epoch) for a presigned HTTPS URL.
 * Returns `null` if the URL is invalid or already expired / within the safety window.
 */
export function parsePresignedUrlExpiresAtMs(
  rawUrl: string,
  now = Date.now(),
): number | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;

  const capDeadline = now + MAX_SIGNED_URL_TTL_MS;
  const params = url.searchParams;

  // S3 / R2 / MinIO SigV4 (`X-Amz-Date` + `X-Amz-Expires`) and Aliyun OSS v4 (`x-oss-date` + `x-oss-expires`).
  for (const [dateParam, expiresParam] of [
    ['x-amz-date', 'x-amz-expires'],
    ['x-oss-date', 'x-oss-expires'],
  ] as const) {
    const rawDate = queryParamCaseInsensitive(params, dateParam);
    const rawExpires = queryParamCaseInsensitive(params, expiresParam);
    if (rawDate !== null && rawExpires !== null) {
      const issuedAtMs = parseCompactUtcTimestamp(rawDate);
      const ttlSeconds = Number(rawExpires);
      if (
        issuedAtMs !== null &&
        Number.isFinite(ttlSeconds) &&
        ttlSeconds > 0
      ) {
        const ttlMs = ttlSeconds * 1000;
        const safetyMs =
          ttlMs >= 2 * SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS
            ? SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS
            : Math.floor(ttlMs * 0.2);
        const deadline = Math.min(issuedAtMs + ttlMs - safetyMs, capDeadline);
        return deadline > now ? deadline : null;
      }
    }
  }

  // S3 v2 / Aliyun OSS v1 / CloudFront (`Expires` Unix timestamp in seconds).
  const rawEpochExpires = queryParamCaseInsensitive(params, 'expires');
  if (rawEpochExpires !== null && /^\d{9,12}$/.test(rawEpochExpires)) {
    const expiresAtMs = Number(rawEpochExpires) * 1000;
    if (Number.isFinite(expiresAtMs)) {
      const remainingMs = expiresAtMs - now;
      if (remainingMs <= 0) return null;
      const safetyMs =
        remainingMs >= 2 * SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS
          ? SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS
          : Math.max(5_000, Math.floor(remainingMs * 0.2));
      const deadline = Math.min(expiresAtMs - safetyMs, capDeadline);
      return deadline > now ? deadline : null;
    }
  }

  return Math.min(now + DEFAULT_SIGNED_URL_TTL_MS, capDeadline);
}

function enforceSingleActiveOwner(owner: string): void {
  if (activeCacheOwner !== null && activeCacheOwner !== owner) {
    clearChatServerMediaCache();
  }
  activeCacheOwner = owner;
}

export function peekCachedServerMedia(
  owner: string,
  roomId: string,
  mediaId: string,
  now = Date.now(),
  options: { allowExpiredImage?: boolean } = {},
): CachedChatServerMediaEntry | null {
  if (!owner || !roomId || !mediaId) return null;
  enforceSingleActiveOwner(owner);
  const key = entryKey(owner, roomId, mediaId);
  const entry = mediaCache.get(key);
  if (!entry) return null;
  const expired = now >= entry.expiresAtMs;
  if (expired) {
    const canServeStaleImage =
      options.allowExpiredImage === true &&
      entry.attachment.category === 'image' &&
      entry.attachment.url !== null &&
      now < entry.staleUntilMs;
    if (!canServeStaleImage) {
      if (now >= entry.staleUntilMs || entry.attachment.category !== 'image') {
        mediaCache.delete(key);
      }
      return null;
    }
  }
  // Refresh LRU recency.
  mediaCache.delete(key);
  mediaCache.set(key, entry);
  return {
    attachment: entry.attachment,
    expiresAtMs: entry.expiresAtMs,
    expired,
    cacheKey: chatServerMediaCacheKey(owner, roomId, mediaId),
  };
}

export function setCachedServerMedia(
  owner: string,
  roomId: string,
  attachment: BotGroupAttachment,
  now = Date.now(),
): number | null {
  if (!owner || !roomId || !attachment.id) return null;
  enforceSingleActiveOwner(owner);

  let expiresAtMs: number;
  if (attachment.url !== null) {
    const parsed = parsePresignedUrlExpiresAtMs(attachment.url, now);
    if (parsed === null) {
      mediaCache.delete(entryKey(owner, roomId, attachment.id));
      return null;
    }
    expiresAtMs = parsed;
  } else {
    expiresAtMs = now + DEFAULT_SIGNED_URL_TTL_MS;
  }

  const key = entryKey(owner, roomId, attachment.id);
  mediaCache.delete(key);
  mediaCache.set(key, {
    owner,
    roomId,
    mediaId: attachment.id,
    attachment,
    expiresAtMs,
    staleUntilMs: Math.max(expiresAtMs, now + MAX_SIGNED_URL_TTL_MS),
  });
  while (mediaCache.size > CHAT_SERVER_MEDIA_CACHE_MAX) {
    const oldest = mediaCache.keys().next().value;
    if (oldest === undefined) break;
    mediaCache.delete(oldest);
  }
  return expiresAtMs;
}

export function invalidateCachedServerMedia(
  owner: string | null | undefined,
  roomId: string | null | undefined,
  mediaId: string,
): void {
  if (!owner || !roomId || !mediaId) return;
  mediaCache.delete(entryKey(owner, roomId, mediaId));
}

/**
 * Purges all cached media authorizations, intrinsic sizes and native image cache
 * for a room (on leave, 403/404 access loss, or room hide).
 */
export function forgetChatServerMediaRoom(roomId: string): void {
  if (!roomId) return;
  for (const [key, entry] of mediaCache) {
    if (entry.roomId === roomId) {
      mediaCache.delete(key);
    }
  }
  roomEpochs.set(roomId, (roomEpochs.get(roomId) ?? 0) + 1);
  clearAttachmentIntrinsicSizes((key) =>
    isChatServerMediaCacheKeyForRoom(key, roomId),
  );
  notifyInvalidation(roomId);
  clearNativeImageCachesBestEffort();
}

/**
 * Purges all cached Chat Server media across every room (on logout or account switch).
 */
export function clearChatServerMediaCache(
  options: { clearNativeImageCache?: boolean } = {},
): void {
  mediaCache.clear();
  roomEpochs.clear();
  globalEpoch += 1;
  activeCacheOwner = null;
  clearAttachmentIntrinsicSizes((key) =>
    key.startsWith(CHAT_SERVER_MEDIA_CACHE_KEY_PREFIX),
  );
  notifyInvalidation(null);
  if (options.clearNativeImageCache) {
    clearNativeImageCachesBestEffort();
  }
}

subscribeMobileAuthOwner(() => {
  const next = getMobileAuthOwner();
  const hadSignedInAccount = lastSignedInAccountKey !== '';
  const switchedOrLoggedOut =
    hadSignedInAccount &&
    (next.switching === true || next.accountKey !== lastSignedInAccountKey);
  if (!next.switching) {
    lastSignedInAccountKey = next.accountKey;
  } else {
    lastSignedInAccountKey = '';
  }
  clearChatServerMediaCache({ clearNativeImageCache: switchedOrLoggedOut });
});

export const __testing = {
  size(): number {
    return mediaCache.size;
  },
  reset(): void {
    mediaCache.clear();
    roomEpochs.clear();
    globalEpoch = 0;
    activeCacheOwner = null;
    lastSignedInAccountKey = getMobileAuthOwner().accountKey;
    clearAttachmentIntrinsicSizes((key) =>
      key.startsWith(CHAT_SERVER_MEDIA_CACHE_KEY_PREFIX),
    );
  },
};
