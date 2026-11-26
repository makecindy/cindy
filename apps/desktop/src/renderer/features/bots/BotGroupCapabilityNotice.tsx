import { Link, useLocation } from 'react-router-dom';
import { BOT_GROUP_SETTINGS_PARAM } from './botGroupPresentation';
import { useTranslation } from 'react-i18next';
import { isBotGroupCapabilityNoticeCode } from '../../../shared/botGroupChat';

function ChooseComputerLink() {
  const { search } = useLocation();
  const { t } = useTranslation();
  const params = new URLSearchParams(search);
  params.set(BOT_GROUP_SETTINGS_PARAM, '1');
  return <Link className="ml-2 underline" to={{ search: params.toString() }}>{t('bots.groupChat.server.settings.chooseComputer')}</Link>;
}

/** A visible reason for one unavailable operation, independent of turn completion. */
export function BotGroupCapabilityNotice({ name, code, chooseDevice }: { name: string; code: unknown; chooseDevice?: boolean }) {
  const { t } = useTranslation();
  if (!isBotGroupCapabilityNoticeCode(code)) return null;
  return <p className="mx-auto max-w-[560px] whitespace-pre-line text-center text-13 leading-5 text-[var(--text-primary)]">
    {t(`bots.groupChat.notice.capability.${code}`, { name })}
    {chooseDevice && code === 'GROUP_ASSISTANT_DEVICE_REQUIRED' && <ChooseComputerLink />}
  </p>;
}
