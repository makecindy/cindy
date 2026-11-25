import { parsePluginInstallationSource } from '@cindy/maker-shared/mcp-apps';
import { getPluginToolUi, type GhostReadmeContent } from '@cindy/plugin-protocol';
import { pluginHasToolUi } from '@cindy/plugin-protocol';
import type { PreparedPluginContribution } from '../../../shared/pluginContributions';
import { PluginShareButton } from './PluginShareButton';
import { PluginUiMenu } from '@/cindy-brain/PluginUiContributions';
import { Button } from '@/components/ui/button';
import { GithubAccountCard } from '@/features/cc-agent/GithubAccountCard';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
/**
 * Plugin detail presentation for configuration, Tools, permissions, and factual metadata.
 *
 * Inputs: the renderer-safe Plugin detail model plus the installed Ghost when available.
 * Outputs: a list-aligned detail frame, responsive identity and actions, Host-owned configuration,
 * and the accordion with source, publisher information, tools and permissions.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AppWindow,
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  Copy,
  Download,
  MessageCircle,
  FolderOpen,
  LayoutTemplate,
  MoreVertical,
  Info,
  Trash2,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

import { PluginReadmeSection, usePluginReadme } from './PluginReadmeSection';
import { PluginDetailDisclosure, PluginRecentUpdates, usePluginTextLines } from './PluginRecentUpdates';
import { PluginPublisherDescription } from './PluginPublisherBadge';
import { PluginDetailHero, type PluginDetailHeroProps } from './PluginDetailHero';
import { pluginPresentationOrigin } from './lib/pluginMarketPresentation';
import type { PluginMarketItem, PluginMarketUpdate } from '../../../shared/pluginMarket';
import { GhostLibrarySection } from './GhostLibrarySection';
import { GhostHandoffFilesSection } from './GhostHandoffFilesSection';
import { GhostAccountReuseSection } from './GhostAccountReuseSection';
import { PluginBackgroundTasksSection } from './PluginBackgroundTasksSection';
import { PluginControlPointsSection } from './PluginControlPointsSection';
import { PluginEngineRemoteUseCards, usePluginRemoteUseEngines } from './PluginEngineRemoteUse';
import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { providerShareGate } from '@/features/provider-share/providerShareFormat';
import { ProviderShareManagePage } from '@/features/provider-share/ProviderShareManagePage';
import { useRemoteControlEnabled } from '@/hooks/useRemoteControlEnabled';
import { PluginTaskPrefs } from '@/cindy-brain/PluginTaskPrefs';
import { GhostSettingsWebview } from '@/cindy-brain/GhostSettingsWebview';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  declaredGhostControlPoints,
  ghostDeclaresHiddenTasks,
  ghostInstallApprovalToken,
  ghostToolDeclaresHandoff,
  ghostTrustLabelKey,
  type GhostPermissionItem,
  type GhostToolDecl,
  type InstalledGhost,
} from '../../../shared/ghost';
import { type GhostPluginDetail } from './lib/ghostPluginViewModel';
import {
  hasPluginPlacementMemory,
  useGlobalTabs,
} from '@/features/right-sidebar/globalTabs';
import {
  openPluginInSidebar,
  resetPluginPlacementAndReturn,
} from '@/features/right-sidebar/pluginPlacement';
import { useTabGroupAssignments } from '@/features/right-sidebar/tabGroups';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { ghostPluginSummary } from './lib/ghostPluginDetailModel';
import { ghostPrimaryAction } from './lib/ghostPluginViewModel';
import { PluginLimitedList, PluginPermissionList, usePluginPermissionFacts, type PluginPermissionFact } from './PluginPermissionList';
import {
  PluginDetailArticle, PluginDetailPermissionRow, PluginDetailRecord, PluginDetailRecordRow, PluginDetailSection,
  usePluginDetailChoice, usePluginDetailLayout, usePluginDetailRelaxed,
} from './PluginDetailRecord';
import { PluginMoreDetails, type PluginRelatedCatalog } from './PluginMoreDetails';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { PLUGIN_MANAGEMENT_FRAME_CLASS } from './PluginManagementLayout';
import { PluginInstallRing } from './PluginInstallRing';
import { usePluginInstallProgress } from './lib/pluginInstallProgress';
import './plugin-motion.css';
import './plugin-detail-layout.css';

interface GhostPluginDetailViewProps {
  /** Remote configuration section, including its heading or disabled notice. */
  remoteConfiguration?: ReactNode;
  remote?: boolean;
  remoteFileUpdate?: boolean;
  ghost: InstalledGhost | null;
  /** Only a verified server-market association can offer public sharing. */
  sharePluginId?: string;
  detail: GhostPluginDetail;
  marketItem?: PluginMarketItem | null;
  installationPending?: boolean;
  panelStatus: string | null;
  enabledOverride?: boolean;
  onBack: () => void;
  backLabel?: string;
  relatedCatalog?: PluginRelatedCatalog;
  onOpenRelated?: (item: PluginMarketItem) => void;
  publishingSection?: ReactNode;
  onToggle: (enabled: boolean) => void;
  /** 主动作:面板型「使用」/ 指令或 Host 能力型「对话」;纯工具型不渲染主按钮。 */
  onUse: () => void;
  /** main-view 入口偏好只影响侧边栏，不改变插件启用态或路由资格。 */
  mainViewSidebarVisible?: boolean;
  onMainViewSidebarVisibleChange?: (visible: boolean) => void;
  /** 头部更新 CTA:市场有新版本时走市场更新确认流。 */
  onUpdate: () => void;
  /**
   * 安装记录缺失或损坏时的恢复入口。可选:仅插件页宿主注入；未注入时按钮不出现，
   * 门控见下方 `needsReapproval && !detail.builtin && onReapprove`。
   */
  onReapprove?: () => void;
  /** ⋮ 菜单的兜底路径:从本地 .cindy 文件更新。 */
  onUpdateFromFile: () => void;
  /** 市场存在新版本时的目标版本号;设置后头部展示显著的更新按钮。 */
  updateVersion?: string;
  updateNotes?: string;
  releaseUpdates?: readonly PluginMarketUpdate[];
  updateBusy?: boolean;
  onUninstall: () => void;
  /** 导出 .cindy;当前详情非已装插件(纯市场视图)时缺省,菜单项不渲染。 */
  onExport?: () => void;
  /** Opens publishing; package preparation and submission belong to the dialog. */
  onContribute?: () => void;
  contributionBusy?: boolean;
  publishingPreview?: PreparedPluginContribution;
  contributionUnavailableReason?: string;
  toggleDisabled: boolean;
  onIconLoadError?: () => void;
}

