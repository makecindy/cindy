/**
 * Badges (DESIGN.md §4 Badges): short non-interactive labels and counts.
 *
 * - Badge: a pill label such as "Recommended", "Beta", "Customized" or a version. Gray chip by
 *   default (`sm`: 11px text, 8px sides, about 18px tall). `xs` (10px) is for counts and dense
 *   lists, `md` (12px) for chat cards such as the plan bubble. Text keeps its own case; there is no
 *   uppercase variant. `outline` trades the fill for a 1px border without changing the height.
 * - CountBadge: a 16px round number for unread or pending counts. The visible number is capped
 *   (`99+`); screen readers read `label` instead (the badge is a labelled image).
 *
 * Badges are labels, not controls: a clickable chip is a Button, a removable chip an input chip.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

// Only tones with a consumer; add a status tone through DESIGN.md §4 Badges when one is needed.
export type BadgeTone = 'neutral' | 'outline' | 'accent' | 'plan';
export type BadgeSize = 'xs' | 'sm' | 'md';

const SIZE_CLASS: Record<BadgeSize, string> = {
  xs: 'gap-0.5 px-1.5 text-10 leading-[1.4]',
  sm: 'gap-1 px-2 text-11 leading-[1.45]',
  md: 'gap-1 px-2 text-12 leading-[1.5]',
};

// The outline border takes 1px of the vertical padding so both looks share one height.
const PADDING_Y_CLASS: Record<BadgeSize, { filled: string; outline: string }> = {
  xs: { filled: 'py-px', outline: 'py-0' },
  sm: { filled: 'py-px', outline: 'py-0' },
  md: { filled: 'py-0.5', outline: 'py-px' },
};

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
  outline: 'border border-[var(--border-default)] text-[var(--text-secondary)]',
  accent: 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
  // Plan review bubble: keeps its own theme slots so custom themes can still restyle it.
  plan: 'bg-[var(--plan-bubble-badge-bg)] text-[var(--plan-bubble-badge-text)]',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Monospace text for commands, versions and identifiers. */
  mono?: boolean;
  /** Leading icon, about the text size (10–12px); hidden from screen readers. */
  icon?: React.ReactNode;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', size = 'sm', mono = false, icon, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex shrink-0 select-none items-center whitespace-nowrap rounded-full font-medium',
        SIZE_CLASS[size],
        PADDING_Y_CLASS[size][tone === 'outline' ? 'outline' : 'filled'],
        TONE_CLASS[tone],
        mono && 'font-mono',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span aria-hidden className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
});

export type CountBadgeTone = 'neutral' | 'unread';

const COUNT_TONE_CLASS: Record<CountBadgeTone, string> = {
  neutral: 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
  // IM unread blue, registered in DESIGN.md §2 (Bot Unread Badge).
  unread: 'bg-[var(--bot-unread-bg)] text-[var(--bot-unread-fg)]',
};

export interface CountBadgeProps {
  count: number;
  /** Larger counts show as `${max}+`. */
  max?: number;
  tone?: CountBadgeTone;
  /** Full meaning for screen readers and the hover title, e.g. "3 unread messages". */
  label?: string;
  className?: string;
}

export function CountBadge({ count, max = 99, tone = 'neutral', label, className }: CountBadgeProps) {
  if (count <= 0) return null;
  // With a label the badge is a named image: assistive tech reads the label (also inside the
  // name of the row or button around it) and never the clipped "99+".
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-4 min-w-4 shrink-0 select-none items-center justify-center rounded-full px-1 text-10 font-medium tabular-nums leading-none',
        COUNT_TONE_CLASS[tone],
        className,
      )}
    >
      <span aria-hidden={label ? true : undefined}>{count > max ? `${max}+` : String(count)}</span>
    </span>
  );
}
