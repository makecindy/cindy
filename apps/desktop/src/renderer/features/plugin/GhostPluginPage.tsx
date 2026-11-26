import { useUninstallPlugin } from './lib/useUninstallPlugin';
import { CatalogDeviceScope, type CatalogDeviceControl } from './useCatalogDevice';
import { RemotePluginCatalogSource } from './RemotePluginCatalogSource';
import { PluginCatalogView } from './PluginCatalogView';
import { LocalPluginShareView } from './LocalPluginShareView';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import { rememberContributionIntent, consumeContributionIntent, matchesContributionIntent } from './lib/contributionIntent';
import { MyPluginsPage, contributionErrorKey, type MyPluginsPageCache, type PluginSubmitOptions } from './MyPluginsPage';
import { localPublishingUnavailableKey } from './lib/ghostPluginDetailModel';
import { PluginPublishDialog, type PluginPublishDialogRequest } from './PluginPublishDialog';
import { featureRetirementById, type FeatureRetirement } from '../../../shared/featureRetirements';
import { RetiredFeatureDetail } from './RetiredFeatureDetail';
import { Button } from '@/components/ui/button';
import { PLUGIN_PAGE_SIZE, type PluginMarketRowMetric } from './PluginCatalogBrowser';
import { usePluginCatalogMemory, pluginCatalogOwnerKey, pluginInstalledGrid, readLocalPluginSnapshot, readPluginRecommendations, usePluginCatalogState } from './lib/pluginCatalogMemory';
import { selectPluginRecommendationBatch, type PluginRecommendationDeck } from './lib/PluginRecommendationSlots';
import { marketDetailAccessRejected, marketDetailCacheFor, retainMarketDetailIcon, marketItemSummary } from './lib/marketDetailCache';
/**
 * Plugin catalog and detail coordinator backed by the latest Ghost host APIs.
 *
 * Inputs: installed Ghost snapshots and user actions. `embedded` mounts the same
 * catalog inside Settings; `onSelectCatalogTab` keeps Plugins / Skills in-panel.
 * Outputs: the Plugin list/detail UI, recommendation-aware return navigation, and Plugin action flows.
 * Publishing preparation starts in the shared dialog; submission stays in-place until confirmed.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowDownToLine,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useAuth } from '@/contexts/AuthContext';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { usePluginReviewUpdates } from '@/contexts/PluginReviewUpdatesContext';
import { readInstalledGhostsSnapshot, useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import {
  cancelPendingPluginSuggestion,
  getPendingPluginSuggestion,
  pendingPluginSuggestionReturnPath,
  pendingSuggestionIsForGhost,
  readyPendingPluginSuggestion,
  subscribePendingPluginSuggestion,
} from '@/features/cc-agent/pendingPluginSuggestion';
import { readPluginRecommendationSnapshot } from '@/features/cc-agent/pluginHomeSuggestions';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { CINDY_PLUGIN_CREATOR_NAME } from '../../../shared/cindyBuiltInSkills';
import { dbToMakerAgentKind, normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import { isSlashCommandUnavailable, loadAllCommands } from '@/lib/slashCommands';
import {
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
} from '@/lib/composerDraftStore';
import { getDraft as getWorkspaceDraft, resetDraftWorkspaceTargets } from '@/state/newMakerDraft';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { pickAndUpdateGhost } from '@/cindy-brain/installFlow';
import { importCindyFile } from '@/cindy-brain/importCindyFile';
import { Tip } from '@/components/ui/tooltip';
import { cn, basename } from '@/lib/utils';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import {
  useGhostUnread,
  useGhostUnreadEntries,
  useGhostUnreadSummary,
} from '@/cindy-brain/ghostUnreadStore';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { useGlobalTabs } from '@/features/right-sidebar/globalTabs';
import { resolveSystemLocale } from '../../../shared/locale';
import {
  ghostInstallApprovalToken,
  type GhostSetupStatus,
  type InstalledGhost,
} from '../../../shared/ghost';
import {
  createPluginLogicalIdentity,
  findInstalledGhostByIdentity,
  findInstalledGhostByInstanceId,
  installedGhostStoragePart,
} from '../../../shared/pluginIdentity';
import type {
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketItem,
} from '../../../shared/pluginMarket';
import type { LegacyGhostRecoveryStatus } from '../../../shared/legacyGhostRecovery';
import {
  toGhostPluginDetail,
  toGhostPluginListItem,
  filterGhostPluginItems,
  ghostWebviewOwnerKey,
  ghostPrimaryAction,
  ghostPluginIconSource,
  marketPresentationForInstalledGhost,
  installedVisibleCount,
  nextOpenPanelIdForOwner,
  sortInstalledForDisplay,
  type GhostPluginListItem,
} from './lib/ghostPluginViewModel';
import { MyPublishesSection } from './MyPublishesSection';
import {
  githubUpdateKey,
  ignoredRoundStorageKey,
  isBatchFinished,
  updateRoundKey,
  type NamedGithubReleaseUpdate,
} from './lib/updateAllModel';
import {
  getUpdateAllBatchState,
  githubRowOutcome,
  reconcileUpdateAllBatch,
  setUpdateAllBatchHooks,
  startUpdateAllBatch,
  subscribeUpdateAllBatch,
} from './lib/updateAllController';
import {
  githubReleaseTarget,
  runGithubReleaseUpdate,
  useGithubReleaseUpdates,
  type GithubReleaseUpdate,
} from './lib/githubReleaseUpdates';
import { formatSetupGateDescription } from './lib/ghostSetupGateModel';
import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PLUGIN_INSTALLED_CARD_GRID_CLASS,
  CatalogManagementNotice,
} from './PluginManagementLayout';
import { usePluginListScrollRestoration } from './lib/usePluginListScrollRestoration';
import { GhostPagePanelHost } from './GhostPagePanelHost';
import { GhostPluginActions } from './GhostPluginActions';
import { formatPluginMarketMetric, PluginSharedUsage } from './PluginSharedUsage';
import { PluginPublisherBadge } from './PluginPublisherBadge';
import {
  currentMainViewVisibilityOwner,
  readMainViewSidebarVisible,
  useMainViewVisibilityRevision,
  writeMainViewSidebarVisible,
} from '@/cindy-brain/mainViewVisibilityStore';
import { UpdateAllDialog } from './UpdateAllDialog';
import { PluginInstallRing } from './PluginInstallRing';
import {
  beginPluginInstallProgress,
  clearFailedPluginInstallProgress,
  dropStalePluginInstallProgress,
  endPluginInstallProgress,
  failPluginInstallProgress,
  succeedPluginInstallProgress,
  usePluginInstallProgress,
} from './lib/pluginInstallProgress';
import { GhostPluginIcon } from './GhostPluginIcon';
import { relatedPluginCatalogCache, removeUnavailableRelatedPlugin, type PluginRelatedCatalog } from './PluginMoreDetails';
import { PluginProjectMenu, usePluginRecentWorkdirs } from './PluginScopePicker';
import {
  canOfferMarketInstall,
  ghostReapprovalRoute,
  marketItemForInstalledGhost,
  marketItemMatchesInstalledGhost,
  publicPublisherFilter,
  marketReviewTargetsInstalledGhost,
  pluginPresentationAuthor,
  pluginPresentationOrigin,
  pluginUpdateForInstalledVersion,
  type PluginPresentationOrigin,
} from './lib/pluginMarketPresentation';
import { AddMarketplaceDialog } from './AddMarketplaceDialog';
import { InstallGithubReleaseDialog } from './InstallGithubReleaseDialog';
import {
  pluginMarketErrorKey,
  pluginMarketOrganizationAccessErrorKey,
} from './lib/pluginMarketErrorKey';
import { ICON_REFRESH_LEAD_MS, usePluginIconRefresh } from './lib/usePluginIconRefresh';
import { forgetFailedMarketIcon } from './lib/pluginBrowserCache';
import { usePluginMarketIcon } from './lib/usePluginMarketIcon';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';
import { usePluginMarketLocaleRefresh } from './lib/usePluginMarketLocaleRefresh';
import './plugin-motion.css';

const PLUGIN_CATALOG_TOOLBAR_CLASS =
  'plugin-catalog-toolbar mb-5 flex items-center justify-between gap-4';
type PluginPresentationFilter = 'all' | PluginPresentationOrigin;

function subscribeCatalogOnline(notify: () => void) {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

type PresentedGhostPluginItem = GhostPluginListItem & {
  marketItem: PluginMarketItem | null;
  author: string | null;
  /** 市场存在更新时的市场记录;列表卡片据此显示更新徽标与直达入口。 */
  marketUpdate: PluginMarketItem | null;
  /** 本地插件从 GitHub Release 检查到的新版本;与 marketUpdate 互斥,市场优先。 */
  githubUpdate: GithubReleaseUpdate | null;
};

function findInstalledRetirementReplacement(
  ghosts: readonly InstalledGhost[],
  marketItems: readonly PluginMarketItem[],
  target: FeatureRetirement['replacement'],
): InstalledGhost | undefined {
  if (!target) return undefined;
  const marketItem = marketItems.find((item) => item.pluginId === target.marketId);
  // IDs may change before all installations update. Reuse either ID in the
  // market row's namespace; without a row the existing root-only fallback stays.
  for (const ghostId of [target.ghostId, ...(target.previousGhostIds ?? [])]) {
    const installed = marketItem
      ? ghosts.find((ghost) => marketItemMatchesInstalledGhost({ ...marketItem, ghostId }, ghost))
      : findInstalledGhostByIdentity(ghosts, createPluginLogicalIdentity(null, ghostId));
    if (installed) return installed;
  }
  return undefined;
}

/** 推荐区来源过滤:本地装的必然在已安装区,不设「本地」档(设计定稿)。 */
const RECOMMENDED_FILTERS: readonly PluginPresentationFilter[] = [
  'all',
  'public',
  'organization',
  'custom',
];

/** 已安装首批展示 10 个，继续滚动时按相同批次追加。 */
const MAX_VISIBLE_INSTALLED_PLUGINS = PLUGIN_PAGE_SIZE;
/** 折叠入口只预览前三个隐藏插件，避免头像堆叠反过来抢占操作文案。 */
const MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS = 3;

/**
 * 本期隐藏「我的发布」二级 tab，避免与「已安装」争抢顶层布局。
 * 重新开放前必须先定首个 tab 的标签；当前「概览」仅为已被用户否掉的占位词，并非定案。
 */
export const SHOW_MY_PUBLISHES_SECTION = false;

/**
 * Product gate for the whole secondary tab experience. The overview stays mounted while tabs
 * switch, and a disabled gate returns it without an extra wrapper or hidden publishing effects.
 */
