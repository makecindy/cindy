/**
 * Plugin catalog and detail coordinator backed by the latest Ghost host APIs.
 *
 * Inputs: installed Ghost snapshots and user actions.
 * Outputs: the Plugin list/detail UI, focus-stable installed queue, and Plugin action flows.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Store,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useAuth } from '@/contexts/AuthContext';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import {
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
} from '@/lib/composerDraftStore';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import {
  confirmAndInstallGhost,
  pickAndUpdateGhost,
  reapproveInstalledGhost,
} from '@/cindy-brain/installFlow';
import { GhostPermissionList, GhostUpdateReview } from '@/cindy-brain/GhostPermissionList';
import { cn } from '@/lib/utils';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import {
  useGhostUnread,
  useGhostUnreadEntries,
  useGhostUnreadSummary,
} from '@/cindy-brain/ghostUnreadStore';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { findSplitChildByPanelKind } from '../../../shared/layoutTree';
import { resolveSystemLocale } from '../../../shared/locale';
import {
  diffInstalledGhostPermissionItems,
  ghostInstallApprovalToken,
  ghostPanelKind,
  ghostPermissionBaselineKey,
  ghostPermissionItems,
  isOfficialGhostId,
  type GhostSetupStatus,
  type InstalledGhost,
} from '../../../shared/ghost';
import type {
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketItem,
  PluginMarketSnapshot,
} from '../../../shared/pluginMarket';
import type { LegacyGhostRecoveryStatus } from '../../../shared/legacyGhostRecovery';
import {
  toGhostPluginDetail,
  toGhostPluginListItem,
  filterGhostPluginItems,
  ghostPanelOwnerKey,
  ghostPrimaryAction,
  marketPresentationForInstalledGhost,
  installedVisibleCount,
  nextOpenPanelIdForOwner,
  sortInstalledForDisplay,
  type GhostPluginListItem,
} from './lib/ghostPluginViewModel';
import { ignoredRoundStorageKey, isBatchFinished, updateRoundKey } from './lib/updateAllModel';
import {
  approveUpdateExpansion,
  getUpdateAllBatchState,
  reconcileUpdateAllBatch,
  setUpdateAllBatchHooks,
  skipUpdateExpansion,
  startUpdateAllBatch,
  subscribeUpdateAllBatch,
} from './lib/updateAllController';
import { formatSetupGateDescription } from './lib/ghostSetupGateModel';
import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PLUGIN_INSTALLED_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from './PluginManagementLayout';
import { GhostPagePanelHost } from './GhostPagePanelHost';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import { UpdateAllDialog } from './UpdateAllDialog';
import { GhostPluginIcon } from './GhostPluginIcon';
import { MarketPluginDetailView } from './MarketPluginDetailView';
import { PluginScopePicker, usePluginRecentWorkdirs } from './PluginScopePicker';
import {
  // 受体模型的两条纯推导:reapprove 路由判定 + 「市场复核目标是否命中已装」。
  // main 的卡片改版不再走 catalogItems 交织,orderPluginCatalogItems 已无引用故不引入。
  ghostReapprovalRoute,
  marketReviewTargetsInstalledGhost,
  pluginPresentationOrigin,
  pluginUpdateForInstalledVersion,
  type PluginPresentationOrigin,
} from './lib/pluginMarketPresentation';
import { AddMarketplaceDialog } from './AddMarketplaceDialog';
import { pluginMarketErrorKey } from './lib/pluginMarketErrorKey';
import { usePluginIconRefresh } from './lib/usePluginIconRefresh';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';
import { usePluginMarketLocaleRefresh } from './lib/usePluginMarketLocaleRefresh';
import './plugin-motion.css';

const PLUGIN_CATALOG_TOOLBAR_CLASS =
  'plugin-catalog-toolbar mb-5 flex items-center justify-between gap-4';
type PluginPresentationFilter = 'all' | PluginPresentationOrigin;
type PresentedGhostPluginItem = GhostPluginListItem & {
  origin: PluginPresentationOrigin;
  /** 市场存在更新时的市场记录;列表卡片据此显示更新徽标与直达入口。 */
  marketUpdate: PluginMarketItem | null;
};

/** 推荐区来源过滤:本地装的必然在已安装区,不设「本地」档(设计定稿)。 */
const RECOMMENDED_FILTERS: readonly PluginPresentationFilter[] = [
  'all',
  'public',
  'organization',
  'custom',
];

/** 已安装区默认只展开一屏内的前 8 个，其余通过显式操作渐进展示。 */
const MAX_VISIBLE_INSTALLED_PLUGINS = 8;
/** 折叠入口只预览前三个隐藏插件，避免头像堆叠反过来抢占操作文案。 */
const MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS = 3;

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

