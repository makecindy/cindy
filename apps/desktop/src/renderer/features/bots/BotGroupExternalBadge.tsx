import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Compact 「外部 / External」 pill shown exclusively to enterprise viewers on external groups
 * and external human members (DESIGN.md §2, bot-group-chat.md §5).
 * Uses the registered `--status-info` token so Light/Dark and custom themes stay legible without hex literals.
 */
export function BotGroupExternalBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-testid="bot-group-external-badge"
      className={cn(
        'inline-flex shrink-0 select-none items-center rounded px-1.5 py-px text-11 font-medium leading-[1.35]',
        'bg-[color-mix(in_srgb,var(--status-info)_14%,transparent)] text-[var(--status-info)]',
        className,
      )}
    >
      {t('bots.groupChat.externalBadge')}
    </span>
  );
}
