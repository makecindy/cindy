import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

/** The same account header in local and cloud settings; no local data hooks. */
export function ProviderAccountHeader({
  icon,
  title,
  subtitle,
  status,
  badges,
  actions,
  menu,
}: {
  icon: ReactNode;
  title: string;
  /** Plain text truncates on one line; a node (e.g. the run-location subtitle) lays itself out. */
  subtitle: ReactNode;
  /** Optional line under the subtitle (the local page's own-computers status). */
  status?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="shrink-0 px-5 py-4">
      {/* 可折行:最小窗口(右栏 ~275px)放不下「状态 + 操作」时整组换行,
            不被卡片 overflow-hidden 裁掉(PR #1102 review 第三轮)。 */}
      <div className="flex flex-wrap items-center gap-3 gap-y-2">
        <div
          data-testid="provider-detail-identity"
          className="flex min-w-0 flex-auto basis-[220px] items-center gap-3"
        >
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              backgroundColor: 'var(--settings-integration-avatar-bg)',
              border: '1px solid var(--settings-integration-avatar-border)',
              color: 'var(--settings-integration-avatar-icon)',
            }}
          >
            {icon}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div
              data-testid="provider-detail-metadata"
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <span
                className="min-w-0 truncate text-14 font-medium leading-tight"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {title}
              </span>
              {badges}
            </div>
            <span
              className="flex min-w-0 items-center gap-1 text-13 leading-tight"
              style={{ color: 'var(--settings-integration-subtitle)' }}
            >
              {typeof subtitle === 'string' ? <span className="min-w-0 truncate">{subtitle}</span> : subtitle}
            </span>
            {status ? (
              <span className="flex min-w-0" style={{ color: 'var(--settings-integration-subtitle)' }}>
                {status}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <div data-testid="provider-detail-actions" className="flex shrink-0 items-center gap-2.5">
            {actions}
          </div>
          {menu}
        </div>
      </div>
    </div>
  );
}

export function ConnectedPill() {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      <Check size={12} strokeWidth={2.5} />
      {t('settings.providers.pill.connected')}
    </span>
  );
}
