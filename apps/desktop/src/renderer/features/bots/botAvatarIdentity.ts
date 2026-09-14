/**
 * Reserved Cindy avatar namespace — the sentinel half of BotAvatar, kept in its
 * own leaf module on purpose so `BotAvatar.tsx` can re-export the vocabulary
 * without every consumer pulling in React/Radix just to check a string.
 */

/**
 * Anything under this prefix resolves to artwork Cindy ships, so a Bot avatar
 * string is either a grapheme the user picked or a sentinel Cindy defined —
 * never a remote URL.
 */
export const CINDY_AVATAR_SCHEME_PREFIX = 'cindy://avatar/';

/**
 * True for every value in the reserved namespace, official or preset or a value
 * only a newer client knows. Callers use it to decide "this is not a grapheme":
 * an older client that meets a `cindy://avatar/<something>` sentinel it does not
 * (or no longer) resolve artwork for must never paint the raw string on screen
 * as if it were an emoji — it falls back to the neutral initial instead.
 */
export function isCindyAvatarSentinel(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase().startsWith(CINDY_AVATAR_SCHEME_PREFIX);
}
