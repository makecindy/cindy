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
    <FeishuBotNotificationSectionView
      ownerBound={feishuReady}
      lifecycleAnnouncement={lifecycleAnnouncement}
      setLifecycleAnnouncement={setLifecycleAnnouncement}
      sessionNotifyEnabled={sessionNotifyEnabled}
      setSessionNotifyEnabled={setSessionNotifyEnabled}
    />
  );
}

/** Shared toggles; the cloud surface supplies the target's values and writes. */
export function FeishuBotNotificationSectionView({
  ownerBound,
  lifecycleAnnouncement,
  setLifecycleAnnouncement,
  sessionNotifyEnabled,
  setSessionNotifyEnabled,
  disabled = false,
  sessionDisabled = false,
}: {
  ownerBound: boolean;
  lifecycleAnnouncement: boolean;
  setLifecycleAnnouncement(enabled: boolean): void;
  sessionNotifyEnabled: boolean;
  setSessionNotifyEnabled(enabled: boolean): void;
  disabled?: boolean;
  /** The session toggle alone is unavailable, e.g. its preference is not readable. */
  sessionDisabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <>
      <ImLifecycleAnnouncementSection
        label={t('settings.feishuBot.lifecycleAnnouncement.label')}
        cellLabel={t('settings.feishuBot.lifecycleAnnouncement.cellLabel')}
        hint={t('settings.feishuBot.lifecycleAnnouncement.hint')}
        checked={lifecycleAnnouncement}
        disabled={disabled}
        onCheckedChange={setLifecycleAnnouncement}
      />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <ImLifecycleAnnouncementSection
        label={t('settings.feishuBot.sessionNotification.label')}
        cellLabel={t('settings.feishuBot.sessionNotification.cellLabel')}
        hint={
          ownerBound
            ? t('settings.feishuBot.sessionNotification.hint')
            : t('settings.feishuBot.sessionNotification.disabledHint')
        }
        checked={sessionNotifyEnabled && ownerBound}
        disabled={disabled || sessionDisabled || !ownerBound}
        onCheckedChange={(next) => {
          if (ownerBound) setSessionNotifyEnabled(next);
        }}
      />
    </>
  );
}
