/**
 * NotificationSection — Settings 页"系统通知"区块。
 *
 * 两个个人通知开关:
 *   1. 桌面通知 — CC Agent session 完成 / 待回复时弹系统 toast(默认开)。
 *   2. 飞书通知 — 同源触发,失焦时给 bot owner 私聊一条文本(默认关)。
 * 企业微信群是共享通道,总开关控制通道可用性;每个自动操作仍需显式选择。
 *
 * 飞书开关的可用前提是 bot 已绑定 ownerOpenId(用户至少私聊过 bot 一次);
 * 未绑定时开关禁用,并在 hint 里提示去"飞书机器人" tab 完成配置/绑定。
 *
 * 沿用 AppearanceSection 的卡片样式(rounded 12 / Card bg / 1px Board / padding 20)。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Send, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useFeishuNotificationSettings } from '@/hooks/useFeishuNotificationSettings';
import { useFeishuBot } from '@/hooks/useFeishuBot';
import { useWecomGroupNotificationSettings } from '@/hooks/useWecomGroupNotificationSettings';

export function NotificationSection() {
  const { enabled, setEnabled } = useNotificationSettings();
  const { enabled: feishuEnabled, setEnabled: setFeishuEnabled } = useFeishuNotificationSettings();
  // ownerOpenId 才是 sendMarkdownText 的硬前置(status='connected' 也可能 owner 未绑),
  // 用它作为飞书开关的可用门槛,与主进程实际兜底逻辑对齐。
  const { ownerOpenId } = useFeishuBot();
  const wecomGroup = useWecomGroupNotificationSettings();
  const [webhookUrl, setWebhookUrl] = useState('');
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

      <div
        className={cn(
          'flex flex-col gap-4 rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-13 font-medium text-[var(--settings-section-sublabel)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.notifications.wecomGroupLabel')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {wecomGroup.configured
                ? t('settings.notifications.wecomGroupConfiguredHint', {
                    maskedKey: wecomGroup.maskedKey,
                  })
                : t('settings.notifications.wecomGroupHint')}
            </p>
          </div>
          <Switch
            checked={wecomGroup.enabled && wecomGroup.configured}
            onCheckedChange={(next) => {
              void wecomGroup
                .setEnabled(next)
                .catch(() => toast.error(t('settings.notifications.wecomGroupToggleFailed')));
            }}
            disabled={!wecomGroup.configured || wecomGroup.busy}
            aria-label={t('settings.notifications.wecomGroupAria')}
          />
        </div>

        {wecomGroup.configured ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={wecomGroup.busy}
              onClick={() => {
                void wecomGroup
                  .test(t('settings.notifications.wecomGroupTestMessage'))
                  .then(() => toast.success(t('settings.notifications.wecomGroupTestSuccess')))
                  .catch(() => toast.error(t('settings.notifications.wecomGroupTestFailed')));
              }}
              className={cn(
                'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full',
                'border border-[var(--settings-btn-secondary-border)]',
                'bg-[var(--settings-btn-secondary-bg)] text-12 font-medium',
                'text-[var(--settings-btn-secondary-text)]',
                wecomGroup.busy && 'cursor-not-allowed opacity-40',
              )}
            >
              {wecomGroup.busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {t('settings.notifications.wecomGroupTest')}
            </button>
            <button
              type="button"
              disabled={wecomGroup.busy}
              onClick={() => {
                void wecomGroup
                  .clear()
                  .then(() => toast.success(t('settings.notifications.wecomGroupCleared')))
                  .catch(() => toast.error(t('settings.notifications.wecomGroupClearFailed')));
              }}
              className={cn(
                'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full',
                'border border-[var(--settings-btn-secondary-border)]',
                'bg-[var(--settings-btn-secondary-bg)] text-12 font-medium',
                'text-[var(--settings-btn-secondary-text)]',
                wecomGroup.busy && 'cursor-not-allowed opacity-40',
              )}
            >
              <Trash2 size={13} />
              {t('settings.notifications.wecomGroupClear')}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              type="password"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder={t('settings.notifications.wecomGroupPlaceholder')}
              autoComplete="new-password"
              spellCheck={false}
              className={cn(
                'h-[42px] w-full rounded-full px-[14px]',
                'border border-[var(--settings-input-border)]',
                'bg-[var(--settings-input-bg)] text-13 text-[var(--settings-input-text)]',
                'placeholder:text-[var(--settings-input-placeholder)] outline-none',
                'focus:border-[var(--settings-input-border-focus)]',
              )}
            />
            <button
              type="button"
              disabled={wecomGroup.busy || !webhookUrl.trim()}
              onClick={() => {
                void wecomGroup
                  .saveAndTest(
                    webhookUrl,
                    t('settings.notifications.wecomGroupTestMessage'),
                  )
                  .then(() => {
                    setWebhookUrl('');
                    toast.success(t('settings.notifications.wecomGroupSaveSuccess'));
                  })
                  .catch(() => toast.error(t('settings.notifications.wecomGroupSaveFailed')));
              }}
              className={cn(
                'flex h-[42px] items-center justify-center gap-1.5 rounded-full',
                'border border-[var(--settings-btn-primary-border)]',
                'bg-[var(--settings-btn-primary-bg)] text-13 font-medium',
                'text-[var(--settings-btn-primary-text)]',
                (wecomGroup.busy || !webhookUrl.trim()) && 'cursor-not-allowed opacity-40',
              )}
            >
              {wecomGroup.busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {t('settings.notifications.wecomGroupSaveAndTest')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
