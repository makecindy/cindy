/**
 * A Bot profile may point at Cindy-managed image bytes, but never at an
 * arbitrary URL or local path. Keep this parser asset-free so main, renderer
 * and Mobile boundary code can share the exact same shape check.
 */
const MANAGED_BOT_AVATAR_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|webp)$/;
const CINDY_BOT_AVATAR_RE = /^cindy:\/\/avatar\/[a-z0-9](?:[a-z0-9/-]{0,79})$/;

export function isManagedBotAvatarUrl(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_BOT_AVATAR_RE.test(value);
}

export function isCindyBotAvatarValue(value: unknown): value is string {
  return typeof value === 'string' && CINDY_BOT_AVATAR_RE.test(value.toLowerCase());
}

export function isSingleBotAvatarGrapheme(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const iterator = segmenter.segment(value)[Symbol.iterator]();
  return !iterator.next().done && iterator.next().done === true;
}

/** Persisted avatar values never contain external URLs, local paths or data URIs. */
export function isSupportedBotAvatarValue(value: unknown): value is string {
  return (
    isManagedBotAvatarUrl(value) || isCindyBotAvatarValue(value) || isSingleBotAvatarGrapheme(value)
  );
}

export function portableBotAvatarOrFallback(value: unknown, fallback = '🤖'): string {
  return isSupportedBotAvatarValue(value) && !isManagedBotAvatarUrl(value) ? value : fallback;
}
