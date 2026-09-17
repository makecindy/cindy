import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function BotConnectionStatus({
  online = true,
  deviceName,
  activityLabel,
  inline = false,
  className,
}: {
  online?: boolean;
  deviceName?: string;
  activityLabel?: string;
  inline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const status = online && activityLabel?.trim()
    ? activityLabel.trim()
    : t(online ? 'bots.remote.online' : 'bots.remote.offline');
  const name = deviceName?.trim();
  const label = name ? `${status} · ${name}` : status;
  if (inline) {
    return (
      <span title={label} className={cn('min-w-0 truncate text-11 leading-normal', className)}>
        {label}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar',
        !online ? 'bg-[var(--text-tertiary)]'
          : activityLabel ? 'bg-[var(--warning-accent)]'
            : 'bg-[var(--remote-status-ready)]',
      )}
    />
  );
}
