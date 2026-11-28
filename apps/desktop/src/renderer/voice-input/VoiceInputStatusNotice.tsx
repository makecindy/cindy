import { CircleX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type VoiceInputStatusNoticeProps = {
  message: string;
  /** `info` is a passing explanation: no error icon, announced politely. */
  tone?: 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  className?: string;
  maxWidthClassName?: string;
};

export function VoiceInputStatusErrorIcon({ className }: { className?: string }) {
  return <CircleX className={cn('h-4 w-4 shrink-0 text-[var(--error-fg)]', className)} aria-hidden="true" />;
}

export function VoiceInputStatusNotice({
  message,
  tone = 'error',
  actionLabel,
  onAction,
  actionDisabled = false,
  className,
  maxWidthClassName = 'max-w-[640px]',
}: VoiceInputStatusNoticeProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto inline-flex items-center gap-2 rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] px-4 py-2.5',
        'text-13 font-medium leading-snug text-[var(--cmd-palette-item-text)] shadow-[shadow:var(--shadow-menu)]',
        maxWidthClassName,
        className,
      )}
    >
      {tone === 'error' && <VoiceInputStatusErrorIcon />}
      <span className="min-w-0 max-w-[calc(100vw-96px)] break-words">
        {message}
      </span>
      {actionLabel && onAction && (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          compact
          disabled={actionDisabled}
          onClick={onAction}
          className="ml-1 shrink-0 rounded-full"
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
