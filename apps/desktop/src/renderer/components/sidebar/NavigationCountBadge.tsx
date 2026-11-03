import { cn } from '@/lib/utils';
import { formatBotUnreadBadge } from '@/features/bots/botListDisplay';

/** Same 99+ overflow as the existing teammate unread pills. */
export function NavigationCountBadge({ count, label, className }: { count: number; label: string; className?: string }) {
  if (count <= 0) return null;
  return <span aria-label={label} title={label} className={cn(
    'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] px-1 text-10 font-medium tabular-nums leading-none text-[var(--text-primary)]',
    className,
  )}>{formatBotUnreadBadge(count)}</span>;
}
