import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useFeishuBot } from '@/hooks/useFeishuBot';
import { useFeishuNotificationSettings } from '@/hooks/useFeishuNotificationSettings';
import { ImLifecycleAnnouncementSection } from './ImLifecycleAnnouncementSection';

export function FeishuBotNotificationSection() {
  const {
    hasSavedCreds,
    ownerOpenId,
    lifecycleAnnouncement,
    setLifecycleAnnouncement,
  } = useFeishuBot();
  const { enabled: sessionNotifyEnabled, setEnabled: setSessionNotifyEnabled } =
    useFeishuNotificationSettings();
  const { t } = useTranslation();

  const feishuReady = Boolean(ownerOpenId);

  // 兜底复位:覆盖"localStorage 残留 true 但 owner 未绑"的边缘态(旧版升级 /
  // 异常退出 / 其他 window 改的)。
  useEffect(() => {
    if (!feishuReady && sessionNotifyEnabled) {
      setSessionNotifyEnabled(false);
    }
  }, [feishuReady, sessionNotifyEnabled, setSessionNotifyEnabled]);

  if (!hasSavedCreds) return null;

  return (
    <>
      <ImLifecycleAnnouncementSection
        label={t('settings.feishuBot.lifecycleAnnouncement.label')}
        cellLabel={t('settings.feishuBot.lifecycleAnnouncement.cellLabel')}
        hint={t('settings.feishuBot.lifecycleAnnouncement.hint')}
        checked={lifecycleAnnouncement}
        onCheckedChange={setLifecycleAnnouncement}
      />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <ImLifecycleAnnouncementSection
        label={t('settings.feishuBot.sessionNotification.label')}
        cellLabel={t('settings.feishuBot.sessionNotification.cellLabel')}
        hint={
          feishuReady
            ? t('settings.feishuBot.sessionNotification.hint')
            : t('settings.feishuBot.sessionNotification.disabledHint')
        }
        checked={sessionNotifyEnabled && feishuReady}
        disabled={!feishuReady}
        onCheckedChange={(next) => {
          if (feishuReady) setSessionNotifyEnabled(next);
        }}
      />
    </>
  );
}
