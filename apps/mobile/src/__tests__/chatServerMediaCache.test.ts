import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountVaultKey } from '@cindy/auth-client';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import {
  __testing as authOwnerTesting,
  invalidateMobileAuthOwnerForSwitch,
  setMobileAuthOwner,
} from '@/auth/authOwnerGeneration';
import {
  __testing as cacheTesting,
  CHAT_SERVER_MEDIA_CACHE_MAX,
  DEFAULT_SIGNED_URL_TTL_MS,
  MAX_SIGNED_URL_TTL_MS,
  SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS,
  chatServerMediaCacheKey,
  chatServerMediaRoomEpoch,
  clearChatServerMediaCache,
  forgetChatServerMediaRoom,
  invalidateCachedServerMedia,
  isChatServerMediaCacheKeyForRoom,
  parsePresignedUrlExpiresAtMs,
  peekCachedServerMedia,
  registerChatServerNativeImageCacheClearer,
  resolveChatServerMediaOwner,
  setCachedServerMedia,
  subscribeChatServerMediaInvalidation,
} from '@/chat/chatServerMediaCache';
import {
  attachmentIntrinsicSizeCache,
  clearAttachmentIntrinsicSizes,
} from '@/session/attachmentIntrinsicSizeCache';

const img = (id: string, url = `https://cdn.example.invalid/${id}.png?sig=1`): BotGroupAttachment => ({
  id,
  name: `${id}.png`,
  category: 'image',
  mimeType: 'image/png',
  size: 1024,
  url,
  path: null,
});

