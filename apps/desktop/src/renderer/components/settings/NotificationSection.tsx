import { notificationSettings } from './NotificationSection.settings-search';
/**
 * NotificationSection — Settings 页"系统通知"区块。
 *
 * 桌面通知 — CC Agent session 完成 / 待回复时弹系统 toast(默认开)。
 * 飞书通知与企业微信群通知已迁移至「IM 机器人」页各自对应的渠道卡片内。
 *
 * 版式用 settings-rows 的分区/卡片/行。
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';

export function NotificationSection() {
  const { enabled, setEnabled } = useNotificationSettings();
  const { t } = useTranslation();

  return (
    <SettingsSection title={t('settings.notifications.title')}>
      <SettingsCard>
        <SettingsRow
          title={
            <span id={notificationSettings.notificationsSessionDoneLabel.targetId}>
              {t(notificationSettings.notificationsSessionDoneLabel.titleKey)}
            </span>
          }
          hint={t(notificationSettings.notificationsSessionDoneLabel.descriptionKey)}
          trailing={
            <Switch data-setting-id={notificationSettings.notificationsSessionDoneLabel.id}
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t('settings.notifications.sessionDoneAria')}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
