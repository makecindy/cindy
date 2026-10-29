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
 *
 * A cloud companion's actor avatar (an `https://` public image, cloud-companions.md) also
 * arrives in `avatar` when the row is built from the cloud (its main computer is offline):
 * it renders as artwork too. Only a single grapheme is ever painted as text.
 */
import { rewriteToRemoteMediaOrigin } from '@/../shared/remoteMediaUrl';
import { useEffect, useState } from 'react';

import cindyPresetAvatar from '@/assets/bot-presets/cindy.png';
// Upgrade failure/older remote-host fallback only; migrated profiles use cindy-media.
import dashPresetAvatar from '../../../../resources/legacy-teammate-avatars/dash.png';
import liziPresetAvatar from '../../../../resources/legacy-teammate-avatars/lizi.png';
import { cn } from '@/lib/utils';
import { isManagedBotAvatarUrl, isSingleBotAvatarGrapheme } from '../../../shared/botAvatarValue';
import {
  BOT_AVATAR_HUES,
  botAvatarHueForSeed,
  botAvatarInitial,
  normalizeBotAvatarHue,
  type BotAvatarHue,
} from '../../../shared/botAvatarHue';
import { CINDY_AVATAR_SCHEME_PREFIX, isCindyAvatarSentinel } from './botAvatarIdentity';
import { useCachedCompanionAvatar, type CompanionAvatarSource } from './companionAvatarCache';

// The sentinel lives in an asset-free leaf module (see botAvatarIdentity.ts) but
// stays part of this module's public surface: UI code imports the avatar
// vocabulary from BotAvatar.
export { CINDY_AVATAR_SCHEME_PREFIX, isCindyAvatarSentinel };
// Hue and initial are shared with the main process (Agent Island) and re-exported here.
export { BOT_AVATAR_HUES, botAvatarHueForSeed, botAvatarInitial, normalizeBotAvatarHue, type BotAvatarHue };

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

export function botAvatarHueToken(value: string | null | undefined): string {
  return HUE_TOKENS[normalizeBotAvatarHue(value)];
}

export interface BotAvatarProps {
  /** Bot-shaped source; only these three fields are read. */
  bot: { avatarUrl?: string | null; deviceId?: string; name: string; avatar?: string | null; avatarColor?: string | null };
  size?: BotAvatarSize;
  className?: string;
}

export function BotAvatar({ bot, size = 'md', className }: BotAvatarProps) {
  const emoji = (bot.avatar ?? '').trim();
  const bundledArtwork = BUNDLED_AVATAR_BY_SENTINEL[emoji.toLowerCase()] ?? null;
  const publicArtwork = [bot.avatarUrl, emoji].find((value) => value?.startsWith('https://')) ?? null;
  // Avatars held elsewhere (another computer, the cloud) are read from this computer's copy first.
  const remoteManaged = !publicArtwork && !bundledArtwork && !!bot.deviceId && isManagedBotAvatarUrl(emoji);
  const cacheSource: CompanionAvatarSource | null = publicArtwork ? { avatar: publicArtwork, deviceId: null }
    : remoteManaged ? { avatar: emoji, deviceId: bot.deviceId! } : null;
  const cached = useCachedCompanionAvatar(cacheSource);
  const original = publicArtwork ?? bundledArtwork ?? (isManagedBotAvatarUrl(emoji) ? rewriteToRemoteMediaOrigin(emoji, bot.deviceId ? { kind: 'device', deviceId: bot.deviceId } : undefined) : null);
  // While the local lookup runs, only the tint shows (no initial flashing before the image).
  const waiting = cached === undefined;
  // The local copy first; if it cannot load (e.g. recycled meanwhile), the original address.
  const candidates = waiting ? [] : [...new Set([cached, original].filter((value): value is string => !!value))];
  const candidateKey = candidates.join('\n');
  const [failed, setFailed] = useState<readonly string[]>([]);
  useEffect(() => setFailed([]), [candidateKey]);
  const visibleArtwork = candidates.find((candidate) => !failed.includes(candidate)) ?? null;
  // Anything that is not one grapheme (an unresolved sentinel, an address whose image failed)
  // falls through to the initial rather than painting the raw string.
  const glyph = !visibleArtwork && isSingleBotAvatarGrapheme(emoji) ? emoji : '';
  const initial = waiting ? '' : botAvatarInitial(bot.name);
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
          referrerPolicy="no-referrer"
          src={visibleArtwork}
          alt=""
          draggable={false}
          onError={() => setFailed((previous) => [...previous, visibleArtwork])}
          className="pointer-events-none h-full w-full select-none rounded-full object-cover"
        />
      ) : glyph ? (
        <span>{glyph}</span>
      ) : (
        <span className="font-medium text-[var(--text-primary)]">{initial}</span>
      )}
    </span>
  );
}
