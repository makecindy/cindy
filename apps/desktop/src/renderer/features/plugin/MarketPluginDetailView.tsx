import { useId } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { ghostPermissionItems } from '../../../shared/ghost';
import type { PluginMarketDetail } from '../../../shared/pluginMarket';
import { GhostPluginIcon } from './GhostPluginIcon';
import { usePluginMarketIcon } from './lib/usePluginMarketIcon';
import { pluginPresentationOrigin } from './lib/pluginMarketPresentation';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';

interface MarketPluginDetailViewProps {
  detail: PluginMarketDetail;
  busy: boolean;
  onBack: () => void;
  onInstall?: () => void;
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
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const marketIcon = usePluginMarketIcon(detail, { deferUntilVisible: false });
  const presentationOrigin = pluginPresentationOrigin(detail);
  // 自定义市场（Git/本地源）的包字节未经服务端校验，安全说明必须如实区分。
  const isCustomSource = detail.sourceType !== 'server';
  const permissions = ghostPermissionItems(detail.manifest);
  const actionKey =
    detail.installState === 'update-available'
      ? 'settings.ghosts.market.update'
      : detail.installState === 'installed'
        ? 'settings.ghosts.market.installed'
        : detail.installState === 'conflict'
          ? 'settings.ghosts.market.replace'
          : 'settings.ghosts.market.install';
  const actionDisabled = busy || detail.installState === 'installed';
  // 同 id 已装时仍展示明确的替换语义；用户点击后才会进入真实包事务。
  const replacementDescriptionId = useId();
  const replacementDescription =
    detail.installState === 'conflict' ? t('settings.ghosts.market.replaceDescription') : undefined;

  return (
    <main
      className="plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]"
      onScroll={onScroll}
    >
      <PluginDetailTopBar
        label={t('settings.ghosts.detail.backToList')}
        onBack={onBack}
        scrolled={scrolled}
      />
      <article className="plugin-detail-frame mx-auto w-full max-w-[824px] px-8 pb-16 pt-5 max-[760px]:px-6">
        <header>
          <div className="plugin-detail-hero grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3">
            <GhostPluginIcon
              iconContainerRef={marketIcon.containerRef}
              iconDataUrl={marketIcon.iconDataUrl}
              iconId={detail.ghostId}
              iconName={detail.name}
              onIconLoad={marketIcon.onIconLoad}
              onIconLoadError={() => marketIcon.onIconLoadError(onIconLoadError)}
              size="detail"
            />
            <div className="min-w-0">
              <h1 className="truncate text-28 font-medium leading-[1.214] text-[var(--text-primary)]">
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
            {onInstall ? (
              <button
                type="button"
                onClick={onInstall}
                disabled={actionDisabled}
                aria-label={t(actionKey)}
                aria-busy={busy || undefined}
                aria-describedby={
                  replacementDescription ? replacementDescriptionId : undefined
                }
                className={cn(
                  'plugin-detail-primary-action inline-flex h-10 min-w-[104px] items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-13 font-medium',
                  'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
                  'transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--accent-hover)] active:scale-[0.98]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
                )}
              >
                {busy ? (
                  <Spinner size={14} />
                ) : (
                  <>
                    <Download size={15} aria-hidden="true" />
                    {t(actionKey)}
                  </>
                )}
              </button>
            ) : null}
          </div>
          <p
            id={replacementDescription ? replacementDescriptionId : undefined}
            className="mt-5 text-14 leading-[1.571] text-[var(--text-secondary)]"
          >
            {replacementDescription ?? (detail.description || detail.ghostId)}
          </p>
        </header>

        <section className="mt-10" aria-labelledby="market-security-title">
          <h2
            id="market-security-title"
            className="text-18 font-medium leading-[1.444] text-[var(--text-primary)]"
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
              {t(
                isCustomSource
                  ? 'settings.ghosts.market.customSecurityDescription'
                  : 'settings.ghosts.market.securityDescription',
              )}
            </p>
          </div>
        </section>

        <section className="mt-10" aria-labelledby="market-permissions-title">
          <div className="flex items-baseline gap-2">
            <h2
              id="market-permissions-title"
              className="text-18 font-medium leading-[1.444] text-[var(--text-primary)]"
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
