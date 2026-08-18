import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * The ⚠ mark next to a hands-on teammate's name.
 *
 * Product ruling (Chris, 2026-08-18): acting without asking is the default, and
 * the risk is carried by an *after the fact* marker rather than an up-front
 * permission gate — "开了么在 bot 名字变成一个感叹号". Icon-only, per the
 * existing status-badge ruling (no text label next to state icons).
 *
 * Two shapes: a plain marker (sidebar rows, which are already inside a button)
 * and a button that deep-links to the "hands-on" chip (settings header).
 */
export function BotTrustedBadge({
  onClick,
  className,
}: {
  /** When given, the badge becomes the shortcut to the capability chip. */
  onClick?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t('bots.trustedBadge.label');
  if (!onClick) {
    return (
      <TriangleAlert
        size={13}
        role="img"
        aria-label={label}
        className={cn('shrink-0 text-[var(--warning-fg)]', className)}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--warning-fg)] hover:bg-[var(--surface-hover)]',
        className,
      )}
    >
      <TriangleAlert size={13} aria-hidden />
    </button>
  );
}
