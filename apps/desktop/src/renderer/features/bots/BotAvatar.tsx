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
 */
import { useMemo, useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

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
  sm: 'h-7 w-7 text-14',
  md: 'h-10 w-10 text-20',
  lg: 'h-14 w-14 text-28',
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

export function botAvatarEmojiForSeed(seed: string): string {
  // Offset the emoji hash so hue and emoji do not advance in lockstep for
  // adjacent names ("Bot 1" / "Bot 2" would otherwise stay visually paired).
  return BOT_AVATAR_EMOJIS[hashSeed(`${seed}#emoji`) % BOT_AVATAR_EMOJIS.length];
}

export interface BotAvatarAssignment {
  hue: BotAvatarHue;
  emoji: string;
}

/** Same name → same avatar, so a new Bot looks intentional before any edit. */
export function botAvatarAssignment(seed: string): BotAvatarAssignment {
  return { hue: botAvatarHueForSeed(seed), emoji: botAvatarEmojiForSeed(seed) };
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
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full leading-none',
        SIZE_CLASSES[size],
        className,
      )}
      style={{ backgroundColor: botAvatarHueToken(bot.avatarColor) }}
    >
      {emoji ? (
        <span>{emoji}</span>
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
 * Avatar editor: the avatar itself is the trigger, the panel is an emoji grid
 * plus a hue row. Panel geometry follows DESIGN.md §4 Select & Dropdown —
 * 12px container, Card fill, 1px Board border, 8px option-row highlights.
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
            'z-50 w-[268px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2 outline-none',
            'data-[state=open]:animate-float-in data-[state=closed]:animate-float-out',
          )}
        >
          <p className="px-1 pb-1 text-11 text-[var(--text-tertiary)]">
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
                  'flex h-8 w-8 items-center justify-center rounded-lg text-14 transition-colors',
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