export function MyPublishesSectionVisibilityGate({
  visible,
  overviewLabel,
  publishesLabel,
  tabsAriaLabel,
  publishes,
  children,
}: {
  visible: boolean;
  overviewLabel: string;
  publishesLabel: string;
  tabsAriaLabel: string;
  publishes: ReactNode;
  children: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<'overview' | 'publishes'>('overview');
  const id = useId();
  const overviewTabId = `${id}-overview-tab`;
  const overviewPanelId = `${id}-overview-panel`;
  const publishesTabId = `${id}-publishes-tab`;
  const publishesPanelId = `${id}-publishes-panel`;

  if (!visible) return <>{children}</>;

  return (
    <>
      <div
        role="tablist"
        aria-label={tabsAriaLabel}
        className="mt-5 flex items-end gap-6 border-b border-[var(--border-default)]"
      >
        {([
          ['overview', overviewLabel, overviewTabId, overviewPanelId],
          ['publishes', publishesLabel, publishesTabId, publishesPanelId],
        ] as const).map(([tab, label, tabId, panelId]) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              onClick={() => setActiveTab(tab)}
              className={cn(
                '-mb-px select-none border-b-2 px-0.5 pb-2.5 pt-1 text-13 font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                active
                  ? 'border-[var(--text-primary)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        id={overviewPanelId}
        role="tabpanel"
        aria-labelledby={overviewTabId}
        hidden={activeTab !== 'overview'}
      >
        {children}
      </div>
      <div
        id={publishesPanelId}
        role="tabpanel"
        aria-labelledby={publishesTabId}
        hidden={activeTab !== 'publishes'}
      >
        {publishes}
      </div>
    </>
  );
}

/** Keeps the installed-section disclosure rule deterministic and directly testable. */
function visibleInstalledPluginItems<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_VISIBLE_INSTALLED_PLUGINS);
}

function collapsedInstalledPluginPreviewItems<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS);
}

type InstalledPluginPreviewItem = Pick<PresentedGhostPluginItem, 'id' | 'name' | 'iconDataUrl'>;

function InstalledPluginOverflow({
  id,
  expanded,
  children,
}: {
  id: string;
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="plugin-installed-overflow"
      data-expanded={expanded}
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div className="plugin-installed-overflow-clip">{children}</div>
    </div>
  );
}

function InstalledPluginDisclosure({
  expanded,
  controlsId,
  totalCount,
  previewItems,
  onToggle,
  onIconLoadError,
}: {
  expanded: boolean;
  controlsId: string;
  totalCount: number;
  previewItems: readonly InstalledPluginPreviewItem[];
  onToggle: () => void;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  const collapsedPreviewItems = collapsedInstalledPluginPreviewItems(previewItems);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controlsId}
      className="mt-3 inline-flex items-center gap-2.5 rounded-full px-3 py-1.5 text-12 text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      {!expanded ? (
        <span className="plugin-installed-preview-stack" aria-hidden="true">
          {collapsedPreviewItems.map((item, index) => (
            <span
              key={item.id}
              className="plugin-installed-preview-card"
              style={{ zIndex: index + 1 }}
            >
              <GhostPluginIcon
                iconDataUrl={item.iconDataUrl}
                iconId={item.id}
                iconName={item.name}
                onIconLoadError={onIconLoadError}
                size="mini"
              />
            </span>
          ))}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        {t(
          expanded
            ? 'settings.ghosts.page.installedCollapse'
            : 'settings.ghosts.page.installedExpand',
          expanded ? undefined : { count: totalCount },
        )}
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={cn(
            'transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
        />
      </span>
    </button>
  );
}

/** Test-only access to the installed-section layout contract. */
export const __installedPluginLayoutForTests = {
  MAX_VISIBLE_INSTALLED_PLUGINS,
  MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS,
  visibleInstalledPluginItems,
  InstalledPluginOverflow,
  InstalledPluginDisclosure,
};

/** 市场首装成功后打开已装详情；更新或来源替换继续停留在当前页面。 */
export function shouldOpenInstalledDetailAfterMarketSuccess(isUpdate: boolean): boolean {
  return !isUpdate;
}

function marketDetailFields(item?: PluginMarketItem) {
  return { includeUpdates: !item || item.sourceType === 'server', includeReadme: true };
}

function installedGhostMarketKeyFor(ghosts: readonly InstalledGhost[]): string {
  return ghosts
    .map((ghost) => `${ghost.manifest.id}\0${ghost.manifest.version}`)
    .sort()
    .join('\0');
}

/** 读「忽略本轮更新」的持久值(键按数据归属分桶,见 ignoredRoundStorageKey)。 */
function readIgnoredRound(storageKey: string): string {
  try {
    return window.localStorage.getItem(storageKey) ?? '';
  } catch {
    return '';
  }
}

/**
 * Ghost-backed Plugin page.
 *
 * This is the first bridge from the existing Plugin product surface to the
 * real Ghost runtime. The page deliberately keeps the previous list/detail
 * interaction shape, while every displayed field comes from InstalledGhost.
 */
export function GhostPluginPage(props: { embedded?: boolean; active?: boolean; onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const snapshotId = searchParams.get('share');
  const closeShare = (ghost?: InstalledGhost) => {
    const next = new URLSearchParams(searchParams); next.delete('share');
    if (ghost) next.set('ghost', installedGhostStoragePart(ghost));
    setSearchParams(next, { replace: true });
  };
  return <CatalogDeviceScope>{(device, online, generation, deviceControl) => snapshotId !== null
    ? <LocalPluginShareView key={`${generation}:${snapshotId}:${device?.deviceId ?? 'local'}`} snapshotId={snapshotId}
        deviceControl={deviceControl} onBack={() => closeShare()} onInstalled={closeShare} />
    : device
    ? <RemotePluginCatalogSource key={`${generation}:${device.deviceId}`} device={device} online={online} deviceControl={deviceControl} {...props} />
    : <LocalPluginCatalogSource deviceControl={deviceControl} {...props} />}</CatalogDeviceScope>;
}

function LocalPluginCatalogSource({
  embedded = false,
  active = true,
  deviceControl,
  onSelectCatalogTab,
}: {
  embedded?: boolean;
  active?: boolean;
  deviceControl?: CatalogDeviceControl;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
} = {}) {
  const { i18n, t } = useTranslation();
  const marketLocale = resolveSystemLocale(i18n.resolvedLanguage ?? i18n.language);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm } = useConfirmDialog();

  const showPluginMarketActionError = useCallback(
    async (error: unknown) => {
      // 用户在安装确认框里取消不是失败，不弹错误提示。
      if (extractIpcError(error)?.code === 'MUTATION_CANCELLED') return;
      toast.error(t(pluginMarketErrorKey(error)));
    },
    [t],
  );
  const { user, mode, dataOwnerId, dataOwnerGeneration } = useAuth();
  const reviewUnread = usePluginReviewUpdates().updates.filter(item => item.unread);
  const signInForContribution = useSignInToCindy('/plugins?myPlugins=1');
  const contributionOwner = JSON.stringify([dataOwnerId, dataOwnerGeneration, user?.id, mode]);
  const contributionOwnerRef = useRef(contributionOwner);
  contributionOwnerRef.current = contributionOwner;
  const contributionMounted = useRef(true);
  useEffect(() => {
    contributionMounted.current = true;
    return () => { contributionMounted.current = false; };
  }, []);
  const contributionCache = useRef<MyPluginsPageCache>({});
  const [contributionBusy, setContributionBusy] = useState(false);
  const [submissionRevision, setSubmissionRevision] = useState(0);
  const contributing = useRef<string | null>(null);
  const [publicationDialog, setPublicationDialog] = useState<PluginPublishDialogRequest | null>(null);
  const publicationDialogSequence = useRef(0);
  const [recommendationNonce] = useState(() => searchParams.get('recommendation'));
  const pendingRecommendation = useSyncExternalStore(
    subscribePendingPluginSuggestion,
    getPendingPluginSuggestion,
  );
  const recommendation =
    pendingRecommendation?.nonce === recommendationNonce &&
    pendingRecommendation.ownerId === dataOwnerId
      ? pendingRecommendation
      : null;
  const recommendationPageMounted = useRef(false);
  useEffect(() => {
    recommendationPageMounted.current = true;
    if (getPendingPluginSuggestion()?.ownerId !== dataOwnerId) cancelPendingPluginSuggestion();
    return () => {
      recommendationPageMounted.current = false;
      queueMicrotask(() => {
        if (!recommendationPageMounted.current && getPendingPluginSuggestion()?.phase === 'setup') {
          cancelPendingPluginSuggestion(recommendationNonce ?? undefined);
        }
      });
    };
  }, [dataOwnerId, recommendationNonce]);
  const continueRecommendation = useCallback(
    async (nonce: string | undefined, ghostId: string) => {
      if (!recommendationPageMounted.current || !nonce) return false;
      const snapshot = readPluginRecommendationSnapshot();
      if (
        snapshot.ownerId !== dataOwnerId ||
        !snapshot.sources.some((s) => s.ghostId === ghostId && s.enabled)
      )
        return false;
      const early = getPendingPluginSuggestion();
      // Another plugin being installed or enabled while this request is open must not touch its project state.
      if (!early || early.nonce !== nonce || !pendingSuggestionIsForGhost(early, ghostId)) return false;
      // A plugin Skill is only usable in the task's project if the plugin is not disabled there: a
      // project-level "off" outlives an uninstall, so a fresh install would still not offer the Skill.
      // Do this before the request leaves the setup phase, so a failure here leaves it resumable.
      if (early.skillName && early.workingDir) {
        try {
          const dir = early.workingDir;
          if (window.electronAPI.ghosts.workdirPrefsSync(dir).disabled.includes(ghostId)) {
            await window.electronAPI.ghosts.setWorkdirDisabled(dir, ghostId, false);
          }
        } catch {
          return false;
        }
        if (!recommendationPageMounted.current || getPendingPluginSuggestion()?.nonce !== nonce) return false;
      }
      const ready = readyPendingPluginSuggestion(nonce, dataOwnerId, ghostId);
      const pending = getPendingPluginSuggestion();
      if (!ready || !pending) return false;
      // Back to where the user asked: the new-task draft or the task they were in.
      navigate(pendingPluginSuggestionReturnPath(pending), {
        state: { pluginSuggestionNonce: ready },
        flushSync: true,
      });
      return true;
    },
    [dataOwnerId, navigate],
  );
  const recommendationNotice = recommendation ? (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3 text-13 text-[var(--text-secondary)]"
    >
      <span>
        {t('newChat.pluginSuggestions.pending', { task: recommendation.suggestion.label })}
      </span>
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        compact
        type="button"
        onClick={() => cancelPendingPluginSuggestion(recommendation.nonce)}
      >
        {t('newChat.pluginSuggestions.cancel')}
      </Button>
    </div>
  ) : null;
  const showEnterprise = user?.membershipKind === 'org';
  const contributor = mode === 'cloud' && (user?.membershipKind === 'personal' || user?.membershipKind === 'org');
  const ghosts = useInstalledGhosts();
  useMainViewVisibilityRevision();
  const installedGhostMarketKey = useMemo(
    () => installedGhostMarketKeyFor(ghosts),
    [ghosts],
  );
  const installedGhostLocationsKey = ghosts
    .map((ghost) => `${ghost.manifest.id}\0${ghost.dir}`)
    .sort()
    .join('\0');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const catalogOwnerKey = pluginCatalogOwnerKey(mode, dataOwnerId, dataOwnerGeneration, marketLocale);
  const catalogMemory = usePluginCatalogMemory(catalogOwnerKey, 'local');
  const catalogMemoryRef = useRef(catalogMemory);
  catalogMemoryRef.current = catalogMemory;
  const [query, setQuery] = usePluginCatalogState(catalogMemory, 'query');
  const [catalogTab, setCatalogTab] = usePluginCatalogState(catalogMemory, 'catalogTab');
  const [installedLimit, setInstalledLimit] = usePluginCatalogState(catalogMemory, 'installedLimit');
  const [marketTotal, setMarketTotal] = usePluginCatalogState(catalogMemory, 'marketTotal');
  const [catalogRevision, setCatalogRevision] = usePluginCatalogState(catalogMemory, 'catalogRevision');
  const [todayPool, setTodayPool] = usePluginCatalogState(catalogMemory, 'todayPool');
  const [recommendationBatch, setRecommendationBatch] = usePluginCatalogState(catalogMemory, 'recommendationBatch');
  const [consumedToday, setConsumedToday] = usePluginCatalogState(catalogMemory, 'consumedToday');
  const [todayLoaded, setTodayLoaded] = usePluginCatalogState(catalogMemory, 'todayLoaded');
  const browserCache = catalogMemory.browser;
  const secondaryTabs = useRef<HTMLDivElement>(null);
  const installedSentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        await window.electronAPI.setApplicationMenuLocale(marketLocale);
        const items = await readPluginRecommendations(catalogMemory);
        if (current) { setTodayPool(items); setTodayLoaded(true); }
      } catch { if (current) { setTodayPool([]); setTodayLoaded(true); } }
    })();
    return () => { current = false; };
  }, [catalogMemory]);
  const [marketSnapshot, setMarketSnapshot] = usePluginCatalogState(catalogMemory, 'snapshot');
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  // 数据归属键:面板宿主按它失效(定义要早于消费点)。
  const panelOwnerKey = ghostWebviewOwnerKey(mode, dataOwnerId);
  const relatedCache = relatedPluginCatalogCache(JSON.stringify([panelOwnerKey, dataOwnerGeneration]));
  const installedGridCache = pluginInstalledGrid(catalogMemory, query);
  const ignoredRoundKey = ignoredRoundStorageKey(mode, dataOwnerId);
  const [ignoredRound, setIgnoredRound] = useState(() => readIgnoredRound(ignoredRoundKey));
  // 账号 / 本地云模式切换:换桶重读,不把上一个身份的「忽略本轮」带进来。
  useEffect(() => {
    setIgnoredRound(readIgnoredRound(ignoredRoundKey));
  }, [ignoredRoundKey]);
  const [originFilter, setOriginFilter] = usePluginCatalogState(catalogMemory, 'originFilter');
  const [marketDetail, setMarketDetail] = useState<PluginMarketItem | PluginMarketDetail | null>(null);
  const [marketDetailError, setMarketDetailError] = useState<string | null>(null);
  const [marketDetailRefreshing, setMarketDetailRefreshing] = useState(false);
  const relatedMarketTrail = useRef<{ owner: string; items: Array<PluginMarketItem | { installedId: string }> }>({ owner: catalogOwnerKey, items: [] });
  if (relatedMarketTrail.current.owner !== catalogOwnerKey) relatedMarketTrail.current = { owner: catalogOwnerKey, items: [] };
  useEffect(() => {
    if (!marketDetail && !selectedId) relatedMarketTrail.current.items.length = 0;
  }, [marketDetail, selectedId]);
  const detailCache = marketDetailCacheFor(catalogOwnerKey);
  const activeDetailCacheRef = useRef(detailCache);
  const foregroundDetailRefresh = useRef<(() => Promise<void>) | null>(null);
  activeDetailCacheRef.current = detailCache;
  const lastDetailScrollRef = useRef(0);
  useEffect(() => {
    const onScroll = () => { lastDetailScrollRef.current = Date.now(); };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);
  const prefetchMarketDetail = useCallback((item: PluginMarketItem, isCurrent: () => boolean) => {
    const scrollStamp = lastDetailScrollRef.current;
    if (Date.now() - scrollStamp < 250) return;
    const fields = marketDetailFields(item);
    detailCache.prefetch(item.pluginId,
      async () => retainMarketDetailIcon(await window.electronAPI.pluginMarket.detail(item.pluginId, fields), item),
      () => isCurrent() && lastDetailScrollRef.current === scrollStamp && activeDetailCacheRef.current === detailCache, fields);
  }, [detailCache]);
  const contributionViewKey = JSON.stringify([location.key, selectedId, marketDetail?.pluginId]);
  const contributionView = useRef({ key: contributionViewKey, token: {} });
  if (contributionView.current.key !== contributionViewKey)
    contributionView.current = { key: contributionViewKey, token: {} };
  // 列表与详情是互斥分支;列表节点会卸载,返回时需显式恢复进入前的滚动位置。
  const pluginCatalogVisible = marketDetail === null && selectedId === null && !searchParams.has('myPlugins') && !searchParams.has('share');
  const {
    listRef: pluginCatalogListRef,
    onListScroll: onPluginCatalogScroll,
    capture: capturePluginCatalogScroll,
    requestRestore: requestPluginCatalogScrollRestore,
    clearPendingRestore: clearPluginCatalogScrollRestore,
  } = usePluginListScrollRestoration(pluginCatalogVisible, catalogMemory.scroll);
  const githubUpdates = useGithubReleaseUpdates(
    ghosts, active && pluginCatalogVisible, dataOwnerId, dataOwnerGeneration,
  );
  const [marketBusy, setMarketBusy] = useState<{ pluginId: string; intent: 'detail' | 'install' } | null>(null);
  const marketBusyId = marketBusy?.pluginId ?? null;
  const marketInstallBusyId = marketBusy?.intent === 'install' ? marketBusy.pluginId : null;
  // 市场操作的同步互斥锁。React state 在提交前有窗口期,快速连点会让多个回调
  // 都读到 null;ref 先到先得,state 只驱动按钮禁用等 UI 展示。每次占锁都返回
  // 唯一 lease,避免账号/模式切换后的旧异步流程误释放新流程持有的同 pluginId 锁。
  const marketBusyLockRef = useRef<{ pluginId: string } | null>(null);
  const acquireMarketBusy = useCallback((pluginId: string, intent: 'detail' | 'install' = 'install') => {
    if (marketBusyLockRef.current !== null) return null;
    const lease = { pluginId, intent };
    marketBusyLockRef.current = lease;
    setMarketBusy(lease);
    return lease;
  }, []);
  const releaseMarketBusy = useCallback((lease: { pluginId: string }) => {
    if (marketBusyLockRef.current !== lease) return;
    marketBusyLockRef.current = null;
    setMarketBusy((current) => (current === lease ? null : current));
  }, []);
  const isMarketBusyLeaseActive = useCallback(
    (lease: { pluginId: string }) => marketBusyLockRef.current === lease,
    [],
  );
  const marketRefreshRequestRef = useRef(0);
  const lastMarketRefreshAtRef = useRef(0);
  const marketDetailRequestRef = useRef(0);
  const installedGhostMarketKeyRef = useRef(installedGhostMarketKey);
  const legacyRecoveryStatusRequestRef = useRef(0);
  const legacyRecoveryRetryRequestRef = useRef(0);
  const [legacyRecoveryStatus, setLegacyRecoveryStatus] =
    useState<LegacyGhostRecoveryStatus | null>(null);
  const [legacyRecoveryRetrying, setLegacyRecoveryRetrying] = useState(false);
  const refreshMarket = useCallback(async (preserveOnError = false, background = false, renewIcons = false) => {
    installedGhostMarketKeyRef.current = installedGhostMarketKeyFor(readInstalledGhostsSnapshot());
    const requestId = ++marketRefreshRequestRef.current;
    const owner = contributionOwnerRef.current;
    const memory = catalogMemoryRef.current;
    const current = () => requestId === marketRefreshRequestRef.current && contributionOwnerRef.current === owner && catalogMemoryRef.current === memory;
    try {
      const snapshot = await readLocalPluginSnapshot(memory, !background, renewIcons);
      if (!current()) return;
      setMarketSnapshot(snapshot);
      lastMarketRefreshAtRef.current = Date.now();
      // The icon renewal caller already refreshes catalog pages with fresh URLs.
      if (!renewIcons && current()) await memory.browser.current.refresh?.();
      // Publish successful sources before reporting an official outage to the
      // existing icon-renewal retry hook. Failed sources retain their old data.
      if (preserveOnError && snapshot.unavailableReason !== null) {
        throw new Error(snapshot.unavailableReason);
      }
    } catch (error) {
      if (!current()) return;
      setMarketSnapshot((current) =>
        current
          ? current
          : {
              items: [],
              unavailableReason: error instanceof Error ? error.message : String(error),
              customSourceNames: [],
              unavailableCustomSourceNames: [],
            },
      );
      // Background icon renewal keeps the current snapshot visible, but must still report
      // failure to the renewal hook so it can schedule a bounded retry.
      if (preserveOnError) throw error;
    }
  }, []);
  // 失败原因已经用提示告诉过用户;离开插件页后不再留着失败标记。
  useEffect(() => clearFailedPluginInstallProgress, []);
  useEffect(() => {
    setMarketDetail(null);
    marketBusyLockRef.current = null;
    setMarketBusy(null);
    // The page stays mounted across account and mode switches: rings started by the previous
    // owner go now. A running batch of the current owner is untouched.
    dropStalePluginInstallProgress();
    marketDetailRequestRef.current += 1;
    // The retained bucket may have missed installation changes off-route.
    // Show it immediately, but revalidate once through the existing reader.
    void refreshMarket();
  }, [clearPluginCatalogScrollRestore, refreshMarket, mode, dataOwnerId, dataOwnerGeneration]);
  const refreshMarketOnForeground = useCallback(async () => {
    await Promise.all([refreshMarket(true), foregroundDetailRefresh.current?.()]);
  }, [refreshMarket]);
  usePluginMarketForegroundRefresh(refreshMarketOnForeground, lastMarketRefreshAtRef);
  useEffect(() => {
    return window.electronAPI.pluginMarket.onUpdateConsentHoldsChanged(() => {
      void refreshMarket(true).catch(() => undefined);
    });
  }, [refreshMarket]);
  useEffect(() => {
    if (
      installedGhostMarketKeyRef.current === installedGhostMarketKey ||
      marketBusyLockRef.current !== null
    ) {
      return;
    }
    // 已装集合或版本变化(装/卸/后台更新)时刷新市场;排序是反应式的。
    // 安装广播早于市场账本提交；等待事务收尾，由成功刷新消费，失败/取消后补刷。
    void refreshMarket(true).catch(() => undefined);
  }, [installedGhostMarketKey, marketBusyId, refreshMarket]);
  const activeSessionWorkingDir = useSyncExternalStore(
    subscribeToLastWorkingDir,
    getLastWorkingDir,
    getLastWorkingDir,
  );
  const recentWorkdirs = usePluginRecentWorkdirs();
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  const scopeDirRef = useRef<string | null>(scopeDir);
  const scopeKeyRef = useRef<string | undefined>(undefined);
  scopeDirRef.current = scopeDir;
  const [projectDisabled, setProjectDisabled] = useState<Set<string>>(() => new Set());
  const handlePickScope = useCallback((dir: string | null) => {
    setScopeDir(dir);
    scopeDirRef.current = dir;
    scopeKeyRef.current = undefined;
    if (!dir) {
      setProjectDisabled(new Set());
      return;
    }
    try {
      const policy = window.electronAPI.ghosts.workdirPrefsSync(dir);
      scopeKeyRef.current = policy.workdirKey;
      setProjectDisabled(new Set(policy.disabled));
    } catch {
      setProjectDisabled(new Set());
    }
  }, []);
  useEffect(() => {
    if (!recommendation) return;
    const target = recommendation.suggestion.pluginId
      ? findInstalledGhostByInstanceId(ghosts, recommendation.suggestion.pluginId)
      : undefined;
    handlePickScope(target?.enabled ? recommendation.workingDir : null);
  }, [recommendation?.nonce, handlePickScope]);
  const effectiveEnabled = useCallback(
    (id: string, globallyEnabled: boolean) =>
      scopeDir === null ? globallyEnabled : globallyEnabled && !projectDisabled.has(id),
    [projectDisabled, scopeDir],
  );
  const [recentGhostIds, setRecentGhostIds] = useState(
    () => window.electronAPI.ghosts.recentUsageSync().ids,
  );
  useEffect(() => window.electronAPI.ghosts.onWorkdirPrefsChanged?.((policy, ownerStamp) => {
    if (!scopeDirRef.current || !isDataOwnerPushCurrent(ownerStamp)) return;
    if (scopeKeyRef.current === undefined) { handlePickScope(scopeDirRef.current); return; }
    if (scopeKeyRef.current === policy.workdirKey) setProjectDisabled(new Set(policy.disabled));
  }), [handlePickScope]);
  useEffect(
    () =>
      window.electronAPI.ghosts.onChanged(() => {
        const dir = scopeDirRef.current;
        if (dir) {
          try {
            const policy = window.electronAPI.ghosts.workdirPrefsSync(dir);
            scopeKeyRef.current = policy.workdirKey;
            setProjectDisabled(new Set(policy.disabled));
          } catch {
            // Keep the current project snapshot if another window races the read.
          }
        }
      }),
    [],
  );
  useEffect(
    () =>
      window.electronAPI.ghosts.onRecentUsageChanged(({ ids }) => {
        setRecentGhostIds(ids);
      }),
    [],
  );
  useEffect(() => {
    legacyRecoveryStatusRequestRef.current += 1;
    legacyRecoveryRetryRequestRef.current += 1;
    setLegacyRecoveryRetrying(false);
  }, [dataOwnerId, mode]);
  useEffect(() => {
    const requestId = ++legacyRecoveryStatusRequestRef.current;
    if (mode !== 'cloud' || !dataOwnerId) {
      setLegacyRecoveryStatus(null);
      return;
    }
    void window.electronAPI.ghosts
      .legacyRecoveryStatus()
      .then((status) => {
        if (requestId !== legacyRecoveryStatusRequestRef.current) return;
        setLegacyRecoveryStatus(status.state === 'none' ? null : status);
      })
      .catch(() => {
        if (requestId === legacyRecoveryStatusRequestRef.current) {
          setLegacyRecoveryStatus(null);
        }
      });
  }, [dataOwnerId, installedGhostLocationsKey, mode]);
  // /plugins?ghost=<id> 深链:直接打开该插件详情(配置就绪弹窗等入口复用;
  // 读后即清参数,避免从详情返回列表后又被同一参数拉回详情)。
  useEffect(() => {
    const target = searchParams.get('ghost');
    if (!target) return;
    setSelectedId(target);
    const next = new URLSearchParams(searchParams);
    next.delete('ghost');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  // /plugins?panel=<id> 深链:打开该插件的页签面板(装入流程「立即开启并
  // 打开面板」从其它视图跳转进来)。合法性由 openPanelGhost 统一裁决:
  // 非 tab 形态或未启用的目标会被下方失效 effect 自动清掉。
  useEffect(() => {
    const target = searchParams.get('panel');
    if (!target) return;
    setOpenPanelId(target);
    const next = new URLSearchParams(searchParams);
    next.delete('panel');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  // 引用稳定:批次对账 effect 以它为依赖,裸 `?? []` 每次渲染都是新数组会空转。
  const marketItems = useMemo(() => marketSnapshot?.items ?? [], [marketSnapshot]);
  const publicPublishersByPluginId = useMemo(() => {
    const publishers = new Map<string, PluginMarketItem['publisherKind']>();
    for (const item of marketItems) {
      if (publicPublisherFilter(item)) publishers.set(item.pluginId, item.publisherKind);
    }
    return publishers;
  }, [marketItems]);
  const todayCandidates = useMemo(() => todayPool.filter(item => {
    const latest = marketItems.find(current => current.pluginId === item.pluginId) ?? item;
    return !consumedToday.has(item.pluginId) && latest.installState !== 'installed' && latest.installState !== 'update-available';
  }), [todayPool, marketItems, consumedToday]);
  const todayItems = useMemo(() => selectPluginRecommendationBatch(todayCandidates, recommendationBatch), [todayCandidates, recommendationBatch]);
  const customSourceNames = useMemo(
    () => marketSnapshot?.customSourceNames ?? [],
    [marketSnapshot?.customSourceNames],
  );
  const catalogDataRevision = useMemo(() => JSON.stringify([
    catalogRevision, showEnterprise, user?.orgId, installedGhostMarketKey, customSourceNames,
    marketSnapshot?.organizationAccessError ?? null, marketSnapshot?.unavailableCustomSourceNames ?? [],
    marketSnapshot?.items.map(item => [item.pluginId, item.installState, item.releaseId, item.version]) ?? [],
  ]), [catalogRevision, showEnterprise, user?.orgId, installedGhostMarketKey, customSourceNames, marketSnapshot]);
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [githubInstallOwner, setGithubInstallOwner] = useState<string | null>(null);
  const githubUpdateByInstanceId = useMemo(
    () => new Map(githubUpdates.map((update) => [update.instanceId, update])),
    [githubUpdates],
  );
  const allInstalledItems = useMemo<PresentedGhostPluginItem[]>(
    () =>
      ghosts
        // cindy-mivo was renamed to xd-mivo. Older user data can still
        // contain both ids; keep the canonical entry from rendering twice.
        .filter(
          (ghost) =>
            ghost.manifest.id !== 'cindy-mivo' ||
            !ghosts.some((candidate) => candidate.manifest.id === 'xd-mivo'),
        )
        .map((ghost) => {
          const marketItem = marketItemForInstalledGhost(marketItems, ghost);
          const presentation = marketPresentationForInstalledGhost(ghost, marketItem);
          const listItem = toGhostPluginListItem(ghost, presentation);
          const marketUpdate = ghost.retirement ? null : pluginUpdateForInstalledVersion(marketItem);
          const recordedPublisher = ghost.publishingSource?.kind === 'public-market'
            ? publicPublishersByPluginId.get(ghost.publishingSource.pluginId)
            : undefined;
          return {
            ...listItem,
            origin: marketItem ? pluginPresentationOrigin(marketItem) : listItem.origin,
            publisherKind: recordedPublisher ?? listItem.publisherKind,
            marketItem,
            // 服务端的空署名代表匿名；公域来源缺少可信投影时也不回退包内作者。
            author: presentation
              ? presentation.author
              : ghost.publishingSource?.kind === 'public-market' ||
                  (marketItem?.sourceType === 'server' && marketItem.scope === 'public')
                ? null
                : ghost.manifest.author ?? null,
            // 同版本展示刷新由 main 标成 installed;legacy-unresolved 仍保留
            // update-available,以便用户用市场包替换未验证的本地字节。
            marketUpdate,
            githubUpdate: marketUpdate
              ? null
              : githubUpdateByInstanceId.get(installedGhostStoragePart(ghost)) ?? null,
          };
        }),
    [ghosts, marketItems, publicPublishersByPluginId, githubUpdateByInstanceId],
  );
  const installedItems = useMemo(
    () =>
      showEnterprise
        ? allInstalledItems
        : allInstalledItems.filter((item) => item.origin !== 'organization'),
    [allInstalledItems, showEnterprise],
  );
  const publishableInstalledItems = useMemo(() => {
    const eligible = new Set(ghosts.filter((ghost) =>
      ghost.publishingSource?.kind === 'local' &&
      !localPublishingUnavailableKey(ghost, marketItemForInstalledGhost(marketItems, ghost)),
    ).map(installedGhostStoragePart));
    return allInstalledItems.filter((item) => eligible.has(item.id));
  }, [ghosts, marketItems, allInstalledItems]);
  const searchedInstalledItems = useMemo(
    () => filterGhostPluginItems(installedItems, query),
    [installedItems, query],
  );
  const effectiveOriginFilter =
    !showEnterprise && originFilter === 'organization'
      ? 'all'
      : originFilter === 'custom' && customSourceNames.length === 0
        ? 'all'
        : originFilter;

  // ── 已安装区排序:未读通知(新→旧) → 最近使用 → 基础序,实时计算 ──
  // 反应式而非冻结快照:排序信号变化即重排。安全边界——`markUsed` 只在对话里
  // 触发(ChatInput),插件页自身不打点,所以「最近使用」的变化只发生在离开本页
  // 之后,回到页面即已重排,不会在用户眼皮下洗牌;后台到达的未读通知冒头则正是
  // 目的所在。切账号/模式时 recentGhostIds 与未读表都会随 owner 快照整体作废。
  // marketUpdate 刻意不作排序键——更新已有统一横幅兜底,可被折叠。
  const unreadEntries = useGhostUnreadEntries();
  const unreadAtById = useMemo(
    () => new Map(unreadEntries.map((entry) => [entry.ghostId, entry.at])),
    [unreadEntries],
  );
  const displayInstalledItems = useMemo(
    () =>
      sortInstalledForDisplay(searchedInstalledItems, {
        recentIds: recentGhostIds,
        unreadAtById,
      }),
    [searchedInstalledItems, recentGhostIds, unreadAtById],
  );
  const primaryInstalledItems = useMemo(
    () => displayInstalledItems.slice(0, installedLimit),
    [displayInstalledItems, installedLimit],
  );
  const showInstalledEmpty = installedItems.length === 0 && !legacyRecoveryStatus &&
    (catalogTab === 'installed' || !!query.trim());
  useEffect(() => {
    const sentinel = installedSentinel.current;
    const root = pluginCatalogListRef.current;
    if (!pluginCatalogVisible || (!query.trim() && catalogTab !== 'installed') || !sentinel || !root
      || installedLimit >= displayInstalledItems.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setInstalledLimit(count => Math.min(count + PLUGIN_PAGE_SIZE, displayInstalledItems.length));
    }, { root, rootMargin: '80px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [catalogTab, query, pluginCatalogVisible, installedLimit, displayInstalledItems.length, pluginCatalogListRef]);

  // ── 更新横幅与批量更新：作为自动更新失败／忙碌跳过后的手动重试入口 ──
  const updatableInstalledItems = useMemo(
    () => installedItems.filter((item) => item.marketUpdate !== null || item.githubUpdate !== null),
    [installedItems],
  );
  const githubBannerUpdates = useMemo<NamedGithubReleaseUpdate[]>(
    () => updatableInstalledItems.flatMap((item) =>
      item.githubUpdate ? [{ ...item.githubUpdate, name: item.name }] : []),
    [updatableInstalledItems],
  );
  const currentRoundKey = useMemo(
    () => updateRoundKey(marketItems, githubBannerUpdates),
    [marketItems, githubBannerUpdates],
  );
  const handleIgnoreRound = useCallback(() => {
    try {
      window.localStorage.setItem(ignoredRoundKey, currentRoundKey);
    } catch {
      // localStorage 不可用时仅本次会话内生效。
    }
    setIgnoredRound(currentRoundKey);
  }, [currentRoundKey, ignoredRoundKey]);

  // 批次状态住在模块级控制器里(生命周期长于本页:关弹窗离开 /plugins
  // 后批次继续跑),页面只订阅快照。真实包校验与落位由统一安装事务负责。
  const updateBatch = useSyncExternalStore(subscribeUpdateAllBatch, getUpdateAllBatchState);
  const updateRows = updateBatch.rows;
  const batchRunning = updateBatch.running;
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  // 与外部事实对账:已装清单或市场快照变化(单项更新/文件更新/卸载)收束
  // 对应批量行——完成判据取市场快照的 installState(目标 release 是否落账),
  // 不用版本号;账号或模式切换作废整批,旧账号的批次绝不落到新账号数据上。
  useEffect(() => {
    reconcileUpdateAllBatch(marketItems);
  }, [ghosts, marketItems, mode, dataOwnerId]);
  // 有未完结批次时横幅必须在场:它是重开批量进度弹窗的唯一入口,
  // 「忽略本轮」不得顺带藏掉正在执行的批次。
  const hasUnfinishedBatch = updateRows !== null && !isBatchFinished(updateRows);
  const bannerVisible =
    hasUnfinishedBatch ||
    (updatableInstalledItems.length > 0 &&
      (currentRoundKey === '' || ignoredRound !== currentRoundKey));
  const selectedGhost = selectedId
    ? (findInstalledGhostByInstanceId(ghosts, selectedId) ?? null)
    : null;
  const selectedPresentation = selectedGhost
    ? marketPresentationForInstalledGhost(
        selectedGhost,
        marketItemForInstalledGhost(marketItems, selectedGhost),
      )
    : null;
  const selectedDetail = selectedGhost
    ? toGhostPluginDetail(selectedGhost, selectedPresentation)
    : null;
  const selectedMarketInstall = selectedGhost
    ? marketItemForInstalledGhost(marketItems, selectedGhost)
    : null;
  const selectedMarketUpdate = selectedDetail
    ? pluginUpdateForInstalledVersion(selectedMarketInstall)
    : null;
  const updatePluginId = selectedMarketUpdate?.pluginId;
  const updateReleaseId = selectedMarketUpdate?.releaseId;
  const historyPluginId = selectedMarketInstall?.sourceType === 'server' ? selectedMarketInstall.pluginId : undefined;
  const historyReleaseId = historyPluginId ? selectedMarketInstall?.releaseId : undefined;
  const notesPluginId = historyPluginId ?? updatePluginId;
  const notesReleaseId = historyReleaseId ?? updateReleaseId;
  const cachedUpdate = notesPluginId ? detailCache.peek(notesPluginId) : undefined;
  const catalogOnline = useSyncExternalStore(subscribeCatalogOnline, () => navigator.onLine);
  const updateNotes = updatePluginId && cachedUpdate?.releaseId === updateReleaseId
    ? cachedUpdate?.manifest.releaseNotes : undefined;
  const releaseUpdates = catalogOnline && cachedUpdate?.releaseId === historyReleaseId ? cachedUpdate?.updates : undefined;
  const [, setUpdateNotesRevision] = useState(0);
  useEffect(() => {
    if (!active || !selectedId || !notesPluginId || !notesReleaseId || !catalogOnline) return;
    const cached = detailCache.peek(notesPluginId);
    if (cached?.releaseId === notesReleaseId && (!historyPluginId || cached.updates !== undefined)) return;
    let current = true;
    let requested = false;
    const fields = historyPluginId ? { includeUpdates: true, includeReadme: false } : undefined;
    const load = (mode: 'open' | 'background') => detailCache.load(notesPluginId, () => {
      requested = true;
      return window.electronAPI.pluginMarket.detail(notesPluginId, fields);
    }, mode, () => current, fields).catch(() => undefined);
    void (async () => {
      let result = await load(cached && cached.releaseId !== notesReleaseId ? 'background' : 'open');
      // A refreshed snapshot can join the previous release's in-flight read.
      // If that read cannot satisfy the new snapshot, make one fresh request.
      if (current && historyPluginId && !requested && result?.releaseId !== notesReleaseId) {
        result = await load('background');
      }
      if (current && result?.releaseId === notesReleaseId) setUpdateNotesRevision(revision => revision + 1);
    })();
    return () => { current = false; };
  }, [active, catalogOnline, detailCache, historyPluginId, notesPluginId, notesReleaseId, selectedId]);
  const selectedMainViewSidebarVisible = selectedDetail?.hasMainView
    ? readMainViewSidebarVisible(dataOwnerId, selectedDetail.id)
    : true;

  // ── 面板收束:页面独占的插件面板宿主;停用/卸载/换形态自动失效 ──
  const openPanelGhost = useMemo(() => {
    if (!openPanelId) return null;
    const ghost = findInstalledGhostByInstanceId(ghosts, openPanelId) ?? null;
    if (!ghost) return null;
    if (ghost.manifest.panel?.position !== 'tab') return null;
    if (!effectiveEnabled(installedGhostStoragePart(ghost), ghost.enabled)) return null;
    return ghost;
  }, [effectiveEnabled, ghosts, openPanelId]);
  useEffect(() => {
    if (openPanelId && !openPanelGhost) setOpenPanelId(null);
  }, [openPanelGhost, openPanelId]);
  // 「打开面板 = 已读」不在这里清:三个 setOpenPanelId 调用点(卡片主动作 /
  // 详情页「使用」/ ?panel= 深链)只是"想开",而面板还有停靠态与独立窗口两种
  // 宿主。清零统一收在面板体 GhostChipPanelBody 挂载处——那才是"内容确实在
  // 用户眼前"的唯一判据,三个宿主自然对称。
  /**
   * 账号 / 本地云模式切换必须关掉在开的面板。
   *
   * 光靠上面那条「解析不到就关」不够:两个账号装了**同 id、同版本、同入口**的
   * 插件时,openPanelGhost 在新身份下照样解析得到,面板宿主不会重挂载,于是
   * 账号 A 的 webview DOM、内存态与交互(表单、登录态、已加载数据)原样留在
   * 账号 B 面前。这里按 owner 键显式清空;首帧不清,免得把 ?panel= 深链刚设上的
   * 目标一并抹掉(那条 effect 排在本条之前)。
   */
  const panelOwnerKeyRef = useRef(panelOwnerKey);
  useEffect(() => {
    const previous = panelOwnerKeyRef.current;
    if (previous === panelOwnerKey) return;
    panelOwnerKeyRef.current = panelOwnerKey;
    setOpenPanelId((current) => nextOpenPanelIdForOwner(previous, panelOwnerKey, current));
  }, [panelOwnerKey]);

  // 停靠形态的面板现在以右侧栏全局页签承载:状态只分「在右侧栏中」与「已从右侧栏关闭」。
  const globalTabs = useGlobalTabs();
  const panelStatus = useMemo(() => {
    if (!selectedDetail || selectedDetail.panelMinWidth === null) return null;
    // 页签形态(面板收束):由插件页承载,没有停靠状态可言。
    if (selectedDetail.tabPanel) return t('settings.ghosts.detail.panelPageHosted');
    const inSidebar = globalTabs.some(
      (tab) => (tab.state as { instanceId?: string } | null)?.instanceId === selectedDetail.id,
    );
    return inSidebar
      ? t('settings.ghosts.detail.panelInSidebar')
      : t('settings.ghosts.detail.panelDismissed');
  }, [globalTabs, selectedDetail, t]);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean, displayName: string) => {
      const pendingNonce = getPendingPluginSuggestion()?.nonce;
      try {
        const dir = scopeDirRef.current;
        if (dir) {
          const result = await window.electronAPI.ghosts.setWorkdirDisabled(dir, id, !enabled);
          if (scopeDirRef.current === dir) setProjectDisabled(new Set(result.disabled));
          toast.success(
            t(
              enabled
                ? 'settings.ghosts.toast.projectEnabled'
                : 'settings.ghosts.toast.projectDisabled',
              { name: displayName },
            ),
          );
        } else {
          await window.electronAPI.ghosts.setEnabled(id, enabled);
        }
        if (enabled) await continueRecommendation(pendingNonce, id);
      } catch (error) {
        toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
      }
    },
    [continueRecommendation, t],
  );

  /** Main 在同一次 install IPC 事务内校验真实包与市场声明的能力上限。 */
  const installMarketPackage = useCallback(
    async (input: {
      pluginId: string;
      options: PluginMarketInstallOptions;
      isStillActive: () => boolean;
    }): Promise<InstalledGhost | null> => {
      const result = await window.electronAPI.pluginMarket.install(input.pluginId, input.options);
      if (!input.isStillActive()) return null;
      setConsumedToday(current => new Set([...current, input.pluginId]));
      return result.ghost;
    },
    [],
  );

  // 目录详情用于发现与能力展示；点击更新后由 Main 下载并校验真实包后直接落位。
  const handleMarketUpdate = useCallback(
    async (instanceId: string) => {
      const installedGhost = findInstalledGhostByInstanceId(ghosts, instanceId) ?? null;
      const marketItem = installedGhost
        ? marketItemForInstalledGhost(marketItems, installedGhost)
        : null;
      if (
        !marketItem ||
        !marketReviewTargetsInstalledGhost(marketItem, installedGhost?.approval.state)
      ) {
        return;
      }
      if (!installedGhost) {
        toast.error(t('settings.ghosts.market.errors.stateChanged'));
        await refreshMarket();
        return;
      }
      // 列表每张卡都有直达入口,同步互斥防止并发更新互相覆盖忙碌状态。
      const marketBusyLease = acquireMarketBusy(marketItem.pluginId);
      if (!marketBusyLease) return;
      // 点下去立刻显示「正在准备」,后续步骤由 Main 的进度推送填入。
      beginPluginInstallProgress(marketItem.pluginId);
      try {
        const next = await window.electronAPI.pluginMarket.detail(marketItem.pluginId);
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        if (!marketReviewTargetsInstalledGhost(next, installedGhost.approval.state)) {
          toast.error(t('settings.ghosts.market.errors.stateChanged'));
          await refreshMarket();
          return;
        }
        const options: PluginMarketInstallOptions = {
          expectedReleaseId: next.releaseId,
          expectedManifest: next.manifest,
          expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval),
          allowSourceReplacement: false,
        };
        const ghost = await installMarketPackage({
          pluginId: next.pluginId,
          options,
          isStillActive: () => isMarketBusyLeaseActive(marketBusyLease),
        });
        if (!ghost || !isMarketBusyLeaseActive(marketBusyLease)) return;
        succeedPluginInstallProgress(marketItem.pluginId);
        toast.success(
          t('settings.ghosts.toast.updated', {
            name: ghost.manifest.name,
            version: ghost.manifest.version,
          }),
        );
        // 列表/详情共用此路径:成功后不切页面,方便连续点其它插件的更新。
        await refreshMarket();
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          // 用户在确认框里取消不是失败,不留失败标记。
          if (extractIpcError(error)?.code !== 'MUTATION_CANCELLED') {
            failPluginInstallProgress(marketItem.pluginId, t(pluginMarketErrorKey(error)));
          }
          await showPluginMarketActionError(error);
        }
      } finally {
        endPluginInstallProgress(marketItem.pluginId);
        releaseMarketBusy(marketBusyLease);
      }
    },
    [
      acquireMarketBusy,
      ghosts,
      isMarketBusyLeaseActive,
      installMarketPackage,
      marketItems,
      refreshMarket,
      releaseMarketBusy,
      showPluginMarketActionError,
      t,
    ],
  );

  const handleUpdate = useCallback(async () => {
    if (!selectedDetail) return;
    if (selectedMarketUpdate) {
      await handleMarketUpdate(selectedDetail.id);
      return;
    }
    await pickAndUpdateGhost(selectedDetail.id, { t });
  }, [handleMarketUpdate, selectedDetail, selectedMarketUpdate, t]);

  /**
   * 安装验证记录缺失或损坏时，用户主动选择重新落位同一来源的真实包。
   * 市场包重装当前 release；本地包重新选择 `.cindy`。两条路都只恢复
   * 完整安装记录，不新增能力确认。
   */
  const handleRecoverInstall = useCallback(
    async (instanceId: string) => {
      const installedGhost = findInstalledGhostByInstanceId(ghosts, instanceId) ?? null;
      if (installedGhost?.builtin) return;
      if (
        ghostReapprovalRoute(installedGhost ? marketItemForInstalledGhost(marketItems, installedGhost) : null) ===
        'market'
      ) {
        await handleMarketUpdate(instanceId);
        return;
      }
      await pickAndUpdateGhost(instanceId, { t });
    },
    [ghosts, handleMarketUpdate, marketItems, t],
  );

  const handleUpdateFromFile = useCallback(async () => {
    if (!selectedDetail) return;
    await pickAndUpdateGhost(selectedDetail.id, { t });
  }, [selectedDetail, t]);

  // 控制器在挂载期借用本页的市场刷新。
  useEffect(
    () =>
      setUpdateAllBatchHooks({
        refreshMarket: () => refreshMarket(),
      }),
    [refreshMarket],
  );
  const handleUpdateAll = useCallback(() => {
    const current = getUpdateAllBatchState();
    // 运行中或还有未完成项的批次:重开弹窗查看进度,不重建批次。
    if (current.running || (current.rows !== null && !isBatchFinished(current.rows))) {
      setUpdateDialogOpen(true);
      return;
    }
    // 单项更新持有 market lease 期间不许开新批次:此刻的市场快照还把那个
    // 插件标成 update-available,批次会把它一并收进去重复装一遍。
    if (marketBusyLockRef.current !== null) return;
    startUpdateAllBatch(
      updatableInstalledItems.flatMap((item) => (item.marketUpdate ? [item.marketUpdate] : [])),
      githubBannerUpdates,
    );
    setUpdateDialogOpen(true);
  }, [githubBannerUpdates, updatableInstalledItems]);

  // GitHub Release 单项更新：借用市场操作的同一把互斥锁（键为 github:<实例>），
  // 与市场单项更新、批量更新互斥；下载与校验仍在 Main 内按最新检查完成。
  const handleGithubUpdate = useCallback(
    async (update: GithubReleaseUpdate) => {
      if (getUpdateAllBatchState().running) return;
      const ghost = findInstalledGhostByInstanceId(ghosts, update.instanceId);
      const target = ghost ? githubReleaseTarget(ghost) : null;
      if (!ghost || !target) return;
      const key = githubUpdateKey(update.instanceId);
      const lease = acquireMarketBusy(key);
      if (!lease) return;
      beginPluginInstallProgress(key);
      try {
        const reply = await runGithubReleaseUpdate({ target, assetId: update.assetId, progressKey: key });
        if (!isMarketBusyLeaseActive(lease)) return;
        const outcome = githubRowOutcome(reply);
        if (outcome.status === 'failed') {
          failPluginInstallProgress(key, outcome.errorText);
          toast.error(outcome.errorText);
        } else if (outcome.updated) {
          succeedPluginInstallProgress(key);
          toast.success(
            t('settings.ghosts.toast.updated', {
              name: ghost.manifest.name,
              version: outcome.version ?? update.version,
            }),
          );
        }
      } catch (error) {
        if (isMarketBusyLeaseActive(lease) && extractIpcError(error)?.code !== 'MUTATION_CANCELLED') {
          const text = t(pluginMarketErrorKey(error));
          failPluginInstallProgress(key, text);
          toast.error(text);
        }
      } finally {
        endPluginInstallProgress(key);
        releaseMarketBusy(lease);
      }
    },
    [acquireMarketBusy, ghosts, isMarketBusyLeaseActive, releaseMarketBusy, t],
  );

  const handlePublish = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    try {
      await window.electronAPI.pluginPublisher.start(picked.filePath);
    } catch (error) {
      const decoded = extractIpcError(error);
      toast.error(
        decoded?.code === 'PERMISSION_DENIED'
          ? t('settings.ghosts.publish.disabled')
          : t('settings.ghosts.publish.startFailed'),
      );
    }
  }, [t]);

  const handleInstall = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    await importCindyFile(picked.filePath, {
      t,
      openThemes: () => navigate('/settings?tab=appearance'),
      // 已在插件页:tab 型插件安装后原地打开面板。
      openPluginPanel: (instanceId) => {
        setSelectedId(null);
        setOpenPanelId(instanceId);
      },
    });
  }, [navigate, t]);

  const handleRetryLegacyRecovery = useCallback(async () => {
    legacyRecoveryStatusRequestRef.current += 1;
    const requestId = ++legacyRecoveryRetryRequestRef.current;
    setLegacyRecoveryRetrying(true);
    try {
      const status = await window.electronAPI.ghosts.retryLegacyRecovery();
      if (requestId === legacyRecoveryRetryRequestRef.current) {
        setLegacyRecoveryStatus(status.state === 'none' ? null : status);
      }
    } catch {
      const status = await window.electronAPI.ghosts.legacyRecoveryStatus().catch(() => null);
      if (requestId === legacyRecoveryRetryRequestRef.current) {
        setLegacyRecoveryStatus(status && status.state !== 'none' ? status : null);
      }
    } finally {
      if (requestId === legacyRecoveryRetryRequestRef.current) {
        await refreshMarket().catch(() => undefined);
        if (requestId === legacyRecoveryRetryRequestRef.current) {
          setLegacyRecoveryRetrying(false);
        }
      }
    }
  }, [refreshMarket]);

  const handleCreateWithCindy = useCallback(async () => {
    const agentKind = dbToMakerAgentKind(normalizeDbAgentKind(getWorkspaceDraft().vendor));
    // Creation starts locally without a project. Use Main-attested identity: a
    // same-named user Skill must never own this entry, including Claude aliases.
    const commands = await loadAllCommands(agentKind, null);
    const creator = commands.find((command) => (
      command.kind === 'agent-skill'
      && command.builtIn === true
      && command.enabled !== false
      && !isSlashCommandUnavailable(command)
      && (command.name === CINDY_PLUGIN_CREATOR_NAME
        || command.name === `cindy:${CINDY_PLUGIN_CREATOR_NAME}`)
    ));
    if (!creator) {
      toast.error(t('settings.ghosts.page.creatorUnavailable'));
      return;
    }
    saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
      text: plainTextToTiptapDoc(`/${creator.name} ${t('settings.ghosts.page.createPrompt')}`),
      builtInSkillIntent: { name: CINDY_PLUGIN_CREATOR_NAME, commandName: creator.name },
      attachments: [],
      focusAtEnd: true,
    });
    resetDraftWorkspaceTargets();
    navigate('/cc-agent/new');
  }, [navigate, t]);

  // 打开插件详情并滚到「配置」区(就绪弹窗的「去配置」动作)。详情视图
  // 可能尚未挂载,滚动排到渲染之后的下一帧;减弱动效时改即时定位。
  const openGhostConfiguration = useCallback((id: string) => {
    setSelectedId(id);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .getElementById('ghost-configuration-title')
          ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
    });
  }, []);

  const handleUseGhost = useCallback(
    async (id: string, displayName: string) => {
      const ghost = findInstalledGhostByInstanceId(ghosts, id) ?? null;
      if (!ghost) return;
      if (!ghost.manifest.command || ghost.retirement) return;
      // 使用前置门:点击时现查配置就绪度(main 侧确定性判定),未就绪先
      // 弹窗引导去配置。查询失败不拦——运行期 networkSlot 仍会兜底报错,
      // 这里拦不住只是少了一次前置提醒,不能因此把能用的插件挡在门外。
      let setupStatus: GhostSetupStatus | null = null;
      try {
        setupStatus = await window.electronAPI.ghosts.setupStatus(id);
      } catch {
        setupStatus = null;
      }
      if (setupStatus && !setupStatus.ready) {
        const goConfigure = await confirm({
          title: t('settings.ghosts.setupGate.title', { name: displayName }),
          description: formatSetupGateDescription(setupStatus, t),
          confirmText: t('settings.ghosts.setupGate.configure'),
          cancelText: t('settings.ghosts.setupGate.cancel'),
          // 主操作「去配置」非破坏性,默认焦点落主按钮(弹窗契约的适用场景)。
          autoFocusConfirm: true,
        });
        if (goConfigure) openGhostConfiguration(id);
        return;
      }
      const existing = getComposerDraft(NEW_MAKER_DRAFT_KEY);
      saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
        text: existing?.text ?? null,
        attachments: existing?.attachments ?? [],
        quotes: existing?.quotes ?? [],
        browserComments: existing?.browserComments ?? [],
        ...(ghost.manifest.command ? { pendingGhostId: installedGhostStoragePart(ghost) } : {}),
        focusAtEnd: existing?.focusAtEnd === true,
      });
      resetDraftWorkspaceTargets();
      navigate('/cc-agent/new');
    },
    [confirm, ghosts, navigate, openGhostConfiguration, t],
  );

  /** 卡片胶囊/详情主动作分发:面板型开页面内面板,指令/Host 能力起对话。 */
  const handlePrimaryAction = useCallback(
    (item: Pick<GhostPluginListItem, 'id' | 'name' | 'tabPanel' | 'canUse'>) => {
      const action = ghostPrimaryAction(item);
      if (action === 'panel') {
        setOpenPanelId(item.id);
        return;
      }
      if (action === 'command') {
        void handleUseGhost(item.id, item.name);
        return;
      }
      setSelectedId(item.id);
    },
    [handleUseGhost],
  );

  const handleMainViewSidebarVisibleChange = useCallback(
    (visible: boolean) => {
      const selected = selectedDetail;
      if (!selected?.hasMainView) return;
      const owner = currentMainViewVisibilityOwner();
      void writeMainViewSidebarVisible(owner, selected.id, visible)
        .then((persisted) => {
          if (!persisted) toast.error(t('settings.ghosts.errors.generic'));
        })
        .catch(() => {
          toast.error(t('settings.ghosts.errors.generic'));
        });
    },
    [selectedDetail, t],
  );

  const handleUse = useCallback(() => {
    if (selectedGhost && selectedDetail) {
      handlePrimaryAction(selectedDetail);
    }
  }, [handlePrimaryAction, selectedDetail, selectedGhost]);

  // 导出当前插件的 .cindy 包:main 侧打包安装目录 → 系统保存对话框落盘。
  // 取消选择静默返回;成功/失败都如实 toast。
  const handleExport = useCallback(async () => {
    if (!selectedDetail) return;
    try {
      const result = await window.electronAPI.ghosts.export(selectedDetail.id);
      if (result.status === 'canceled') return;
      toast.success(t('settings.ghosts.toast.exported', { name: selectedDetail.name }));
    } catch {
      toast.error(t('settings.ghosts.toast.exportFailed', { name: selectedDetail.name }));
    }
  }, [selectedDetail, t]);

  const uninstallPlugin = useUninstallPlugin();
  const handleUninstall = () => {
    if (selectedGhost && selectedDetail) {
      return uninstallPlugin(selectedGhost, selectedDetail.name, selectedMarketInstall?.pluginId, refreshMarket);
    }
  };

  const handleSelectMarket = useCallback(
    async (item: PluginMarketItem | string, preferInstalled = false, navigation: 'catalog' | 'detail' | 'back' = 'catalog') => {
      if (navigation !== 'back' && marketBusyLockRef.current) return;
      const pluginId = typeof item === 'string' ? item : item.pluginId;
      if (navigation === 'catalog') {
        relatedMarketTrail.current.items.length = 0;
        capturePluginCatalogScroll(pluginId);
      }
      const requestId = ++marketDetailRequestRef.current;
      const owner = contributionOwnerRef.current;
      const current = () => contributionMounted.current && requestId === marketDetailRequestRef.current && contributionOwnerRef.current === owner && activeDetailCacheRef.current === detailCache;
      let cached = detailCache.peek(pluginId);
      const preview = typeof item === 'string' ? marketItems.find(item => item.pluginId === pluginId) : item;
      if (cached && preview && (cached.releaseId !== preview.releaseId || cached.installState !== preview.installState)) {
        detailCache.invalidate(pluginId);
        cached = undefined;
      }
      setMarketDetailError(null);
      setMarketDetailRefreshing(!detailCache.isFresh(pluginId));
      // A list item has no authority to provide permissions or enable installation.
      // Drop any extra fields supplied by a catalog fixture/older host.
      const summary = marketItemSummary((preview ?? {}) as Partial<PluginMarketDetail>);
      if (cached) setMarketDetail(cached);
      else if (preview) setMarketDetail(summary as PluginMarketItem);
      try {
        const fields = marketDetailFields(preview);
        const detail = await detailCache.load(pluginId,
          async () => retainMarketDetailIcon(await window.electronAPI.pluginMarket.detail(pluginId, fields), preview),
          'open', current, fields);
        if (current()) {
          const installed = preferInstalled && (detail.installState === 'installed' || detail.installState === 'update-available')
            ? ghosts.find(ghost => marketItemMatchesInstalledGhost(detail, ghost)) : undefined;
          if (installed) {
            setMarketDetail(null);
            setSelectedId(installedGhostStoragePart(installed));
          } else {
            if (detail !== cached) setMarketDetail(detail);
          }
        }
      } catch (error) {
        if (current()) {
          if (extractIpcError(error)?.code === 'NOT_FOUND') removeUnavailableRelatedPlugin(relatedCache, pluginId);
          // A transient background failure must not hide usable content. A Main
          // refusal revokes the cached permissions and install action immediately.
          if (cached && !marketDetailAccessRejected(error)) {
            setMarketDetailError(t(pluginMarketErrorKey(error)));
            return;
          }
          if (preview || cached) {
            const unavailable = marketItemSummary((cached ?? summary) as Partial<PluginMarketDetail>);
            setMarketDetail(unavailable as PluginMarketItem);
            setMarketDetailError(t(pluginMarketErrorKey(error)));
          } else toast.error(t(pluginMarketErrorKey(error)));
        }
      } finally {
        if (current()) setMarketDetailRefreshing(false);
      }
    },
    [capturePluginCatalogScroll, detailCache, ghosts, marketItems, relatedCache, t],
  );
  const handleMarketBack = useCallback(() => {
    const previous = relatedMarketTrail.current.items.pop();
    if (previous) {
      if ('installedId' in previous) {
        marketDetailRequestRef.current += 1;
        setMarketDetail(null);
        setSelectedId(previous.installedId);
      } else {
        void handleSelectMarket(previous, false, 'back');
      }
      return;
    }
    cancelPendingPluginSuggestion(recommendationNonce ?? undefined);
    requestPluginCatalogScrollRestore();
    marketDetailRequestRef.current += 1;
    setMarketDetail(null);
  }, [handleSelectMarket, recommendationNonce, requestPluginCatalogScrollRestore]);

  const refreshVisibleMarketDetail = useCallback(async (pluginId: string, background = false) => {
    // A background icon renewal may observe navigation, but must never invalidate a
    // user-initiated detail request by advancing its request generation.
    const requestId = marketDetailRequestRef.current;
    const owner = contributionOwnerRef.current;
    const current = () => contributionMounted.current && requestId === marketDetailRequestRef.current && contributionOwnerRef.current === owner && activeDetailCacheRef.current === detailCache;
    try {
      const cached = detailCache.peek(pluginId);
      const fields = marketDetailFields(cached);
      const detail = await detailCache.load(pluginId, () => window.electronAPI.pluginMarket.detail(pluginId, fields),
        background ? 'background' : 'refresh', current, fields);
      if (!current()) return;
      setMarketDetailError(null);
      setMarketDetail((current) => (current?.pluginId === pluginId ? detail : current));
    } catch (error) {
      // A background URL renewal must not close an otherwise usable detail page.
      if (current()) {
        if (extractIpcError(error)?.code === 'NOT_FOUND') removeUnavailableRelatedPlugin(relatedCache, pluginId);
        if (marketDetailAccessRejected(error)) {
          setMarketDetail(current => {
            if (!current || current.pluginId !== pluginId) return current;
            return marketItemSummary(current);
          });
          setMarketDetailError(t(pluginMarketErrorKey(error)));
        }
        throw error;
      }
    }
  }, [detailCache, relatedCache, t]);
  foregroundDetailRefresh.current = marketDetail?.pluginId
    ? () => refreshVisibleMarketDetail(marketDetail.pluginId, true) : null;
  useEffect(() => {
    const pluginId = searchParams.get('market');
    if (!pluginId || marketBusyId !== null) return;
    const next = new URLSearchParams(searchParams);
    next.delete('market');
    setSearchParams(next, { replace: true });
    void handleSelectMarket(pluginId, true);
  }, [handleSelectMarket, marketBusyId, searchParams, setSearchParams]);
  usePluginMarketLocaleRefresh(
    marketLocale,
    async () => {
      const memory = catalogMemoryRef.current;
      await window.electronAPI.setApplicationMenuLocale(marketLocale);
      if (catalogMemoryRef.current !== memory) return;
      if (!memory.localeReady) {
        // A cold page may have started its snapshot before Main acknowledged the
        // UI language. Finish that read, then refresh once in the correct bucket.
        await memory.snapshotFlight?.catch(() => undefined);
        if (catalogMemoryRef.current !== memory) return;
        memory.snapshotAt = 0;
        memory.localeReady = true;
      }
    },
    () => refreshMarket(true, true),
    marketDetail?.pluginId ? () => refreshVisibleMarketDetail(marketDetail.pluginId) : undefined,
  );
  const visibleTodayItems = useMemo(
    () => active && pluginCatalogVisible && !query.trim() && todayItems.length === 3 ? todayItems : [],
    [active, pluginCatalogVisible, query, todayItems],
  );
  const visibleMarketIcons = useMemo(
    () => [...marketItems.map((item) => item.icon), ...visibleTodayItems.map((item) => item.icon), marketDetail?.icon],
    [marketDetail?.icon, marketItems, visibleTodayItems],
  );
  const refreshVisibleMarketIcons = useCallback(async () => {
    const memory = catalogMemoryRef.current;
    const renewBefore = Date.now() + ICON_REFRESH_LEAD_MS;
    for (const [key, icon] of memory.marketIcons) {
      if (Date.parse(icon.expiresAt) <= renewBefore) memory.marketIcons.delete(key);
    }
    const refreshBrowser = memory.browser.current.refresh?.({ force: true, renewIcons: true }) ?? Promise.resolve();
    const refreshes = [refreshMarket(true, false, true), refreshBrowser];
    if (visibleTodayItems.some(item => item.icon)) {
      refreshes.push(refreshBrowser.catch(() => undefined).then(async () => {
        if (catalogMemoryRef.current !== memory) return;
        const items = await readPluginRecommendations(memory, visibleTodayItems);
        if (catalogMemoryRef.current === memory) setTodayPool(items);
      }));
    }
    if (marketDetail?.pluginId) {
      refreshes.push(refreshVisibleMarketDetail(marketDetail.pluginId));
    }
    const failed = (await Promise.allSettled(refreshes)).find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }, [marketDetail?.pluginId, refreshMarket, refreshVisibleMarketDetail, setTodayPool, visibleTodayItems]);
  const handleMarketIconLoadError = usePluginIconRefresh(
    visibleMarketIcons,
    refreshVisibleMarketIcons,
  );
  const handleCardIconLoadError = (item: PluginMarketItem) => {
    forgetFailedMarketIcon(catalogMemoryRef.current.marketIcons, item);
    handleMarketIconLoadError();
  };

  const runMarketInstallFlow = useCallback(
    async (marketDetailArg: PluginMarketDetail) => {
      const pendingNonce = getPendingPluginSuggestion()?.nonce;
      const marketDetail = marketDetailArg;
      // 确认框等待期间也持有 lease。账号/模式切换会清除当前 lease,
      // 旧确认回调恢复后必须先验权,不能在新会话里继续安装。
      const marketBusyLease = acquireMarketBusy(marketDetail.pluginId);
      if (!marketBusyLease) return;
      // 市场更新与用户显式选择的同 id 替换都走原位更新，
      // 保留生效状态和按 ghostId 存储的用户数据。
      const isUpdate =
        marketDetail.installState === 'update-available' ||
        marketDetail.installState === 'conflict';
      // 详情页与市场卡片原位显示圆环;后续步骤由 Main 的进度推送填入。
      beginPluginInstallProgress(marketDetail.pluginId, isUpdate ? 'update' : 'install');
      try {
        let installedGhost =
          ghosts.find((ghost) => marketItemMatchesInstalledGhost(marketDetail, ghost)) ?? null;
        if (isUpdate && !installedGhost) {
          try {
            installedGhost =
              window.electronAPI.ghosts
                .listSync()
                .ghosts.find((ghost) => marketItemMatchesInstalledGhost(marketDetail, ghost)) ?? null;
          } catch {
            // bridge 不可用或状态切换时保持 null；下面按状态变化安全终止。
          }
        }
        if (isUpdate && !installedGhost) {
          if (isMarketBusyLeaseActive(marketBusyLease)) {
            toast.error(t('settings.ghosts.market.errors.stateChanged'));
          }
          releaseMarketBusy(marketBusyLease);
          await refreshMarket();
          return;
        }
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        const options: PluginMarketInstallOptions = {
          expectedReleaseId: marketDetail.releaseId,
          expectedManifest: marketDetail.manifest,
          ...(isUpdate && installedGhost
            ? { expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval) }
            : {}),
          // 来源隔离(#2043):仅用户显式选择的冲突替换允许切换来源;更新与原位安装不切换。
          allowSourceReplacement: marketDetail.installState === 'conflict',
        };
        const ghost = await installMarketPackage({
          pluginId: marketDetail.pluginId,
          options,
          isStillActive: () => isMarketBusyLeaseActive(marketBusyLease),
        });
        if (!ghost || !isMarketBusyLeaseActive(marketBusyLease)) return;
        succeedPluginInstallProgress(marketDetail.pluginId);
        if (await continueRecommendation(pendingNonce, installedGhostStoragePart(ghost))) return;
        // 市场首装装完即开(2026-07-26 定案),toast 用"已安装";更新路径如实
        // 用"已更新"(生效状态未被改变),并留在当前页方便连续更新多个插件。
        toast.success(
          isUpdate
            ? t('settings.ghosts.toast.updated', {
                name: ghost.manifest.name,
                version: ghost.manifest.version,
              })
            : t('settings.ghosts.toast.installed', {
                name: ghost.manifest.name,
              }),
        );
        if (shouldOpenInstalledDetailAfterMarketSuccess(isUpdate)) {
          // The IPC receipt can precede namespace/source hydration. Use the same
          // Host instance projection as the selected detail, keeping the exact
          // namespace/version match rather than inventing missing identity.
          const installedGhost = findInstalledGhostByInstanceId(readInstalledGhostsSnapshot(), installedGhostStoragePart(ghost)) ?? ghost;
          if (marketItemMatchesInstalledGhost(marketDetail, installedGhost) && marketDetail.version === installedGhost.manifest.version) {
            const summary = marketItemSummary(marketDetail);
            const installed: PluginMarketItem = { ...summary, installState: 'installed', enabled: ghost.enabled };
            // Display-only receipt projection, before selecting configuration.
            // The normal snapshot refresh replaces it through the existing flow.
            setMarketSnapshot(current => ({ ...(current ?? { unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }),
              items: [...(current?.items.filter(item => item.pluginId !== installed.pluginId) ?? []), installed] }));
          }
          setMarketDetail((current) =>
            current?.pluginId === marketDetail.pluginId ? null : current,
          );
          setSelectedId(installedGhostStoragePart(ghost));
        } else {
          await refreshVisibleMarketDetail(marketDetail.pluginId).catch(() => undefined);
        }
        await refreshMarket();
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          // 用户在确认框里取消不是失败,不留失败标记。
          if (extractIpcError(error)?.code !== 'MUTATION_CANCELLED') {
            failPluginInstallProgress(marketDetail.pluginId, t(pluginMarketErrorKey(error)));
          }
          await showPluginMarketActionError(error);
        }
      } finally {
        endPluginInstallProgress(marketDetail.pluginId);
        releaseMarketBusy(marketBusyLease);
      }
    },
    [
      acquireMarketBusy,
      ghosts,
      isMarketBusyLeaseActive,
      installMarketPackage,
      continueRecommendation,
      refreshMarket,
      refreshVisibleMarketDetail,
      releaseMarketBusy,
      setMarketSnapshot,
      showPluginMarketActionError,
      t,
    ],
  );
  const handleInstallFromMarket = useCallback(async () => {
    if (!marketDetail || !('manifest' in marketDetail) || marketDetailError || marketDetailRefreshing) return;
    const requestId = marketDetailRequestRef.current;
    const owner = contributionOwnerRef.current;
    const view = contributionView.current.token;
    const current = () => contributionMounted.current && contributionView.current.token === view && requestId === marketDetailRequestRef.current && contributionOwnerRef.current === owner && activeDetailCacheRef.current === detailCache;
    setMarketDetailRefreshing(true);
    try {
      // load joins an existing foreground read before consulting its fresh cache.
      // Installation must consume that result, never this render's old manifest.
      const detail = await detailCache.load(marketDetail.pluginId, () => window.electronAPI.pluginMarket.detail(marketDetail.pluginId));
      if (!current()) return;
      setMarketDetail(detail);
      await runMarketInstallFlow(detail);
    } catch (error) {
      if (current()) {
        if (marketDetailAccessRejected(error)) {
          const summary = marketItemSummary(marketDetail);
          setMarketDetail(summary);
        }
        setMarketDetailError(t(pluginMarketErrorKey(error)));
      }
    } finally {
      if (current()) setMarketDetailRefreshing(false);
    }
  }, [detailCache, marketDetail, marketDetailError, marketDetailRefreshing, runMarketInstallFlow, t]);
  /** 推荐卡片上的直接「安装」:先取详情,再走与详情页相同的确认+安装流。 */
  const handleInstallMarketItem = useCallback(
    async (pluginId: string) => {
      const marketBusyLease = acquireMarketBusy(pluginId);
      if (!marketBusyLease) return;
      // 点下去立刻显示「正在准备」;取到详情后安装流程按首装或替换重新起步。
      beginPluginInstallProgress(pluginId, 'install');
      let detail: PluginMarketDetail;
      try {
        detail = await window.electronAPI.pluginMarket.detail(pluginId);
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          const reason = t(pluginMarketErrorKey(error));
          failPluginInstallProgress(pluginId, reason);
          toast.error(reason);
        }
        endPluginInstallProgress(pluginId);
        releaseMarketBusy(marketBusyLease);
        return;
      }
      if (!isMarketBusyLeaseActive(marketBusyLease)) {
        endPluginInstallProgress(pluginId);
        return;
      }
      releaseMarketBusy(marketBusyLease);
      try {
        await runMarketInstallFlow(detail);
      } finally {
        // 安装流程未能开始(例如另一项操作抢先)时,不留下停在「准备」的圆环。
        endPluginInstallProgress(pluginId);
      }
    },
    [acquireMarketBusy, isMarketBusyLeaseActive, releaseMarketBusy, runMarketInstallFlow, t],
  );

  useEffect(() => {
    const id = searchParams.get('retired');
    if (!id) return;
    if (ghosts.some((ghost) => ghost.manifest.id === id && ghost.retirement)) {
      // The detached sidebar can navigate here while market details are still open/loading.
      marketDetailRequestRef.current += 1;
      setMarketDetail(null);
      setSelectedId(id);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('retired');
    setSearchParams(next, { replace: true });
  }, [ghosts, searchParams, setSearchParams]);

  useEffect(() => {
    // Market details render first; selecting a hidden notice does not make it read.
    if (marketDetail || !selectedGhost?.retirement?.unread) return;
    void window.electronAPI.ghosts
      .acknowledgeRetirement(installedGhostStoragePart(selectedGhost))
      .catch(() => toast.error(t('settings.ghosts.retirement.saveFailed')));
  }, [marketDetail, selectedGhost?.manifest.id, selectedGhost?.retirement?.unread, t]);

  const handleReplaceRetiredFeature = async () => {
    const descriptor =
      selectedGhost?.retirement && featureRetirementById(selectedGhost.retirement.id);
    const target = descriptor?.replacement;
    if (!target || !selectedGhost?.retirement?.eligible) return;
    const replacement = findInstalledRetirementReplacement(
      window.electronAPI.ghosts.listSync().ghosts,
      marketItems,
      target,
    );
    if (replacement) {
      const replacementId = installedGhostStoragePart(replacement);
      if (replacement.enabled) {
        setSelectedId(replacementId);
        handlePrimaryAction(toGhostPluginListItem(replacement));
      } else {
        const lease = acquireMarketBusy(target.marketId);
        if (!lease) return;
        try {
          await window.electronAPI.ghosts.setEnabled(
            replacementId, true, ghostInstallApprovalToken(replacement.approval),
          );
          if (isMarketBusyLeaseActive(lease)) setSelectedId(replacementId);
        } catch (error) {
          if (isMarketBusyLeaseActive(lease)) await showPluginMarketActionError(error);
        } finally {
          releaseMarketBusy(lease);
        }
      }
      return;
    }
    await handleInstallMarketItem(target.marketId);
  };

  const showMyPlugins = searchParams.has('myPlugins');
  useEffect(() => {
    if (!searchParams.has('contributionChild') && !searchParams.has('contributionTransfer')) return;
    const next = new URLSearchParams(searchParams); next.delete('contributionChild'); next.delete('contributionTransfer');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const contributionUnavailableKey = localPublishingUnavailableKey(selectedGhost, selectedMarketInstall);
  const showLocalPublishing = selectedGhost?.publishingSource?.kind === 'local' && !contributionUnavailableKey;
  useEffect(() => {
    if (showMyPlugins) { setSelectedId(null); setMarketDetail(null); }
  }, [showMyPlugins]);
  useEffect(() => { setPublicationDialog(null); }, [contributionOwner, selectedDetail?.id, showMyPlugins]);
  useEffect(() => { contributing.current = null; setContributionBusy(false); }, [contributionOwner]);

  const openMyPlugins = (pluginId?: string) => {
    if (pluginCatalogVisible) capturePluginCatalogScroll();
    setSelectedId(null); setMarketDetail(null);
    const next = new URLSearchParams(searchParams);
    next.set('myPlugins', '1'); next.delete('contributionChild'); next.delete('contributionTransfer');
    if (pluginId) next.set('contribution', pluginId); else next.delete('contribution');
    setSearchParams(next);
  };
  const preparePublication = (instanceId: string) => {
    const ghost = findInstalledGhostByInstanceId(ghosts, instanceId);
    if (!ghost || ghost.publishingSource?.kind !== 'local' ||
      localPublishingUnavailableKey(ghost, marketItemForInstalledGhost(marketItems, ghost)))
      throw new Error('Current local publishing source is unavailable');
    return window.electronAPI.pluginContributions.prepare(instanceId, {
      directory: ghost.dir, approvalToken: ghostInstallApprovalToken(ghost.approval),
    });
  };
  const contribute = async (instanceId: string, options?: PluginSubmitOptions): Promise<boolean> => {
    if (contributing.current) return false;
    if (!contributor) {
      const ghost = findInstalledGhostByInstanceId(ghosts, instanceId);
      if (!ghost || localPublishingUnavailableKey(ghost) || ghost.publishingSource?.kind !== 'local') return false;
      const nonce = rememberContributionIntent(ghost);
      const next = new URLSearchParams(searchParams); next.set('myPlugins', '1'); next.set('contributionIntent', nonce);
      setSearchParams(next);
      if (mode !== 'cloud') {
        await signInForContribution();
        navigate('/login', { replace: true, state: { returnTo: `/plugins?${next}` } });
      }
      return false;
    }
    const owner = contributionOwner;
    const submittedFrom = contributionView.current.token;
    const stillHere = () => contributionMounted.current && contributionOwnerRef.current === owner &&
      contributionView.current.token === submittedFrom && (options?.isCurrent?.() ?? true);
    contributing.current = owner;
    setContributionBusy(true);
    let preparedId: string | undefined;
    try {
      const clicked = findInstalledGhostByInstanceId(ghosts, instanceId);
      if (!clicked) throw new Error('Original installed plugin is unavailable');
      if (clicked.publishingSource?.kind !== 'local' || localPublishingUnavailableKey(clicked, marketItemForInstalledGhost(marketItems, clicked)))
        throw new Error('Current publishing source or permission is unavailable');
      const prepared = options?.prepared ?? await preparePublication(instanceId);
      if (prepared.instanceId !== instanceId) throw new Error('Original installed plugin changed');
      preparedId = prepared.preparedId;
      if (contributionOwnerRef.current !== owner) return false;
      let result = await window.electronAPI.pluginContributions.submit(prepared.preparedId);
      preparedId = undefined;
      // Keep upload bookkeeping inside this submit action. Only a confirmed
      // server submission belongs in My Plugins; HTTP 202 is still submitting.
      while (result.stage !== 'complete') {
        if (!contributionMounted.current || contributionOwnerRef.current !== owner) return false;
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        if (!contributionMounted.current || contributionOwnerRef.current !== owner) return false;
        result = await window.electronAPI.pluginContributions.status(result.localId);
      }
      if (!contributionMounted.current || contributionOwnerRef.current !== owner) return false;
      if (result.operation?.status !== 'succeeded' || !result.operation.receipt) {
        toast.error(t(`settings.ghosts.contribution.errors.${result.operation?.failure?.code ?? result.errorCode ?? 'INTERNAL'}`, {
          defaultValue: t('settings.ghosts.contribution.submitFailed'),
        }));
        return false;
      }
      contributionCache.current.page = null; contributionCache.current.detail = null;
      setSubmissionRevision(value => value + 1);
      if (stillHere() && (!showMyPlugins || searchParams.get('contribution') !== result.operation.receipt.pluginId))
        openMyPlugins(result.operation.receipt.pluginId);
      return true;
    } catch (error) {
      if (contributionOwnerRef.current === owner) { toast.error(t(contributionErrorKey(error), { defaultValue: t('settings.ghosts.contribution.loadFailed') })); }
      return false;
    } finally {
      if (preparedId && contributionOwnerRef.current === owner) void window.electronAPI.pluginContributions.discard(preparedId).catch(() => undefined);
      if (contributionOwnerRef.current === owner && contributing.current === owner) { contributing.current = null; setContributionBusy(false); }
    }
  };

  useEffect(() => {
    const nonce = searchParams.get('contributionIntent');
    if (!nonce || !contributor) return;
    const target = consumeContributionIntent(nonce);
    const next = new URLSearchParams(searchParams); next.delete('contributionIntent');
    setSearchParams(next, { replace: true });
    if (!target) return;
    const matches = ghosts.filter((ghost) => matchesContributionIntent(target, ghost));
    if (matches.length === 1) {
      // Login returns to the exact local detail so the actual package summary is read first.
      next.delete('myPlugins'); next.delete('contribution'); next.delete('contributionChild');
      setSelectedId(installedGhostStoragePart(matches[0]));
      setMarketDetail(null);
      setSearchParams(next, { replace: true });
    }
    else toast.error(t('settings.ghosts.contribution.installForAccount'));
  }, [searchParams, contributor, contributionOwner, ghosts]);

  const publishingInstalledRevision = JSON.stringify([installedGhostMarketKey, installedGhostLocationsKey,
    ghosts.map(ghost => [installedGhostStoragePart(ghost), ghostInstallApprovalToken(ghost.approval), ghost.publishingSource])]);
  const publicationDialogView = publicationDialog && publicationDialog.owner === contributionOwner && publicationDialog.instanceId === selectedDetail?.id ? (
    <PluginPublishDialog
      key={publicationDialog.id}
      open={publicationDialog.open}
      ownerKey={contributionOwner}
      initialInstanceId={publicationDialog.instanceId}
      reader={window.electronAPI.pluginContributions}
      localPlugins={publishableInstalledItems}
      installedPluginCount={allInstalledItems.length}
      onPrepare={preparePublication}
      onSubmitUpdate={contribute}
      submitBusy={contributionBusy}
      installedRevision={publishingInstalledRevision}
      submissionRevision={submissionRevision}
      onOpenChange={open => setPublicationDialog(current => current?.id === publicationDialog.id ? { ...current, open } : current)}
      onClosed={() => setPublicationDialog(current => current?.id === publicationDialog.id && !current.open ? null : current)}
    />
  ) : null;

  // 面板收束:aside 只挂在插件页语境里(列表/详情/市场详情共用),
  // 路由离开本页组件整体卸载 → webview 一并回收,绝不残留到别的界面。
  const panelAside = openPanelGhost ? (
    // key 纳入 owner 代际:双保险。即便将来某条路径漏了上面的清空,换身份也会
    // 强制卸载重建宿主(webview 连同它的 DOM/内存态一起丢),不会跨账号复用。
    <GhostPagePanelHost
      key={`${panelOwnerKey}:${installedGhostStoragePart(openPanelGhost)}`}
      ghost={openPanelGhost}
      onClose={() => setOpenPanelId(null)}
    />
  ) : null;


  const relatedCatalog: PluginRelatedCatalog = {
    cache: relatedCache, ownerKey: catalogOwnerKey, catalogKey: marketLocale, local: true,
    loadPage: window.electronAPI.pluginMarket.query, liveItems: marketSnapshot?.items,
    installedGhosts: ghosts, iconCache: catalogMemory.marketIcons, online: catalogOnline,
  };
  const backFromInstalledDetail = () => {
    requestPluginCatalogScrollRestore();
    setSelectedId(null);
  };

  if (showMyPlugins) return <MyPluginsPage
    key={contributionOwner}
    cache={contributionCache.current}
    reader={window.electronAPI.pluginContributions}
    localPlugins={publishableInstalledItems}
    installedPluginCount={allInstalledItems.length}
    onPrepare={preparePublication}
    installedRevision={publishingInstalledRevision}
    onReadPublished={window.electronAPI.pluginMarket.detail}
    submitBusy={contributionBusy}
    submissionRevision={submissionRevision}
    onSubmitUpdate={contribute}
    onViewLocal={() => {
      const next = new URLSearchParams(searchParams); next.delete('myPlugins'); next.delete('contribution'); next.delete('contributionChild'); next.delete('contributionTransfer');
      requestPluginCatalogScrollRestore();
      setSelectedId(null); setMarketDetail(null); setSearchParams(next, { replace: true });
    }}
  />;


  if (marketDetail) return (
    <PluginCatalogView aside={panelAside} notice={recommendationNotice} detail={{ market: {
      detail: marketDetail,
      error: marketDetailError,
      refreshing: marketDetailRefreshing,
      onRetry: () => void handleSelectMarket(marketDetail, false, 'detail'),
      busy: marketBusyId === marketDetail.pluginId,
      showInstallProgress: true,
      onBack: handleMarketBack,
      backLabel: relatedMarketTrail.current.items.length ? t('settings.back') : undefined,
      relatedCatalog,
      onOpenRelated: item => {
        if (marketBusyLockRef.current) return;
        relatedMarketTrail.current.items.push(marketItemSummary(marketDetail));
        void handleSelectMarket(item, false, 'detail');
      },
      onInstall: canOfferMarketInstall(mode, marketDetail.ghostId) ? handleInstallFromMarket : undefined,
      onIconLoadError: handleMarketIconLoadError,
    } }} />
  );

  if (selectedGhost?.retirement) {
    const target = featureRetirementById(selectedGhost.retirement.id)?.replacement;
    return (
      <RetiredFeatureDetail
        ghost={selectedGhost}
        replacement={findInstalledRetirementReplacement(ghosts, marketItems, target)}
        busy={marketBusyId !== null}
        onBack={backFromInstalledDetail}
        onReplace={() => void handleReplaceRetiredFeature()}
        onDismiss={() => {
          void window.electronAPI.ghosts
            .acknowledgeRetirement(installedGhostStoragePart(selectedGhost))
            .then(backFromInstalledDetail)
            .catch(() => toast.error(t('settings.ghosts.retirement.saveFailed')));
        }}
        onUninstall={() => void handleUninstall()}
      />
    );
  }

  if (selectedDetail) return (
    <PluginCatalogView aside={panelAside} notice={recommendationNotice} overlay={publicationDialogView} detail={{ installed: {
      ghost: selectedGhost,
      sharePluginId: selectedMarketInstall?.sourceType === 'server' && selectedMarketInstall.scope === 'public' ? selectedMarketInstall.pluginId : undefined,
      detail: selectedDetail,
      marketItem: selectedMarketInstall,
      installationPending: selectedMarketInstall !== null && marketInstallBusyId === selectedMarketInstall.pluginId,
      panelStatus,
      enabledOverride: selectedGhost ? effectiveEnabled(installedGhostStoragePart(selectedGhost), selectedGhost.enabled) : undefined,
      backLabel: relatedMarketTrail.current.items.length ? t('settings.back') : undefined,
      onBack: () => {
        if (relatedMarketTrail.current.items.length) {
          setSelectedId(null);
          handleMarketBack();
        } else {
          cancelPendingPluginSuggestion(recommendationNonce ?? undefined);
          backFromInstalledDetail();
        }
      },
      relatedCatalog,
      onOpenRelated: item => {
        if (marketBusyLockRef.current) return;
        relatedMarketTrail.current.items.push({ installedId: selectedDetail.id });
        setSelectedId(null);
        void handleSelectMarket(item, false, 'detail');
      },
      onToggle: enabled => void handleToggle(selectedDetail.id, enabled, selectedDetail.name),
      onUse: handleUse,
      mainViewSidebarVisible: selectedMainViewSidebarVisible,
      onMainViewSidebarVisibleChange: handleMainViewSidebarVisibleChange,
      onUpdate: () => void handleUpdate(),
      onUpdateFromFile: () => void handleUpdateFromFile(),
      onReapprove: () => void handleRecoverInstall(selectedDetail.id),
      updateVersion: selectedMarketUpdate?.version,
      updateNotes,
      releaseUpdates,
      updateBusy: (selectedMarketUpdate !== null && marketBusyId !== null) || batchRunning,
      onUninstall: () => void handleUninstall(),
      onExport: selectedGhost ? () => void handleExport() : undefined,
      onContribute: !showLocalPublishing ? undefined : () => {
        if (!contributor) { void contribute(selectedDetail.id); return; }
        setPublicationDialog({
          id: ++publicationDialogSequence.current, owner: contributionOwner, open: true, instanceId: selectedDetail.id,
        });
      },
      contributionUnavailableReason: contributionUnavailableKey === 'officialGithubRequired' || (contributionUnavailableKey === 'reservedId' && selectedGhost?.publishingSource?.kind === 'public-market')
        ? t(`settings.ghosts.contribution.unavailable.${contributionUnavailableKey}`)
        : selectedGhost?.publishingSource?.kind === 'local' && contributionUnavailableKey
          ? t(`settings.ghosts.contribution.unavailable.${contributionUnavailableKey}`) : undefined,
      contributionBusy,
      toggleDisabled: scopeDir !== null && selectedGhost !== null && !selectedGhost.enabled,
      onIconLoadError: handleMarketIconLoadError,
    } }} />
  );

  const unreadReviewTone = reviewUnread.length === 0
    ? undefined
    : reviewUnread.some(item => item.status !== 'approved' && item.status !== 'enabled') ? 'error' : 'done';

  return (
    <PluginCatalogView
      aside={panelAside}
      overlay={<>
        {githubInstallOwner === contributionOwner && (
          <InstallGithubReleaseDialog
            key={contributionOwner}
            onClose={() => setGithubInstallOwner(null)}
            onInstalled={(id) => {
              if (contributionOwnerRef.current !== contributionOwner) return;
              setOpenPanelId(null);
              setSelectedId(id);
              setGithubInstallOwner(null);
            }}
          />
        )}
        <AddMarketplaceDialog
          open={addMarketplaceOpen}
          onOpenChange={setAddMarketplaceOpen}
          onSourcesChanged={() => { setCatalogRevision(value => value + 1); void refreshMarket(); }}
        />
        {updateRows ? (
          <UpdateAllDialog
            open={updateDialogOpen}
            rows={updateRows}
            iconByGhostId={new Map(ghosts.map((ghost) => [ghost.manifest.id, ghost.iconDataUrl]))}
            onClose={() => setUpdateDialogOpen(false)}
          />
        ) : null}
      </>}
      catalog={{
        embedded,
        onSelectCatalogTab,
        query,
        onQueryChange: setQuery,
        scrollRef: pluginCatalogListRef,
        onScroll: onPluginCatalogScroll,
        tabsRef: secondaryTabs,
        tab: catalogTab,
        onSelectTab: setCatalogTab,
        target: {
          computer: deviceControl,
          projectLabel: scopeDir ? basename(scopeDir) : undefined,
          project: <PluginProjectMenu
            scopeDir={scopeDir}
            activeSessionWorkingDir={activeSessionWorkingDir ?? undefined}
            recentWorkdirs={recentWorkdirs}
            onPick={handlePickScope}
          />,
        },
        notice: recommendationNotice,
        publication: { onClick: () => openMyPlugins(), unreadTone: unreadReviewTone },
        headerActions: <GhostPluginActions
          onInstall={() => void handleInstall()}
          onInstallGithubRelease={() => setGithubInstallOwner(contributionOwner)}
          onCreateWithCindy={handleCreateWithCindy}
          onAddMarketplace={() => setAddMarketplaceOpen(true)}
        />,
        wrapSections: sections => (
          <MyPublishesSectionVisibilityGate
            visible={SHOW_MY_PUBLISHES_SECTION && showEnterprise}
            overviewLabel={t('settings.ghosts.page.overviewTab')}
            publishesLabel={t('settings.ghosts.publish.section')}
            tabsAriaLabel={t('settings.ghosts.page.secondaryTabsAria')}
            publishes={<MyPublishesSection enabled={showEnterprise} onPublish={() => void handlePublish()} />}
          >
            {sections}
          </MyPublishesSectionVisibilityGate>
        ),
        recommendations: !todayLoaded || todayItems.length === 3 ? {
          loading: !todayLoaded,
          items: todayItems,
          order: catalogMemory.recommendationOrder,
          shuffle: {
            title: t('settings.ghosts.page.todayRecommendations'),
            label: t('newChat.homeSuggestions.shuffle'),
            candidates: todayCandidates,
            onChange: setRecommendationBatch,
          },
          active,
          busy: todayItems.some(item => item.pluginId === marketBusyId || item.pluginId === marketInstallBusyId),
          trackInstallProgress: true,
          renderItem: (item, featured, deck) => <MarketPluginCard compact featured={featured} item={item}
            recommendationDeck={deck} busy={marketBusyId !== null} pending={marketInstallBusyId === item.pluginId} showInstallProgress
            onSelect={() => void handleSelectMarket(item)}
            onPrefetch={isCurrent => prefetchMarketDetail(item, isCurrent)}
            onInstall={canOfferMarketInstall(mode, item.ghostId) ? () => void handleInstallMarketItem(item.pluginId) : undefined}
            onIconLoadError={handleCardIconLoadError} />,
        } : undefined,
        scopeNotice: scopeDir ? (
          <CatalogManagementNotice
            title={t('settings.ghosts.projectBanner.title', { name: basename(scopeDir) })}
            action={
              <Button
                variant="secondary"
                tone="quiet"
                size="sm"
                compact
                onClick={() => handlePickScope(null)}
              >
                {t('settings.ghosts.projectBanner.backToGlobal')}
              </Button>
            }
          >
            {t('settings.ghosts.projectBanner.desc', {
              device: t('settings.ghosts.remote.thisComputer'),
            })}
          </CatalogManagementNotice>
        ) : undefined,
        installedTotal: installedItems.length,
        installedCount: searchedInstalledItems.length,
        installedNotice: <>
          {legacyRecoveryStatus ? (
            <LegacyGhostRecoveryNotice
              status={legacyRecoveryStatus}
              retrying={legacyRecoveryRetrying}
              onRetry={() => void handleRetryLegacyRecovery()}
            />
          ) : null}

          {bannerVisible && !query.trim() ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-[var(--surface-hover-soft)] px-4 py-2.5">
              <span className="plugin-update-icons flex shrink-0 gap-1.5" aria-hidden="true">
                {updatableInstalledItems.slice(0, 5).map(item => (
                  <span key={item.id} className="size-6"><GhostPluginIcon size="mini" iconId={item.id} iconName={item.name} iconDataUrl={item.iconDataUrl} /></span>
                ))}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-13 font-medium text-[var(--text-primary)]">
                  {t('settings.ghosts.page.updatesAvailable', {
                    count: updatableInstalledItems.length,
                  })}
                </p>
                <p className="sr-only">
                  {updatableInstalledItems
                    .map((item) => `${item.name} v${item.marketUpdate?.version ?? item.githubUpdate?.version ?? ''}`)
                    .join(' · ')}
                </p>
              </div>
                <Button
                  variant="secondary"
                  size="sm"
                  tone="quiet"
                  compact
                type="button"
                onClick={handleIgnoreRound}
                  className="shrink-0"
              >
                {t('settings.ghosts.page.ignoreRound')}
                </Button>
                {/* 单项更新在飞时禁用:与 handleUpdateAll 的守卫同因,按钮如实变灰。 */}
                <Button
                  variant="cta"
                  size="sm"
                  compact
                  loading={marketInstallBusyId !== null}
                type="button"
                onClick={handleUpdateAll}
                disabled={marketBusyId !== null}
                  className="shrink-0"
              >
                {t('settings.ghosts.page.updateAll')}
                </Button>
            </div>
          ) : null}
        </>,
        installedSentinel: primaryInstalledItems.length > 0 ? installedSentinel : undefined,
        installedGrid: primaryInstalledItems.length > 0 ? {
          count: primaryInstalledItems.length,
          cache: installedGridCache,
          renderItem: index => {
            const item = primaryInstalledItems[index]!;
            return (
              <GhostPluginCard
                key={item.id}
                item={item}
                sourceLabel={item.origin ? t(`settings.ghosts.page.origin.${item.origin}`) : undefined}
                marketItem={item.marketItem}
                author={item.author}
                updateVersion={item.marketUpdate?.version ?? item.githubUpdate?.version}
                updateBusy={
                  ((item.marketUpdate !== null || item.githubUpdate !== null) && marketBusyId !== null) ||
                  batchRunning
                }
                updatePending={
                  item.githubUpdate
                    ? githubUpdateKey(item.githubUpdate.instanceId) === marketInstallBusyId
                    : item.marketUpdate?.pluginId === marketInstallBusyId
                }
                updateProgressKey={
                  item.githubUpdate ? githubUpdateKey(item.githubUpdate.instanceId) : undefined
                }
                onUpdate={
                  item.marketUpdate
                    ? () => void handleMarketUpdate(item.id)
                    : item.githubUpdate
                      ? () => void handleGithubUpdate(item.githubUpdate!)
                      : undefined
                }
                onReapprove={() => void handleRecoverInstall(item.id)}
                effectiveEnabled={effectiveEnabled(item.id, item.enabled)}
                onPrimary={() => handlePrimaryAction(item)}
                onManage={() => { capturePluginCatalogScroll(`installed:${item.id}`); setSelectedId(item.id); }}
                onIconLoadError={handleMarketIconLoadError}
              />
            );
          },
        } : undefined,
        installedEmpty: primaryInstalledItems.length === 0 && !legacyRecoveryStatus && installedItems.length > 0 ? (
          <div className="rounded-xl border-[0.5px] border-[var(--border-default)] px-5 py-10 text-center">
            <p className="text-13 text-[var(--text-secondary)]">{t('settings.ghosts.page.emptyFiltered')}</p>
          </div>
        ) : undefined,
        market: {
          cacheRef: browserCache,
          ownerKey: catalogOwnerKey,
          iconCache: catalogMemory.marketIcons,
          prewarm: active && marketSnapshot !== null,
          catalogKey: marketLocale,
          revision: catalogDataRevision,
          installedItems: marketSnapshot?.items,
          installedGhosts: ghosts,
          scope: catalogTab === 'installed' && !query.trim() ? 'official' : effectiveOriginFilter,
          onScope: setOriginFilter,
          showOrganization: showEnterprise,
          visible: active && (!!query.trim() || catalogTab === 'market'),
          loadPage: window.electronAPI.pluginMarket.query,
          online: catalogOnline,
          renderRevision: marketBusyId,
          onCounts: counts => { if (!query.trim()) setMarketTotal(counts?.all ?? null); },
          total: marketTotal,
          renderPublicPreview: showInstalledEmpty ? publicItems => {
            const icons = publicItems.filter(item => publicPublisherFilter(item) === 'official').slice(0, 3);
            return (
              <div className="plugin-installed-empty px-5 text-center">
                {icons.length > 0 ? (
                  <div className="mb-7 flex justify-center gap-3.5 [&>span]:size-14" aria-hidden="true">
                    {icons.map(item => (
                      <GhostPluginIcon key={item.pluginId} size="detail"
                        iconId={item.ghostId} iconName={item.name}
                        iconDataUrl={ghostPluginIconSource(item.icon?.url, item.icon?.sha256)}
                        onIconLoadError={handleMarketIconLoadError} />
                    ))}
                  </div>
                ) : null}
                <h2 className="text-18 font-medium text-[var(--text-primary)]">{t('settings.ghosts.empty')}</h2>
                <p className="mt-2 text-14 text-[var(--text-secondary)]">{t('settings.ghosts.emptyHint')}</p>
                <Button className="mt-5" variant="cta" size="lg"
                  onClick={() => {
                    setQuery('');
                    setOriginFilter('official');
                    setCatalogTab('market');
                  }}>
                  {t('settings.ghosts.page.browseMarket')}
                </Button>
              </div>
            );
          } : undefined,
          renderItem: (item, metric) => <MarketPluginCard key={item.pluginId} item={item} metric={metric}
            busy={marketBusyId !== null} pending={marketInstallBusyId === item.pluginId} showInstallProgress
            onSelect={() => void handleSelectMarket(item)}
            onPrefetch={isCurrent => prefetchMarketDetail(item, isCurrent)}
            onInstall={canOfferMarketInstall(mode, item.ghostId) && item.installState !== 'installed' && item.installState !== 'update-available'
              ? () => void handleInstallMarketItem(item.pluginId) : undefined}
            onIconLoadError={handleCardIconLoadError} />,
        },
      }}
    />
  );
}

export function LegacyGhostRecoveryNotice({
  status,
  retrying,
  onRetry,
}: {
  status: LegacyGhostRecoveryStatus;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status.state === 'none') return null;
  const messageKey =
    status.state === 'claimed-by-other-owner'
      ? 'settings.ghosts.legacyRecovery.claimedByOtherOwner'
      : status.state === 'partial' || status.canRetry
        ? status.canRetry
          ? 'settings.ghosts.legacyRecovery.partial'
          : 'settings.ghosts.legacyRecovery.partialBlocked'
        : 'settings.ghosts.legacyRecovery.deferred';
  return (
    <div className="rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-6 text-left">
      <p className="text-14 font-medium text-[var(--text-primary)]">
        {t('settings.ghosts.legacyRecovery.title')}
      </p>
      <p className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">
        {t(messageKey, { count: status.legacyPluginCount })}
      </p>
      {status.canRetry ? (
        <Button
          variant="secondary"
          size="lg"
          loading={retrying}
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4"
        >
          {t('settings.ghosts.legacyRecovery.retry')}
        </Button>
      ) : null}
    </div>
  );
}

function MarketRecommendationFace({
  item, featured, layer, moving, metadataId, metadata, detailButton, actions, onIconLoadError,
}: {
  item: PluginMarketItem;
  featured: boolean;
  layer?: 'current' | 'outgoing';
  moving: boolean;
  metadataId: string;
  metadata: ReactNode;
  detailButton?: ReactNode;
  actions?: ReactNode;
  onIconLoadError: () => void;
}) {
  const { t } = useTranslation();
  const icon = usePluginMarketIcon(item, { deferUntilVisible: false });
  const origin = pluginPresentationOrigin(item);
  const publisherFilter = publicPublisherFilter(item);
  return <div className="plugin-recommendation-face" data-recommendation-layer={layer}
    hidden={!layer} inert={moving || undefined} aria-hidden={layer !== 'current' || undefined}>
    {detailButton}
    <div className="plugin-recommendation-head pointer-events-none flex min-w-0 items-center gap-3">
      <GhostPluginIcon size={featured ? 'detail' : 'sm'} iconContainerRef={icon.containerRef} iconDataUrl={icon.iconDataUrl}
        iconId={item.ghostId} iconName={item.name} officialCatalog={publisherFilter === 'official'} onIconLoad={icon.onIconLoad}
        onIconLoadError={() => icon.onIconLoadError(onIconLoadError)} />
      {layer ? <div className="plugin-recommendation-content min-w-0 flex-1">
        <div className="plugin-catalog-name-group flex min-w-0 items-center gap-2">
          <p className={cn('plugin-catalog-name font-medium text-[var(--text-primary)]', featured ? 'text-20' : 'text-15')} title={item.name}>{item.name}</p>
          <PluginPublisherBadge origin={origin} kind={item.publisherKind}
            sourceLabel={origin === 'public' && publisherFilter === null ? t('mcpApps.source.market') : undefined} />
        </div>
        {layer === 'current' ? <div className="sr-only">{metadata}</div> : null}
      </div> : null}
    </div>
    {layer ? <p id={layer === 'current' ? metadataId : undefined}
      className={cn('plugin-recommendation-description pointer-events-none text-pretty text-[var(--text-secondary)]', featured ? 'line-clamp-3 text-16 leading-relaxed' : 'line-clamp-2 text-13 leading-[1.54]')}>{item.description || item.ghostId}</p> : null}
    {layer ? <div className="plugin-recommendation-actions flex min-w-0 items-center gap-3">{actions}</div> : null}
  </div>;
}

// A virtual row can remount before the visibility observer runs. Reuse icons
// that painted successfully while their current catalog metadata stays alive.
const loadedMarketRowIcons = new WeakMap<NonNullable<PluginMarketItem['icon']>, string>();

export function MarketPluginCard({
  item,
  compact = false,
  featured = false,
  recommendationDeck,
  metric,
  busy,
  pending = false,
  showInstallProgress = false,
  onSelect,
  onPrefetch,
  onInstall,
  onIconLoadError,
}: {
  item: PluginMarketItem;
  compact?: boolean;
  featured?: boolean;
  recommendationDeck?: PluginRecommendationDeck;
  metric?: PluginMarketRowMetric | null;
  busy: boolean;
  /** 本卡正在安装:主按钮换成 Spinner。 */
  pending?: boolean;
  /**
   * 本窗口发起的安装在卡片上原位显示圆环进度。只有本机插件页开启;远程设备页的卡片
   * 与本机的安装无关,保持按钮运行态。
   */
  showInstallProgress?: boolean;
  onSelect: () => void;
  onPrefetch?: (isCurrent: () => boolean) => void;
  /** 卡片直接安装；卡片正文、右侧空白与右上角箭头都进入详情。 */
  onInstall?: () => void;
  onIconLoadError(item: PluginMarketItem): void;
}) {
  const { t, i18n } = useTranslation();
  const metadataId = useId();
  const sortMetric = !compact && metric && item.sourceType === 'server'
    ? formatPluginMarketMetric(metric, item.sortValue, i18n.language)
    : null;
  const MetricIcon = metric?.icon === 'download' ? ArrowDownToLine : Activity;
  const marketIcon = usePluginMarketIcon(item, { deferUntilVisible: true });
  const rowIcon = !compact && item.sourceType === 'server' ? item.icon : undefined;
  const loadedIconUrl = rowIcon && loadedMarketRowIcons.get(rowIcon);
  const rowIconUrl = loadedIconUrl ?? marketIcon.iconDataUrl;
  const origin = pluginPresentationOrigin(item);
  const author = pluginPresentationAuthor(item);
  const unavailable = busy;
  const installProgress = usePluginInstallProgress(showInstallProgress ? item.pluginId : null);
  const installFailed = installProgress?.download.phase === 'failed';
  const installed = item.installState === 'installed' || item.installState === 'update-available';
  const installOffered = Boolean(onInstall) && !installed;
  // 失败的圆环只陪着还在的安装按钮出现,按钮此时变「重试」。
  const installRing = (compact || !installed) && installProgress && (!installFailed || installOffered) ? installProgress : null;
  // 安装圆环与操作按钮占同一格,卡片宽度不变。
  const installRingCovers = installRing !== null && !installFailed;
  const installLabel = t('settings.ghosts.page.installAria', { name: item.name });
  const replacementDescriptionId = useId();
  const replacementDescription =
    item.installState === 'conflict' ? t('settings.ghosts.market.replaceDescription') : undefined;
  const prefetchRef = useRef(onPrefetch);
  prefetchRef.current = onPrefetch;
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchGeneration = useRef(0);
  const cancelPrefetch = useCallback(() => {
    prefetchGeneration.current += 1;
    if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  }, []);
  const schedulePrefetch = useCallback(() => {
    cancelPrefetch();
    const generation = prefetchGeneration.current;
    prefetchTimer.current = setTimeout(() => { prefetchRef.current?.(() => prefetchGeneration.current === generation); }, 250);
  }, [cancelPrefetch]);
  useEffect(() => cancelPrefetch, [cancelPrefetch]);
  const prefetchEvents = {
    onPointerEnter: schedulePrefetch,
    onPointerLeave: cancelPrefetch,
    onFocusCapture: schedulePrefetch,
    onBlurCapture: cancelPrefetch,
  };
  const publisherFilter = publicPublisherFilter(item);
  const showOrigin = publisherFilter === null;
  const sourceMark = <PluginPublisherBadge origin={origin} kind={item.publisherKind}
    sourceLabel={origin === 'public' && showOrigin ? t('mcpApps.source.market') : undefined} />;
  const metadata = <>
    {showOrigin && origin !== 'public' ? <span className="shrink-0">{t(`settings.ghosts.page.origin.${origin}`)}</span> : null}
    {showOrigin && origin !== 'public' && author ? <span aria-hidden="true">·</span> : null}
    {author ? <span className="min-w-0 max-w-[120px] truncate">{author}</span> : null}
    {compact ? <PluginSharedUsage detail={item} variant="list" leadingSeparator={showOrigin || Boolean(author)}
      onClick={!unavailable ? onSelect : undefined} /> : null}
    {sortMetric ? <span>{' '}{sortMetric.label}</span> : null}
  </>;
  const faceControls = compact ? {
    pluginId: item.pluginId,
    detailButton: <button type="button" className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      disabled={unavailable} onClick={onSelect} aria-label={item.name} aria-describedby={metadataId} />,
    actions: onInstall || installRing ? (
      <span className={cn('pointer-events-auto relative z-[1] min-h-7 shrink-0 items-center justify-items-end gap-1.5', installFailed ? 'flex' : 'grid')}>
        {installRing ? (
          <PluginInstallRing label={installLabel} progress={installRing} className="col-start-1 row-start-1" />
        ) : null}
        {onInstall && installFailed ? (
          <CardRetryButton size="sm" label={installLabel} disabled={unavailable} onClick={onInstall} />
        ) : onInstall ? <Button className={cn('col-start-1 row-start-1 shrink-0', installRingCovers && 'invisible')} variant={featured ? "cta" : "primary"} size={featured ? "lg" : "sm"} compact
          loading={pending && !installRing} disabled={unavailable || installRingCovers} onClick={onInstall}
          aria-hidden={installRingCovers || undefined}
          aria-label={installLabel}>{t('settings.ghosts.market.install')}</Button> : null}
      </span>
    ) : null,
  } : undefined;
  const outgoingId = recommendationDeck?.outgoingId;
  const settledControls = useRef<typeof faceControls>(undefined);
  useLayoutEffect(() => {
    if (!outgoingId) settledControls.current = faceControls;
  }, [faceControls, outgoingId]);
  if (compact) return <article {...prefetchEvents} className="plugin-recommendation-card relative min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
    data-featured={featured} data-recommendation-id={item.pluginId}>
    {(recommendationDeck?.items ?? [item]).map(candidate => {
      const layer = candidate.pluginId === item.pluginId ? 'current' : candidate.pluginId === outgoingId ? 'outgoing' : undefined;
      const controls = layer === 'current' ? faceControls
        : layer === 'outgoing' && settledControls.current?.pluginId === outgoingId ? settledControls.current : undefined;
      return <MarketRecommendationFace key={candidate.pluginId} item={candidate} featured={featured}
        layer={layer} moving={Boolean(outgoingId)} metadata={metadata} metadataId={metadataId}
        detailButton={controls?.detailButton} actions={controls?.actions}
        onIconLoadError={() => onIconLoadError(candidate)} />;
    })}
  </article>;
  const installedStatusId = `${metadataId}-installed`;
  return (
    <article
      {...prefetchEvents}
      className={cn(
        'plugin-catalog-row group flex w-full select-none items-center gap-4 rounded-xl px-3.5 py-3 text-left',
        'transition-colors hover:bg-[var(--surface-hover-soft)] focus-within:bg-[var(--surface-hover-soft)] motion-reduce:transition-none',
        installed && 'relative',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={unavailable}
        aria-label={item.name}
        aria-describedby={cn(metadataId, replacementDescription && replacementDescriptionId, installed && installedStatusId)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-4 self-stretch text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          installed && 'after:absolute after:inset-0',
          unavailable ? 'cursor-wait' : 'cursor-pointer',
        )}
      >
        <GhostPluginIcon
          iconContainerRef={marketIcon.containerRef}
          iconDataUrl={rowIconUrl}
          iconId={item.ghostId}
          iconName={item.name}
          officialCatalog={publisherFilter === 'official'}
          onIconLoad={() => {
            marketIcon.onIconLoad();
            if (rowIcon && rowIconUrl) loadedMarketRowIcons.set(rowIcon, rowIconUrl);
          }}
          onIconLoadError={() => {
            if (rowIcon) loadedMarketRowIcons.delete(rowIcon);
            if (loadedIconUrl && loadedIconUrl !== rowIcon?.thumbnailUrl) {
              // This is already the full icon, so refresh it as a full-source failure.
              onIconLoadError(item);
            } else {
              marketIcon.onIconLoadError(() => onIconLoadError(item));
            }
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
          <span className="plugin-catalog-name-group plugin-market-row-name-group flex min-w-0 items-center gap-2">
            <span className="plugin-catalog-name truncate text-15 font-medium text-[var(--text-primary)]" title={item.name}>{item.name}</span>
            <span className="plugin-market-row-facts contents">
              {sourceMark}
              {metric === undefined ? (
                <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                  <PluginSharedUsage detail={item} variant="list" leadingSeparator={false} />
                </span>
              ) : sortMetric ? (
                <Tip text={sortMetric.label}>
                  <span role="group" aria-label={sortMetric.label} className="inline-flex shrink-0 items-center gap-1 text-12 tabular-nums text-[var(--text-tertiary)]">
                    {metric?.kind === 'count' ? <MetricIcon size={12} className="shrink-0" aria-hidden="true" /> : null}
                    <span aria-hidden="true">{sortMetric.text}</span>
                  </span>
                </Tip>
              ) : null}
            </span>
          </span>
          <span id={metadataId} className="sr-only">{metadata}</span>
          <span
            id={replacementDescription ? replacementDescriptionId : undefined}
            className="mt-0.5 truncate text-13 leading-5 text-[var(--text-secondary)]"
            title={replacementDescription ?? (item.description || item.ghostId)}
          >
            {replacementDescription ?? (item.description || item.ghostId)}
          </span>
        </span>
        {installed ? (
          <span id={installedStatusId} className="shrink-0 whitespace-nowrap px-2 text-13 text-[var(--text-tertiary)]">
            {t('settings.ghosts.page.installedSection')}
          </span>
        ) : null}
      </button>
      {installed ? null : <div className="relative flex min-w-8 shrink-0 items-center justify-end">
        <button
          type="button"
          onClick={onSelect}
          disabled={unavailable}
          aria-label={t('settings.ghosts.market.detailsAria', { name: item.name })}
          aria-describedby={replacementDescription ? replacementDescriptionId : undefined}
          className={cn(
            'group/market-details flex items-center justify-end rounded-xl text-[var(--text-tertiary)]',
            (onInstall || installRing) && 'sr-only focus:not-sr-only focus:absolute focus:right-full',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full',
              'transition-[background-color,color,transform] duration-150 group-hover/market-details:bg-[var(--surface-hover-soft)] group-hover/market-details:text-[var(--text-primary)] group-active/market-details:scale-[0.96]',
            )}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </button>
        <span className={cn('relative z-[1] min-h-8 items-center justify-items-end gap-1.5', installFailed ? 'flex' : 'grid')}>
          {installRing ? (
            <PluginInstallRing label={installLabel} progress={installRing} className="col-start-1 row-start-1" />
          ) : null}
          {onInstall && installFailed ? (
            <CardRetryButton
              size="md"
              label={item.installState === 'conflict' ? t('settings.ghosts.market.replaceAria', { name: item.name }) : installLabel}
              disabled={unavailable}
              onClick={(event) => {
                event.stopPropagation();
                onInstall();
              }}
            />
          ) : onInstall ? (
            <Button
              variant="primary"
              size="sm"
              compact
              loading={pending && !installRing}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onInstall();
              }}
              disabled={unavailable || installRingCovers}
              aria-busy={pending || undefined}
              aria-hidden={installRingCovers || undefined}
              aria-label={
                item.installState === 'conflict'
                  ? t('settings.ghosts.market.replaceAria', { name: item.name })
                  : installLabel
              }
              aria-describedby={replacementDescription ? replacementDescriptionId : undefined}
              className={cn('col-start-1 row-start-1 shrink-0', installRingCovers && 'invisible')}
            >
              {t(
                item.installState === 'conflict'
                  ? 'settings.ghosts.market.replace'
                  : 'settings.ghosts.market.install',
              )}
            </Button>
          ) : null}
        </span>
      </div>}
    </article>
  );
}

/**
 * 已安装插件卡片(设计定稿):
 * - 整卡可点 = 进详情(与滑杆管理入口同目标);
 * - 主动作留在右下角胶囊(面板「使用」/ 指令或能力「对话」/ 工具型无按钮);
 * - 无启用开关(收进详情页);滑杆图标 = 管理入口;
 * - 有新版本时显示「更新」按钮，目标版本保留在悬停提示和读屏标签中。
 *   更新进行中胶囊原位换成 DownloadRing 圆环 + 步骤文字;失败时圆环停在原处写失败原因,
 *   旁边换成带提示的重试图标按钮,宽度不超过原胶囊。
 */
export function GhostPluginCard({
  item,
  readOnly = false,
  sourceLabel,
  showLocalUnread = true,
  marketItem,
  author,
  updateVersion,
  updateBusy = false,
  updatePending = false,
  updateProgressKey,
  onUpdate: onPluginUpdate,
  onReapprove,
  effectiveEnabled,
  onPrimary,
  onManage,
  onIconLoadError,
}: {
  item: Pick<GhostPluginListItem, 'id' | 'name' | 'description'> & Partial<GhostPluginListItem>;
  readOnly?: boolean;
  sourceLabel?: string;
  showLocalUnread?: boolean;
  marketItem?: PluginMarketItem | null;
  author?: string | null;
  /** 市场存在新版本时的目标版本;与 onUpdate 同时提供。 */
  updateVersion?: string;
  updateBusy?: boolean;
  updatePending?: boolean;
  /** 不走市场的更新（GitHub Release）用自己的进度键；缺省按市场 pluginId。 */
  updateProgressKey?: string;
  onUpdate?: () => void;
  /** 本机列表提供恢复入口，远程列表沿用原有状态和操作。 */
  onReapprove?: () => void;
  effectiveEnabled?: boolean;
  onPrimary: () => void;
  onManage: () => void;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  const metadataId = useId();
  const origin = marketItem ? pluginPresentationOrigin(marketItem) : item.origin;
  const publisherKind = item.publisherKind ?? (marketItem?.sourceType === 'server' && marketItem.scope === 'public'
    ? marketItem.publisherKind : undefined);
  const hasPublicBadge = origin === 'public' && (publisherKind === 'official' || publisherKind === 'personal');
  let installationLabel = sourceLabel;
  if (origin === 'public') {
    installationLabel = hasPublicBadge ? undefined : t('mcpApps.source.market');
  } else if (item.installationLabelKey) {
    installationLabel = t(`settings.ghosts.detail.${item.installationLabelKey}`, { name: item.installationNamespace });
  } else if (!origin && !installationLabel) {
    const source = item.installationSource;
    installationLabel = t(`mcpApps.source.${source?.kind ?? 'unknown'}`, { namespace: source?.namespace });
  }
  const visibleAuthor = origin === 'public' && publisherKind !== 'official' ? null : author;
  const sourceMarkLabel = !origin || (origin === 'public' && !hasPublicBadge) ? installationLabel : undefined;
  const installationMetadata = sourceMarkLabel ? undefined : installationLabel;
  const enabled = effectiveEnabled ?? item.enabled;
  const needsReapproval = onReapprove !== undefined &&
    item.approvalState !== undefined && item.approvalState !== 'approved';
  const showDisabledStatus = !readOnly && enabled === false && !item.retirement && !needsReapproval;
  const muted = enabled === false && !item.retirement && !needsReapproval;
  const warningKeys = ([
    needsReapproval ? 'settings.ghosts.reapproval.badge' : null,
    item.oauthAuthorizationExpired ? 'settings.ghosts.page.oauthAuthorizationExpired' : null,
  ] as const).filter(key => key !== null);
  // 远程列表不投影本机同名插件的未读状态。
  const localUnread = useGhostUnread(item.id);
  const localUnreadSummary = useGhostUnreadSummary(item.id);
  const unread = showLocalUnread && localUnread;
  const unreadSummary = showLocalUnread ? localUnreadSummary : undefined;
  const description = item.retirement
    ? t('settings.ghosts.retirement.cardNotice')
    : unreadSummary || item.description || item.id;
  // 更新进度按市场 pluginId 订阅在卡片内:进度变化只重绘这一张卡,不带动整页。
  const updateProgress = usePluginInstallProgress(
    readOnly || needsReapproval ? null : updateProgressKey ?? marketItem?.pluginId,
  );
  const onUpdate = needsReapproval ? undefined : onPluginUpdate;
  const updateFailed = updateProgress?.download.phase === 'failed';
  const updateOffered = Boolean(updateVersion && onUpdate);
  // 失败的圆环只陪着还在的更新按钮出现;更新入口没了就不留一个孤零零的失败标记。
  const updateRing = updateProgress && (!updateFailed || updateOffered) ? updateProgress : null;
  const showUpdate = updateOffered || updateRing !== null;
  const updateLabel = t('settings.ghosts.page.updateAria', {
    name: item.name,
    version: updateVersion ?? item.version ?? '',
  });
  const primary = ghostPrimaryAction({
    canUse: item.canUse ?? false,
    tabPanel: item.tabPanel ?? false,
  });
  const agentInvoked = !readOnly && !item.retirement && !needsReapproval && enabled && primary === 'manage'
    ? t('settings.ghosts.page.agentInvoked') : null;
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onManage();
  };
  let primaryControl: ReactNode;
  let conversationControl: ReactNode;
  if (readOnly) {
    primaryControl = (
      <CardPillButton onClick={onManage} label={t('settings.ghosts.market.details')} />
    );
  } else if (item.retirement) {
    primaryControl = (
      <CardPillButton onClick={onManage} label={t('settings.ghosts.retirement.view')} />
    );
  } else if (needsReapproval) {
    if (!item.builtin) {
      primaryControl = (
        <CardPillButton
          onClick={onReapprove}
          label={t('settings.ghosts.reapproval.action')}
          ariaLabel={t('settings.ghosts.reapproval.actionAria', { name: item.name })}
          disabled={updateBusy}
        />
      );
    }
  } else if (item.oauthAuthorizationExpired) {
    primaryControl = (
      <CardPillButton onClick={onManage} label={t('newChat.pluginSetup.account.reconnect')} />
    );
  } else if (enabled && primary === 'panel') {
    primaryControl = (
      <CardPillButton
        onClick={onPrimary}
        label={t('settings.ghosts.page.usePanelAction')}
        ariaLabel={t('settings.ghosts.page.useAria', { name: item.name })}
      />
    );
  } else if (enabled && primary === 'command') {
    conversationControl = (
      <CardPillButton
        onClick={onPrimary}
        icon={<MessageCircle size={13} aria-hidden="true" />}
        label={t('settings.ghosts.page.chatAction')}
        ariaLabel={t('settings.ghosts.page.chatAria', { name: item.name })}
      />
    );
  }
  return (
    <article
      role="button"
      tabIndex={0}
      data-plugin-id={`installed:${item.id}`}
      data-fixed-actions={!readOnly && (showUpdate || Boolean(primaryControl) || showDisabledStatus)}
      onClick={onManage}
      onKeyDown={handleCardKeyDown}
      aria-label={item.name}
      aria-describedby={showDisabledStatus ? `${metadataId} ${metadataId}-disabled` : metadataId}
      className={cn(
        'plugin-catalog-row plugin-installed-row group grid w-full cursor-pointer select-none gap-x-4 rounded-xl px-3.5 py-3 text-left',
        'transition-colors hover:bg-[var(--surface-hover-soft)] focus-within:bg-[var(--surface-hover-soft)] motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      <GhostPluginIcon
        iconDataUrl={item.iconDataUrl}
        iconId={item.id}
        iconName={item.name}
        onIconLoadError={onIconLoadError}
      />
      <span className="plugin-installed-row-identity flex min-w-0 flex-col pt-0.5">
        <span className="plugin-installed-name-group flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="flex min-w-0 max-w-full items-center gap-2">
            <span
              className={cn('plugin-installed-name truncate text-15 font-medium', muted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]')}
              title={item.name}
            >
              {item.name}
            </span>
            {item.retirement?.unread ? (
              <AttentionDot tone="awaiting" size={6} className="mt-px" />
            ) : unread ? (
              <AttentionDot size={6} className="mt-px" />
            ) : null}
          </span>
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2">
            <PluginPublisherBadge origin={origin} kind={publisherKind} sourceLabel={sourceMarkLabel} />
            {marketItem ? (
              <span className="plugin-installed-narrow-metrics hidden text-12 text-[var(--text-tertiary)]">
                <PluginSharedUsage detail={marketItem} variant="list" leadingSeparator={false} />
              </span>
            ) : null}
            {agentInvoked ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-11 text-[var(--text-tertiary)]">
                <Bot size={13} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate" title={agentInvoked}>{agentInvoked}</span>
              </span>
            ) : null}
          </span>
        </span>
        <span
          id={metadataId}
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-1.5 text-12 text-[var(--text-tertiary)]',
            !readOnly && !item.retirement && warningKeys.length === 0 && enabled !== false && 'sr-only',
          )}
        >
          {installationMetadata ? <span className="min-w-0 break-words">{installationMetadata}</span> : null}
          {visibleAuthor ? (
            <>
              {installationMetadata ? <span aria-hidden="true">·</span> : null}
              <span className="min-w-0 max-w-[120px] truncate" title={visibleAuthor}>{visibleAuthor}</span>
            </>
          ) : null}
          {marketItem ? (
            <span className="plugin-installed-wide-metrics contents">
              <PluginSharedUsage detail={marketItem} variant="list" leadingSeparator={Boolean(installationMetadata || visibleAuthor)} />
            </span>
          ) : null}
          {readOnly && item.version ? <span>v{item.version}</span> : null}
          {readOnly && enabled !== undefined ? (
            <span>
              {t(
                enabled
                  ? 'settings.ghosts.detail.enabledLabel'
                  : 'settings.ghosts.detail.disabledLabel',
              )}
            </span>
          ) : null}
          {item.retirement ? (
            <span> · {t('settings.ghosts.retirement.status')}</span>
          ) : warningKeys.map((key, index) => (
            <span key={key} className="inline-flex min-w-0 items-center gap-1 text-[var(--warning-fg)]">
              {' · '}
              {index === 0 ? <AlertTriangle size={11} className="shrink-0" aria-hidden="true" /> : null}
              <span>{t(key)}</span>
            </span>
          ))}
        </span>
      </span>
      <span
        title={description}
        className={cn(
          'plugin-installed-row-description mt-0.5 truncate text-13 leading-5',
          unreadSummary && !muted ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
        )}
      >
        {description}
      </span>
      {/* 仅真实控件拦截冒泡，右列空白仍可进入详情。 */}
      {!readOnly ? (
        <span className="plugin-installed-row-hover-actions plugin-installed-row-actions flex items-center justify-end gap-1">
          <Tip text={t('settings.ghosts.page.manageAction')}>
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              className="w-7 px-0"
              onClick={stopAnd(onManage)}
              aria-label={t('settings.ghosts.page.manageAria', { name: item.name })}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
            </Button>
          </Tip>
          {conversationControl}
        </span>
      ) : null}
      {showUpdate || primaryControl || showDisabledStatus ? (
        <span className="plugin-installed-row-fixed-actions plugin-installed-row-actions flex items-center justify-end gap-1">
          {/* 更新进行中圆环与隐形的按钮叠在同一格,右列宽度不变,简介不会跟着换行;失败时两者并排。 */}
          {showUpdate ? <span className={cn('min-h-7 items-center justify-items-end gap-1.5', updateFailed ? 'flex' : 'grid')}>
            {updateRing ? (
              <PluginInstallRing
                label={updateLabel}
                progress={updateRing}
                size={16}
                className={cn('col-start-1 row-start-1 gap-1', updateOffered && !updateFailed && 'w-full [contain:inline-size]')}
              />
            ) : null}
            {updateVersion && onUpdate && updateFailed ? (
              <CardRetryButton size="sm" label={updateLabel} disabled={updateBusy} onClick={stopAnd(onUpdate)} />
            ) : updateVersion && onUpdate ? (
              <Button
                variant="secondary"
                size="sm"
                compact
                loading={updatePending && !updateRing}
                type="button"
                onClick={stopAnd(onUpdate)}
                disabled={updateBusy || updateRing !== null}
                aria-busy={updatePending || undefined}
                aria-hidden={updateRing ? true : undefined}
                aria-label={updateLabel}
                title={updateLabel}
                className={cn('col-start-1 row-start-1 min-w-20', updateRing && 'invisible')}
              >
                {t('settings.ghosts.installConsent.confirmUpdate')}
              </Button>
            ) : null}
          </span> : null}
          {primaryControl}
          {showDisabledStatus ? (
            <span id={`${metadataId}-disabled`} className="whitespace-nowrap text-12 text-[var(--text-tertiary)]">
              {t('settings.ghosts.disabledTag')}
            </span>
          ) : null}
        </span>
      ) : null}
    </article>
  );
}

/**
 * Retry beside a failed ring on a plugin card. A square icon button with a tooltip keeps the
 * failed state no wider than the button it replaced, so the card's title is never squeezed out.
 */
function CardRetryButton({
  size,
  label,
  disabled,
  onClick,
}: {
  size: 'sm' | 'md';
  label: string;
  disabled?: boolean;
  onClick: (event: { stopPropagation: () => void }) => void;
}) {
  const { t } = useTranslation();
  return (
    <Tip text={t('commonUi.retry')}>
      <Button
        variant="secondary"
        size={size}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn('shrink-0 px-0', size === 'sm' ? 'w-7' : 'w-8')}
      >
        <RotateCcw size={size === 'sm' ? 13 : 14} aria-hidden="true" />
      </Button>
    </Tip>
  );
}

function stopAnd(handler: () => void) {
  return (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    handler();
  };
}

function CardPillButton({
  onClick,
  label,
  icon,
  ariaLabel,
  disabled,
}: {
  onClick: () => void;
  label: string;
  icon?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="primary"
      size="md"
      compact
      type="button"
      onClick={stopAnd(onClick)}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
    >
      {icon}
      {label}
    </Button>
  );
}
