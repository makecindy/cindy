/**
 * Kbd (DESIGN.md §4 Badges): a keyboard shortcut keycap such as "Esc" or "Enter".
 *
 * The keycap frame is the registered 4px shape (§5 Keyboard keycap), never a pill. `default` sits
 * on ordinary surfaces; `onSolid` sits inside the filled "Allow" action of permission-style
 * confirmation cards and follows that button's theme slots (`--perm-allow-*`).
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export type KbdTone = 'default' | 'onSolid';

const TONE_CLASS: Record<KbdTone, string> = {
  default: 'border-[var(--border-default)] bg-[var(--perm-code-bg)] text-[var(--text-secondary)]',
  onSolid:
    'border-[var(--perm-allow-kbd-border)] bg-[var(--perm-allow-kbd-bg)] text-[var(--perm-allow-btn-text)] opacity-70',
};

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  tone?: KbdTone;
}

export function Kbd({ tone = 'default', className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn('rounded-[4px] border px-1.5 py-px text-11 font-normal', TONE_CLASS[tone], className)}
      {...props}
    />
  );
}
