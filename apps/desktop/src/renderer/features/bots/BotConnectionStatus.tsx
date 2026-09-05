import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function BotConnectionStatus({
  online = true,
  deviceName,
}: {
  online?: boolean;
  deviceName?: string;
}) {
  const { t } = useTranslation();
  const label = `${t(online ? 'bots.remote.online' : 'bots.remote.offline')} · ${deviceName || t('bots.remote.thisDevice')}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar',
        online ? 'bg-[var(--remote-status-ready)]' : 'bg-[var(--text-tertiary)]',
      )}
    />
  );
}
