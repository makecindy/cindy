/**
 * LinkOpenSection — Settings → 个性化 下的「链接打开方式」偏好。
 *
 * 控制消息流里左键点击时的默认打开位置,拆成两个互不影响的开关:
 *   - 外部网页:互联网链接。默认系统默认浏览器。
 *   - 内部网页:本地硬盘 HTML 与本机地址(localhost)。默认内置侧边栏浏览器。
 * 右键菜单里始终两种都可临时选,本设置只决定左键直开走哪个。
 *
 * 存储走 useLinkOpenPreference(localStorage 只存 override,选回默认即清除,
 * 规则 20);每个开关各自「恢复默认」,复用 DefaultOverrideControls。
 *
 * 版式跟 AgentResourceSection 同一套多行卡:一张卡、两行、控件贴右,
 * 避免两张独立卡把分段控件单独占一整行。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  LINK_OPEN_DEFAULTS,
  useLinkOpenPreference,
  type LinkOpenKind,
  type LinkOpenPreference,
} from '@/hooks/useLinkOpenPreference';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const OPTIONS: Array<{ value: LinkOpenPreference; labelKey: string }> = [
  { value: 'sidebar', labelKey: 'settings.linkOpen.options.sidebar' },
  { value: 'external', labelKey: 'settings.linkOpen.options.external' },
];

/** 带分割线的多行卡片:卡片自身不留内边距,由每行 `px-4 py-4` 承担。 */
const CARD_CLASS = cn(
  'flex flex-col rounded-xl',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);
const ROW_CLASS = 'flex items-center justify-between gap-3 px-4 py-4';
const ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
const ROW_HINT_CLASS = 'text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70';
const DIVIDER_CLASS = 'mx-4 h-px bg-[var(--settings-theme-card-border)]';

function LinkOpenPreferenceRow({ kind }: { kind: LinkOpenKind }) {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useLinkOpenPreference(kind);

  const onReset = useCallback(() => {
    setPreference(LINK_OPEN_DEFAULTS[kind]);
    toast.success(t('settings.defaults.restored'));
  }, [kind, setPreference, t]);

  return (
    <div className={ROW_CLASS}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className={ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
          {t(`settings.linkOpen.${kind}.label`)}
        </p>
        <p className={ROW_HINT_CLASS}>{t(`settings.linkOpen.${kind}.description`)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
        {/* 分段控件的 token 与外观分区「侧边栏卡片模式」完全同款(docs/design-rules/cindy-design-system.md 复用原则):
            选中态 chip 底 + 正文字色,未选中态次级字色 + hover 项底。 */}
        <div
          role="radiogroup"
          aria-label={t(`settings.linkOpen.${kind}.ariaLabel`)}
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

export function LinkOpenSection() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.linkOpen.title')}
        </h2>
        <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
          {t('settings.linkOpen.description')}
        </p>
      </div>

      <div className={CARD_CLASS}>
        <LinkOpenPreferenceRow kind="web" />
        <div className={DIVIDER_CLASS} />
        <LinkOpenPreferenceRow kind="local" />
      </div>
    </div>
  );
}
