/**
 * Reserved Cindy avatar namespace — the sentinel half of BotAvatar, kept in its
 * own leaf module on purpose.
 *
 * `BotAvatar.tsx` imports React, Radix and the bundled portraits; `botTemplates.ts`
 * only needs the sentinel strings, and it is also imported by plain-Node tooling
 * (`scripts/seed-cindy-bots-offline-demo.mts` runs it through tsx, where a
 * `*.png` import has no loader). Keeping the vocabulary dependency-free lets both
 * worlds share one value. `BotAvatar.tsx` re-exports everything here, so UI code
 * can keep importing the whole avatar vocabulary from one place. Never import an
 * asset into this file.
 */

/**
 * Anything under this prefix resolves to artwork Cindy ships, so a Bot avatar
 * string is either a grapheme the user picked or a sentinel Cindy defined —
 * never a remote URL.
 */
export const CINDY_AVATAR_SCHEME_PREFIX = 'cindy://avatar/';

/** The official Cindy portrait, shared with the account avatar. */
export const CINDY_OFFICIAL_AVATAR = 'cindy://avatar/official';

/** Sub-namespace for the shipped character set (preset portraits). */
export const CINDY_PRESET_AVATAR_PREFIX = `${CINDY_AVATAR_SCHEME_PREFIX}preset/`;

/**
 * Shipped character portraits. Order is stable — hash assignment depends on it,
 * and it is also the order of the picker's character row.
 */
export const BOT_PRESET_AVATAR_IDS = [
  'shiba',
  'whitecat',
  'robot',
  'dino',
  'melody',
  'star',
  'butler',
  'owl',
] as const;

export type BotPresetAvatarId = (typeof BOT_PRESET_AVATAR_IDS)[number];

/**
 * True for every value in the reserved namespace, official or preset or a value
 * only a newer client knows. Callers use it to decide "this is not a grapheme":
 * an older client that meets a future `cindy://avatar/<something-else>` must
 * never paint the raw string on screen as if it were an emoji.
 */
export function isCindyAvatarSentinel(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase().startsWith(CINDY_AVATAR_SCHEME_PREFIX);
}

/**
 * True only for the official Cindy portrait. Deliberately narrow: an unknown
 * member of the namespace is *not* Cindy herself, so it must not inherit the
 * official mark (that would brand an arbitrary Bot as official). Unknown values
 * fall back to the neutral initial in {@link isCindyAvatarSentinel} consumers.
 */
export function isCindyOfficialAvatar(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === CINDY_OFFICIAL_AVATAR;
}

/** Sentinel for a shipped character portrait. */
export function presetAvatarValue(id: BotPresetAvatarId): string {
  return `${CINDY_PRESET_AVATAR_PREFIX}${id}`;
}

/**
 * Strict parse: only ids this build ships resolve. A preset added by a newer
 * client returns null here, so the renderer falls back instead of pointing an
 * `<img>` at a bundle path that does not exist.
 */
export function parsePresetAvatarId(value: string | null | undefined): BotPresetAvatarId | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith(CINDY_PRESET_AVATAR_PREFIX)) return null;
  const id = normalized.slice(CINDY_PRESET_AVATAR_PREFIX.length);
  return (BOT_PRESET_AVATAR_IDS as readonly string[]).includes(id)
    ? (id as BotPresetAvatarId)
    : null;
}
