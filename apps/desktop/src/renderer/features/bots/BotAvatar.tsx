/**
 * BotAvatar — the single Bot identity mark used by every Bot surface.
 *
 * One component, one shape: a flat round tint with a centered emoji (or the
 * name's first grapheme when a Bot has no emoji yet). Colors come from the
 * registered `--bot-avatar-*-bg` family (DESIGN.md §2 / §10 "Bot Avatar Hues");
 * never inline a hex here and never borrow a text/focus token as a fill — the
 * pre-redesign avatar did exactly that and painted emoji onto the focus ring.
 *
 * Legacy data compatibility: the four historical `avatarColor` values
 * (violet / blue / amber / graphite) are members of the new hue family, so old
 * rows resolve without any data migration. Anything unrecognized is hashed into
 * a stable hue instead of collapsing every legacy Bot onto one color.
 *
 * A managed-URL `avatar` (an uploaded image, normalized by main) and a known
 * bundled preset sentinel render as an `<img>`. Any unknown
 * `cindy://avatar/…` sentinel is not a grapheme, so it falls back to the neutral
 * initial instead of painting the raw sentinel string as text.
 */
import { useEffect, useState } from 'react';

import cindyPresetAvatar from '@/assets/bot-presets/cindy.png';
import dashPresetAvatar from '@/assets/bot-presets/dash.png';
import liziPresetAvatar from '@/assets/bot-presets/lizi.png';
import { cn } from '@/lib/utils';
import { isManagedBotAvatarUrl } from '../../../shared/botAvatarValue';
import { CINDY_AVATAR_SCHEME_PREFIX, isCindyAvatarSentinel } from './botAvatarIdentity';

// The sentinel lives in an asset-free leaf module (see botAvatarIdentity.ts) but
// stays part of this module's public surface: UI code imports the avatar
// vocabulary from BotAvatar.
export { CINDY_AVATAR_SCHEME_PREFIX, isCindyAvatarSentinel };

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

const HUE_TOKENS: Record<BotAvatarHue, string> = {
  red: 'var(--bot-avatar-red-bg)',
  orange: 'var(--bot-avatar-orange-bg)',
  amber: 'var(--bot-avatar-amber-bg)',
  green: 'var(--bot-avatar-green-bg)',
  teal: 'var(--bot-avatar-teal-bg)',
  blue: 'var(--bot-avatar-blue-bg)',
  violet: 'var(--bot-avatar-violet-bg)',
  pink: 'var(--bot-avatar-pink-bg)',
  graphite: 'var(--bot-avatar-graphite-bg)',
};

const BUNDLED_AVATAR_BY_SENTINEL: Readonly<Record<string, string>> = {
  'cindy://avatar/preset/cindy': cindyPresetAvatar,
  'cindy://avatar/preset/dash': dashPresetAvatar,
  'cindy://avatar/preset/lizi': liziPresetAvatar,
};

const SIZE_CLASSES = {
  /** 20px — the ContentHeader lockup, where the mark sits next to 13px text. */
  xs: 'h-5 w-5 text-11',
  sm: 'h-7 w-7 text-14',
  md: 'h-10 w-10 text-20',
  lg: 'h-14 w-14 text-28',
  /** 64px — the roster card portrait. `text-28` is the top of the numeric scale. */
  xl: 'h-16 w-16 text-28',
} as const;

export type BotAvatarSize = keyof typeof SIZE_CLASSES;

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

export interface BotAvatarAssignment {
  hue: BotAvatarHue;
  /** Grapheme or reserved sentinel — the same shape as `BotProfile.avatar`. */
  emoji: string;
}

/**
 * Same name → same hue, so a new Bot looks intentional before any edit. There is
 * no auto-assigned character or emoji anymore: a fresh Bot starts on the hue
 * tint plus its name's initial, and only ever changes if the Bot's own name
 * changes.
 */
export function botAvatarAssignment(seed: string): BotAvatarAssignment {
  return { hue: botAvatarHueForSeed(seed), emoji: '' };
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

export function botAvatarHueToken(value: string | null | undefined): string {
  return HUE_TOKENS[normalizeBotAvatarHue(value)];
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

export interface BotAvatarProps {
  /** Bot-shaped source; only these three fields are read. */
  bot: { name: string; avatar?: string | null; avatarColor?: string | null };
  size?: BotAvatarSize;
  className?: string;
}

export function BotAvatar({ bot, size = 'md', className }: BotAvatarProps) {
  const emoji = (bot.avatar ?? '').trim();
  const bundledArtwork = BUNDLED_AVATAR_BY_SENTINEL[emoji.toLowerCase()] ?? null;
  const artwork = bundledArtwork ?? (isManagedBotAvatarUrl(emoji) ? emoji : null);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [artwork]);
  const visibleArtwork = imageFailed ? null : artwork;
  // An unresolved sentinel (a preset only a newer client knows) is still not a
  // grapheme: fall through to the initial rather than paint `cindy://avatar/…`.
  const glyph = visibleArtwork || isCindyAvatarSentinel(emoji) || isManagedBotAvatarUrl(emoji)
    ? ''
    : emoji;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full leading-none',
        SIZE_CLASSES[size],
        className,
      )}
      // Kept even for artwork: the hue is what shows through while the bundled
      // image decodes, so the avatar never flashes white.
      style={{ backgroundColor: botAvatarHueToken(bot.avatarColor) }}
    >
      {visibleArtwork ? (
        <img
          src={visibleArtwork}
          alt=""
          draggable={false}
          onError={() => setImageFailed(true)}
          className="pointer-events-none h-full w-full select-none rounded-full object-cover"
        />
      ) : glyph ? (
        <span>{glyph}</span>
      ) : (
        <span className="font-medium text-[var(--text-primary)]">{botAvatarInitial(bot.name)}</span>
      )}
    </span>
  );
}
