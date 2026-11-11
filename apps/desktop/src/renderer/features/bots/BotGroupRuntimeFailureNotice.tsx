import { useTranslation } from 'react-i18next';
import { isBotGroupRuntimeFailureCode, readBotGroupRuntimeFailureReason } from '../../../shared/botGroupChat';

export function BotGroupRuntimeFailureNotice({ name, code, reason }: { name: string; code: unknown; reason?: unknown }) {
  const { t } = useTranslation();
  if (!isBotGroupRuntimeFailureCode(code)) return null;
  const publicReason = readBotGroupRuntimeFailureReason(code, reason);
  return <p className="mx-auto max-w-[560px] whitespace-pre-line text-center text-13 leading-5 text-[var(--text-primary)]">
    {t(publicReason ? `bots.groupChat.notice.runtimeFailureReason.${publicReason}` : `bots.groupChat.notice.runtimeFailure.${code}`, { name })}
  </p>;
}
