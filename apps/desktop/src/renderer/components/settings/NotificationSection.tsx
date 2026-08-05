/**
 * NotificationSection — Settings 页"系统通知"区块。
 *
 * 两个独立开关:
 *   1. 桌面通知 — CC Agent session 完成 / 待回复时弹系统 toast(默认开)。
 *   2. 飞书通知 — 同源触发,失焦时给 bot owner 私聊一条文本(默认关)。
 *
 * 飞书开关的可用前提是 bot 已绑定 ownerOpenId(用户至少私聊过 bot 一次);
 * 未绑定时开关禁用,并在 hint 里提示去"飞书机器人" tab 完成配置/绑定。
 *
 * 沿用 AppearanceSection 的卡片样式(rounded 12 / Card bg / 1px Board / padding 20)。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useFeishuNotificationSettings } from '@/hooks/useFeishuNotificationSettings';
import { useFeishuBot } from '@/hooks/useFeishuBot';

export function NotificationSection() {
  const { enabled, setEnabled } = useNotificationSettings();
  const { enabled: feishuEnabled, setEnabled: setFeishuEnabled } = useFeishuNotificationSettings();
  // ownerOpenId 才是 sendMarkdownText 的硬前置(status='connected' 也可能 owner 未绑),
  // 用它作为飞书开关的可用门槛,与主进程实际兜底逻辑对齐。
  const { ownerOpenId } = useFeishuBot();
  const feishuReady = Boolean(ownerOpenId);
  const { t } = useTranslation();

  // 兜底复位:覆盖"localStorage 残留 true 但 owner 未绑"的边缘态(旧版升级 /
  // 异常退出 / 其他 window 改的)。解绑动作本身已在 useFeishuBot.clear() 命中,
  // 这里只是双层保险——任何时候 Settings 挂载到飞书未绑都同步落 false。
  useEffect(() => {
    if (!feishuReady && feishuEnabled) {
      setFeishuEnabled(false);
    }
  }, [feishuReady, feishuEnabled, setFeishuEnabled]);

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

      {/* 飞书通知 — 同卡片样式,未绑定时仅 Switch disabled,卡片底色/边框与上方对齐 */}
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
            {t('settings.notifications.feishuLabel')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {feishuReady
              ? t('settings.notifications.feishuHint')
              : t('settings.notifications.feishuDisabledHint')}
          </p>
        </div>

        <Switch
          checked={feishuEnabled && feishuReady}
          onCheckedChange={setFeishuEnabled}
          disabled={!feishuReady}
          aria-label={t('settings.notifications.feishuAria')}
        />
      </div>
    </div>
  );
}
