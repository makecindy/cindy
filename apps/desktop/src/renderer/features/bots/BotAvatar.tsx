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
 * One exception to "flat tint + emoji": shipped artwork. `avatar` may hold a
 * `cindy://avatar/…` sentinel instead of a grapheme — the official Cindy mark or
 * one of the preset characters — which resolves to a bundled portrait. The
 * official mark is reserved: auto-assignment only ever mints a preset character,
 * so an official-looking Bot is always an explicit template or user choice. A
 * sentinel this build does not know (a preset added by a newer client) renders
 * the neutral initial rather than a broken image or a raw URL.
 */
import { useMemo, useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useTranslation } from 'react-i18next';

import cindyOfficialAvatarSrc from '@/assets/cindy-avatar-account.png';
import presetButlerSrc from '@/assets/bot-avatar-preset-butler.png';
import presetDinoSrc from '@/assets/bot-avatar-preset-dino.png';
import presetMelodySrc from '@/assets/bot-avatar-preset-melody.png';
import presetOwlSrc from '@/assets/bot-avatar-preset-owl.png';
import presetRobotSrc from '@/assets/bot-avatar-preset-robot.png';
import presetShibaSrc from '@/assets/bot-avatar-preset-shiba.png';
import presetStarSrc from '@/assets/bot-avatar-preset-star.png';
import presetWhitecatSrc from '@/assets/bot-avatar-preset-whitecat.png';
import { cn } from '@/lib/utils';
import {
  BOT_PRESET_AVATAR_IDS,
  CINDY_AVATAR_SCHEME_PREFIX,
  CINDY_OFFICIAL_AVATAR,
  CINDY_PRESET_AVATAR_PREFIX,
  isCindyAvatarSentinel,
  isCindyOfficialAvatar,
  parsePresetAvatarId,
  presetAvatarValue,
  type BotPresetAvatarId,
} from './botAvatarIdentity';

// The sentinels live in an asset-free leaf module (see botAvatarIdentity.ts) but
// stay part of this module's public surface: UI code imports the whole avatar
// vocabulary from BotAvatar.
export {
  BOT_PRESET_AVATAR_IDS,
  CINDY_AVATAR_SCHEME_PREFIX,
  CINDY_OFFICIAL_AVATAR,
  CINDY_PRESET_AVATAR_PREFIX,
  isCindyAvatarSentinel,
  isCindyOfficialAvatar,
  parsePresetAvatarId,
  presetAvatarValue,
  type BotPresetAvatarId,
};

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

/** Bundled artwork for {@link CINDY_OFFICIAL_AVATAR}. */
export const CINDY_OFFICIAL_AVATAR_SRC = cindyOfficialAvatarSrc;

/**
 * Bundled artwork for every shipped character. Keys are exhaustive by type, so a
 * new id in `BOT_PRESET_AVATAR_IDS` cannot ship without its portrait.
 */
export const BOT_PRESET_AVATAR_SRC: Record<BotPresetAvatarId, string> = {
  shiba: presetShibaSrc,
  whitecat: presetWhitecatSrc,
  robot: presetRobotSrc,
  dino: presetDinoSrc,
  melody: presetMelodySrc,
  star: presetStarSrc,
  butler: presetButlerSrc,
  owl: presetOwlSrc,
};

/**
 * Bundled portrait for an avatar value, or null when the value is a grapheme or a
 * sentinel this build cannot resolve. Single resolver for every Bot surface so no
 * caller has to re-derive "is this artwork".
 */
export function botAvatarArtworkSrc(value: string | null | undefined): string | null {
  if (isCindyOfficialAvatar(value)) return CINDY_OFFICIAL_AVATAR_SRC;
  const preset = parsePresetAvatarId(value);
  return preset ? BOT_PRESET_AVATAR_SRC[preset] : null;
}

/**
 * Curated emoji set: assistant / tool / nature / interstellar, deliberately
 * single-codepoint (plus the historical 🛠️) so they render the same on macOS,
 * Windows and Linux without ZWJ or skin-tone fallbacks.
 */
export const BOT_AVATAR_EMOJIS = [
  '🤖',
  '🧭',
  '🛠️',
  '📡',
  '🚀',
  '🛰️',
  '🔭',
  '☄️',
  '✨',
  '⭐',
  '🌙',
  '⚡',
  '🔮',
  '🧩',
  '🧠',
  '📘',
  '📌',
  '🌿',
  '🌊',
  '🌸',
  '🍀',
  '🐧',
  '🦊',
  '🐳',
] as const;

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

export function botAvatarPresetForSeed(seed: string): BotPresetAvatarId {
  // Salt the character hash so hue and character do not advance in lockstep for
  // adjacent names ("Bot 1" / "Bot 2" would otherwise stay visually paired).
  return BOT_PRESET_AVATAR_IDS[hashSeed(`${seed}#preset`) % BOT_PRESET_AVATAR_IDS.length];
}

export interface BotAvatarAssignment {
  hue: BotAvatarHue;
  /** Grapheme or reserved sentinel — the same shape as `BotProfile.avatar`. */
  emoji: string;
}

/**
 * Same name → same avatar, so a new Bot looks intentional before any edit.
 *
 * Auto-assignment hands out a shipped *character*, not an emoji: a fresh Bot then
 * reads as a persistent companion instead of a glyph on a colored disc. The
 * official Cindy mark stays out of the pool (it must remain an explicit template
 * or user choice), and the emoji set stays available in the picker.
 */