export function diffMarketUpdatePermissionItems(
  installed: InstalledGhost,
  next: PluginMarketDetail['manifest'],
) {
  return diffInstalledGhostPermissionItems(installed, next);
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
export function GhostPluginPage() {
  const { i18n, t } = useTranslation();
  const marketLocale = resolveSystemLocale(i18n.resolvedLanguage ?? i18n.language);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm, confirmWithCheckbox } = useConfirmDialog();
  const { user, mode, dataOwnerId } = useAuth();
  const showEnterprise = user?.membershipKind === 'org';
  const ghosts = useInstalledGhosts();
  const installedGhostIds = useMemo(() => ghosts.map((ghost) => ghost.manifest.id), [ghosts]);
  const installedGhostIdsKey = useMemo(
    () => [...installedGhostIds].sort().join('\0'),
    [installedGhostIds],
  );
  const installedGhostLocationsKey = ghosts
    .map((ghost) => `${ghost.manifest.id}\0${ghost.dir}`)
    .sort()
    .join('\0');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const installedOverflowId = useId();
  const [marketSnapshot, setMarketSnapshot] = useState<PluginMarketSnapshot | null>(null);
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  // 数据归属键:面板宿主按它失效(定义要早于消费点)。
  const panelOwnerKey = ghostPanelOwnerKey(mode, dataOwnerId);
  const ignoredRoundKey = ignoredRoundStorageKey(mode, dataOwnerId);
  const [ignoredRound, setIgnoredRound] = useState(() => readIgnoredRound(ignoredRoundKey));
  // 账号 / 本地云模式切换:换桶重读,不把上一个身份的「忽略本轮」带进来。
  useEffect(() => {
    setIgnoredRound(readIgnoredRound(ignoredRoundKey));
  }, [ignoredRoundKey]);
  const [originFilter, setOriginFilter] = useState<PluginPresentationFilter>('all');
  const [marketDetail, setMarketDetail] = useState<PluginMarketDetail | null>(null);
  const [marketBusyId, setMarketBusyId] = useState<string | null>(null);
  // 市场操作的同步互斥锁。React state 在提交前有窗口期,快速连点会让多个回调
  // 都读到 null;ref 先到先得,state 只驱动按钮禁用等 UI 展示。每次占锁都返回
  // 唯一 lease,避免账号/模式切换后的旧异步流程误释放新流程持有的同 pluginId 锁。
  const marketBusyLockRef = useRef<{ pluginId: string } | null>(null);
  const acquireMarketBusy = useCallback((pluginId: string) => {
    if (marketBusyLockRef.current !== null) return null;
    const lease = { pluginId };
    marketBusyLockRef.current = lease;
    setMarketBusyId(pluginId);
    return lease;
  }, []);
  const releaseMarketBusy = useCallback((lease: { pluginId: string }) => {
    if (marketBusyLockRef.current !== lease) return;
    marketBusyLockRef.current = null;
    setMarketBusyId((current) => (current === lease.pluginId ? null : current));
  }, []);
  const isMarketBusyLeaseActive = useCallback(
    (lease: { pluginId: string }) => marketBusyLockRef.current === lease,
    [],
  );
  const marketRefreshRequestRef = useRef(0);
  const lastMarketRefreshAtRef = useRef(0);
  const marketDetailRequestRef = useRef(0);
  const installedGhostIdsKeyRef = useRef(installedGhostIdsKey);
  const legacyRecoveryStatusRequestRef = useRef(0);
  const legacyRecoveryRetryRequestRef = useRef(0);
  const [legacyRecoveryStatus, setLegacyRecoveryStatus] =
    useState<LegacyGhostRecoveryStatus | null>(null);
  const [legacyRecoveryRetrying, setLegacyRecoveryRetrying] = useState(false);
  const refreshMarket = useCallback(async (preserveOnError = false) => {
    const requestId = ++marketRefreshRequestRef.current;
    try {
      const snapshot = await window.electronAPI.pluginMarket.snapshot();
      if (requestId !== marketRefreshRequestRef.current) return;
      // Main intentionally represents market outages as data so the initial page can render a
      // non-blocking empty state. During icon renewal, convert that fulfilled unavailable result
      // back into a failure: the catch path preserves the visible snapshot and the hook retries.
      if (preserveOnError && snapshot.unavailableReason !== null) {
        throw new Error(snapshot.unavailableReason);
      }
      setMarketSnapshot(snapshot);
      lastMarketRefreshAtRef.current = Date.now();
    } catch (error) {
      if (requestId !== marketRefreshRequestRef.current) return;
      setMarketSnapshot((current) =>
        preserveOnError && current
          ? current
          : {
              items: [],
              unavailableReason: error instanceof Error ? error.message : String(error),
              customSourceNames: [],
            },
      );
      // Background icon renewal keeps the current snapshot visible, but must still report
      // failure to the renewal hook so it can schedule a bounded retry.
      if (preserveOnError) throw error;
    }
  }, []);
  useEffect(() => {
    setMarketSnapshot(null);
    setMarketDetail(null);
    marketBusyLockRef.current = null;
    setMarketBusyId(null);
    marketDetailRequestRef.current += 1;
    void refreshMarket();
  }, [refreshMarket, mode, dataOwnerId]);
  const refreshMarketOnForeground = useCallback(() => refreshMarket(true), [refreshMarket]);
  usePluginMarketForegroundRefresh(refreshMarketOnForeground, lastMarketRefreshAtRef);
  useEffect(() => {
    if (installedGhostIdsKeyRef.current === installedGhostIdsKey) return;
    installedGhostIdsKeyRef.current = installedGhostIdsKey;
    // 已装集合变化(装/卸)时刷新市场;排序是反应式的,没有快照需要维护。
    void refreshMarket(true).catch(() => undefined);
  }, [installedGhostIdsKey, refreshMarket]);
  const activeSessionWorkingDir = useSyncExternalStore(
    subscribeToLastWorkingDir,
    getLastWorkingDir,
    getLastWorkingDir,
  );
  const recentWorkdirs = usePluginRecentWorkdirs();
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  const scopeDirRef = useRef<string | null>(scopeDir);
  scopeDirRef.current = scopeDir;
  const [projectDisabled, setProjectDisabled] = useState<Set<string>>(() => new Set());
  const handlePickScope = useCallback((dir: string | null) => {
    setScopeDir(dir);
    if (!dir) {
      setProjectDisabled(new Set());
      return;
    }
    try {
      setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
    } catch {
      setProjectDisabled(new Set());
    }
  }, []);
  const effectiveEnabled = useCallback(
    (id: string, globallyEnabled: boolean) =>
      scopeDir === null ? globallyEnabled : globallyEnabled && !projectDisabled.has(id),
    [projectDisabled, scopeDir],
  );
  const [recentGhostIds, setRecentGhostIds] = useState(
    () => window.electronAPI.ghosts.recentUsageSync().ids,
  );
  useEffect(
    () =>
      window.electronAPI.ghosts.onChanged(() => {
        const dir = scopeDirRef.current;
        if (dir) {
          try {
            setProjectDisabled(new Set(window.electronAPI.ghosts.workdirPrefsSync(dir).disabled));
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
  const customSourceNames = useMemo(
    () => marketSnapshot?.customSourceNames ?? [],
    [marketSnapshot?.customSourceNames],
  );
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const marketByGhostId = useMemo(() => {
    const map = new Map<string, PluginMarketItem>();
    for (const item of marketItems) {
      if (item.installState !== 'conflict') map.set(item.ghostId, item);
    }
    return map;
  }, [marketItems]);
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
          const marketItem = marketByGhostId.get(ghost.manifest.id) ?? null;
          const presentation = marketPresentationForInstalledGhost(ghost, marketItem);
          return {
            ...toGhostPluginListItem(ghost, presentation),
            origin: pluginPresentationOrigin(marketItem),
            // 同版本展示刷新由 main 标成 installed;legacy-unresolved 仍保留
            // update-available,以便用户用市场包替换未验证的本地字节。
            marketUpdate: pluginUpdateForInstalledVersion(marketItem),
          };
        }),
    [ghosts, marketByGhostId],
  );
  const installedItems = useMemo(
    () =>
      showEnterprise
        ? allInstalledItems
        : allInstalledItems.filter((item) => item.origin !== 'organization'),
    [allInstalledItems, showEnterprise],
  );
  const searchedInstalledItems = useMemo(
    () => filterGhostPluginItems(installedItems, query),
    [installedItems, query],
  );
  const searchedAvailableMarketItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return marketItems.filter((item) => {
      if (item.installState === 'installed' || item.installState === 'update-available') {
        return false;
      }
      if (!showEnterprise && pluginPresentationOrigin(item) === 'organization') return false;
      return `${item.name} ${item.description ?? ''} ${item.ghostId} ${item.author ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [marketItems, query, showEnterprise]);
  const recommendedFilters = useMemo(
    () =>
      RECOMMENDED_FILTERS.filter((filter) => {
        if (filter === 'organization') return showEnterprise;
        // 未添加任何自定义市场时不显示"自定义"档(与组织档的隐藏模式一致)。
        if (filter === 'custom') return customSourceNames.length > 0;
        return true;
      }),
    [customSourceNames.length, showEnterprise],
  );
  const effectiveOriginFilter =
    !showEnterprise && originFilter === 'organization'
      ? 'all'
      : originFilter === 'custom' && customSourceNames.length === 0
        ? 'all'
        : originFilter;
  const availableMarketItems = useMemo(
    () =>
      effectiveOriginFilter === 'all'
        ? searchedAvailableMarketItems
        : searchedAvailableMarketItems.filter(
            (item) => pluginPresentationOrigin(item) === effectiveOriginFilter,
          ),
    [effectiveOriginFilter, searchedAvailableMarketItems],
  );
  // 「自定义」档内按来源市场分组(≥2 个源时展示小标题);组顺序沿用市场添加顺序。
  const customGroups = useMemo(() => {
    if (effectiveOriginFilter !== 'custom') return null;
    const groups = new Map<string, PluginMarketItem[]>();
    for (const item of availableMarketItems) {
      const key = item.sourceMarketName ?? '';
      const list = groups.get(key);
      if (list) {
        list.push(item);
      } else {
        groups.set(key, [item]);
      }
    }
    return [...groups.entries()].sort((a, b) => {
      const aIndex = customSourceNames.indexOf(a[0]);
      const bIndex = customSourceNames.indexOf(b[0]);
      return (
        (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
        (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex)
      );
    });
  }, [availableMarketItems, customSourceNames, effectiveOriginFilter]);
  const recommendedCounts = useMemo(() => {
    const counts: Record<PluginPresentationOrigin, number> = {
      public: 0,
      organization: 0,
      local: 0,
      custom: 0,
    };
    for (const item of searchedAvailableMarketItems) {
      counts[pluginPresentationOrigin(item)] += 1;
    }
    return counts;
  }, [searchedAvailableMarketItems]);

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
  // 切账号/模式收起折叠区:换 owner 的已装集合不同,上一个身份的展开态不带过去。
  const collapseOwnerKeyRef = useRef(panelOwnerKey);
  useEffect(() => {
    if (collapseOwnerKeyRef.current === panelOwnerKey) return;
    collapseOwnerKeyRef.current = panelOwnerKey;
    setInstalledExpanded(false);
  }, [panelOwnerKey]);
  const displayInstalledItems = useMemo(
    () =>
      sortInstalledForDisplay(searchedInstalledItems, {
        recentIds: recentGhostIds,
        unreadAtById,
      }),
    [searchedInstalledItems, recentGhostIds, unreadAtById],
  );
  // 未读通知永不折叠:可见窗口至少 MAX_VISIBLE_INSTALLED_PLUGINS 个,并容纳全部
  // 未读——未读已排在最前,按未读数量扩窗即可保证它们都落在可见区(更新可被折叠)。
  const visibleInstalledCount = useMemo(
    () => installedVisibleCount(displayInstalledItems, unreadAtById, MAX_VISIBLE_INSTALLED_PLUGINS),
    [displayInstalledItems, unreadAtById],
  );
  const primaryInstalledItems = useMemo(
    () => displayInstalledItems.slice(0, visibleInstalledCount),
    [displayInstalledItems, visibleInstalledCount],
  );
  const additionalInstalledItems = useMemo(
    () => displayInstalledItems.slice(visibleInstalledCount),
    [displayInstalledItems, visibleInstalledCount],
  );
  const hiddenInstalledCount = Math.max(0, displayInstalledItems.length - visibleInstalledCount);

  // ── 更新横幅与批量更新(设计定稿:全部更新;扩权单独确认,绝不静默放行)──
  const updatableInstalledItems = useMemo(
    () => installedItems.filter((item) => item.marketUpdate !== null),
    [installedItems],
  );
  const currentRoundKey = useMemo(() => updateRoundKey(marketItems), [marketItems]);
  const handleIgnoreRound = useCallback(() => {
    try {
      window.localStorage.setItem(ignoredRoundKey, currentRoundKey);
    } catch {
      // localStorage 不可用时仅本次会话内生效。
    }
    setIgnoredRound(currentRoundKey);
  }, [currentRoundKey, ignoredRoundKey]);

  // 批次状态住在模块级控制器里(生命周期长于本页:关弹窗离开 /plugins
  // 后批次继续跑,回来仍保留待确认项的批准/跳过入口),页面只订阅快照。
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
  // 有未完结批次(含待确认项)时横幅必须在场:它是重开批量弹窗的唯一入口,
  // 「忽略本轮」不得顺带藏掉待确认项的批准/跳过路径。
  const hasUnfinishedBatch = updateRows !== null && !isBatchFinished(updateRows);
  const bannerVisible =
    hasUnfinishedBatch ||
    (updatableInstalledItems.length > 0 &&
      (currentRoundKey === '' || ignoredRound !== currentRoundKey));
  const selectedGhost = selectedId
    ? (ghosts.find((ghost) => ghost.manifest.id === selectedId) ?? null)
    : null;
  const selectedPresentation = selectedGhost
    ? marketPresentationForInstalledGhost(
        selectedGhost,
        marketByGhostId.get(selectedGhost.manifest.id),
      )
    : null;
  const selectedDetail = selectedGhost
    ? toGhostPluginDetail(selectedGhost, selectedPresentation)
    : null;
  const selectedMarketInstall = selectedDetail
    ? (marketByGhostId.get(selectedDetail.id) ?? null)
    : null;
  const selectedMarketUpdate = selectedDetail
    ? pluginUpdateForInstalledVersion(selectedMarketInstall)
    : null;

  // ── 面板收束:页面独占的插件面板宿主;停用/卸载/换形态自动失效 ──
  const openPanelGhost = useMemo(() => {
    if (!openPanelId) return null;
    const ghost = ghosts.find((candidate) => candidate.manifest.id === openPanelId);
    if (!ghost) return null;
    if (ghost.manifest.panel?.position !== 'tab') return null;
    if (!effectiveEnabled(ghost.manifest.id, ghost.enabled)) return null;
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

  const panelStatus = useMemo(() => {
    if (!selectedDetail || selectedDetail.panelMinWidth === null) return null;
    // 页签形态(面板收束):由插件页承载,没有停靠状态可言。
    if (selectedDetail.tabPanel) return t('settings.ghosts.detail.panelPageHosted');
    try {
      const kind = ghostPanelKind(selectedDetail.id);
      const docked =
        findSplitChildByPanelKind(window.electronAPI.layout.getStateSync().layout, kind) !== null;
      return docked
        ? t('settings.ghosts.detail.panelDocked', {
            min: selectedDetail.panelMinWidth,
          })
        : t('settings.ghosts.detail.panelNotDocked');
    } catch {
      return t('settings.ghosts.detail.panelNotDocked');
    }
  }, [selectedDetail, t]);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean, displayName: string) => {
      try {
        const dir = scopeDirRef.current;
        if (dir) {
          const result = await window.electronAPI.ghosts.setWorkdirDisabled(dir, id, !enabled);
          setProjectDisabled(new Set(result.disabled));
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
      } catch (error) {
        toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
      }
    },
    [t],
  );

  /** 真实包的追加确认由窗口级 Host 在这一次 install IPC 事务内完成。 */
  const installReviewedMarketPackage = useCallback(
    async (input: {
      detail: PluginMarketDetail;
      lease: { pluginId: string };
      options: PluginMarketInstallOptions;
    }): Promise<InstalledGhost | null> => {
      const result = await window.electronAPI.pluginMarket.install(
        input.detail.pluginId,
        input.options,
      );
      return result.ghost ?? null;
    },
    [],
  );

  // 市场更新流程由列表卡片和详情页共用:先取目标 release 的完整 manifest 做
  // 权限 diff,经用户确认后才安装,不做静默升级。
  //
  // 同版本的 `installed` 也走这里:缺少批准状态的存量安装靠"用市场包重装同一
  // release"恢复,此时权限 diff 会把目标包的全部权限当新增项逐条列出。
  // 所有来源先展示详情清单；官方包下载后仍以真实包清单兜底发现额外权限。
  const handleMarketUpdate = useCallback(
    async (ghostId: string) => {
      const marketItem = marketByGhostId.get(ghostId);
      if (!marketItem) return;
      const installedGhost = ghosts.find((ghost) => ghost.manifest.id === ghostId) ?? null;
      if (!marketReviewTargetsInstalledGhost(marketItem, installedGhost?.approval.state)) {
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
      try {
        const next = await window.electronAPI.pluginMarket.detail(marketItem.pluginId);
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        const diff = diffMarketUpdatePermissionItems(installedGhost, next.manifest);
        const approved = await confirm({
          title: t('settings.ghosts.updateConfirm.title', { name: next.name }),
          description: t('settings.ghosts.updateConfirm.body', {
            from: installedGhost?.manifest.version ?? next.version,
            to: next.version,
          }),
          content: <GhostUpdateReview diff={diff} />,
          maxWidth: 520,
          confirmText: t('settings.ghosts.updateConfirm.confirm'),
          cancelText: t('settings.ghosts.updateConfirm.cancel'),
        });
        if (!approved || !isMarketBusyLeaseActive(marketBusyLease)) return;
        const options: PluginMarketInstallOptions = {
          expectedReleaseId: next.releaseId,
          expectedManifest: next.manifest,
          expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval),
          allowPermissionExpansion: diff.added.length > 0,
          ...(installedGhost
            ? { reviewedBaseline: ghostPermissionBaselineKey(installedGhost.manifest) }
            : {}),
        };
        const ghost = await installReviewedMarketPackage({
          detail: next,
          lease: marketBusyLease,
          options,
        });
        if (!ghost) return;
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        toast.success(
          t('settings.ghosts.toast.updated', {
            name: ghost.manifest.name,
            version: ghost.manifest.version,
          }),
        );
        await refreshMarket();
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          toast.error(t(pluginMarketErrorKey(error)));
        }
      } finally {
        releaseMarketBusy(marketBusyLease);
      }
    },
    [
      acquireMarketBusy,
      confirm,
      ghosts,
      isMarketBusyLeaseActive,
      installReviewedMarketPackage,
      marketByGhostId,
      refreshMarket,
      releaseMarketBusy,
      t,
    ],
  );

  const handleUpdate = useCallback(async () => {
    if (!selectedDetail) return;
    if (selectedMarketUpdate) {
      await handleMarketUpdate(selectedDetail.id);
      return;
    }
    await pickAndUpdateGhost(selectedDetail.id, { t, confirm, confirmWithCheckbox });
  }, [confirm, confirmWithCheckbox, handleMarketUpdate, selectedDetail, selectedMarketUpdate, t]);

  /**
   * 缺少批准状态时的恢复入口。市场自有的包重走市场安装确认(重新下载 + 逐项
   * 权限确认);本地包让用户重新选一次 `.cindy`。两条路都落到同一套权限确认,
   * 不存在"点一下就悄悄恢复运行"的分支。
   */
  const handleReapprove = useCallback(
    async (ghostId: string) => {
      // 随包插件不走人工重新确认(入口已隐藏,这里是防御):批准由启动对账自动补。
      if (ghosts.find((g) => g.manifest.id === ghostId)?.builtin) return;
      if (ghostReapprovalRoute(marketByGhostId.get(ghostId)) === 'market') {
        await handleMarketUpdate(ghostId);
        return;
      }
      // 本地包路线:从已装目录读全量权限清单确认后开 receipt,不用用户翻出原始
      // .cindy 文件;目录读不出时该流程内部自动回退到"重新选包"。
      await reapproveInstalledGhost(ghostId, { t, confirm, confirmWithCheckbox });
    },
    [confirm, confirmWithCheckbox, ghosts, handleMarketUpdate, marketByGhostId, t],
  );

  const handleUpdateFromFile = useCallback(async () => {
    if (!selectedDetail) return;
    await pickAndUpdateGhost(selectedDetail.id, { t, confirm, confirmWithCheckbox });
  }, [confirm, confirmWithCheckbox, selectedDetail, t]);

  // 控制器在挂载期借用本页的市场刷新;卸载后批次继续跑,重新进页全量刷新。
  useEffect(
    () => setUpdateAllBatchHooks({ refreshMarket: () => refreshMarket() }),
    [refreshMarket],
  );
  const handleUpdateAll = useCallback(() => {
    const current = getUpdateAllBatchState();
    // 运行中或还有待确认项的批次:重开弹窗接着处理,不重建批次。
    if (current.running || (current.rows !== null && !isBatchFinished(current.rows))) {
      setUpdateDialogOpen(true);
      return;
    }
    // 单项更新持有 market lease 期间不许开新批次:此刻的市场快照还把那个
    // 插件标成 update-available,批次会把它一并收进去重复装一遍。
    if (marketBusyLockRef.current !== null) return;
    startUpdateAllBatch(
      updatableInstalledItems.flatMap((item) => (item.marketUpdate ? [item.marketUpdate] : [])),
    );
    setUpdateDialogOpen(true);
  }, [updatableInstalledItems]);

  const handleInstall = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    await confirmAndInstallGhost(picked.filePath, {
      t,
      confirm,
      confirmWithCheckbox,
      // 已在插件页:tab 型插件勾选「立即开启并打开面板」后原地开面板。
      openPluginPanel: (ghostId) => {
        setSelectedId(null);
        setOpenPanelId(ghostId);
      },
    });
  }, [confirm, confirmWithCheckbox, t]);

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

  const handleCreateWithCindy = useCallback(() => {
    saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
      text: plainTextToTiptapDoc(t('settings.ghosts.page.createPrompt')),
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
      const ghost = ghosts.find((candidate) => candidate.manifest.id === id);
      if (!ghost?.manifest.command) return;
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
        pendingGhostId: ghost.manifest.id,
      });
      resetDraftWorkspaceTargets();
      navigate('/cc-agent/new');
    },
    [confirm, ghosts, navigate, openGhostConfiguration, t],
  );

  /** 卡片/详情主动作分发:面板型开页面内面板,指令型起对话,工具型进管理。 */
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

  const handleUninstall = useCallback(async () => {
    if (!selectedDetail) return;
    const ok = await confirm({
      title: t('settings.ghosts.uninstallConfirm.title', { name: selectedDetail.name }),
      description: t('settings.ghosts.uninstallConfirm.description'),
      confirmText: t('settings.ghosts.uninstall'),
      cancelText: t('settings.ghosts.uninstallConfirm.cancel'),
    });
    if (!ok) return;
    try {
      if (selectedMarketInstall) {
        await window.electronAPI.pluginMarket.uninstall(selectedMarketInstall.pluginId);
        await refreshMarket();
      } else {
        await window.electronAPI.ghosts.uninstall(selectedDetail.id);
      }
      toast.success(t('settings.ghosts.toast.uninstalled', { name: selectedDetail.name }));
    } catch (error) {
      toast.error(
        selectedMarketInstall
          ? t(pluginMarketErrorKey(error))
          : t(ghostInstallErrorKey(extractIpcError(error)?.code)),
      );
    }
  }, [confirm, refreshMarket, selectedDetail, selectedMarketInstall, t]);

  const handleSelectMarket = useCallback(
    async (pluginId: string) => {
      // 与 handleMarketUpdate 共用同一互斥锁:更新进行中不叠加其它市场操作。
      const marketBusyLease = acquireMarketBusy(pluginId);
      if (!marketBusyLease) return;
      const requestId = ++marketDetailRequestRef.current;
      try {
        const detail = await window.electronAPI.pluginMarket.detail(pluginId);
        if (
          requestId === marketDetailRequestRef.current &&
          isMarketBusyLeaseActive(marketBusyLease)
        ) {
          setMarketDetail(detail);
        }
      } catch (error) {
        if (
          requestId === marketDetailRequestRef.current &&
          isMarketBusyLeaseActive(marketBusyLease)
        ) {
          toast.error(t(pluginMarketErrorKey(error)));
        }
      } finally {
        releaseMarketBusy(marketBusyLease);
      }
    },
    [acquireMarketBusy, isMarketBusyLeaseActive, releaseMarketBusy, t],
  );

  const refreshVisibleMarketDetail = useCallback(async (pluginId: string) => {
    // A background icon renewal may observe navigation, but must never invalidate a
    // user-initiated detail request by advancing its request generation.
    const requestId = marketDetailRequestRef.current;
    try {
      const detail = await window.electronAPI.pluginMarket.detail(pluginId);
      if (requestId !== marketDetailRequestRef.current) return;
      setMarketDetail((current) => (current?.pluginId === pluginId ? detail : current));
    } catch (error) {
      // A background URL renewal must not close an otherwise usable detail page.
      if (requestId === marketDetailRequestRef.current) throw error;
    }
  }, []);
  usePluginMarketLocaleRefresh(
    marketLocale,
    async () => {
      await window.electronAPI.setApplicationMenuLocale(marketLocale);
    },
    () => refreshMarket(true),
    marketDetail?.pluginId ? () => refreshVisibleMarketDetail(marketDetail.pluginId) : undefined,
  );
  const visibleMarketIcons = useMemo(
    () => [...marketItems.map((item) => item.icon), marketDetail?.icon],
    [marketDetail?.icon, marketItems],
  );
  const refreshVisibleMarketIcons = useCallback(async () => {
    const refreshes: Promise<void>[] = [refreshMarket(true)];
    if (marketDetail?.pluginId) {
      refreshes.push(refreshVisibleMarketDetail(marketDetail.pluginId));
    }
    await Promise.all(refreshes);
  }, [marketDetail?.pluginId, refreshMarket, refreshVisibleMarketDetail]);
  const handleMarketIconLoadError = usePluginIconRefresh(
    visibleMarketIcons,
    refreshVisibleMarketIcons,
  );

  const runMarketInstallFlow = useCallback(
    async (marketDetailArg: PluginMarketDetail) => {
      const marketDetail = marketDetailArg;
      // 确认框等待期间也持有 lease。账号/模式切换会清除当前 lease,
      // 旧确认回调恢复后必须先验权,不能在新会话里继续安装。
      const marketBusyLease = acquireMarketBusy(marketDetail.pluginId);
      if (!marketBusyLease) return;
      // 详情页按钮在 update-available 态复用本入口,后端走原位更新并保留
      // 生效状态 —— 文案必须分支,不能对更新路径承诺"装完即开"(review P1)。
      const isUpdate = marketDetail.installState === 'update-available';
      try {
        let installedGhost =
          ghosts.find((ghost) => ghost.manifest.id === marketDetail.ghostId) ?? null;
        if (isUpdate && !installedGhost) {
          try {
            installedGhost =
              window.electronAPI.ghosts
                .listSync()
                .ghosts.find((ghost) => ghost.manifest.id === marketDetail.ghostId) ?? null;
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
        const diff = isUpdate
          ? diffMarketUpdatePermissionItems(installedGhost!, marketDetail.manifest)
          : null;
        const confirmed = await confirm({
          title: isUpdate
            ? t('settings.ghosts.updateConfirm.title', { name: marketDetail.name })
            : t('settings.ghosts.market.installConfirmTitle', {
                name: marketDetail.name,
              }),
          description: isUpdate
            ? t('settings.ghosts.market.updateConfirmDescription')
            : t(
                marketDetail.sourceType === 'server'
                  ? 'settings.ghosts.market.installConfirmDescription'
                  : 'settings.ghosts.market.customInstallConfirmDescription',
              ),
          content: isUpdate ? (
            <GhostUpdateReview diff={diff!} />
          ) : (
            <GhostPermissionList items={ghostPermissionItems(marketDetail.manifest)} />
          ),
          maxWidth: 520,
          confirmText: isUpdate
            ? t('settings.ghosts.updateConfirm.confirm')
            : t('settings.ghosts.market.install'),
          cancelText: isUpdate
            ? t('settings.ghosts.updateConfirm.cancel')
            : t('settings.ghosts.installConfirm.cancel'),
          autoFocusConfirm: true,
        });
        if (!confirmed || !isMarketBusyLeaseActive(marketBusyLease)) return;
        const options: PluginMarketInstallOptions = {
          expectedReleaseId: marketDetail.releaseId,
          expectedManifest: marketDetail.manifest,
          ...(isUpdate && installedGhost
            ? { expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval) }
            : {}),
          ...(isUpdate && diff!.added.length > 0
            ? {
                allowPermissionExpansion: true,
                ...(installedGhost
                  ? { reviewedBaseline: ghostPermissionBaselineKey(installedGhost.manifest) }
                  : {}),
              }
            : {}),
        };
        const ghost = await installReviewedMarketPackage({
          detail: marketDetail,
          lease: marketBusyLease,
          options,
        });
        if (!ghost) return;
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        // 市场首装装完即开(2026-07-26 定案),toast 用"已安装";更新路径如实
        // 用"已更新"(生效状态未被改变)。
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
        setMarketDetail((current) =>
          current?.pluginId === marketDetail.pluginId ? null : current,
        );
        setSelectedId(ghost.manifest.id);
        await refreshMarket();
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          toast.error(t(pluginMarketErrorKey(error)));
        }
      } finally {
        releaseMarketBusy(marketBusyLease);
      }
    },
    [
      acquireMarketBusy,
      confirm,
      ghosts,
      isMarketBusyLeaseActive,
      installReviewedMarketPackage,
      refreshMarket,
      releaseMarketBusy,
      t,
    ],
  );
  const handleInstallFromMarket = useCallback(async () => {
    if (!marketDetail) return;
    await runMarketInstallFlow(marketDetail);
  }, [marketDetail, runMarketInstallFlow]);
  /** 推荐卡片上的直接「安装」:先取详情,再走与详情页相同的确认+安装流。 */
  const handleInstallMarketItem = useCallback(
    async (pluginId: string) => {
      const marketBusyLease = acquireMarketBusy(pluginId);
      if (!marketBusyLease) return;
      let detail: PluginMarketDetail;
      try {
        detail = await window.electronAPI.pluginMarket.detail(pluginId);
      } catch (error) {
        if (isMarketBusyLeaseActive(marketBusyLease)) {
          toast.error(t(pluginMarketErrorKey(error)));
        }
        releaseMarketBusy(marketBusyLease);
        return;
      }
      releaseMarketBusy(marketBusyLease);
      await runMarketInstallFlow(detail);
    },
    [acquireMarketBusy, isMarketBusyLeaseActive, releaseMarketBusy, runMarketInstallFlow, t],
  );

  // 面板收束:aside 只挂在插件页语境里(列表/详情/市场详情共用),
  // 路由离开本页组件整体卸载 → webview 一并回收,绝不残留到别的界面。
  const panelAside = openPanelGhost ? (
    // key 纳入 owner 代际:双保险。即便将来某条路径漏了上面的清空,换身份也会
    // 强制卸载重建宿主(webview 连同它的 DOM/内存态一起丢),不会跨账号复用。
    <GhostPagePanelHost
      key={`${panelOwnerKey}:${openPanelGhost.manifest.id}`}
      ghost={openPanelGhost}
      onClose={() => setOpenPanelId(null)}
    />
  ) : null;

  if (marketDetail) {
    return (
      <div className="flex h-full min-h-0 w-full">
        <div className="min-w-0 flex-1">
          <MarketPluginDetailView
            detail={marketDetail}
            busy={marketBusyId === marketDetail.pluginId}
            onBack={() => {
              marketDetailRequestRef.current += 1;
              setMarketDetail(null);
            }}
            onInstall={() => void handleInstallFromMarket()}
            onIconLoadError={handleMarketIconLoadError}
          />
        </div>
        {panelAside}
      </div>
    );
  }

  if (selectedDetail) {
    return (
      <div className="flex h-full min-h-0 w-full">
        <div className="min-w-0 flex-1">
          <GhostPluginDetailView
            ghost={selectedGhost}
            detail={selectedDetail}
            panelStatus={panelStatus}
            enabledOverride={
              selectedGhost
                ? effectiveEnabled(selectedGhost.manifest.id, selectedGhost.enabled)
                : undefined
            }
            onBack={() => setSelectedId(null)}
            onToggle={(enabled) =>
              void handleToggle(selectedDetail.id, enabled, selectedDetail.name)
            }
            onUse={handleUse}
            onUpdate={() => void handleUpdate()}
            onUpdateFromFile={() => void handleUpdateFromFile()}
            // 受体模型的 §5 恢复入口:缺批准的安装在详情页重新确认(市场包重装 /
            // 本地包读目录权限确认),详情视图据 needsReapproval 门控运行按钮。
            onReapprove={() => void handleReapprove(selectedDetail.id)}
            updateVersion={selectedMarketUpdate?.version}
            updateBusy={(selectedMarketUpdate !== null && marketBusyId !== null) || batchRunning}
            onUninstall={() => void handleUninstall()}
            // 官方保留前缀(cindy-/filo-/xd-)的插件走本地装入会被拒,
            // 导出产物无法重装,不提供导出项。
            onExport={
              selectedGhost && !isOfficialGhostId(selectedDetail.id)
                ? () => void handleExport()
                : undefined
            }
            toggleDisabled={scopeDir !== null && selectedGhost !== null && !selectedGhost.enabled}
            onIconLoadError={handleMarketIconLoadError}
          />
        </div>
        {panelAside}
      </div>
    );
  }

  return (
    <PluginManagementLayout
      activeTab="plugins"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={t('settings.ghosts.page.search')}
      clearSearchLabel={t('settings.ghosts.page.clearSearch')}
      headerActions={
        <GhostPluginActions
          onInstall={() => void handleInstall()}
          onCreateWithCindy={handleCreateWithCindy}
          onAddMarketplace={() => setAddMarketplaceOpen(true)}
        />
      }
    >
      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]">
          <PluginManagementPage>
            <header className="plugin-motion-page-header pb-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                    {t('settings.ghosts.title')}
                  </h1>
                  <PluginScopePicker
                    scopeDir={scopeDir}
                    activeSessionWorkingDir={activeSessionWorkingDir ?? undefined}
                    recentWorkdirs={recentWorkdirs}
                    onPick={handlePickScope}
                  />
                </div>
                <p className="mt-2 max-w-2xl text-14 leading-6 text-[var(--text-secondary)]">
                  {t('settings.ghosts.description')}
                </p>
              </div>
            </header>

            {scopeDir ? (
              <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                    {scopeDir}
                  </span>
                  <span className="truncate text-12 text-[var(--text-tertiary)]">
                    {t('settings.ghosts.projectBanner.desc')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handlePickScope(null)}
                  className="shrink-0 rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
                >
                  {t('settings.ghosts.projectBanner.backToGlobal')}
                </button>
              </div>
            ) : null}

            <section className="plugin-motion-page-section mt-6 min-w-0">
              <div className="mb-4 flex items-baseline gap-2">
                <h2 className="text-20 font-medium text-[var(--text-primary)]">
                  {t('settings.ghosts.page.installedSection')}
                </h2>
                <span className="text-13 tabular-nums text-[var(--text-tertiary)]">
                  {searchedInstalledItems.length}
                </span>
              </div>

              {legacyRecoveryStatus ? (
                <LegacyGhostRecoveryNotice
                  status={legacyRecoveryStatus}
                  retrying={legacyRecoveryRetrying}
                  onRetry={() => void handleRetryLegacyRecovery()}
                />
              ) : null}

              {bannerVisible ? (
                <div className="mb-4 flex items-center gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)]">
                    <ArrowUp size={16} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-13 font-medium text-[var(--text-primary)]">
                      {t('settings.ghosts.page.updatesAvailable', {
                        count: updatableInstalledItems.length,
                      })}
                    </p>
                    <p className="truncate text-12 text-[var(--text-secondary)]">
                      {updatableInstalledItems
                        .map((item) => `${item.name} v${item.marketUpdate?.version ?? ''}`)
                        .join(' · ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleIgnoreRound}
                    className="shrink-0 rounded-full px-3 py-1.5 text-12 text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {t('settings.ghosts.page.ignoreRound')}
                  </button>
                  {/* 单项更新在飞时禁用:与 handleUpdateAll 的守卫同因,按钮如实变灰。 */}
                  <button
                    type="button"
                    onClick={handleUpdateAll}
                    disabled={marketBusyId !== null}
                    className="inline-flex h-9 shrink-0 items-center rounded-full bg-[var(--accent-cta-bg)] px-4 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-transform duration-150 hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {t('settings.ghosts.page.updateAll')}
                  </button>
                </div>
              ) : null}

              {primaryInstalledItems.length > 0 ? (
                <>
                  <div className={cn('plugin-motion-stagger', PLUGIN_INSTALLED_CARD_GRID_CLASS)}>
                    {primaryInstalledItems.map((item) => (
                      <GhostPluginCard
                        key={item.id}
                        item={item}
                        sourceLabel={t(`settings.ghosts.page.origin.${item.origin}`)}
                        updateVersion={item.marketUpdate?.version}
                        updateBusy={
                          (item.marketUpdate !== null && marketBusyId !== null) || batchRunning
                        }
                        onUpdate={
                          item.marketUpdate ? () => void handleMarketUpdate(item.id) : undefined
                        }
                        effectiveEnabled={effectiveEnabled(item.id, item.enabled)}
                        onPrimary={() => handlePrimaryAction(item)}
                        onManage={() => setSelectedId(item.id)}
                        onIconLoadError={handleMarketIconLoadError}
                      />
                    ))}
                  </div>
                  {additionalInstalledItems.length > 0 ? (
                    <InstalledPluginOverflow id={installedOverflowId} expanded={installedExpanded}>
                      <div
                        className={cn(
                          PLUGIN_INSTALLED_CARD_GRID_CLASS,
                          'plugin-installed-overflow-grid',
                          installedExpanded && 'plugin-motion-stagger',
                        )}
                      >
                        {additionalInstalledItems.map((item) => (
                          <GhostPluginCard
                            key={item.id}
                            item={item}
                            sourceLabel={t(`settings.ghosts.page.origin.${item.origin}`)}
                            updateVersion={item.marketUpdate?.version}
                            updateBusy={
                              (item.marketUpdate !== null && marketBusyId !== null) || batchRunning
                            }
                            onUpdate={
                              item.marketUpdate ? () => void handleMarketUpdate(item.id) : undefined
                            }
                            effectiveEnabled={effectiveEnabled(item.id, item.enabled)}
                            onPrimary={() => handlePrimaryAction(item)}
                            onManage={() => setSelectedId(item.id)}
                            onIconLoadError={handleMarketIconLoadError}
                          />
                        ))}
                      </div>
                    </InstalledPluginOverflow>
                  ) : null}
                </>
              ) : !legacyRecoveryStatus ? (
                <div className="rounded-xl border-[0.5px] border-[var(--border-default)] px-5 py-10 text-center">
                  <p className="text-13 text-[var(--text-secondary)]">
                    {installedItems.length === 0
                      ? t('settings.ghosts.empty')
                      : t('settings.ghosts.page.emptyFiltered')}
                  </p>
                  {installedItems.length === 0 ? (
                    <p className="mt-1.5 text-12 text-[var(--text-tertiary)]">
                      {t('settings.ghosts.emptyHint')}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {hiddenInstalledCount > 0 ? (
                <InstalledPluginDisclosure
                  expanded={installedExpanded}
                  controlsId={installedOverflowId}
                  totalCount={displayInstalledItems.length}
                  previewItems={additionalInstalledItems}
                  onToggle={() => setInstalledExpanded((expanded) => !expanded)}
                  onIconLoadError={handleMarketIconLoadError}
                />
              ) : null}
            </section>

            {availableMarketItems.length > 0 ||
            searchedAvailableMarketItems.length > 0 ||
            marketSnapshot?.unavailableReason ? (
              <section className="plugin-motion-page-section mt-10 min-w-0">
                <div className={PLUGIN_CATALOG_TOOLBAR_CLASS}>
                  {/* 推荐区标题不带数字(设计定稿):数量感由卡片自身传达。 */}
                  <h2 className="shrink-0 whitespace-nowrap text-20 font-medium text-[var(--text-primary)]">
                    {t('settings.ghosts.page.recommendedSection')}
                  </h2>
                  <div
                    className="plugin-catalog-filters flex min-w-0 max-w-full items-center gap-1"
                    role="group"
                    aria-label={t('settings.ghosts.page.filtersAria')}
                    style={WINDOW_NO_DRAG_STYLE}
                  >
                    {recommendedFilters.map((filter) => {
                      const selected = effectiveOriginFilter === filter;
                      const count =
                        filter === 'all'
                          ? searchedAvailableMarketItems.length
                          : recommendedCounts[filter];
                      return (
                        <button
                          key={filter}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setOriginFilter(filter)}
                          className={cn(
                            'shrink-0 select-none rounded-full border border-transparent px-3.5 py-2 text-12 transition-colors duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                            selected
                              ? 'plugin-motion-selected text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          {filter === 'all'
                            ? t('settings.ghosts.page.filterAll')
                            : t(`settings.ghosts.page.origin.${filter}`)}
                          <span className="ml-1.5 tabular-nums text-[var(--text-tertiary)]">
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {marketSnapshot?.unavailableReason ? (
                  <p className="mb-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12 text-[var(--text-secondary)]">
                    {t(
                      marketSnapshot.unavailableReason === 'authentication-required'
                        ? 'settings.ghosts.market.authenticationRequired'
                        : marketSnapshot.unavailableReason === 'not-configured'
                          ? 'settings.ghosts.market.notConfigured'
                          : 'settings.ghosts.market.unavailable',
                    )}
                  </p>
                ) : null}

                {availableMarketItems.length > 0 ? (
                  customGroups && customGroups.length > 1 ? (
                    <div className="flex flex-col gap-6">
                      {customGroups.map(([marketName, groupItems]) => (
                        <section key={marketName || 'unknown-source'}>
                          <header className="mb-3 flex items-baseline gap-2">
                            <h3 className="text-14 font-medium text-[var(--text-primary)]">
                              {marketName || t('settings.ghosts.page.origin.custom')}
                            </h3>
                            <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                              {groupItems.length}
                            </span>
                          </header>
                          <div
                            className={cn(
                              'plugin-motion-stagger',
                              PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
                            )}
                          >
                            {groupItems.map((item) => (
                              <MarketPluginCard
                                key={item.pluginId}
                                item={item}
                                busy={marketBusyId !== null}
                                onSelect={() => void handleSelectMarket(item.pluginId)}
                                onInstall={() => void handleInstallMarketItem(item.pluginId)}
                                onIconLoadError={handleMarketIconLoadError}
                              />
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                      {availableMarketItems.map((item) => (
                        <MarketPluginCard
                          key={item.pluginId}
                          item={item}
                          busy={marketBusyId !== null}
                          onSelect={() => void handleSelectMarket(item.pluginId)}
                          onInstall={() => void handleInstallMarketItem(item.pluginId)}
                          onIconLoadError={handleMarketIconLoadError}
                        />
                      ))}
                    </div>
                  )
                ) : marketSnapshot?.unavailableReason ? null : (
                  <div className="rounded-xl border-[0.5px] border-[var(--border-default)] px-5 py-10 text-center">
                    <p className="text-13 text-[var(--text-secondary)]">
                      {t('settings.ghosts.page.emptyFiltered')}
                    </p>
                  </div>
                )}
              </section>
            ) : null}
          </PluginManagementPage>
        </main>
        {panelAside}
      </div>
      <AddMarketplaceDialog
        open={addMarketplaceOpen}
        onOpenChange={setAddMarketplaceOpen}
        onSourcesChanged={() => void refreshMarket()}
      />
      {updateRows ? (
        <UpdateAllDialog
          open={updateDialogOpen}
          rows={updateRows}
          iconByGhostId={new Map(ghosts.map((ghost) => [ghost.manifest.id, ghost.iconDataUrl]))}
          onApprove={(pluginId) => void approveUpdateExpansion(pluginId)}
          onSkip={skipUpdateExpansion}
          onClose={() => setUpdateDialogOpen(false)}
        />
      ) : null}
    </PluginManagementLayout>
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
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={cn(
            'mt-4 inline-flex h-9 items-center rounded-full border border-[var(--border-default)] px-4 text-12 font-medium text-[var(--text-primary)]',
            'transition-[background-color,border-color,opacity,transform] duration-150 hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-55 disabled:active:scale-100',
          )}
        >
          {retrying
            ? t('settings.ghosts.legacyRecovery.retrying')
            : t('settings.ghosts.legacyRecovery.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function MarketPluginCard({
  item,
  busy,
  onSelect,
  onInstall,
  onIconLoadError,
}: {
  item: PluginMarketItem;
  busy: boolean;
  onSelect: () => void;
  /** 卡片直接安装；卡片正文、右侧空白与右上角箭头都进入详情。 */
  onInstall?: () => void;
  onIconLoadError: () => void;
}) {
  const { t } = useTranslation();
  const unavailable = busy || item.installState === 'conflict';
  const conflictDescriptionId = useId();
  const conflictDescription =
    item.installState === 'conflict' ? t('settings.ghosts.market.conflictDescription') : undefined;
  return (
    <article
      className={cn(
        'group flex min-h-[108px] w-full select-none items-start gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-px hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]',
        'active:translate-y-0 active:scale-[0.992] motion-reduce:transform-none motion-reduce:transition-none',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={unavailable}
        aria-label={item.name}
        aria-describedby={conflictDescription ? conflictDescriptionId : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-4 self-stretch text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          unavailable
            ? item.installState === 'conflict'
              ? 'cursor-not-allowed'
              : 'cursor-wait'
            : 'cursor-pointer',
        )}
      >
        <GhostPluginIcon
          iconDataUrl={item.icon?.url}
          iconId={item.ghostId}
          iconName={item.name}
          onIconLoadError={onIconLoadError}
        />
        <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
          <span className="truncate text-15 font-medium text-[var(--text-primary)]">
            {item.name}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-11 text-[var(--text-tertiary)]">
            <span className="shrink-0">
              {t(`settings.ghosts.page.origin.${pluginPresentationOrigin(item)}`)}
            </span>
            <span className="shrink-0" aria-hidden="true">
              ·
            </span>
            <span className="shrink-0">v{item.version}</span>
            <span className="shrink-0" aria-hidden="true">
              ·
            </span>
            <span className="min-w-0 truncate font-mono">{item.ghostId}</span>
            {item.author ? (
              <>
                <span className="shrink-0" aria-hidden="true">
                  ·
                </span>
                <span className="min-w-0 truncate">{item.author}</span>
              </>
            ) : null}
          </span>
          <span
            id={conflictDescription ? conflictDescriptionId : undefined}
            className="mt-1.5 line-clamp-2 text-13 leading-5 text-[var(--text-secondary)]"
          >
            {conflictDescription ?? (item.description || item.ghostId)}
          </span>
        </span>
      </button>
      <div className="relative flex min-h-[76px] min-w-8 shrink-0 flex-col items-end justify-end self-stretch">
        <button
          type="button"
          onClick={onSelect}
          disabled={unavailable}
          aria-label={t(
            item.installState === 'conflict'
              ? 'settings.ghosts.market.conflictAria'
              : 'settings.ghosts.market.detailsAria',
            { name: item.name },
          )}
          aria-describedby={conflictDescription ? conflictDescriptionId : undefined}
          className={cn(
            'group/market-details absolute inset-0 flex items-start justify-end rounded-xl text-[var(--text-tertiary)]',
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
        {item.installState === 'conflict' ? (
          <span
            role="status"
            className="relative z-[1] inline-flex h-8 shrink-0 select-none items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-11 font-medium text-[var(--text-secondary)]"
          >
            {t('settings.ghosts.market.conflict')}
          </span>
        ) : onInstall ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onInstall();
            }}
            disabled={unavailable}
            aria-label={t('settings.ghosts.page.installAria', { name: item.name })}
            aria-describedby={conflictDescription ? conflictDescriptionId : undefined}
            className={cn(
              'relative z-[1] inline-flex h-8 shrink-0 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)]',
              'transition-[background-color,border-color,transform,opacity] duration-150 hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {t('settings.ghosts.market.install')}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Plugin-specific creation and import actions rendered after the shared search. */
function GhostPluginActions({
  onInstall,
  onCreateWithCindy,
  onAddMarketplace,
}: {
  onInstall: () => void;
  onCreateWithCindy: () => void;
  onAddMarketplace: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'plugin-management-action-trigger group inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]',
            'transition-[background-color,border-color,transform] duration-150 ease-out',
            'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'data-[state=open]:border-[var(--text-tertiary)] data-[state=open]:bg-[var(--surface-chip)]',
          )}
          aria-label={t('settings.ghosts.page.addPluginAria')}
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">
            {t('settings.ghosts.page.addPlugin')}
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="plugin-management-action-chevron transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-max min-w-52 max-w-[calc(100vw-2rem)] rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
      >
        <DropdownMenuItem
          onSelect={onCreateWithCindy}
          className="h-10 gap-3 whitespace-nowrap rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Sparkles
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.page.createWithCindy')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
        <DropdownMenuItem
          onSelect={onInstall}
          className="h-10 gap-3 whitespace-nowrap rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Upload
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.install')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
        <DropdownMenuItem
          onSelect={onAddMarketplace}
          className="h-10 gap-3 whitespace-nowrap rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Store
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.market.sources.addMarketplace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 已安装插件卡片(设计定稿):
 * - 整卡可点 = 主动作(面板「使用」/ 指令「对话」/ 工具型与停用态进管理);
 * - 无启用开关(收进详情页);滑杆图标 = 管理入口;
 * - 更新 = 文字胶囊「更新到 vX」,无任何小圆点(绿点专职未读语义,PR-B 接入)。
 */
export function GhostPluginCard({
  item,
  sourceLabel,
  updateVersion,
  updateBusy = false,
  onUpdate,
  effectiveEnabled,
  onPrimary,
  onManage,
  onIconLoadError,
}: {
  item: GhostPluginListItem;
  sourceLabel?: string;
  /** 市场存在新版本时的目标版本;与 onUpdate 同时提供。 */
  updateVersion?: string;
  updateBusy?: boolean;
  onUpdate?: () => void;
  effectiveEnabled?: boolean;
  onPrimary: () => void;
  onManage: () => void;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  const enabled = effectiveEnabled ?? item.enabled;
  // 未读(badge 槽):单条卡片走**呼吸**点(AttentionDot 形态规范——聚合入口
  // 静态、单条呼吸)。有摘要时顶替静态描述:用户扫一眼就知道新内容是什么。
  const unread = useGhostUnread(item.id);
  const unreadSummary = useGhostUnreadSummary(item.id);
  const primary = ghostPrimaryAction(item);
  const cardAction = enabled && primary !== 'manage' ? onPrimary : onManage;
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    cardAction();
  };
  let primaryControl: ReactNode;
  if (!enabled) {
    primaryControl = (
      <CardPillButton onClick={onManage} label={t('settings.ghosts.page.manageAction')} />
    );
  } else if (primary === 'panel') {
    primaryControl = (
      <CardPillButton
        onClick={onPrimary}
        label={t('settings.ghosts.page.usePanelAction')}
        ariaLabel={t('settings.ghosts.page.useAria', { name: item.name })}
      />
    );
  } else if (primary === 'command') {
    primaryControl = (
      <CardPillButton
        onClick={onPrimary}
        icon={<MessageCircle size={13} aria-hidden="true" />}
        label={t('settings.ghosts.page.chatAction')}
        ariaLabel={t('settings.ghosts.page.chatAria', { name: item.name })}
      />
    );
  } else {
    primaryControl = (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-11 text-[var(--text-tertiary)]">
        <Bot size={13} aria-hidden="true" />
        {t('settings.ghosts.page.agentInvoked')}
      </span>
    );
  }
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={cardAction}
      onKeyDown={handleCardKeyDown}
      aria-label={item.name}
      className={cn(
        'group flex min-h-[108px] w-full cursor-pointer select-none items-start gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-px hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]',
        'active:translate-y-0 active:scale-[0.992]',
        'motion-reduce:transform-none motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        !enabled && 'opacity-60',
      )}
    >
      <GhostPluginIcon
        iconDataUrl={item.iconDataUrl}
        iconId={item.id}
        iconName={item.name}
        onIconLoadError={onIconLoadError}
      />
      <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-15 font-medium text-[var(--text-primary)]">
            {item.name}
          </span>
          {unread ? <AttentionDot breathing size={6} className="mt-px" /> : null}
        </span>
        <span className="mt-1 block min-w-0 truncate text-11 text-[var(--text-tertiary)]">
          {sourceLabel ? `${sourceLabel} · ` : ''}v{item.version}
          {!updateVersion ? (
            <span className="inline-flex items-center gap-1">
              {' · '}
              <Check size={11} className="inline" aria-hidden="true" />
              {t('settings.ghosts.page.upToDate')}
            </span>
          ) : null}
          {!enabled ? ` · ${t('settings.ghosts.disabledTag')}` : ''}
        </span>
        {/* 未读摘要顶替静态描述:静态描述用户早读过了,"新内容是什么"才是这一刻
            的信息。摘要文字提到 primary 档以区别于常态描述(不另加色,颜色语义
            留给那颗点)。 */}
        <span
          className={cn(
            'mt-1.5 line-clamp-2 text-13 leading-5',
            unreadSummary ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {unreadSummary || item.description || item.id}
        </span>
      </span>
      {/* 右列控制区:自行消费点击,不冒泡到整卡主动作(纯冒泡拦截层,无独立语义)。 */}
      <span
        className="flex shrink-0 flex-col items-end justify-between gap-2 self-stretch"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span className="flex items-center gap-1.5">
          {updateVersion && onUpdate ? (
            <button
              type="button"
              onClick={onUpdate}
              disabled={updateBusy}
              aria-label={t('settings.ghosts.page.updateAria', {
                name: item.name,
                version: updateVersion,
              })}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 text-11 font-medium text-[var(--text-primary)]',
                'transition-colors duration-150 hover:bg-[var(--surface-hover-soft)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:cursor-wait disabled:opacity-40',
              )}
            >
              <ArrowUp size={11} className="text-[var(--text-secondary)]" aria-hidden="true" />
              {t('settings.ghosts.page.updateTo', { version: updateVersion })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onManage}
            aria-label={t('settings.ghosts.page.manageAria', { name: item.name })}
            title={t('settings.ghosts.page.manageAction')}
            className="grid size-7 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
        </span>
        {primaryControl}
      </span>
    </article>
  );
}

function CardPillButton({
  onClick,
  label,
  icon,
  ariaLabel,
}: {
  onClick: () => void;
  label: string;
  icon?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-3.5 text-12 font-medium text-[var(--text-primary)]',
        'transition-[background-color,transform] duration-150 hover:bg-[var(--surface-hover)] active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
