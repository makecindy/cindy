/**
 * NotificationSection — Settings 页"系统通知"区块。
 *
 * 桌面通知 — CC Agent session 完成 / 待回复时弹系统 toast(默认开)。
 * 飞书通知与企业微信群通知已迁移至「IM 机器人」页各自对应的渠道卡片内。
 *
 * 沿用 AppearanceSection 的卡片样式(rounded 12 / Card bg / 1px Board / padding 20)。
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';

export function NotificationSection() {
  const { enabled, setEnabled } = useNotificationSettings();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 标题与 Appearance 同级 */}
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.notifications.title')}
      </h2>

      {/* 桌面通知 — 沿用原有卡片样式 */}
      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.notifications.sessionDoneLabel')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.notifications.sessionDoneHint')}
          </p>
        </div>

        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('settings.notifications.sessionDoneAria')}
        />
      </div>
    </div>
  );
}
