/**
 * BrowserBackendSubsection —「自动操作浏览器」卡片里的一行,segmented 切换
 * "侧边栏内置浏览器 / 独立外置浏览器"。
 *
 * 纯 UI(dumb component):active kind / pending / onSelect 都从父组件
 * (ComputerUseSection) 拿。父组件根据 `active` 决定整张卡片其它 cell 是否
 * 渲染(外部 backend 才显示 Chrome 探测 + 打开登录入口)。
 *
 * segmented control 样式跟 ImDefaultSettingsSection 的 agentKind 切换器一致 ——
 * container `surface-chip` 胶囊,active chip `surface-elevated + border-default`
 * + 加粗,inactive transparent border + secondary text。对齐 docs/design-rules/cindy-design-system.md §5
 * Tab Pills:"Active: Light Gray bg; Inactive: transparent"。
 */

import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

type BackendKind = 'external' | 'rsb-webview';

interface BrowserBackendSubsectionProps {
  active: BackendKind;
  pending: boolean;
  onSelect: (kind: BackendKind) => void;
}

const CHIP_BASE = cn(
  'flex h-7 min-w-0 items-center justify-center gap-1.5 px-3 rounded-full',
  'border text-12 leading-none transition-colors',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:opacity-50 disabled:pointer-events-none',
);
const CHIP_ACTIVE = cn(
  'border-[var(--border-default)] bg-[var(--surface-elevated)]',
  'font-medium text-[var(--settings-section-title)]',
);
const CHIP_INACTIVE = cn(
  'border-transparent font-normal',
  'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
);

export function BrowserBackendSubsection({
  active,
  pending,
  onSelect,
}: BrowserBackendSubsectionProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-12 font-medium leading-[1.4] text-[var(--settings-section-title)]">
          {t('settings.computerUse.browserBackend.title')}
        </p>
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.browserBackend.description')}
        </p>
      </div>
      <div
        className="flex h-8 items-center gap-0.5 rounded-full bg-[var(--surface-chip)] p-[3px]"
        role="tablist"
        aria-label={t('settings.computerUse.browserBackend.title')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={active === 'rsb-webview'}
          disabled={pending}
          onClick={() => onSelect('rsb-webview')}
          className={cn(CHIP_BASE, active === 'rsb-webview' ? CHIP_ACTIVE : CHIP_INACTIVE)}
        >
          {t('settings.computerUse.browserBackend.rsbWebview.title')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={active === 'external'}
          disabled={pending}
          onClick={() => onSelect('external')}
          className={cn(CHIP_BASE, active === 'external' ? CHIP_ACTIVE : CHIP_INACTIVE)}
        >
          {t('settings.computerUse.browserBackend.external.title')}
        </button>
      </div>
    </div>
  );
}
