/**
 * Local copy of companion avatars that live elsewhere (cloud-companions.md §2): the avatar of a
 * companion on another computer (`cindy-media://blobs/…` there) and a cloud actor's public image
 * (`https://…`). Shown from this computer first, so an offline main computer or a restart never
 * turns a known avatar back into an initial.
 *
 * Bytes go into the media store as a regenerable cache (media-storage-and-protocols.md: the
 * integration-cache index, `isCache`, recycled by the store's size limit). Both sources are
 * immutable per address — a blob address is its content hash and a new cloud avatar gets a new
 * address — so a hit never needs revalidation.
 */
import { BOT_AVATAR_MAX_BYTES, isManagedBotAvatarUrl } from '../../shared/botAvatarValue.js';

export const COMPANION_AVATAR_CACHE = 'companion-avatar';

/**
 * The account's media store, captured when a lookup starts: a download that finishes after the
 * account changed is never written into the next one (`put` throws instead).
 */
export interface CompanionAvatarScope {
  /** Identifies the account; in-flight downloads and retry pauses are kept per account. */
  key: string;
  get: (cacheKey: string) => Promise<string | null>;
  put: (cacheKey: string, bytes: Uint8Array, mimeType: string) => Promise<string>;
}

export interface CompanionAvatarCacheDeps {
  /** Local blob address when this store already holds that content (any source). */
  localBlob: (url: string) => Promise<string | null>;
  scope: () => CompanionAvatarScope;
  /** Image bytes of another computer's media (device-link), bounded. */
  fetchFromDevice: (deviceId: string, url: string) => Promise<{ buffer: Uint8Array; mimeType?: string }>;
  /** Public image bytes through the guarded download (no private networks), bounded. */
  fetchPublic: (url: string) => Promise<{ buffer: Uint8Array; mimeType?: string }>;
  /** Image MIME from the bytes themselves; null when they are not a supported image. */
  sniff: (bytes: Uint8Array) => string | null;
  now?: () => number;
}

export interface CompanionAvatarRequest {
  avatar: string;
  /** The computer that holds a `cindy-media://` avatar. */
  deviceId?: string | null;
  /** Download and keep it when it is not cached yet (otherwise only look). */
  fetch?: boolean;
}

const FAILURE_BACKOFF_MS = 60_000;
const BLOB_RE = /^cindy-media:\/\/blobs\/([0-9a-f]{64})\.[a-z0-9]+$/;

/** Cache key of an avatar address, or null when it is not one this cache keeps. */
export function companionAvatarKey(avatar: string, deviceId?: string | null): string | null {
  if (avatar.startsWith('https://') && avatar.length <= 2048) return `${COMPANION_AVATAR_CACHE}:${avatar}`;
  const blob = isManagedBotAvatarUrl(avatar) ? BLOB_RE.exec(avatar) : null;
  return blob && deviceId ? `${COMPANION_AVATAR_CACHE}:blob:${blob[1]}` : null;
}

export function createCompanionAvatarCache(deps: CompanionAvatarCacheDeps) {
  const now = deps.now ?? Date.now;
  const inflight = new Map<string, Promise<string | null>>();
  const failedUntil = new Map<string, number>();

  async function lookup(scope: CompanionAvatarScope, request: CompanionAvatarRequest, key: string): Promise<string | null> {
    // Same content already here (e.g. it was handed to this computer once): no copy needed.
    if (!request.avatar.startsWith('https://')) {
      const local = await deps.localBlob(request.avatar).catch(() => null);
      if (local) return local;
    }
    return scope.get(key).catch(() => null);
  }

  async function download(scope: CompanionAvatarScope, request: CompanionAvatarRequest, key: string): Promise<string | null> {
    const fetched = request.avatar.startsWith('https://')
      ? await deps.fetchPublic(request.avatar)
      : await deps.fetchFromDevice(request.deviceId!, request.avatar);
    if (fetched.buffer.byteLength === 0 || fetched.buffer.byteLength > BOT_AVATAR_MAX_BYTES) return null;
    // The sender's MIME is not trusted: only bytes that are an image are kept.
    const mimeType = deps.sniff(fetched.buffer);
    if (!mimeType?.startsWith('image/')) return null;
    return scope.put(key, fetched.buffer, mimeType);
  }

  return {
    /** Local address of the avatar, or null (not cached, not cacheable, or the download failed). */
    async resolve(request: CompanionAvatarRequest): Promise<string | null> {
      const key = companionAvatarKey(request.avatar, request.deviceId);
      if (!key) return null;
      const scope = deps.scope();
      const hit = await lookup(scope, request, key);
      if (hit || !request.fetch) return hit;
      const slot = `${scope.key}\n${key}`;
      if ((failedUntil.get(slot) ?? 0) > now()) return null;
      const pending = inflight.get(slot);
      if (pending) return pending;
      const run = download(scope, request, key)
        .catch(() => null)
        .then((url) => {
          if (url) failedUntil.delete(slot); else failedUntil.set(slot, now() + FAILURE_BACKOFF_MS);
          return url;
        })
        .finally(() => { inflight.delete(slot); });
      inflight.set(slot, run);
      return run;
    },
  };
}

export type CompanionAvatarCache = ReturnType<typeof createCompanionAvatarCache>;
