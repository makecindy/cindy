import { PluginShareButton } from './PluginShareButton';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { PluginRecentUpdates } from './PluginRecentUpdates';
import { PluginMoreDetails, type PluginRelatedCatalog } from './PluginMoreDetails';
import { PluginDetailFactsSection, PluginDetailHeader, pluginPackageSizeFacts, PluginPermissionCount, ToolsSection } from './GhostPluginDetailView';
import { PluginDetailArticle, PluginDetailPermissionRow, PluginDetailRecord, usePluginDetailLayout } from './PluginDetailRecord';
import { PluginPermissionList, usePluginPermissionFacts, type PluginPermissionFact } from './PluginPermissionList';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ghostPermissionItems } from '../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem } from '../../../shared/pluginMarket';
import { cn } from '@/lib/utils';
import { PluginPublisherDescription } from './PluginPublisherBadge';
import { usePluginMarketIcon } from './lib/usePluginMarketIcon';
import { pluginPresentationAuthor, pluginPresentationOrigin, publicPublisherFilter } from './lib/pluginMarketPresentation';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { PLUGIN_MANAGEMENT_FRAME_CLASS } from './PluginManagementLayout';
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
  backLabel?: string;
  relatedCatalog?: PluginRelatedCatalog;
  onOpenRelated?: (item: PluginMarketItem) => void;
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
  backLabel,
  relatedCatalog,
  onOpenRelated,
  onInstall,
  onIconLoadError,
}: MarketPluginDetailViewProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const manifest = 'manifest' in detail ? detail.manifest : undefined;
  const readme = 'readme' in detail ? detail.readme : undefined;
  const updates = 'updates' in detail ? detail.updates : undefined;
  const permissionItems = useMemo(() => manifest ? ghostPermissionItems(manifest) : [], [manifest]);
  const permissions = usePluginPermissionFacts(permissionItems);
  const layout = usePluginDetailLayout({
    id: `market:${detail.pluginId}`,
    ready: Boolean(manifest),
    navigationScope: relatedCatalog?.local ? relatedCatalog.cache : undefined,
    hasParent: Boolean(backLabel),
    blocks: {
      description: Boolean(detail.description || detail.ghostId),
      updates: Boolean(updates?.length || manifest?.releaseNotes?.trim()),
      readme: Boolean(readme?.markdown.trim()), permissions: permissions.length > 0, facts: true,
    },
  });
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
  const communityDisclaimerId = useId();
  const isCommunityPlugin = presentationOrigin === 'public' && detail.publisherKind === 'personal';
  const actionDescription = [
    replacementDescription && replacementDescriptionId,
    isCommunityPlugin && communityDisclaimerId,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <main
      ref={root}
      tabIndex={-1}
      aria-busy={loading || undefined}
      className="app-wallpaper-surface plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]"
      onScroll={onScroll}
    >
      <PluginDetailTopBar
        label={backLabel ?? t('settings.ghosts.detail.backToList')}
        onBack={() => { layout.rememberBack(); onBack(); }}
        scrolled={scrolled}
        actions={
          detail.sourceType === 'server' && detail.scope === 'public' ? (
            <PluginShareButton pluginId={detail.pluginId} />
          ) : undefined
        }
      />
      <PluginDetailArticle layout={layout} className={cn(PLUGIN_MANAGEMENT_FRAME_CLASS, 'plugin-detail-frame pb-16 pt-5')}>
        <PluginDetailHeader
          key={detail.pluginId}
          id={detail.ghostId}
          name={detail.name}
          description={detail.description || detail.ghostId}
          readme={readme}
          fallbackFacts={manifest ? {
            permissionCount: permissions.length,
            toolCount: manifest.tools?.length,
            source: t(`settings.ghosts.page.origin.${presentationOrigin}`),
          } : undefined}
          author={pluginPresentationAuthor(detail)}
          version={detail.version}
          marketItem={detail}
          origin={presentationOrigin}
          publisherKind={detail.publisherKind}
          iconContainerRef={marketIcon.containerRef}
          iconDataUrl={marketIcon.iconDataUrl}
          officialCatalog={publicPublisherFilter(detail) === 'official'}
          onIconLoad={marketIcon.onIconLoad}
          onIconLoadError={() => marketIcon.onIconLoadError(onIconLoadError)}
          sourceNotice={isCommunityPlugin ? (
            <p id={communityDisclaimerId} className="mt-3 text-12 leading-[1.667] text-[var(--text-tertiary)]">
              {t('settings.ghosts.market.communityDisclaimer')}
            </p>
          ) : detail.sourceType !== 'server' ? (
            <p className="mt-3 text-12 leading-[1.667] text-[var(--text-tertiary)]">
              {t('settings.ghosts.installConsent.customMarketSourceNotice')}
            </p>
          ) : null}
          actions={onInstall || installRing ? (
              <>
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
                    loading={busy}
                    type="button"
                    onClick={onInstall}
                    disabled={actionDisabled}
                    aria-label={t(showActionLoading ? 'settings.ghosts.remote.detailLoading' : installFailed ? 'commonUi.retry' : actionKey)}
                    aria-busy={busy || refreshing || loading || undefined}
                    aria-describedby={actionDescription}
                  >
                    {showActionLoading ? <Spinner size={15} aria-hidden="true" /> : null}
                    {t(showActionLoading ? 'settings.ghosts.remote.detailLoading' : installFailed ? 'commonUi.retry' : actionKey)}
                  </Button>
                ) : null}
              </>
          ) : null}
        >
          {replacementDescription ? (
            <p id={replacementDescriptionId} className="mt-3 text-13 leading-5 text-[var(--text-secondary)]">
              {replacementDescription}
            </p>
          ) : null}
        </PluginDetailHeader>

        {error ? (
          <ErrorNotice className="mt-10" role="alert" message={error} actions={
            <Button size="sm" onClick={onRetry}>{t('settings.ghosts.remote.retry')}</Button>
          } />
        ) : null}
        <MarketPluginDetailBody detail={detail} error={manifest ? null : error} showLoading={showLoading} permissions={permissions} />
        {manifest && detail.sourceType === 'server' && detail.installState === 'not-installed' ? (
          <PluginMoreDetails detailId={detail.pluginId} catalog={relatedCatalog}
            onSelect={onOpenRelated && (item => { layout.rememberForward(item.pluginId); onOpenRelated(item); })} />
        ) : null}
      </PluginDetailArticle>
    </main>
  );
}