export function botAvatarAssignment(seed: string): BotAvatarAssignment {
  return { hue: botAvatarHueForSeed(seed), emoji: presetAvatarValue(botAvatarPresetForSeed(seed)) };
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
  const artwork = botAvatarArtworkSrc(emoji);
  // An unresolved sentinel (a preset only a newer client knows) is still not a
  // grapheme: fall through to the initial rather than paint `cindy://avatar/…`.
  const glyph = artwork || isCindyAvatarSentinel(emoji) ? '' : emoji;
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
      {artwork ? (
        <img
          src={artwork}
          alt=""
          draggable={false}
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

export interface BotAvatarPickerProps {
  name: string;
  avatar: string;
  avatarColor: string;
  onChange: (next: BotAvatarAssignment) => void;
  size?: BotAvatarSize;
  /** Rendered under the avatar inside the trigger, e.g. an edit affordance. */
  triggerLabel?: ReactNode;
  disabled?: boolean;
}

/**
 * Avatar editor: the avatar itself is the trigger, the panel is a character row,
 * an emoji grid and a hue row — characters first, because that is what a Bot
 * should look like by default. Panel geometry follows DESIGN.md §4 Select &
 * Dropdown — 12px container, Card fill, 1px Board border, 8px option-row
 * highlights. Cells are width-flexible so a row never overflows the panel.
 */
export function BotAvatarPicker({
  name,
  avatar,
  avatarColor,
  onChange,
  size = 'md',
  triggerLabel,
  disabled,
}: BotAvatarPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hue = useMemo(() => normalizeBotAvatarHue(avatarColor), [avatarColor]);
  const officialSelected = isCindyOfficialAvatar(avatar);
  const selectedPreset = useMemo(() => parsePresetAvatarId(avatar), [avatar]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('bots.avatarPicker.open')}
          className={cn(
            'relative inline-flex shrink-0 items-center justify-center rounded-full border border-transparent transition-colors',
            'hover:border-[var(--border-default)] focus-visible:border-[var(--focus-ring)] focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <BotAvatar bot={{ name, avatar, avatarColor: hue }} size={size} />
          {triggerLabel}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className={cn(
            'z-50 w-[300px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2 outline-none',
            'data-[state=open]:animate-float-in data-[state=closed]:animate-float-out',
          )}
        >
          <p className="px-1 pb-1 text-11 text-[var(--text-tertiary)]">
            {t('bots.avatarPicker.charactersLabel')}
          </p>
          <div className="grid grid-cols-9 gap-0.5">
            {/* The official Cindy mark leads the character row; same cell
                geometry and selected state as every other cell, only the glyph
                is artwork. */}
            <button
              type="button"
              onClick={() => onChange({ hue, emoji: CINDY_OFFICIAL_AVATAR })}
              aria-pressed={officialSelected}
              aria-label={t('bots.avatarPicker.official')}
              className={cn(
                'flex h-8 w-full items-center justify-center rounded-lg transition-colors',
                officialSelected
                  ? 'bg-[var(--surface-chip)]'
                  : 'hover:bg-[var(--surface-hover)]',
              )}
            >
              <img
                src={CINDY_OFFICIAL_AVATAR_SRC}
                alt=""
                aria-hidden
                draggable={false}
                className="pointer-events-none h-6 w-6 select-none rounded-full object-cover"
              />
            </button>
            {BOT_PRESET_AVATAR_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onChange({ hue, emoji: presetAvatarValue(id) })}
                aria-pressed={selectedPreset === id}
                aria-label={t(`bots.avatarPicker.presets.${id}`)}
                className={cn(
                  'flex h-8 w-full items-center justify-center rounded-lg transition-colors',
                  selectedPreset === id
                    ? 'bg-[var(--surface-chip)]'
                    : 'hover:bg-[var(--surface-hover)]',
                )}
              >
                <img
                  src={BOT_PRESET_AVATAR_SRC[id]}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="pointer-events-none h-6 w-6 select-none rounded-full object-cover"
                />
              </button>
            ))}
          </div>
          <p className="px-1 pb-1 pt-2 text-11 text-[var(--text-tertiary)]">
            {t('bots.avatarPicker.emojiLabel')}
          </p>
          <div className="grid grid-cols-8 gap-0.5">
            {BOT_AVATAR_EMOJIS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onChange({ hue, emoji: item })}
                aria-pressed={avatar === item}
                aria-label={t('bots.chooseAvatar', { avatar: item })}
                className={cn(
                  'flex h-8 w-full items-center justify-center rounded-lg text-14 transition-colors',
                  avatar === item
                    ? 'bg-[var(--surface-chip)]'
                    : 'hover:bg-[var(--surface-hover)]',
                )}
              >
                <span aria-hidden>{item}</span>
              </button>
            ))}
          </div>
          <p className="px-1 pb-1 pt-2 text-11 text-[var(--text-tertiary)]">
            {t('bots.avatarPicker.hueLabel')}
          </p>
          <div className="flex flex-wrap gap-1 px-1 pb-1">
            {BOT_AVATAR_HUES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onChange({ hue: item, emoji: avatar })}
                aria-pressed={hue === item}
                aria-label={t('bots.chooseAvatarColor', { color: item })}
                className={cn(
                  'h-6 w-6 rounded-full border transition-colors',
                  hue === item
                    ? 'border-[var(--text-primary)]'
                    : 'border-[var(--border-default)]',
                )}
                style={{ backgroundColor: HUE_TOKENS[item] }}
              />
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
