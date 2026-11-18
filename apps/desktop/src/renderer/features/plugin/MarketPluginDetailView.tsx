import { PluginShareButton } from './PluginShareButton';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { PluginVersionUpdates } from './PluginVersionUpdates';
import { ToolsSection } from './GhostPluginDetailView';
import { PluginReadmeSection } from './PluginReadmeSection';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ghostPermissionItems } from '../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem } from '../../../shared/pluginMarket';
import { PluginSharedUsage } from './PluginSharedUsage';
import { PluginPublisherBadge, PluginPublisherDescription } from './PluginPublisherBadge';
import { GhostPluginIcon } from './GhostPluginIcon';
import { usePluginMarketIcon } from './lib/usePluginMarketIcon';
import { pluginPresentationAuthor, pluginPresentationOrigin } from './lib/pluginMarketPresentation';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { PluginInstallRing } from './PluginInstallRing';
import { usePluginInstallProgress } from './lib/pluginInstallProgress';

interface MarketPluginDetailViewProps {
  detail: PluginMarketItem | PluginMarketDetail;
  error?: string | null;
  refreshing?: boolean;
  onRetry?: () => void;
  busy: boolean;
  /**
   * Show this window's install of the plugin as a ring in place of the button. Only the local
   * Plugin page turns it on; a remote computer's market view is not about installs here.
   */
  showInstallProgress?: boolean;
  onBack: () => void;
  onInstall?: () => void;
  onIconLoadError: () => void;
}
/** 尚未安装的市场 Plugin 详情；只展示协议事实，不创建 renderer 侧安装逻辑。 */
export function MarketPluginDetailView({
  detail,
  error,
  refreshing = false,
  onRetry,
  busy,
  showInstallProgress = false,
  onBack,
  onInstall,
  onIconLoadError,
}: MarketPluginDetailViewProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const manifest = 'manifest' in detail ? detail.manifest : undefined;
  const loading = !manifest && !error;
  const [showLoading, setShowLoading] = useState(false);
  const showActionLoading = showLoading || (refreshing && Boolean(manifest));
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, [detail.pluginId]);
  useEffect(() => {
    if (!loading) { setShowLoading(false); return; }
    const timer = setTimeout(() => setShowLoading(true), 300);
    return () => clearTimeout(timer);
  }, [loading]);
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const marketIcon = usePluginMarketIcon(detail, { deferUntilVisible: false });
  const presentationOrigin = pluginPresentationOrigin(detail);
  const installProgress = usePluginInstallProgress(showInstallProgress ? detail.pluginId : null);
  const installFailed = installProgress?.download.phase === 'failed';
  // 进行中与完成时圆环替换按钮;失败时圆环停在原处,按钮回来供重试。
  const installRing = installProgress && (!installFailed || onInstall) ? installProgress : null;
  const actionKey =
    detail.installState === 'update-available'
      ? 'settings.ghosts.market.update'
      : detail.installState === 'installed'
        ? 'settings.ghosts.market.installed'
        : detail.installState === 'conflict'
          ? 'settings.ghosts.market.replace'
          : 'settings.ghosts.market.install';
  const actionDisabled = busy || refreshing || Boolean(error) || !manifest || detail.installState === 'installed';
  // 同 id 已装时仍展示明确的替换语义；用户点击后才会进入真实包事务。
  const replacementDescriptionId = useId();
  const replacementDescription =
    detail.installState === 'conflict' ? t('settings.ghosts.market.replaceDescription') : undefined;

  return (
    <main
      ref={root}
      tabIndex={-1}
      aria-busy={loading || undefined}
      className="app-wallpaper-surface plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]"
      onScroll={onScroll}
    >
      <PluginDetailTopBar
        label={t('settings.ghosts.detail.backToList')}
        onBack={onBack}
        scrolled={scrolled}
        actions={
          detail.sourceType === 'server' && detail.scope === 'public' ? (
            <PluginShareButton pluginId={detail.pluginId} />
          ) : undefined
        }
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
            <div className="plugin-detail-heading min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <h1 className="truncate text-28 font-medium leading-[1.214] text-[var(--text-primary)]">{detail.name}</h1>
                <PluginPublisherBadge origin={presentationOrigin} kind={detail.publisherKind} />
              </div>
              <div className="plugin-detail-metadata mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-12 text-[var(--text-tertiary)]">
                <span>{t(`settings.ghosts.market.scope.${presentationOrigin}`)}</span>
                <span aria-hidden="true">·</span>
                <span>v{detail.version}</span>
                <PluginSharedUsage detail={detail} />
                {pluginPresentationAuthor(detail) ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{pluginPresentationAuthor(detail)}</span>
                  </>
                ) : null}
              </div>
            </div>
            {onInstall || installRing ? (
              <div className="plugin-detail-actions flex min-w-0 flex-wrap items-center gap-1.5">
                {installRing ? (
                  <PluginInstallRing
                    label={detail.name}
                    progress={installRing}
                    size={24}
                    explainRetry
                    className="max-w-[260px] px-1 text-13 font-medium"
                  />
                ) : null}
                {onInstall && (!installProgress || installFailed) ? (
                  <Button
                    variant="cta"
                    size="lg"
                    compact
                    loading={busy}
                    type="button"
                    onClick={onInstall}
                    disabled={actionDisabled}
                    aria-label={t(showActionLoading ? 'settings.ghosts.remote.detailLoading' : installFailed ? 'commonUi.retry' : actionKey)}
                    aria-busy={busy || refreshing || loading || undefined}
                    aria-describedby={replacementDescription ? replacementDescriptionId : undefined}
                    className="plugin-detail-primary-action min-w-[104px] whitespace-nowrap"
                  >
                    <span className="inline-grid">
                      <span aria-hidden="true" className="invisible col-start-1 row-start-1 inline-flex items-center justify-center gap-2">
                        <Download size={15} />{t('settings.ghosts.remote.detailLoading')}
                      </span>
                      <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-2">
                        {showActionLoading ? <Spinner size={15} aria-hidden="true" /> : installFailed ? null : <Download size={15} aria-hidden="true" />}
                        {t(showActionLoading ? 'settings.ghosts.remote.detailLoading' : installFailed ? 'commonUi.retry' : actionKey)}
                      </span>
                    </span>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <PluginPublisherDescription origin={presentationOrigin} kind={detail.publisherKind} />
          <p className="mt-5 text-14 leading-[1.571] text-[var(--text-secondary)]">
            {detail.description || detail.ghostId}
          </p>
          {replacementDescription ? (
            <p id={replacementDescriptionId} className="mt-3 text-13 leading-5 text-[var(--text-secondary)]">
              {replacementDescription}
            </p>
          ) : null}
        </header>

        {error ? (
          <ErrorNotice className="mt-10" role="alert" message={error} actions={
            <Button size="sm" onClick={onRetry}>{t('settings.ghosts.remote.retry')}</Button>
          } />
        ) : null}
        <MarketPluginDetailBody detail={detail} error={manifest ? null : error} showLoading={showLoading} />
      </article>
    </main>
  );
}

/** Body content stays mounted when only the install freshness indicator changes. */
const MarketPluginDetailBody = memo(function MarketPluginDetailBody({ detail, error, showLoading }: {
  detail: PluginMarketItem | PluginMarketDetail;
  error?: string | null;
  showLoading: boolean;
}) {
  const { t } = useTranslation();
  const manifest = !error && 'manifest' in detail ? detail.manifest : undefined;
  const permissions = manifest ? ghostPermissionItems(manifest) : [];
  const isCustomSource = detail.sourceType !== 'server';
  return <>
        {!error ? <div className="flow-root">
          {manifest ? <>
            <PluginReadmeSection readme={'readme' in detail ? detail.readme ?? null : null} />
            {manifest.tools?.length ? <ToolsSection tools={manifest.tools} /> : null}
          </> : !error ? (
            <section className={`pt-10 ${showLoading ? '' : 'invisible'}`} aria-label={t('settings.ghosts.detail.readmeTitle')}>
              <h2 className="text-18 font-medium leading-[1.444] text-[var(--text-primary)]">{t('settings.ghosts.detail.readmeTitle')}</h2>
              <div aria-hidden="true" className="mt-5 space-y-3">
                <div className="h-4 w-full rounded-full bg-[var(--surface-hover-soft)]" />
                <div className="h-4 w-5/6 rounded-full bg-[var(--surface-hover-soft)]" />
                <div className="h-4 w-4/5 rounded-full bg-[var(--surface-hover-soft)]" />
              </div>
            </section>
          ) : null}
        </div> : null}
        {!error ? <section className="mt-10" aria-labelledby="market-security-title">
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
        </section> : null}

        {!error ? <section className="mt-10" aria-labelledby="market-permissions-title">
          <div className="flex items-baseline gap-2">
            <h2
              id="market-permissions-title"
              className="text-18 font-medium leading-[1.444] text-[var(--text-primary)]"
            >
              {t('settings.ghosts.perm.grantsTitle')}
            </h2>
            {manifest ? <span className="text-12 text-[var(--text-tertiary)]">
              {t('settings.ghosts.perm.itemCount', { count: permissions.length })}
            </span> : null}
          </div>
          <div className="mt-5 max-w-[760px] divide-y divide-[var(--border-default)] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5">
            {!manifest ? (
              <div aria-hidden="true" className={`space-y-4 py-4 ${showLoading ? '' : 'invisible'}`}>
                <div className="h-4 w-4/5 rounded-full bg-[var(--surface-hover-soft)]" />
                <div className="h-4 w-2/3 rounded-full bg-[var(--surface-hover-soft)]" />
              </div>
            ) : permissions.length > 0 ? (
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
        </section> : null}
        {manifest?.releaseNotes?.trim() ? (
          <PluginVersionUpdates key={detail.pluginId}>
            <section className="space-y-3" aria-label={t('settings.ghosts.contribution.releaseNotes')}>
              <h2 className="text-18 font-medium leading-[1.444] text-[var(--text-primary)]">
                {t('settings.ghosts.contribution.releaseNotes')} · {detail.version}
              </h2>
              <p className="whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-secondary)]">
                {manifest.releaseNotes}
              </p>
            </section>
          </PluginVersionUpdates>
        ) : null}
  </>;
});
