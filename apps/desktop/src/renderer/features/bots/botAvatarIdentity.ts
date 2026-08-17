/**
 * Reserved Cindy avatar namespace — the sentinel half of BotAvatar, kept in its
 * own leaf module on purpose.
 *
 * `BotAvatar.tsx` imports React, Radix and the bundled portrait; `botTemplates.ts`
 * only needs the sentinel string, and it is also imported by plain-Node tooling
 * (`scripts/seed-cindy-bots-offline-demo.mts` runs it through tsx, where a
 * `*.png` import has no loader). Keeping the constant dependency-free lets both
 * worlds share one value. `BotAvatar.tsx` re-exports everything here, so UI code
 * can keep importing the whole avatar vocabulary from one place.
 */

/**
 * Anything under this prefix resolves to artwork Cindy ships, so a Bot avatar
 * string is either a grapheme the user picked or a sentinel Cindy defined —
 * never a remote URL.
 */
export const CINDY_AVATAR_SCHEME_PREFIX = 'cindy://avatar/';

/** The official Cindy portrait, shared with the account avatar. */
export const CINDY_OFFICIAL_AVATAR = 'cindy://avatar/official';

/**
 * True for every value in the reserved namespace, not just the exact sentinel:
 * an older client that meets a future `cindy://avatar/<something-else>` must
 * render the official mark rather than paint a raw URL as if it were an emoji.
 */
export function isCindyOfficialAvatar(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase().startsWith(CINDY_AVATAR_SCHEME_PREFIX);
}
