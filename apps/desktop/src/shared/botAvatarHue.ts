/**
 * Bot avatar hue and initial — the asset-free half of BotAvatar, shared so the
 * main process can paint the same identity mark outside the renderer (the macOS
 * Agent Island). Colors stay with their consumers: the renderer resolves the
 * registered `--bot-avatar-*-bg` tokens, the native island its own dark palette.
 */

/** Registered hue family. Order is stable — hash assignment depends on it. */
export const BOT_AVATAR_HUES = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'graphite',
] as const;

export type BotAvatarHue = (typeof BOT_AVATAR_HUES)[number];

/** FNV-1a over UTF-16 code units: stable across runs, platforms and locales. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function botAvatarHueForSeed(seed: string): BotAvatarHue {
  return BOT_AVATAR_HUES[hashSeed(seed) % BOT_AVATAR_HUES.length];
}

export function normalizeBotAvatarHue(value: string | null | undefined): BotAvatarHue {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((BOT_AVATAR_HUES as readonly string[]).includes(candidate)) return candidate as BotAvatarHue;
  // Historical rows only ever stored the four names above, all of which are
  // family members. Keep unknown values deterministic rather than defaulting
  // every one of them to a single hue.
  if (!candidate) return 'violet';
  return botAvatarHueForSeed(candidate);
}

/** First grapheme of the name, uppercased — the fallback when avatar is empty. */
export function botAvatarInitial(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const segmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;
  const first = segmenter
    ? (segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? '')
    : (Array.from(trimmed)[0] ?? '');
  return first.toUpperCase();
}
