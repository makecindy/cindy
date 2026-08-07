import { useTranslation } from 'react-i18next';

import { useFeishuBot } from '@/hooks/useFeishuBot';
import { ImLifecycleAnnouncementSection } from './ImLifecycleAnnouncementSection';

export function FeishuBotNotificationSection() {
  const {
    hasSavedCreds,
    lifecycleAnnouncement,
    setLifecycleAnnouncement,
  } = useFeishuBot();
  const { t } = useTranslation();

  if (!hasSavedCreds) return null;

  return (
    <ImLifecycleAnnouncementSection
      label={t('settings.feishuBot.lifecycleAnnouncement.label')}
      cellLabel={t('settings.feishuBot.lifecycleAnnouncement.cellLabel')}
      hint={t('settings.feishuBot.lifecycleAnnouncement.hint')}
      checked={lifecycleAnnouncement}
      onCheckedChange={setLifecycleAnnouncement}
    />
  );
}
