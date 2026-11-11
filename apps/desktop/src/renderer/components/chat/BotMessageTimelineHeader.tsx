import { useTranslation } from 'react-i18next';
import { formatBotMessageGroupTime } from '@/features/bots/botConversationTimeline';

/** Stream-owned separators preceding a message, outside its content/selection body. */
export function BotMessageTimelineHeader({
  startsUnread,
  groupTimestamp,
}: {
  startsUnread: boolean;
  groupTimestamp?: number;
}) {
  const { t, i18n } = useTranslation();
  return (
    <>
      {startsUnread ? (
        <div
          data-selection-quote-scope=""
          className="mb-3 flex items-center gap-3"
          role="separator"
          aria-label={t('bots.chat.newMessagesBoundary')}
        >
          <div className="h-px flex-1 bg-[var(--bot-unread-bg)] opacity-30" />
          <span className="shrink-0 text-11 font-medium tracking-[0.08em] text-[var(--bot-unread-bg)]">
            {t('bots.chat.newMessagesBoundary')}
          </span>
          <div className="h-px flex-1 bg-[var(--bot-unread-bg)] opacity-30" />
        </div>
      ) : null}
      {groupTimestamp !== undefined ? (
        <time
          data-selection-quote-scope=""
          dateTime={new Date(groupTimestamp).toISOString()}
          className="mb-3 block text-center text-11 text-[var(--text-tertiary)]"
        >
          {formatBotMessageGroupTime(groupTimestamp, i18n.resolvedLanguage ?? i18n.language)}
        </time>
      ) : null}
    </>
  );
}
