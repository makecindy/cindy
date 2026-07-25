import { ArrowLeft, Download, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import { ghostPermissionItems } from '../../../shared/ghost';
import type { PluginMarketDetail } from '../../../shared/pluginMarket';
import { GhostPluginIcon } from './GhostPluginIcon';
import { pluginPresentationOrigin } from './lib/pluginMarketPresentation';

interface MarketPluginDetailViewProps {
  detail: PluginMarketDetail;
  busy: boolean;
  onBack: () => void;
  onInstall: () => void;
  onIconLoadError: () => void;
}
/** 尚未安装的市场 Plugin 详情；只展示协议事实，不创建 renderer 侧安装逻辑。 */
export function MarketPluginDetailView({
  detail,
  busy,
  onBack,
  onInstall,
  onIconLoadError,
}: MarketPluginDetailViewProps) {
  const { t } = useTranslation();
  const permissions = ghostPermissionItems(detail.manifest);
  const presentationOrigin = pluginPresentationOrigin(detail);
  const actionKey =
    detail.installState === 'update-available'
      ? 'settings.ghosts.market.update'
      : detail.installState === 'installed'
        ? 'settings.ghosts.market.installed'
        : detail.installState === 'conflict'
          ? 'settings.ghosts.market.conflict'
          : 'settings.ghosts.market.install';
  const actionDisabled =
    busy || detail.installState === 'installed' || detail.installState === 'conflict';

  return (
    <main className="plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]">
      <article className="plugin-detail-frame mx-auto w-full max-w-[824px] px-8 pb-16 pt-5 max-[760px]:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-3 mb-7 inline-flex h-9 items-center gap-2 rounded-full px-3 text-13 text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t('settings.ghosts.detail.backToList')}
        </button>

        <header>
          <div className="plugin-detail-hero grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3">
            <GhostPluginIcon
              iconDataUrl={detail.icon?.url}
              iconId={detail.ghostId}
              iconName={detail.name}
              onIconLoadError={onIconLoadError}
              size="detail"
            />
            <div className="min-w-0">
              <h1 className="truncate text-28 font-medium leading-[34px] text-[var(--text-primary)]">
                {detail.name}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-12 text-[var(--text-tertiary)]">
                <span>{t(`settings.ghosts.market.scope.${presentationOrigin}`)}</span>
                <span aria-hidden="true">·</span>
                <span>v{detail.version}</span>
                {detail.author ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{detail.author}</span>
                  </>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={onInstall}
              disabled={actionDisabled}
              className={cn(
                'plugin-detail-primary-action inline-flex h-10 min-w-[104px] items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-13 font-medium',
                'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
                'transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--accent-hover)] active:scale-[0.98]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
              )}
            >
              <Download size={15} aria-hidden="true" />
              {t(actionKey)}
            </button>
          </div>
          <p className="mt-5 text-14 leading-[22px] text-[var(--text-secondary)]">
            {detail.description || detail.ghostId}
          </p>
        </header>

        <section className="mt-10" aria-labelledby="market-security-title">
          <h2
            id="market-security-title"
            className="text-18 font-medium leading-[26px] text-[var(--text-primary)]"
          >
            {t('settings.ghosts.market.securityTitle')}
          </h2>
          <div className="mt-5 flex max-w-[760px] items-start gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-4">
            <ShieldCheck
              size={18}
              className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            <p className="text-13 leading-5 text-[var(--text-secondary)]">
              {t('settings.ghosts.market.securityDescription')}
            </p>
          </div>
        </section>

        <section className="mt-10" aria-labelledby="market-permissions-title">
          <div className="flex items-baseline gap-2">
            <h2
              id="market-permissions-title"
              className="text-18 font-medium leading-[26px] text-[var(--text-primary)]"
            >
              {t('settings.ghosts.perm.grantsTitle')}
            </h2>
            <span className="text-12 text-[var(--text-tertiary)]">
              {t('settings.ghosts.perm.itemCount', { count: permissions.length })}
            </span>
          </div>
          <div className="mt-5 max-w-[760px] divide-y divide-[var(--border-default)] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5">
            {permissions.length > 0 ? (
              permissions.map((permission, index) => (
                <div
                  key={`${permission.kind}-${permission.labelKey}-${index}`}
                  className="py-3.5 text-13 leading-5 text-[var(--text-secondary)]"
                >
                  {t(`settings.ghosts.perm.${permission.labelKey}`, permission.labelArgs)}
                </div>
              ))
            ) : (
              <div className="py-4 text-13 text-[var(--text-tertiary)]">
                {t('settings.ghosts.market.noPermissions')}
              </div>
            )}
          </div>
        </section>
      </article>
    </main>
  );
}
