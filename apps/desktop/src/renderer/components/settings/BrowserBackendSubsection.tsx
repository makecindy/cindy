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
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  BrowserBackendHealth,
  BrowserBackendHealthReason,
} from '../../../shared/browserBackend';

type BackendKind = 'external' | 'rsb-webview';

interface BrowserBackendSubsectionProps {
  active: BackendKind;
  pending: boolean;
  recovering: boolean;
  health: BrowserBackendHealth | null;
  onSelect: (kind: BackendKind) => void;
  onRecover: () => void;
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

function healthReasonKey(reason: BrowserBackendHealthReason | undefined): string {
  switch (reason) {
    case 'disposing':
      return 'settings.computerUse.browserBackend.health.reasons.disposing';
    case 'host-unavailable':
      return 'settings.computerUse.browserBackend.health.reasons.hostUnavailable';
    case 'start-failed':
      return 'settings.computerUse.browserBackend.health.reasons.startFailed';
    case 'recovery-failed':
      return 'settings.computerUse.browserBackend.health.reasons.recoveryFailed';
    case 'status-failed':
    default:
      return 'settings.computerUse.browserBackend.health.reasons.statusFailed';
  }
}

export function BrowserBackendSubsection({
  active,
  pending,
  recovering,
  health,
  onSelect,
  onRecover,
}: BrowserBackendSubsectionProps) {
  const { t } = useTranslation();
  const embeddedHealth =
    active === 'rsb-webview' && health?.active === 'rsb-webview' ? health : null;
  return (
    <div className="border-t border-[var(--settings-theme-card-border)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-[14px]">
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
      {embeddedHealth ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div
            className={cn(
              'flex min-w-0 flex-1 items-start gap-2 text-12 leading-[1.5]',
              embeddedHealth.status === 'error'
                ? 'text-[var(--error-fg)]'
                : 'text-[var(--settings-section-desc)]',
            )}
            role={embeddedHealth.status === 'error' ? 'alert' : 'status'}
          >
            {embeddedHealth.status === 'error' ? (
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            )}
            <span>
              {embeddedHealth.status === 'error'
                ? t('settings.computerUse.browserBackend.health.error', {
                    reason: t(healthReasonKey(embeddedHealth.reason)),
                  })
                : t('settings.computerUse.browserBackend.health.ready')}
            </span>
          </div>
          <button
            type="button"
            onClick={onRecover}
            disabled={pending || !embeddedHealth.canRecover}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3',
              'bg-[var(--settings-input-bg)] text-12 font-medium',
              'text-[var(--settings-section-title)] transition-colors',
              'hover:bg-[var(--surface-chip)]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <span
              className={cn(
                'inline-flex shrink-0',
                recovering && 'animate-spinner motion-reduce:animate-none',
              )}
            >
              <RefreshCw size={12} />
            </span>
            {recovering
              ? t('settings.computerUse.browserBackend.health.recovering')
              : embeddedHealth.status === 'error'
                ? t('settings.computerUse.browserBackend.health.recover')
                : t('settings.computerUse.browserBackend.health.reconnect')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
