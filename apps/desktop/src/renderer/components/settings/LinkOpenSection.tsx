/**
 * LinkOpenSection — Settings → 个性化 下的「链接打开方式」偏好。
 *
 * 控制消息流里左键点击 http(s) 链接 / HTML 文件时的默认打开位置:
 *   - 内置侧边栏浏览器(系统默认)
 *   - 系统默认浏览器
 * 右键菜单里始终两种都可临时选,本设置只决定左键直开走哪个。
 *
 * 存储走 useLinkOpenPreference(localStorage 只存 override,选回默认即清除,
 * 规则 20);「恢复默认」按钮复用 DefaultOverrideControls。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  useLinkOpenPreference,
  type LinkOpenPreference,
} from '@/hooks/useLinkOpenPreference';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const OPTIONS: Array<{ value: LinkOpenPreference; labelKey: string }> = [
  { value: 'sidebar', labelKey: 'settings.linkOpen.options.sidebar' },
  { value: 'external', labelKey: 'settings.linkOpen.options.external' },
];

export function LinkOpenSection() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useLinkOpenPreference();

  const onReset = useCallback(() => {
    setPreference('sidebar');
    toast.success(t('settings.defaults.restored'));
  }, [setPreference, t]);

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.linkOpen.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.linkOpen.description')}
        </p>
      </div>

      <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-14 font-medium leading-none text-[var(--text-primary)]">
            {t('settings.linkOpen.card.label')}
          </p>
          <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
        </div>

        <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.linkOpen.card.description')}
        </p>

        {/* 分段控件的 token 与外观分区「侧边栏卡片模式」完全同款(docs/design-rules/cindy-design-system.md 复用原则):
            选中态 chip 底 + 正文字色,未选中态次级字色 + hover 项底。 */}
        <div
          role="radiogroup"
          aria-label={t('settings.linkOpen.card.ariaLabel')}
          className="flex w-fit shrink-0 items-center gap-0.5 rounded-full border border-[var(--settings-theme-card-border)] p-0.5"
        >
          {OPTIONS.map((opt) => {
            const active = preference === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setPreference(opt.value)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)]'
                    : 'text-[var(--settings-section-sublabel)] hover:bg-sidebar-item-hover',
                )}
              >
                {t(opt.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
