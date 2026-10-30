import { useTranslation } from 'react-i18next';
import { isBotGroupRuntimeFailureCode } from '../../../shared/botGroupChat';

export function BotGroupRuntimeFailureNotice({ name, code }: { name: string; code: unknown }) {
  const { t } = useTranslation();
  if (!isBotGroupRuntimeFailureCode(code)) return null;
  return <p className="mx-auto max-w-[560px] whitespace-pre-line text-center text-13 leading-5 text-[var(--text-primary)]">
    {t(`bots.groupChat.notice.runtimeFailure.${code}`, { name })}
  </p>;
}