const DETAIL_SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';
const DETAIL_SURFACE_INTERACTIVE_CLASS =
  'transition-[background-color,border-color,transform] duration-150 hover:border-[var(--border-default)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_96%,var(--surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:scale-[0.99]';

/** Installed Ghost detail surface, ordered around configuration and capability review. */
export function GhostPluginDetailView({
  remote = false,
  remoteFileUpdate = false,
  remoteConfiguration,
  ghost,
  sharePluginId,
  detail,
  panelStatus,
  enabledOverride,
  onBack,
  backLabel,
  relatedCatalog,
  onOpenRelated,
  publishingSection,
  onToggle,
  onUse,
  marketItem,
  installationPending = false,
  mainViewSidebarVisible = true,
  onMainViewSidebarVisibleChange,
  onUpdate,
  onReapprove,
  onUpdateFromFile,
  updateVersion,
  updateNotes,
  releaseUpdates,
  updateBusy = false,
  onUninstall,
  onExport,
  onContribute,
  contributionBusy = false,
  publishingPreview,
  contributionUnavailableReason,
  toggleDisabled,
  onIconLoadError,
}: GhostPluginDetailViewProps) {
  const { t, i18n } = useTranslation();
  const uiLanguage = i18n.resolvedLanguage ?? i18n.language;
  const presentationOrigin = marketItem ? pluginPresentationOrigin(marketItem) : detail.origin;
  const publisherKind = marketItem?.sourceType === 'server' && marketItem.scope === 'public'
    ? marketItem.publisherKind : detail.publisherKind;
  const installationLabel = detail.installationLabelKey
    ? t(`settings.ghosts.detail.${detail.installationLabelKey}`, { name: detail.installationNamespace })
    : undefined;
  const { scrolled, onScroll } = usePluginDetailScrolled();
  // 只有本窗口发起的更新才有进度;远程设备上的插件仍按回执显示。
  const updateProgress = usePluginInstallProgress(remote ? null : marketItem?.pluginId);
  const updateFailed = updateProgress?.download.phase === 'failed';
  const updateLabel =
    !updateVersion || updateVersion === detail.version
      ? t('settings.ghosts.market.update')
      : t('settings.ghosts.market.updateTo', { version: updateVersion });
  const targetReleaseNotes = updateVersion ? updateNotes?.trim() : undefined;
  const noteVersion = targetReleaseNotes && updateVersion ? updateVersion : detail.version;
  const fallbackNotes = targetReleaseNotes || detail.releaseNotes?.trim();
  const enableSwitchId = useId();
  const publicationBlocked = publishingPreview?.preflight?.actions.canSubmit === false;
  const [githubConnectionVersion, setGithubConnectionVersion] = useState(0);
  const [taskApprovalPending, setTaskApprovalPending] = useState(false);
  const [browserActivation, setBrowserActivation] = useState<{ id: string; state: 'pending' | 'done' | 'failed' } | null>(null);
  // 未批准的安装不可运行；恢复入口与普通停用区分。
  const needsReapproval = detail.approvalState !== 'approved';
  const enabled = (enabledOverride ?? detail.enabled) && !needsReapproval;
  const primaryAction = ghostPrimaryAction(detail);
  const authorizationExpired = !remote && enabled && detail.oauthAuthorizationExpired;
  const primaryEnabled =
    enabled &&
    (primaryAction === 'panel' ||
      (primaryAction === 'command' && detail.canUse));
  // The shared GitHub login is available to any approved declaration.
  const hasGithubConnection =
    !remote && !needsReapproval &&
    ghost?.manifest.network?.secrets?.some(secret => secret.source === 'gh-cli') === true;
  // 这个插件在本机提供的执行引擎：每个引擎一张「允许被远程调用」的卡片(远程查看别的电脑的插件时不显示，
  // 开关只能在装着插件的那台电脑上改)。
  const remoteUseEngines = usePluginRemoteUseEngines(!remote && ghost ? detail.id : null);
  const remoteControlEnabled = useRemoteControlEnabled();
  const [shareManageSelection, setShareManageSelection] = useState<{ ghostId: string; engineKey: string } | null>(null);
  const shareManageEngine = !remote && shareManageSelection?.ghostId === detail.id
    ? remoteUseEngines.find((engine) => engine.key === shareManageSelection.engineKey && engine.remoteUse?.shareSupported === true) ?? null
    : null;
  const hasConfiguration =
    (hasGithubConnection && Boolean(ghost?.manifest.routineEvents)) ||
    Boolean(ghost?.manifest.browserExtension) ||
    detail.hasMainView ||
    detail.hasSettingsUi ||
    detail.hasTaskPreferences ||
    remoteUseEngines.length > 0;
  const summary = ghostPluginSummary(detail.description, detail.ghostId);
  // 远程文件更新按目标 Host 能力判断，不能使用控制端的 DEV 状态。
  const localUpdateAvailable = (!remote || remoteFileUpdate) && ghost?.publishingSource?.kind !== 'public-market';
  const hasAdditionalActions = localUpdateAvailable || onExport !== undefined;
  // 远程设备的插件目录不在本机，详细介绍只在本机详情页读取。
  const { readme, pending: readmePending } = usePluginReadme(
    ghost ? `${detail.id}@${ghost.manifest.version}@${uiLanguage}` : null,
    ghost?.manifest.readme && !remote ? () => window.electronAPI.ghosts.readme(detail.id, uiLanguage) : null,
  );
  const permissionFacts = usePluginPermissionFacts(detail.permissions.filter(item => item.kind !== 'tool'));
  const toolUiDeclared = Boolean(ghost && pluginHasToolUi(ghost.manifest));
  const accountReuseDeclared = ghost?.manifest.network?.secrets?.some(
    secret => !secret.source || secret.source === 'user' || secret.source === 'oauth',
  ) === true;
  const libraryDeclared = ghost?.manifest.library === true;
  const handoffDeclared = (ghost?.manifest.tools ?? []).some(tool => ghostToolDeclaresHandoff(tool));
  const controlPointsDeclared = Boolean(ghost && declaredGhostControlPoints(ghost.manifest).length);
  const hiddenTasksDeclared = ghostDeclaresHiddenTasks(ghost?.manifest);
  const layout = usePluginDetailLayout({
    id: `installed:${detail.id}`,
    navigationScope: !remote && relatedCatalog?.local ? relatedCatalog.cache : undefined,
    hasParent: Boolean(backLabel),
    readmePending,
    blocks: {
      description: Boolean(summary), updates: Boolean(releaseUpdates?.length || fallbackNotes),
      readme: Boolean(readme?.markdown.trim()), permissions: permissionFacts.length > 0, facts: true,
    },
  });
  const localShareAvailable = !remote && ghost?.publishingSource?.kind === 'local' &&
    ghost.approval.state === 'approved' && ghost.namespaceState === 'confirmed' && (ghost.namespace === null || ghost.namespace === 'local') &&
    !ghost.builtin;

  if (shareManageEngine) {
    return (
      <main className="app-wallpaper-surface plugin-motion-root h-full min-h-0 w-full overflow-hidden bg-[var(--surface)]">
        <div className="mx-auto h-full w-full max-w-[824px] px-8 pt-5 max-[760px]:px-6">
          <ProviderShareManagePage
            key={`local:${shareManageEngine.providerId}`}
            providerId={shareManageEngine.providerId}
            providerName={shareManageEngine.name}
            providerIcon={<PluginEngineIcon size={18} iconDataUrl={shareManageEngine.iconDataUrl} />}
            backLabel={detail.name}
            gate={providerShareGate({
              remoteControlEnabled,
              invocationEnabled: shareManageEngine.remoteUse?.enabled === true,
            })}
            onBack={() => setShareManageSelection(null)}
          />
        </div>
      </main>
    );
  }

  return (
    <main
      className="app-wallpaper-surface plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]"
      onScroll={onScroll}
    >
      <PluginDetailTopBar
        label={backLabel ?? t('settings.ghosts.detail.backToList')}
        onBack={() => { layout.rememberBack(); onBack(); }}
        scrolled={scrolled}
        actions={<>
          {sharePluginId ? <PluginShareButton pluginId={sharePluginId} /> : localShareAvailable && ghost ? <PluginShareButton ghost={ghost} /> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tip text={t('settings.ghosts.detail.moreActions')}>
                <Button variant="secondary" tone="quiet" size="lg" className="w-9 px-0"
                  aria-label={t('settings.ghosts.detail.moreActions')}>
                  <MoreVertical size={18} aria-hidden="true" />
                </Button>
              </Tip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={8}
              className="w-56 p-1.5"
            >
              {localUpdateAvailable ? (
                <DropdownMenuItem
                  onSelect={onUpdateFromFile}
                  disabled={updateBusy}
                >
                  {t('settings.ghosts.detail.updateFromFile')}
                </DropdownMenuItem>
              ) : null}
              {onExport ? (
                <DropdownMenuItem
                  onSelect={onExport}
                  className="gap-2.5"
                >
                  <Download size={15} aria-hidden="true" />
                  {t('settings.ghosts.detail.exportPackage')}
                </DropdownMenuItem>
              ) : null}
              {hasAdditionalActions ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuItem
                onSelect={onUninstall}
                disabled={updateBusy}
                variant="danger"
                className="gap-2.5"
              >
                <Trash2 size={15} aria-hidden="true" />
                {t('settings.ghosts.uninstall')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>}
      />
      <PluginDetailArticle layout={layout} className={cn(PLUGIN_MANAGEMENT_FRAME_CLASS, 'plugin-detail-frame pb-16 pt-5')}>
        <PluginDetailHeader
          id={detail.id}
          name={detail.name}
          description={summary}
          readme={readme}
          fallbackFacts={{
            permissionCount: permissionFacts.length,
            toolCount: detail.tools.length,
            source: presentationOrigin ? t(`settings.ghosts.page.origin.${presentationOrigin}`) : undefined,
          }}
          author={detail.author}
          version={detail.version}
          marketItem={marketItem}
          origin={presentationOrigin}
          publisherKind={publisherKind}
          installationPending={installationPending}
          versionLabel={updateVersion ? 'installed' : 'current'}
          iconDataUrl={detail.iconDataUrl}
          onIconLoadError={onIconLoadError}
          sourceNotice={marketItem && marketItem.sourceType !== 'server' ? (
            <p className="mt-3 text-12 leading-[1.667] text-[var(--text-tertiary)]">
              {t('settings.ghosts.installConsent.customMarketSourceNotice')}
            </p>
          ) : null}
          actions={
            <>
              {needsReapproval && !detail.builtin && onReapprove ? (
                <Button
                  variant="cta"
                  size="lg"
                  type="button"
                  onClick={onReapprove}
                  disabled={updateBusy}
                >
                  {t('settings.ghosts.reapproval.action')}
                </Button>
              ) : (
                <>
                  {/* 更新进行中:圆环原位替换更新按钮;失败时圆环停在原处,按钮回来供重试。 */}
                  {updateProgress && (!updateFailed || updateVersion) ? (
                    <PluginInstallRing
                      label={updateLabel}
                      progress={updateProgress}
                      size={24}
                      explainRetry
                      className="max-w-[260px] px-1 text-13 font-medium"
                    />
                  ) : null}
                  {updateVersion && (!updateProgress || updateFailed) ? (
                    // 更新提级(设计定稿):有新版本时黑色主 CTA 直达市场更新确认流。
                    <Button
                      variant="cta"
                      size="lg"
                      loading={updateBusy}
                      type="button"
                      onClick={onUpdate}
                      disabled={updateBusy}
                      aria-label={updateLabel}
                      aria-busy={updateBusy || undefined}
                    >
                      {updateFailed ? (
                        t('commonUi.retry')
                      ) : (
                        <>
                          <ArrowUp size={14} aria-hidden="true" />
                          {updateLabel}
                        </>
                      )}
                    </Button>
                  ) : null}
                </>
              )}
              {!remote && !needsReapproval && primaryAction !== 'manage' ? (
                <Button
                  variant={updateVersion || authorizationExpired || ghost?.oauthScopeStale ? 'secondary' : 'cta'}
                  size="lg"
                  type="button"
                  onClick={onUse}
                  disabled={!primaryEnabled}
                  title={!enabled ? t('settings.ghosts.detail.useDisabled') : undefined}
                >
                  {primaryAction === 'command' ? (
                    <MessageCircle size={14} aria-hidden="true" />
                  ) : null}
                  {t(
                    primaryAction === 'panel'
                      ? 'settings.ghosts.detail.useAction'
                      : 'settings.ghosts.detail.chatAction',
                  )}
                </Button>
              ) : null}
              {!publicationBlocked && onContribute ? (
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={onContribute}
                  loading={contributionBusy}
                  disabled={Boolean(contributionUnavailableReason)}
                  title={contributionUnavailableReason}
                >
                  {t('settings.ghosts.contribution.publishPlugin')}
                </Button>
              ) : null}
            </>
          }
          enableControl={
            <label
              htmlFor={enableSwitchId}
              className={cn(
                'flex items-center gap-2 rounded-full py-1 pl-2 transition-colors duration-[var(--motion-fast)]',
                'hover:bg-[var(--surface-hover-soft)]',
                toggleDisabled || needsReapproval ? 'cursor-not-allowed' : 'cursor-pointer',
              )}
            >
              <span
                className={cn(
                  'min-w-0 text-13 text-[var(--text-secondary)] [overflow-wrap:anywhere]',
                  (toggleDisabled || needsReapproval) && 'opacity-60',
                )}
              >
                {t(
                  enabled
                    ? 'settings.ghosts.detail.enabledLabel'
                    : 'settings.ghosts.detail.disabledLabel',
                )}
              </span>
              <Switch
                id={enableSwitchId}
                checked={enabled}
                disabled={toggleDisabled || needsReapproval}
                onCheckedChange={onToggle}
                aria-label={t('settings.ghosts.enableAria', { name: detail.name })}
              />
            </label>
          }
        >

          {needsReapproval ? (
            <div className={cn('mt-5 rounded-xl px-4 py-3.5', DETAIL_SURFACE_CLASS)} role="status">
              <p className="text-13 font-medium text-[var(--text-primary)]">
                {t('settings.ghosts.reapproval.noticeTitle')}
              </p>
              <p className="mt-1 text-13 leading-5 text-[var(--text-secondary)]">
                {t(
                  detail.builtin
                    ? 'settings.ghosts.reapproval.bodyBuiltinRestart'
                    : detail.approvalState === 'invalid'
                      ? 'settings.ghosts.reapproval.bodyInvalid'
                      : 'settings.ghosts.reapproval.bodyLegacy',
                )}
              </p>
            </div>
          ) : null}
          {!remote && (authorizationExpired || (detail.hasSettingsUi && ghost?.oauthScopeStale)) ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {authorizationExpired ? <OauthScopeStaleBadge expired /> : null}
              {detail.hasSettingsUi && ghost?.oauthScopeStale ? <OauthScopeStaleBadge /> : null}
            </div>
          ) : null}
        </PluginDetailHeader>

        <PluginRecentUpdates key={detail.id} updates={releaseUpdates} fallback={fallbackNotes ? {
          version: noteVersion, releaseNotes: fallbackNotes,
          publishedAt: marketItem?.sourceType === 'server' && marketItem.version === noteVersion ? marketItem.publishedAt : undefined,
        } : undefined} />

        {remote ? remoteConfiguration : hasConfiguration ? (
          <PluginDetailSection title={t('settings.ghosts.detail.configurationTitle')}>
            <div className="min-w-0 space-y-3">
              {ghost?.manifest.browserExtension ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" disabled={!enabled || browserActivation?.id === detail.id && browserActivation.state === 'pending'}
                    onClick={async () => {
                      const id = detail.id;
                      setBrowserActivation({ id, state: 'pending' });
                      try {
                        const result = await window.electronAPI.ghosts.activateBrowser(id);
                        setBrowserActivation({ id, state: result.ok ? 'done' : 'failed' });
                      } catch { setBrowserActivation({ id, state: 'failed' }); }
                    }}>
                    {t('settings.ghosts.detail.browserUse')}
                  </Button>
                  {browserActivation?.id === detail.id && browserActivation.state !== 'pending' ? (
                    <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">
                      {t(browserActivation.state === 'done' ? 'settings.ghosts.detail.browserActivated' : 'settings.ghosts.detail.browserActivationFailed')}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {detail.hasMainView ? (
                <div
                  className={cn(
                    DETAIL_SURFACE_CLASS,
                    'flex min-h-20 items-center gap-3 rounded-xl px-5 py-4',
                  )}
                >
                  <AppWindow
                    size={18}
                    className="shrink-0 text-[var(--text-tertiary)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                      {t('settings.ghosts.detail.sidebarEntryTitle')}
                    </p>
                    <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
                      {t('settings.ghosts.detail.sidebarEntryDescription', {
                        title: detail.mainViewTitle ?? detail.name,
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={mainViewSidebarVisible}
                    onCheckedChange={onMainViewSidebarVisibleChange}
                    aria-label={t('settings.ghosts.detail.showInSidebar')}
                  />
                </div>
              ) : null}
              {detail.hasSettingsUi ? (
                ghost ? (
                  <GhostSettingsWebview
                    reloadKey={githubConnectionVersion}
                    account={
                      hasGithubConnection ? (
                        <GithubAccountCard
                          pluginSettings
                          includeEvents={ghost.manifest.id === 'cindy-github' && ghost.namespace === null}
                          onConnected={() => setGithubConnectionVersion((version) => version + 1)}
                        />
                      ) : undefined
                    }
                    ghost={ghost}
                    title={t('settings.ghosts.detail.settingsTitle', { name: detail.name })}
                    appearance="plugin"
                  />
                ) : (
                  <div
                    className={cn(
                      DETAIL_SURFACE_CLASS,
                      'flex min-h-20 items-center gap-3 rounded-xl px-5 py-4',
                    )}
                  >
                    <LayoutTemplate
                      size={18}
                      className="shrink-0 text-[var(--text-tertiary)]"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                        {t('settings.ghosts.detail.settingsTitle', { name: detail.name })}
                      </p>
                      <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
                        {t('settings.ghosts.detail.settingsUnavailableUntilRestore')}
                      </p>
                    </div>
                  </div>
                )
              ) : null}
              <PluginEngineRemoteUseCards
                engines={remoteUseEngines}
                onManageShare={(engine) => setShareManageSelection({ ghostId: detail.id, engineKey: engine.key })}
                surfaceClassName={DETAIL_SURFACE_CLASS}
              />
              {ghost?.manifest.routineEvents ? (
                <p className="text-13 text-[var(--text-secondary)]">
                  {t('routines.pluginCapability')}
                </p>
              ) : null}
              {detail.hasTaskPreferences ? (
                <PluginTaskPrefs ghostId={detail.id} appearance="plugin"
                  showTaskRows={detail.hasPluginTasks}
                  legacyDefault={ghost?.manifest.agent?.errand === true && !ghost.manifest.agent?.tasks && !ghost.manifest.workspace} />
              ) : null}
            </div>
          </PluginDetailSection>
        ) : null}

        <PluginBackgroundTasksSection
          ghostId={detail.id}
          installed={ghost !== null}
          hiddenTasksDeclared={hiddenTasksDeclared}
        />

        {ghost && !remote ? (
          <PluginControlPointsSection
            ghostId={detail.id}
            declared={controlPointsDeclared}
          />
        ) : null}

        {ghost && toolUiDeclared && <section className="mt-4 space-y-3">
          {!remote && <PluginUiMenu ghostId={detail.id} />}
          <h3 className="text-14 font-medium text-[var(--text-primary)]">{t('settings.ghosts.perm.mcpUi')}</h3>
          <PluginLimitedList items={(ghost.manifest.tools ?? []).filter(tool => getPluginToolUi(ghost.manifest)?.tools[tool.name])}
            className="space-y-3" choiceKey="interactiveTools" renderItem={tool => (
              <li key={tool.name} className="text-13 text-[var(--text-secondary)]">
                <p>{tool.name}</p>
                <p className="break-all text-12">{getPluginToolUi(ghost.manifest)?.tools[tool.name].visibility && !getPluginToolUi(ghost.manifest)?.tools[tool.name].visibility!.includes('model') ? t('settings.ghosts.perm.mcpAppOnly') : `ghost_call: ${tool.name}`}</p>
              </li>
            )} />
          {!remote && enabled && ghost.uiCapabilityApproved !== true && <Button variant="secondary" size="sm" disabled={taskApprovalPending} onClick={async () => {
            setTaskApprovalPending(true);
            try { await window.electronAPI.ghosts.requestUiApproval(detail.id); }
            catch { toast.error(t('settings.ghosts.errors.generic')); }
            finally { setTaskApprovalPending(false); }
          }}>{t('settings.ghosts.installConsent.updateNeedsConsent')}</Button>}
        </section>}

        {!remote && enabled && ghost?.manifest.agent?.tasks === true && ghost.taskCapabilityApproved !== true ? (
          <Button variant="secondary" size="sm" className="mt-4" disabled={taskApprovalPending} onClick={async () => {
            setTaskApprovalPending(true);
            try {
              await window.electronAPI.ghosts.requestTaskApproval(detail.id);
            } catch {
              toast.error(t('settings.ghosts.errors.generic'));
            } finally {
              setTaskApprovalPending(false);
            }
          }}>
            {t('settings.ghosts.perm.agentTasksRequest')}
          </Button>
        ) : null}
        {!remote && enabled && ghost?.manifest.agent?.observe === true && ghost.observeCapabilityApproved !== true ? (
          <Button variant="secondary" size="sm" className="mt-4" disabled={taskApprovalPending} onClick={async () => {
            setTaskApprovalPending(true);
            try {
              await window.electronAPI.ghosts.requestTaskApproval(detail.id, 'observe');
            } catch {
              toast.error(t('settings.ghosts.errors.generic'));
            } finally {
              setTaskApprovalPending(false);
            }
          }}>
            {t('settings.ghosts.perm.agentObserveRequest')}
          </Button>
        ) : null}
        {!remote && enabled && ghost?.manifest.agent?.companions === true && ghost.companionsCapabilityApproved !== true ? (
          <Button variant="secondary" size="sm" className="mt-4" disabled={taskApprovalPending} onClick={async () => {
            setTaskApprovalPending(true);
            try {
              await window.electronAPI.ghosts.requestTaskApproval(detail.id, 'companions');
            } catch {
              toast.error(t('settings.ghosts.errors.generic'));
            } finally {
              setTaskApprovalPending(false);
            }
          }}>
            {t('settings.ghosts.perm.agentCompanionsRequest')}
          </Button>
        ) : null}

        {!remote ? <GhostAccountReuseSection key={`${detail.id}:${ghostInstallApprovalToken(ghost?.approval)}`} ghostId={detail.id} enabled={enabled} declared={accountReuseDeclared} /> : null}
        {!remote ? <GhostLibrarySection ghostId={detail.id} enabled={libraryDeclared} /> : null}
        {!remote ? (
          <GhostHandoffFilesSection
            ghostId={detail.id}
            declared={handoffDeclared}
          />
        ) : null}

        {publishingSection}

        <PluginDetailRecord key={detail.id}>
          <PluginPermissionSummary items={permissionFacts} />
          <DetailsSection
            detail={remote ? { ...detail, installDir: null } : detail}
            marketItem={marketItem}
            panelStatus={panelStatus}
            installationLabel={installationLabel}
            publisherDescription={<PluginPublisherDescription origin={presentationOrigin} kind={publisherKind} />}
          />
        </PluginDetailRecord>
        {!remote && !needsReapproval && !ghost?.retirement ? (
          <PluginMoreDetails detailId={marketItem?.pluginId ?? `installed:${detail.id}`} catalog={relatedCatalog}
            onSelect={onOpenRelated && (item => { layout.rememberForward(item.pluginId); onOpenRelated(item); })} />
        ) : null}
      </PluginDetailArticle>
    </main>
  );
}

/** 宿主侧非阻塞角标；重新连接动作继续复用插件设置区已有入口。 */
export function OauthScopeStaleBadge({ expired = false }: { expired?: boolean } = {}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex w-fit max-w-full items-center gap-1.5 rounded-full bg-[var(--warning-bg-soft)] px-3 py-1.5 text-12 leading-[1.667] text-[var(--text-secondary)]"
    >
      <AlertTriangle size={13} className="shrink-0 text-[var(--warning-fg)]" aria-hidden="true" />
      <span>{t(expired ? 'settings.ghosts.page.oauthAuthorizationExpired' : 'settings.ghosts.detail.oauthScopeStale')}</span>
    </div>
  );
}

export function PluginDetailHeader({
  description,
  readme,
  sourceNotice,
  children,
  ...hero
}: PluginDetailHeroProps & {
  description: string;
  readme?: GhostReadmeContent | null;
  sourceNotice?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header>
      <PluginDetailHero {...hero} />
      <PluginDetailDescription key={hero.id} description={description} readme={readme} />
      {sourceNotice}
      {children}
    </header>
  );
}

export function PluginDetailDescription({ description, readme }: {
  description: string;
  readme?: GhostReadmeContent | null;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [choice, setChoice] = usePluginDetailChoice('description');
  const { ref, lines } = usePluginTextLines(description);
  const relaxedDescription = usePluginDetailRelaxed('description');
  const relaxedReadme = usePluginDetailRelaxed('readme');
  const hasReadme = Boolean(readme?.markdown.trim());
  const roomier = choice === undefined && relaxedDescription;
  const preview = choice === undefined && relaxedReadme && hasReadme;
  const expand = choice !== true && (hasReadme || lines > (roomier ? 6 : 3));
  const collapse = choice === true || preview || (roomier && lines > 3);
  if (!description.trim() && !hasReadme) return null;
  return (
    <div className="mt-7">
      <div id={id}>
        <p
          ref={ref}
          className={cn(
            'whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-16 leading-[1.7] text-[var(--text-primary)]',
            choice !== true && (roomier ? 'line-clamp-6' : lines > 3 && 'line-clamp-2'),
          )}
        >
          {description}
        </p>
        {hasReadme && (choice || preview) ? <PluginReadmeSection readme={readme ?? null} preview={preview} /> : null}
      </div>
      {expand || collapse ? (
        <div className="mt-1 flex flex-wrap gap-x-2">
          {expand && <PluginDetailDisclosure expanded={false} controls={id} onClick={() => setChoice(true)}>
            {t('settings.ghosts.detail.descriptionExpand')}
          </PluginDetailDisclosure>}
          {collapse && <PluginDetailDisclosure expanded controls={id} onClick={() => setChoice(false)}>
            {t('settings.ghosts.detail.descriptionCollapse')}
          </PluginDetailDisclosure>}
        </div>
      ) : null}
    </div>
  );
}

/** Compact factual metadata with one shared color and stable product order. */
export function ToolsSection({ tools }: { tools: readonly (Pick<GhostToolDecl, 'name' | 'description'> & Partial<GhostToolDecl>)[] }) {
  const { t } = useTranslation();
  if (!tools.length) return null;
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-13 font-medium text-[var(--text-secondary)]">
        {t('settings.ghosts.detail.toolsTitle')}{' '}
        <span className="tabular-nums">{t('settings.ghosts.detail.toolCount', { count: tools.length })}</span>
      </h3>
      <PluginLimitedList items={tools} limit={6} choiceKey="tools" className="divide-y divide-[var(--border-default)]"
        renderItem={tool => <ToolDescriptionRow key={tool.name} tool={tool} />} />
    </div>
  );
}

function ToolDescriptionRow({ tool }: { tool: Pick<GhostToolDecl, 'name' | 'description'> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, tool.description]);
  return (
    <li className="grid min-w-0 gap-x-3 gap-y-1 py-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]">
      <code className="break-words text-13 text-[var(--text-primary)]">{tool.name}</code>
      <p ref={ref} className={cn('whitespace-pre-line break-words text-13 leading-[1.54] text-[var(--text-secondary)]', !expanded && 'line-clamp-2')}>
        {tool.description || t('settings.ghosts.detail.noToolDescription')}
      </p>
      {clipped || expanded ? <Button type="button" tone="quiet" variant="secondary" size="xs" compact className="justify-self-start" aria-expanded={expanded}
        aria-label={t('settings.ghosts.detail.openTool', { name: tool.name })} onClick={() => setExpanded(value => !value)}>
        <ChevronDown size={14} className={expanded ? 'rotate-180' : undefined} aria-hidden="true" />
      </Button> : null}
    </li>
  );
}

/** A Tool exposes only its author-provided description after explicit activation. */
export function ToolDescriptionChip({ tool }: { tool: Pick<GhostToolDecl, 'name' | 'description'> & Partial<GhostToolDecl> }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('settings.ghosts.detail.openTool', { name: tool.name })}
          className={cn(
            DETAIL_SURFACE_CLASS,
            DETAIL_SURFACE_INTERACTIVE_CLASS,
            'inline-flex h-8 max-w-full items-center rounded-full px-3 text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          <code className="truncate font-mono text-13 leading-[1.385]">{tool.name}</code>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className={cn(
          DETAIL_SURFACE_CLASS,
          'w-[320px] rounded-xl p-4 text-[var(--text-primary)] shadow-[shadow:var(--shadow-menu)] data-[state=open]:animate-none data-[state=closed]:animate-none',
        )}
      >
        <p className="text-13 leading-5 text-[var(--text-secondary)]">
          {tool.description || t('settings.ghosts.detail.noToolDescription')}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function PermissionSummary({ items }: { items: readonly GhostPermissionItem[] }) {
  return <PluginPermissionSummary items={usePluginPermissionFacts(items.filter(item => item.kind !== 'tool'))} />;
}

export function PluginPermissionSummary({ items }: { items: readonly PluginPermissionFact[] }) {
  const { t } = useTranslation();
  return (
    <PluginDetailPermissionRow summary={<PluginPermissionCount items={items} />}>
      {limit => items.length ? <PluginPermissionList items={items} limit={limit} choiceKey="permissionList" /> : (
        <p className="text-13 text-[var(--text-tertiary)]">{t('settings.ghosts.market.noPermissions')}</p>
      )}
    </PluginDetailPermissionRow>
  );
}

export function PluginPermissionCount({ items }: { items: readonly PluginPermissionFact[] }) {
  const { t } = useTranslation();
  const count = t('settings.ghosts.perm.itemCount', { count: items.length });
  return items.some(item => item.highRisk) ? `${t('settings.ghosts.detail.includesHighRisk')} · ${count}` : count;
}

export function pluginPackageSizeFacts(t: TFunction, item: PluginMarketItem | null | undefined, installedVersion?: string) {
  if (item?.sourceType !== 'server' || item.sizeBytes === undefined) return [];
  const size = formatBytes(item.sizeBytes);
  const listedVersion = item.version.replace(/^v/, '');
  return [{
    key: 'packageSize',
    label: t('settings.ghosts.detail.infoPackageSize'),
    value: installedVersion !== undefined && installedVersion.replace(/^v/, '') !== listedVersion
      ? t('settings.ghosts.detail.infoPackageSizeWithVersion', { size, version: `v${listedVersion}` })
      : size,
  }];
}

export function DetailsSection({
  detail,
  marketItem,
  panelStatus,
  installationLabel,
  publisherDescription,
}: {
  detail: GhostPluginDetail;
  marketItem?: PluginMarketItem | null;
  panelStatus: string | null;
  installationLabel?: string;
  publisherDescription?: ReactNode;
}) {
  const { t } = useTranslation();
  const installationSource = parsePluginInstallationSource(detail.installationSource);
  const sourceLabel = t(`mcpApps.source.${installationSource.kind}`, { namespace: installationSource.namespace });
  const sourceValue = installationLabel && installationSource.kind !== 'unknown' &&
    installationSource.kind !== 'market' && installationLabel !== sourceLabel
    ? `${installationLabel} · ${sourceLabel}` : installationLabel ?? sourceLabel;
  const trustLabelKey = ghostTrustLabelKey(detail.trust);
  const globalTabs = useGlobalTabs();
  useTabGroupAssignments();
  const installedGhost = useInstalledGhosts().find(
    (ghost) => installedGhostStoragePart(ghost) === detail.id,
  );
  const inSidebar = globalTabs.some(
    (tab) => (tab.state as { instanceId?: string } | null)?.instanceId === detail.id,
  );
  // 用户拖过 / 弹过 / 已套过默认边:给「恢复默认位置」。
  const canResetPlacement = hasPluginPlacementMemory(detail.id);
  const placementActionClass =
    'shrink-0 rounded-md px-2 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
  const facts: Array<{
    key: string;
    label: string;
    value: string;
    monospace?: boolean;
    action?: ReactNode;
    fullWidth?: boolean;
  }> = [
    {
      key: 'version',
      label: t('settings.ghosts.detail.infoVersion'),
      value: `v${detail.version}`,
    },
    ...pluginPackageSizeFacts(t, marketItem, detail.version),
    ...(detail.author
      ? [
          {
            key: 'author',
            label: t('settings.ghosts.detail.infoAuthor'),
            value: detail.author,
          },
        ]
      : []),
    {
      key: 'source',
      label: t('mcpApps.sourceLabel'),
      value: sourceValue,
    },
    {
      key: 'trust',
      label: t('mcpApps.signatureLabel'),
      value: t(`settings.ghosts.trust.${trustLabelKey}`, {
        publisher: detail.trust.publisherName ?? t('settings.ghosts.trust.unknownPublisher'),
      }),
    },
    {
      key: 'identifier',
      label: t('settings.ghosts.detail.infoId'),
      value: detail.ghostId,
      monospace: true,
    },
    ...(detail.contents.length > 0
      ? [
          {
            key: 'contents',
            label: t('settings.ghosts.detail.infoContents'),
            value: detail.contents
              .map((content) => t(`settings.ghosts.contents.${content}`))
              .join(' · '),
          },
        ]
      : []),
    {
      key: 'panel',
      label: t('settings.ghosts.detail.infoPanel'),
      value:
        detail.panelMinWidth === null
          ? t('settings.ghosts.detail.panelNone')
          : panelStatus || t('settings.ghosts.detail.panelDismissed'),
      // 停靠形态面板关掉页签后,这里是除右侧栏「+」菜单外的另一个重开入口
      // (这类插件没有左侧栏入口)。已在侧栏、停用、tab 形态或无面板时不渲染。
      // 「恢复默认位置」:清掉用户的放置记忆(拖到的边 / 弹过窗口),回到插件声明的默认边。
      ...(detail.panelMinWidth !== null && !detail.tabPanel
        ? {
            action: (
              <span className="flex shrink-0 items-center gap-1">
                {detail.enabled && !inSidebar && (
                  <button
                    type="button"
                    onClick={() => {
                      if (installedGhost) void openPluginInSidebar(installedGhost, 'panel');
                    }}
                    className={placementActionClass}
                  >
                    {t('settings.ghosts.detail.openInSidebar')}
                  </button>
                )}
                {canResetPlacement && (
                  <button
                    type="button"
                    onClick={() => {
                      if (installedGhost) void resetPluginPlacementAndReturn(installedGhost);
                    }}
                    className={placementActionClass}
                  >
                    {t('settings.ghosts.detail.resetPlacement')}
                  </button>
                )}
              </span>
            ),
          }
        : {}),
    },
    ...(detail.installDir
      ? [
          {
            key: 'location',
            label: t('settings.ghosts.detail.infoLocation'),
            value: detail.installDir,
            fullWidth: true,
            action: (
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(detail.installDir ?? '').then(
                      () => toast.success(t('settings.ghosts.detail.locationCopied')),
                      () => toast.error(t('settings.ghosts.detail.locationCopyFailed')),
                    );
                  }}
                  title={t('settings.ghosts.detail.copyLocation')}
                  aria-label={t('settings.ghosts.detail.copyLocation')}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const installDir = detail.installDir;
                    if (!installDir) return;
                    void window.electronAPI.openPath(installDir).then(
                      (result) => {
                        if (shouldShowOpenPathError(result))
                          toast.error(t('settings.ghosts.errors.generic'));
                      },
                      () => toast.error(t('settings.ghosts.errors.generic')),
                    );
                  }}
                  title={t('settings.ghosts.detail.openLocation')}
                  aria-label={t('settings.ghosts.detail.openLocation')}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <FolderOpen size={14} aria-hidden="true" />
                </button>
              </div>
            ),
          },
        ]
      : []),
  ];
  return <PluginDetailFactsSection facts={facts}>
    {publisherDescription}
    <ToolsSection tools={detail.tools} />
  </PluginDetailFactsSection>;
}

export function PluginDetailFactsSection({
  facts,
  children,
}: {
  facts: readonly {
    key: string;
    label: string;
    value: string;
    monospace?: boolean;
    action?: ReactNode;
    fullWidth?: boolean;
  }[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = usePluginDetailChoice('facts');
  const relaxed = usePluginDetailRelaxed('facts');
  return (
    <PluginDetailRecordRow icon={Info} title={t('settings.ghosts.detail.infoTitle')} open={choice ?? relaxed} onOpenChange={setChoice}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.key} className={cn('min-w-0', fact.fullWidth && 'col-span-full')}>
            <p className="truncate text-13 leading-5 text-[var(--text-secondary)]">{fact.label}</p>
            <ExpandableDetailValue
              label={fact.label}
              value={fact.value}
              monospace={fact.monospace}
              action={fact.action}
            />
          </div>
        ))}
      </div>
      {children}
    </PluginDetailRecordRow>
  );
}

/** One-line fact value that reveals its complete text in place only when it overflows. */
function ExpandableDetailValue({
  label,
  value,
  monospace,
  action,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const valueRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    if (expanded) return;
    const valueElement = valueRef.current;
    if (!valueElement) return;
    const measure = () => {
      setOverflows(valueElement.scrollWidth > valueElement.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(valueElement);
    return () => observer.disconnect();
  }, [expanded, value]);

  const toggleLabel = t(
    expanded
      ? 'settings.ghosts.detail.collapseInfoValue'
      : 'settings.ghosts.detail.expandInfoValue',
    { label },
  );

  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1">
      <div
        ref={valueRef}
        className={cn(
          'min-w-0 flex-1 text-14 leading-[1.571] text-[var(--text-primary)]',
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-nowrap',
          monospace && 'font-mono text-13',
        )}
        title={!expanded ? value : undefined}
      >
        {value}
      </div>
      {action}
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ChevronDown
            size={15}
            strokeWidth={1.7}
            className={cn('transition-transform duration-150', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
}
