import { Button } from '@/components/ui/button';

/**
 * One block of settings the instance did not answer: a line and a compact 「重新读取」, as the
 * client's Telegram behaviour settings show a failed read (TelegramBehaviorSettings.tsx,
 * SettingsRequestError, not exported; copied as is).
 */
export function CloudRequestError({
  message,
  retryLabel,
  onRetry,
  disabled = false,
}: {
  message: string;
  retryLabel?: string;
  onRetry?(): void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-11 text-[var(--settings-section-desc)]">
      <span>{message}</span>
      {onRetry && retryLabel && (
        <Button variant="secondary" size="sm" compact type="button" disabled={disabled} onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
