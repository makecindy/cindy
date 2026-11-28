import { useTranslation } from 'react-i18next';
import { isBotGroupCapabilityNoticeCode } from '../../../shared/botGroupChat';

/**
 * A visible reason for one unavailable operation, independent of turn completion. The group
 * Cindy's wait for a computer is the requester's own card above the composer, not a notice here.
 */
export function BotGroupCapabilityNotice({ name, code }: { name: string; code: unknown }) {
  const { t } = useTranslation();
  if (!isBotGroupCapabilityNoticeCode(code)) return null;
  return <p className="mx-auto max-w-[560px] whitespace-pre-line text-center text-13 leading-5 text-[var(--text-primary)]">
    {t(`bots.groupChat.notice.capability.${code}`, { name })}
  </p>;
}
