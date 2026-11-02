import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { providerMonogram } from '@/lib/providerModels';
import { cn } from '@/lib/utils';

/** 供应商卡片图标。 */
export function cardIcon(sel: { providerId?: string; name: string }): ReactNode {
  if (sel.providerId && hasProviderLogo(sel.providerId)) {
    return <ProviderLogoMark providerId={sel.providerId} size={15} />;
  }
  return <span className="text-12 font-medium leading-none">{providerMonogram(sel.name)}</span>;
}

/**
 * 目录单行(2026-07 定稿:第 1 步由三列卡片宫格改为单列列表)——名称在左、
 * 鉴权方式靠右;行宽给足后不再需要截断测量 + Tip 组合。
 */
export function ProviderRow({
  icon,
  name,
  meta,
  beta,
  busy,
  className,
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'name'> & {
  icon: ReactNode;
  name: string;
  meta: string;
  beta?: boolean;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      {...buttonProps}
      type="button"
      title={name}
      disabled={busy || buttonProps.disabled}
      aria-busy={busy}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
        className,
      )}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : icon}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-13 font-medium"
        style={{ color: 'var(--settings-section-title)' }}
      >
        {name}
      </span>
      {beta && (
        <span className="shrink-0 rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2 py-[1px] text-10 font-medium uppercase leading-[1.5] tracking-wide text-[var(--text-secondary)]">
          {t('settings.providers.local.beta')}
        </span>
      )}
      {/* meta 可收缩截断:en 等长文案在窄弹窗下不得把名称挤出(PR #1102 review)。 */}
      <span className="min-w-0 truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
        {meta}
      </span>
    </button>
  );
}