describe('chatServerMediaCache', () => {
  beforeEach(() => {
    authOwnerTesting.reset();
    cacheTesting.reset();
    clearAttachmentIntrinsicSizes();
    registerChatServerNativeImageCacheClearer(null);
  });

  afterEach(() => {
    registerChatServerNativeImageCacheClearer(null);
    authOwnerTesting.reset();
    cacheTesting.reset();
    clearAttachmentIntrinsicSizes();
  });

  it('enforces bounded LRU eviction and refreshes recency on hit', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const owner = 'global:user-1:1';
    for (let i = 0; i < CHAT_SERVER_MEDIA_CACHE_MAX; i++) {
      setCachedServerMedia(owner, 'room-1', img(`m-${i}`), now);
    }
    expect(cacheTesting.size()).toBe(CHAT_SERVER_MEDIA_CACHE_MAX);

    // Touch m-0 so it becomes MRU; m-1 becomes the oldest entry.
    expect(peekCachedServerMedia(owner, 'room-1', 'm-0', now + 1000)?.attachment.id).toBe('m-0');

    setCachedServerMedia(owner, 'room-1', img('m-overflow'), now + 2000);
    expect(cacheTesting.size()).toBe(CHAT_SERVER_MEDIA_CACHE_MAX);
    expect(peekCachedServerMedia(owner, 'room-1', 'm-0', now + 2000)).not.toBeNull();
    expect(peekCachedServerMedia(owner, 'room-1', 'm-1', now + 2000)).toBeNull();
    expect(peekCachedServerMedia(owner, 'room-1', 'm-overflow', now + 2000)).not.toBeNull();
  });

  it('parses SigV4, Aliyun OSS v4, epoch Expires and fallback TTLs while rejecting unsafe URLs', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);

    // AWS S3 / R2 SigV4: 15 min TTL -> renews 60s early
    const amz = parsePresignedUrlExpiresAtMs(
      'https://s3.example.invalid/a.png?X-Amz-Date=20261126T120000Z&X-Amz-Expires=900',
      now,
    );
    expect(amz).toBe(now + 900_000 - SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS);

    // Short SigV4 TTL (< 2 min): uses 20% safety buffer instead of rejecting immediately
    const shortAmz = parsePresignedUrlExpiresAtMs(
      'https://s3.example.invalid/short.png?X-Amz-Date=20261126T120000Z&X-Amz-Expires=60',
      now,
    );
    expect(shortAmz).toBe(now + 60_000 - 12_000);

    // Aliyun OSS v4
    const ossV4 = parsePresignedUrlExpiresAtMs(
      'https://oss.example.invalid/b.png?x-oss-date=20261126T120000Z&x-oss-expires=600',
      now,
    );
    expect(ossV4).toBe(now + 600_000 - SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS);

    // Unix epoch Expires (OSS v1 / S3 v2 / CloudFront)
    const epochSeconds = Math.floor((now + 10 * 60_000) / 1000);
    const epoch = parsePresignedUrlExpiresAtMs(
      `https://cdn.example.invalid/c.png?Expires=${epochSeconds}&Signature=abc`,
      now,
    );
    expect(epoch).toBe(epochSeconds * 1000 - SIGNED_URL_EXPIRY_SAFETY_BUFFER_MS);

    // Short Unix epoch Expires (e.g. Chat Server's 60s Aliyun OSS v1 signed URL)
    const shortEpochSeconds = Math.floor((now + 60_000) / 1000);
    const shortEpoch = parsePresignedUrlExpiresAtMs(
      `https://oss.example.invalid/chat.png?OSSAccessKeyId=k&Expires=${shortEpochSeconds}&Signature=s`,
      now,
    );
    expect(shortEpoch).toBe(shortEpochSeconds * 1000 - 12_000);

    // Almost-expired Unix epoch Expires (<= 5s remaining) is not cached
    const almostExpiredEpoch = Math.floor((now + 4_000) / 1000);
    expect(
      parsePresignedUrlExpiresAtMs(
        `https://oss.example.invalid/chat.png?Expires=${almostExpiredEpoch}&Signature=s`,
        now,
      ),
    ).toBeNull();

    // Very long TTL is capped at MAX_SIGNED_URL_TTL_MS
    const longSig = parsePresignedUrlExpiresAtMs(
      'https://s3.example.invalid/long.png?X-Amz-Date=20261126T120000Z&X-Amz-Expires=86400',
      now,
    );
    expect(longSig).toBe(now + MAX_SIGNED_URL_TTL_MS);

    // Already expired or within safety buffer returns null
    expect(
      parsePresignedUrlExpiresAtMs(
        'https://s3.example.invalid/expired.png?X-Amz-Date=20261126T110000Z&X-Amz-Expires=600',
        now,
      ),
    ).toBeNull();

    // Opaque signed URL without standard expiry params gets conservative fallback TTL
    expect(
      parsePresignedUrlExpiresAtMs('https://cdn.example.invalid/d.png?sig=opaque', now),
    ).toBe(now + DEFAULT_SIGNED_URL_TTL_MS);

    // Unsafe protocols or embedded credentials are rejected
    expect(parsePresignedUrlExpiresAtMs('http://cdn.example.invalid/e.png', now)).toBeNull();
    expect(parsePresignedUrlExpiresAtMs('https://user:pass@cdn.example.invalid/e.png', now)).toBeNull();
  });

  it('expires cached entries once past deadline and supports single-item invalidation', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const owner = 'global:user-1:1';
    const url = 'https://s3.example.invalid/a.png?X-Amz-Date=20261126T120000Z&X-Amz-Expires=180';
    setCachedServerMedia(owner, 'room-1', img('m-1', url), now);

    // 119s later: still valid (180 - 60 = 120s effective TTL)
    expect(peekCachedServerMedia(owner, 'room-1', 'm-1', now + 119_000)?.expired).toBe(false);
    // 120s later: proactively expired for strict peek, while stale-while-revalidate
    // still allows rendering the expo-image cached key until MAX_SIGNED_URL_TTL_MS
    expect(peekCachedServerMedia(owner, 'room-1', 'm-1', now + 120_000)).toBeNull();
    expect(
      peekCachedServerMedia(owner, 'room-1', 'm-1', now + 120_000, { allowExpiredImage: true })?.expired,
    ).toBe(true);
    // Past MAX_SIGNED_URL_TTL_MS: entry is fully evicted
    expect(
      peekCachedServerMedia(owner, 'room-1', 'm-1', now + MAX_SIGNED_URL_TTL_MS, { allowExpiredImage: true }),
    ).toBeNull();
    expect(cacheTesting.size()).toBe(0);

    setCachedServerMedia(owner, 'room-1', img('m-2'), now);
    invalidateCachedServerMedia(owner, 'room-1', 'm-2');
    expect(peekCachedServerMedia(owner, 'room-1', 'm-2', now)).toBeNull();
  });

  it('produces collision-free stable keys and isolates room revocation from sibling rooms', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const owner = 'global:user:1:gen1';
    const roomA = 'room:a';
    const roomB = 'room:b';
    const clearNative = vi.fn();
    registerChatServerNativeImageCacheClearer(clearNative);

    setCachedServerMedia(owner, roomA, img('media:1'), now);
    setCachedServerMedia(owner, roomB, img('media:1'), now);
    const keyA1 = chatServerMediaCacheKey(owner, roomA, 'media:1');
    const keyB1 = chatServerMediaCacheKey(owner, roomB, 'media:1');
    expect(keyA1).not.toBe(keyB1);
    expect(isChatServerMediaCacheKeyForRoom(keyA1, roomA)).toBe(true);
    expect(isChatServerMediaCacheKeyForRoom(keyA1, roomB)).toBe(false);

    attachmentIntrinsicSizeCache.set(keyA1, { width: 800, height: 400 });
    attachmentIntrinsicSizeCache.set(keyB1, { width: 300, height: 300 });
    attachmentIntrinsicSizeCache.set('https://unrelated.example/img.png', { width: 100, height: 100 });

    const invalidatedRooms: Array<string | null> = [];
    const unsubscribe = subscribeChatServerMediaInvalidation((roomId) => invalidatedRooms.push(roomId));
    const epochBefore = chatServerMediaRoomEpoch(roomA);

    forgetChatServerMediaRoom(roomA);
    unsubscribe();

    expect(peekCachedServerMedia(owner, roomA, 'media:1', now)).toBeNull();
    expect(peekCachedServerMedia(owner, roomB, 'media:1', now)).not.toBeNull();
    expect(attachmentIntrinsicSizeCache.has(keyA1)).toBe(false);
    expect(attachmentIntrinsicSizeCache.has(keyB1)).toBe(true);
    expect(attachmentIntrinsicSizeCache.has('https://unrelated.example/img.png')).toBe(true);
    expect(chatServerMediaRoomEpoch(roomA)).toBeGreaterThan(epochBefore);
    expect(chatServerMediaCacheKey(owner, roomA, 'media:1')).not.toBe(keyA1);
    expect(invalidatedRooms).toEqual([roomA]);
    expect(clearNative).toHaveBeenCalledTimes(1);
  });

  it('clears all caches on logout and account switch without wiping native disk cache on cold start', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const clearNative = vi.fn();
    registerChatServerNativeImageCacheClearer(clearNative);

    // Cold start transition ('' -> user-a) must not wipe pre-existing native disk cache
    setMobileAuthOwner('user-a', 'global');
    expect(clearNative).not.toHaveBeenCalled();

    const ownerA = resolveChatServerMediaOwner('user-a', 1)!;
    expect(ownerA).toBe(`${accountVaultKey('global', 'user-a')}:1`);
    setCachedServerMedia(ownerA, 'room-1', img('m-1'), now);
    const keyA = chatServerMediaCacheKey(ownerA, 'room-1', 'm-1');
    attachmentIntrinsicSizeCache.set(keyA, { width: 640, height: 480 });

    // Mismatched React userId during switch transition is rejected
    expect(resolveChatServerMediaOwner('user-b', 1)).toBeNull();
    expect(resolveChatServerMediaOwner(null, 1)).toBeNull();

    // Reversible switch invalidation clears memory + intrinsic sizes + native image cache
    invalidateMobileAuthOwnerForSwitch();
    expect(resolveChatServerMediaOwner('user-a', 1)).toBeNull();
    expect(cacheTesting.size()).toBe(0);
    expect(attachmentIntrinsicSizeCache.has(keyA)).toBe(false);
    expect(clearNative).toHaveBeenCalledTimes(1);

    // Sign in as user-b
    setMobileAuthOwner('user-b', 'global');
    const ownerB = resolveChatServerMediaOwner('user-b', 2)!;
    expect(ownerB).toBe(`${accountVaultKey('global', 'user-b')}:2`);
    setCachedServerMedia(ownerB, 'room-1', img('m-1'), now);
    const keyB = chatServerMediaCacheKey(ownerB, 'room-1', 'm-1');
    attachmentIntrinsicSizeCache.set(keyB, { width: 320, height: 240 });

    // Logout clears everything + native image cache
    setMobileAuthOwner(null);
    expect(cacheTesting.size()).toBe(0);
    expect(attachmentIntrinsicSizeCache.has(keyB)).toBe(false);
    expect(clearNative).toHaveBeenCalledTimes(2);
  });

  it('clears previous owner entries when active owner string changes directly', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    setCachedServerMedia('gen:1', 'room-1', img('m-1'), now);
    expect(cacheTesting.size()).toBe(1);

    expect(peekCachedServerMedia('gen:2', 'room-1', 'm-1', now)).toBeNull();
    expect(cacheTesting.size()).toBe(0);

    clearChatServerMediaCache();
    expect(cacheTesting.size()).toBe(0);
  });
});
