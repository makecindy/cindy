import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

export function ComputerPermissionRow({
  label,
  iconSrc,
  granted,
  pending,
  actionLabel,
  onAction,
  compact = false,
}: {
  compact?: boolean;
  label: string;
  iconSrc: string;
  granted: boolean;
  pending: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onAction}
      disabled={pending}
      className={cn(
        'flex w-full min-w-0 items-center text-left',
        compact
          ? 'min-h-8 gap-2 rounded-md py-1'
          : 'min-h-[64px] gap-3 rounded-xl border border-solid border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3.5 py-3',
        'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
        'disabled:cursor-default disabled:hover:bg-[var(--settings-input-bg)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      <img
        className={cn(
          'shrink-0 object-contain grayscale opacity-70',
          compact ? 'size-4' : 'size-8',
        )}
        src={iconSrc}
        alt=""
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--settings-section-title)]">
        {label}
      </span>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium',
          compact ? 'h-6 px-2 text-11' : 'h-8 px-3 text-12',
          compact && !pending && granted
            ? 'border border-transparent bg-transparent text-[var(--settings-section-sublabel)]'
            : pending
              ? 'border border-dashed border-[var(--settings-input-border)] bg-[var(--surface-chip)] text-[var(--settings-section-desc)]'
              : granted
                ? 'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] text-[var(--settings-section-title)]'
                : 'border border-[var(--surface-chip)] bg-[var(--surface-chip)] text-[var(--settings-section-title)]',
        )}
      >
        {pending ? <Spinner size={12} /> : null}
        <span>{actionLabel}</span>
        {granted && !pending ? <Check size={13} strokeWidth={2.3} aria-hidden="true" /> : null}
      </span>
    </button>
  );
}