/** Body content stays mounted when only the install freshness indicator changes. */
const MarketPluginDetailBody = memo(function MarketPluginDetailBody({ detail, error, showLoading, permissions }: {
  detail: PluginMarketItem | PluginMarketDetail;
  error?: string | null;
  showLoading: boolean;
  permissions: readonly PluginPermissionFact[];
}) {
  const { t } = useTranslation();
  const manifest = !error && 'manifest' in detail ? detail.manifest : undefined;
  const isCustomSource = detail.sourceType !== 'server';
  const author = pluginPresentationAuthor(detail);
  const origin = pluginPresentationOrigin(detail);
  const source = origin === 'public'
    ? t('settings.ghosts.detail.publicInstall')
    : t(`settings.ghosts.market.scope.${origin}`);
  if (error) return null;
  const releaseNotes = manifest?.releaseNotes?.trim();
  return (
    <>
    <PluginRecentUpdates key={detail.pluginId} updates={'updates' in detail ? detail.updates : undefined}
      fallback={releaseNotes ? {
        version: detail.version, releaseNotes, publishedAt: isCustomSource ? undefined : detail.publishedAt,
      } : undefined} />
    <PluginDetailRecord>
      <PluginDetailPermissionRow key={detail.pluginId} summary={manifest ? <PluginPermissionCount items={permissions} /> : undefined}>
        {limit => <>
        <p className="mb-4 text-13 font-medium text-[var(--text-primary)]">{t('settings.ghosts.perm.grantsTitle')}</p>
        {!manifest ? (
          <div aria-hidden="true" className={`space-y-4 py-4 ${showLoading ? '' : 'invisible'}`}>
            <div className="h-4 w-4/5 rounded-full bg-[var(--surface-hover-soft)]" />
            <div className="h-4 w-2/3 rounded-full bg-[var(--surface-hover-soft)]" />
          </div>
        ) : permissions.length ? <PluginPermissionList items={permissions} limit={limit} choiceKey="permissionList" /> : (
          <p className="text-13 text-[var(--text-tertiary)]">{t('settings.ghosts.market.noPermissions')}</p>
        )}
        <div className="mt-5 flex items-start gap-3 border-t border-[var(--border-default)] pt-4">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-12 font-medium text-[var(--text-primary)]">{t('settings.ghosts.market.securityTitle')}</h3>
            <p className="mt-1 text-pretty text-12 leading-normal text-[var(--text-secondary)]">
              {t(isCustomSource ? 'settings.ghosts.market.customSecurityDescription' : 'settings.ghosts.market.securityDescription')}
            </p>
          </div>
        </div>
        </>}
      </PluginDetailPermissionRow>
      <PluginDetailFactsSection facts={[
        { key: 'version', label: t('settings.ghosts.detail.infoVersion'), value: `v${detail.version}` },
        ...pluginPackageSizeFacts(t, detail),
        ...(author ? [{ key: 'author', label: t('settings.ghosts.detail.infoAuthor'), value: author }] : []),
        { key: 'source', label: t('mcpApps.sourceLabel'), value: source },
        { key: 'identifier', label: t('settings.ghosts.detail.infoId'), value: detail.ghostId, monospace: true },
      ]}>
        {origin === 'public' && detail.publisherKind === 'personal' ? null : (
          <PluginPublisherDescription origin={origin} kind={detail.publisherKind} />
        )}
        {manifest?.tools ? <ToolsSection tools={manifest.tools} /> : null}
      </PluginDetailFactsSection>
    </PluginDetailRecord>
    </>
  );
});
