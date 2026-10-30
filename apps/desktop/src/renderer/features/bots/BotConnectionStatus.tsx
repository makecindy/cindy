import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Cached/unknown connectivity must never be presented as offline. */
export function isBotKnownOffline(online?: boolean | null, connectionKnown?: boolean): boolean {
  return online === false && connectionKnown !== false;
}

export function BotConnectionStatus({
  online = true,
  connectionKnown,
  deviceName,
  inline = false,
  quiet = false,
  className,
}: {
  online?: boolean | null;
  connectionKnown?: boolean;
  /**
   * A cloud companion (docs/product-rules/cloud-companions.md §3.1): like IM, its main computer
   * being unreachable is not announced; only a message that cannot be delivered says so.
   */
  quiet?: boolean;
  deviceName?: string;
  inline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const offline = !quiet && isBotKnownOffline(online, connectionKnown);
  const status = offline ? t('bots.remote.offline') : '';
  const name = deviceName?.trim();
  const label = [status, name].filter(Boolean).join(' · ');
  if (inline) {
    if (!label) return null;
    return (
      <span title={label} className={cn('min-w-0 truncate text-11 leading-normal', className)}>
        {label}
      </span>
    );
  }
  if (!offline) return null;
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar',
        'bg-[var(--remote-status-failed)]',
      )}
    />
  );
}
