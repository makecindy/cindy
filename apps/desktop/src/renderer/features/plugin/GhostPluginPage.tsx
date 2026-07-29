/**
 * Plugin catalog and detail coordinator backed by the latest Ghost host APIs.
 *
 * Inputs: installed Ghost snapshots and user actions.
 * Outputs: the Plugin list/detail UI, focus-stable installed queue, and Plugin action flows.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, ChevronUp, Plus, Sparkles, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
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
import { patchDraft } from '@/state/newMakerDraft';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { confirmAndInstallGhost, pickAndUpdateGhost } from '@/cindy-brain/installFlow';
import { GhostPermissionList, GhostUpdateReview } from '@/cindy-brain/GhostPermissionList';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { findSplitChildByPanelKind } from '../../../shared/layoutTree';
import { resolveSystemLocale } from '../../../shared/locale';
import {
  diffGhostPermissionItems,
  ghostPanelKind,
  ghostPermissionItems,
  type GhostSetupStatus,
} from '../../../shared/ghost';
import type {
  PluginMarketDetail,
  PluginMarketItem,
  PluginMarketSnapshot,
} from '../../../shared/pluginMarket';
import type { LegacyGhostRecoveryStatus } from '../../../shared/legacyGhostRecovery';
import {
  toGhostPluginDetail,
  toGhostPluginListItem,
  filterGhostPluginItems,
  marketPresentationForInstalledGhost,
  sortGhostPluginItemsByRecentUse,
  type GhostPluginListItem,
} from './lib/ghostPluginViewModel';
import { formatSetupGateDescription } from './lib/ghostSetupGateModel';
import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from './PluginManagementLayout';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import { GhostPluginIcon } from './GhostPluginIcon';
import { MarketPluginDetailView } from './MarketPluginDetailView';
import { PluginScopePicker, usePluginRecentWorkdirs } from './PluginScopePicker';
import {
  orderPluginCatalogItems,
  pluginPresentationOrigin,
  pluginUpdateForInstalledVersion,
  type PluginPresentationOrigin,
} from './lib/pluginMarketPresentation';
import { pluginMarketErrorKey } from './lib/pluginMarketErrorKey';
import { usePluginIconRefresh } from './lib/usePluginIconRefresh';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';
import { usePluginMarketLocaleRefresh } from './lib/usePluginMarketLocaleRefresh';
import './plugin-motion.css';

const MAX_VISIBLE_INSTALLED_GHOSTS = 5;
const PLUGIN_CATALOG_TOOLBAR_CLASS =
  'plugin-catalog-toolbar mb-5 flex items-center justify-between gap-4';
type PluginPresentationFilter = 'all' | PluginPresentationOrigin;
type PresentedGhostPluginItem = GhostPluginListItem & {
  origin: PluginPresentationOrigin;
  /** 市场存在更新时的市场记录;列表卡片据此显示更新徽标与直达入口。 */
  marketUpdate: PluginMarketItem | null;
};

const PRESENTATION_FILTERS: readonly PluginPresentationFilter[] = [
  'all',
  'public',
  'organization',
  'local',
];

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
  const installedGhostIdsKey = ghosts
    .map((ghost) => ghost.manifest.id)
    .sort()
    .join('\0');
  const installedGhostLocationsKey = ghosts
    .map((ghost) => `${ghost.manifest.id}\0${ghost.dir}`)
    .sort()
    .join('\0');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const [marketSnapshot, setMarketSnapshot] = useState<PluginMarketSnapshot | null>(null);
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
    // refreshMarket(true) reports an unavailable market by rejecting after preserving
    // the current snapshot; the state update already happened in refreshMarket.
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
  const marketItems = marketSnapshot?.items ?? [];
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
  const installedShortcutItems = useMemo(
    () => sortGhostPluginItemsByRecentUse(installedItems, recentGhostIds),
    [installedItems, recentGhostIds],
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
  const originFilters = useMemo(
    () =>
      showEnterprise
        ? PRESENTATION_FILTERS
        : PRESENTATION_FILTERS.filter((filter) => filter !== 'organization'),
    [showEnterprise],
  );
  const effectiveOriginFilter =
    !showEnterprise && originFilter === 'organization' ? 'all' : originFilter;
  const items = useMemo(
    () =>
      effectiveOriginFilter === 'all'
        ? searchedInstalledItems
        : searchedInstalledItems.filter((item) => item.origin === effectiveOriginFilter),
    [effectiveOriginFilter, searchedInstalledItems],
  );
  const availableMarketItems = useMemo(
    () =>
      effectiveOriginFilter === 'all'
        ? searchedAvailableMarketItems
        : searchedAvailableMarketItems.filter(
            (item) => pluginPresentationOrigin(item) === effectiveOriginFilter,
          ),
    [effectiveOriginFilter, searchedAvailableMarketItems],
  );
  const catalogItems = useMemo(
    () => orderPluginCatalogItems(marketItems, items, availableMarketItems),
    [availableMarketItems, items, marketItems],
  );
  const originCounts = useMemo(() => {
    const counts: Record<PluginPresentationOrigin, number> = {
      public: 0,
      organization: 0,
      local: 0,
    };
    for (const item of searchedInstalledItems) counts[item.origin] += 1;
    for (const item of searchedAvailableMarketItems) {
      counts[pluginPresentationOrigin(item)] += 1;
    }
    return counts;
  }, [searchedAvailableMarketItems, searchedInstalledItems]);
  const searchedItemCount = searchedInstalledItems.length + searchedAvailableMarketItems.length;
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

  const panelStatus = useMemo(() => {
    if (!selectedDetail || selectedDetail.panelMinWidth === null) return null;
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

  // 市场更新流程由列表卡片和详情页共用:先取目标 release 的完整 manifest 做
  // 权限 diff,经用户确认后才安装,不做静默升级。
  const handleMarketUpdate = useCallback(
    async (ghostId: string) => {
      const marketItem = marketByGhostId.get(ghostId);
      if (!marketItem || marketItem.installState !== 'update-available') return;
      const installedGhost = ghosts.find((ghost) => ghost.manifest.id === ghostId) ?? null;
      // 列表每张卡都有直达入口,同步互斥防止并发更新互相覆盖忙碌状态。
      const marketBusyLease = acquireMarketBusy(marketItem.pluginId);
      if (!marketBusyLease) return;
      try {
        const next = await window.electronAPI.pluginMarket.detail(marketItem.pluginId);
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        const diff = diffGhostPermissionItems(
          installedGhost?.manifest ?? next.manifest,
          next.manifest,
        );
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
        const result = await window.electronAPI.pluginMarket.install(marketItem.pluginId, {
          expectedReleaseId: next.releaseId,
          allowPermissionExpansion: diff.added.length > 0,
        });
        if (!isMarketBusyLeaseActive(marketBusyLease)) return;
        toast.success(
          t('settings.ghosts.toast.updated', {
            name: result.ghost.manifest.name,
            version: result.ghost.manifest.version,
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

  const handleInstall = useCallback(async () => {
    const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
    if (!picked || 'canceled' in picked) return;
    await confirmAndInstallGhost(picked.filePath, { t, confirm, confirmWithCheckbox });
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
    patchDraft({
      workingDir: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
    });
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
      patchDraft({
        workingDir: null,
        remoteHostId: null,
        deviceLinkDeviceId: null,
        deviceLinkDeviceName: null,
      });
      navigate('/cc-agent/new');
    },
    [confirm, ghosts, navigate, openGhostConfiguration, t],
  );

  const handleUse = useCallback(() => {
    if (selectedGhost && selectedDetail) {
      void handleUseGhost(selectedGhost.manifest.id, selectedDetail.name);
    }
  }, [handleUseGhost, selectedDetail, selectedGhost]);

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

  const handleInstallFromMarket = useCallback(async () => {
    if (!marketDetail) return;
    // 确认框等待期间也持有 lease。账号/模式切换会清除当前 lease,
    // 旧确认回调恢复后必须先验权,不能在新会话里继续安装。
    const marketBusyLease = acquireMarketBusy(marketDetail.pluginId);
    if (!marketBusyLease) return;
    // 详情页按钮在 update-available 态复用本入口,后端走原位更新并保留
    // 生效状态 —— 文案必须分支,不能对更新路径承诺"装完即开"(review P1)。
    const isUpdate = marketDetail.installState === 'update-available';
    // 装完即开意味着"确认安装"就是运行授权,确认框里必须如实展示权限清单
    // (与本地装入确认框同一信息量,review P1):首装展示完整清单,更新展示
    // 与已装版本的权限 diff,并据此决定 allowPermissionExpansion(否则扩权
    // 更新从本入口必被 main 的 PRECONDITION_FAILED 拦下)。更新详情来自 Main
    // 的现查事实,renderer 的 ghosts 推送缓存可能短暂滞后;仅在 update 态且缓存
    // 缺目标时,用既有 listSync 向 Main 现查一次。仍缺失说明状态已经变化,
    // 让后端按原有校验拒绝,绝不能拿新清单和自己做 diff 吞掉新增权限。
    let installedGhost =
      ghosts.find((ghost) => ghost.manifest.id === marketDetail.ghostId) ?? null;
    if (isUpdate && !installedGhost) {
      try {
        installedGhost =
          window.electronAPI.ghosts
            .listSync()
            .ghosts.find((ghost) => ghost.manifest.id === marketDetail.ghostId) ?? null;
      } catch {
        // bridge 不可用/状态切换时保持 null;下面不展示伪造的空 diff,
        // 安装调用也不放开 permission expansion,Main 会按真实状态 fail closed。
      }
    }
    if (isUpdate && !installedGhost) {
      // detail 仍说可更新、Main 的实时已装清单却没有目标:这是明确的状态
      // 变化,不要展示伪造的空 diff 后让用户确认一次必失败的更新。
      if (isMarketBusyLeaseActive(marketBusyLease)) {
        toast.error(t('settings.ghosts.market.errors.stateChanged'));
      }
      releaseMarketBusy(marketBusyLease);
      await refreshMarket();
      return;
    }
    const diff = isUpdate
      ? diffGhostPermissionItems(installedGhost!.manifest, marketDetail.manifest)
      : null;
    try {
      const confirmed = await confirm({
        title: isUpdate
          ? t('settings.ghosts.updateConfirm.title', { name: marketDetail.name })
          : t('settings.ghosts.market.installConfirmTitle', {
              name: marketDetail.name,
            }),
        description: isUpdate
          ? t('settings.ghosts.market.updateConfirmDescription')
          : t('settings.ghosts.market.installConfirmDescription'),
        // 限高与滚动交给共享 ConfirmDialog(max-h-[85vh] + 内部滚动区 + 打开时
        // 闪一下滚动条),这里不再自套一层 min(56vh,520px) —— 两层限高会让
        // "到底了没有"取决于内外层谁先触底(2026-07-27 收口)。
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
      const result = await window.electronAPI.pluginMarket.install(marketDetail.pluginId, {
        expectedReleaseId: marketDetail.releaseId,
        ...(isUpdate && diff!.added.length > 0
          ? { allowPermissionExpansion: true }
          : {}),
      });
      if (!isMarketBusyLeaseActive(marketBusyLease)) return;
      // 市场首装装完即开(2026-07-26 定案),toast 用"已安装";更新路径如实
      // 用"已更新"(生效状态未被改变)。
      toast.success(
        isUpdate
          ? t('settings.ghosts.toast.updated', {
              name: result.ghost.manifest.name,
              version: result.ghost.manifest.version,
            })
          : t('settings.ghosts.toast.installed', {
              name: result.ghost.manifest.name,
            }),
      );
      setMarketDetail(null);
      setSelectedId(result.ghost.manifest.id);
      await refreshMarket();
    } catch (error) {
      if (isMarketBusyLeaseActive(marketBusyLease)) {
        toast.error(t(pluginMarketErrorKey(error)));
      }
    } finally {
      releaseMarketBusy(marketBusyLease);
    }
  }, [
    acquireMarketBusy,
    confirm,
    ghosts,
    isMarketBusyLeaseActive,
    marketDetail,
    refreshMarket,
    releaseMarketBusy,
    t,
  ]);

  if (marketDetail) {
    return (
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
    );
  }

  if (selectedDetail) {
    return (
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
        onToggle={(enabled) => void handleToggle(selectedDetail.id, enabled, selectedDetail.name)}
        onUse={handleUse}
        onUpdate={() => void handleUpdate()}
        updateLabel={
          selectedMarketUpdate
            ? t('settings.ghosts.market.update')
            : undefined
        }
        updateVersion={
          selectedMarketUpdate?.version
        }
        updateBusy={selectedMarketUpdate !== null && marketBusyId !== null}
        onUninstall={() => void handleUninstall()}
        toggleDisabled={scopeDir !== null && selectedGhost !== null && !selectedGhost.enabled}
        onIconLoadError={handleMarketIconLoadError}
      />
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
        />
      }
    >
      <main className="min-h-0 w-full flex-1 overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]">
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

          {installedShortcutItems.length > 0 ? (
            <section className="plugin-motion-page-section mt-5 border-b-[0.5px] border-[var(--border-default)] pb-5">
              <div className="mb-1 flex items-baseline gap-2">
                <h2 className="text-13 font-medium text-[var(--text-secondary)]">
                  {t('settings.ghosts.page.installedTitle')}
                </h2>
                <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                  {installedShortcutItems.length}
                </span>
              </div>
              <InstalledGhostQueue
                items={installedShortcutItems}
                expanded={installedExpanded}
                onExpandedChange={setInstalledExpanded}
                onSelect={setSelectedId}
                onIconLoadError={handleMarketIconLoadError}
              />
            </section>
          ) : null}

          <section className="plugin-motion-page-section mt-6 min-w-0">
            <div className={PLUGIN_CATALOG_TOOLBAR_CLASS}>
              <div className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
                <h2 className="text-20 font-medium text-[var(--text-primary)]">
                  {t('settings.ghosts.page.allTitle')}
                </h2>
                <span className="text-13 tabular-nums text-[var(--text-tertiary)]">
                  {items.length + availableMarketItems.length}
                </span>
              </div>
              <div
                className="plugin-catalog-filters flex min-w-0 max-w-full items-center gap-1 overflow-x-auto"
                role="group"
                aria-label={t('settings.ghosts.page.filtersAria')}
                style={WINDOW_NO_DRAG_STYLE}
              >
                {originFilters.map((filter) => {
                  const selected = effectiveOriginFilter === filter;
                  const count = filter === 'all' ? searchedItemCount : originCounts[filter];
                  return (
                    <button
                      key={filter}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setOriginFilter(filter)}
                      className={cn(
                        'shrink-0 select-none rounded-full px-3.5 py-2 text-12 transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        selected
                          ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
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

            {legacyRecoveryStatus ? (
              <LegacyGhostRecoveryNotice
                status={legacyRecoveryStatus}
                retrying={legacyRecoveryRetrying}
                onRetry={() => void handleRetryLegacyRecovery()}
              />
            ) : null}

            {catalogItems.length > 0 ? (
              <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                {catalogItems.map((catalogItem) =>
                  catalogItem.kind === 'installed' ? (
                    <GhostPluginCard
                      key={`installed:${catalogItem.item.id}`}
                      item={catalogItem.item}
                      sourceLabel={t(`settings.ghosts.page.origin.${catalogItem.item.origin}`)}
                      onSelect={() => setSelectedId(catalogItem.item.id)}
                      onAction={() =>
                        void handleUseGhost(catalogItem.item.id, catalogItem.item.name)
                      }
                      updateVersion={catalogItem.item.marketUpdate?.version}
                      updateBusy={catalogItem.item.marketUpdate !== null && marketBusyId !== null}
                      onUpdate={
                        catalogItem.item.marketUpdate
                          ? () => void handleMarketUpdate(catalogItem.item.id)
                          : undefined
                      }
                      effectiveEnabled={effectiveEnabled(
                        catalogItem.item.id,
                        catalogItem.item.enabled,
                      )}
                      toggleDisabled={scopeDir !== null && !catalogItem.item.enabled}
                      onToggle={(enabled) =>
                        void handleToggle(catalogItem.item.id, enabled, catalogItem.item.name)
                      }
                      onIconLoadError={handleMarketIconLoadError}
                    />
                  ) : (
                    <MarketPluginCard
                      key={`market:${catalogItem.item.pluginId}`}
                      item={catalogItem.item}
                      busy={marketBusyId !== null}
                      onSelect={() => void handleSelectMarket(catalogItem.item.pluginId)}
                      onIconLoadError={handleMarketIconLoadError}
                    />
                  ),
                )}
              </div>
            ) : !legacyRecoveryStatus ? (
              <div className="rounded-xl border-[0.5px] border-[var(--border-default)] px-5 py-10 text-center">
                <p className="text-13 text-[var(--text-secondary)]">
                  {installedItems.length === 0 && marketItems.length === 0
                    ? t('settings.ghosts.empty')
                    : t('settings.ghosts.page.emptyFiltered')}
                </p>
                {installedItems.length === 0 && marketItems.length === 0 ? (
                  <p className="mt-1.5 text-12 text-[var(--text-tertiary)]">
                    {t('settings.ghosts.emptyHint')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </PluginManagementPage>
      </main>
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
  onIconLoadError,
}: {
  item: PluginMarketItem;
  busy: boolean;
  onSelect: () => void;
  onIconLoadError: () => void;
}) {
  const { t } = useTranslation();
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
        disabled={busy || item.installState === 'conflict'}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          item.installState === 'conflict'
            ? 'disabled:cursor-not-allowed'
            : 'disabled:cursor-wait',
        )}
        aria-label={item.name}
      >
        <GhostPluginIcon
          iconDataUrl={item.icon?.url}
          iconId={item.ghostId}
          iconName={item.name}
          onIconLoadError={onIconLoadError}
        />
        <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-15 font-medium text-[var(--text-primary)]">
              {item.name}
            </span>
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
          <span className="mt-1.5 line-clamp-2 text-13 leading-5 text-[var(--text-secondary)]">
            {item.description || item.ghostId}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onSelect}
        disabled={busy || item.installState === 'conflict'}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 self-center rounded-lg border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)]',
          'transition-[background-color,border-color,transform,opacity] duration-150 hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        <ChevronRight size={13} aria-hidden="true" />
        {t(
          item.installState === 'conflict'
            ? 'settings.ghosts.market.conflict'
            : 'settings.ghosts.market.details',
        )}
      </button>
    </article>
  );
}

/** Plugin-specific creation and import actions rendered after the shared search. */
function GhostPluginActions({
  onInstall,
  onCreateWithCindy,
}: {
  onInstall: () => void;
  onCreateWithCindy: () => void;
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
        className="w-52 rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
      >
        <DropdownMenuItem
          onSelect={onCreateWithCindy}
          className="h-10 gap-3 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
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
          className="h-10 gap-3 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Upload
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.install')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact installed Plugin card. */
export function GhostPluginCard({
  item,
  sourceLabel,
  onSelect,
  onAction,
  onUpdate,
  updateVersion,
  updateBusy = false,
  onToggle,
  effectiveEnabled,
  toggleDisabled = false,
  onIconLoadError,
}: {
  item: GhostPluginListItem;
  sourceLabel?: string;
  onSelect: () => void;
  onAction: () => void;
  /** 市场存在新版本时的直达更新入口;与 updateVersion 同时提供。 */
  onUpdate?: () => void;
  updateVersion?: string;
  updateBusy?: boolean;
  onToggle?: (enabled: boolean) => void;
  effectiveEnabled?: boolean;
  toggleDisabled?: boolean;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article
      className={cn(
        'group flex min-h-[108px] w-full select-none items-start gap-4 rounded-xl border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-px hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]',
        'active:translate-y-0 active:scale-[0.992]',
        'motion-reduce:transform-none motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        aria-label={item.name}
      >
        <GhostPluginIcon
          iconDataUrl={item.iconDataUrl}
          iconId={item.id}
          iconName={item.name}
          onIconLoadError={onIconLoadError}
        />
        <span className="flex min-w-0 flex-1 flex-col self-stretch pt-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-15 font-medium text-[var(--text-primary)]">
              {item.name}
            </span>
            {updateVersion ? (
              <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 font-medium leading-4 text-[var(--text-secondary)]">
                {t('settings.ghosts.market.updateAvailable')}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-11 text-[var(--text-tertiary)]">
            {sourceLabel ? (
              <>
                <span>{sourceLabel}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span>v{item.version}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono">{item.id}</span>
          </span>
          <span className="mt-1.5 line-clamp-2 text-13 leading-5 text-[var(--text-secondary)]">
            {item.description || item.id}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2 self-center">
        {onToggle ? (
          <Switch
            checked={effectiveEnabled ?? item.enabled}
            disabled={toggleDisabled}
            onCheckedChange={onToggle}
            aria-label={t('settings.ghosts.enableAria', { name: item.name })}
          />
        ) : null}
        {updateVersion && onUpdate ? (
          <button
            type="button"
            onClick={onUpdate}
            disabled={updateBusy}
            className={cn(
              'inline-flex h-8 shrink-0 items-center justify-center self-center rounded-lg border border-[var(--border-default)] bg-transparent px-3 text-12 font-medium text-[var(--text-primary)]',
              'transition-[background-color,border-color,transform,opacity] duration-150',
              'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:cursor-wait disabled:opacity-40 disabled:active:scale-100',
            )}
            aria-label={t('settings.ghosts.market.updateAria', { name: item.name })}
          >
            {t('settings.ghosts.market.updateAction')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onAction}
            disabled={!(effectiveEnabled ?? item.enabled) || !item.canUse}
            className={cn(
              'inline-flex h-8 shrink-0 items-center justify-center self-center rounded-lg border border-[var(--border-default)] bg-transparent px-3 text-12 font-medium text-[var(--text-primary)]',
              'transition-[background-color,border-color,transform,opacity] duration-150',
              'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
            )}
            aria-label={t('settings.ghosts.page.useAria', { name: item.name })}
          >
            {t('settings.ghosts.page.useAction')}
          </button>
        )}
      </div>
    </article>
  );
}

export function InstalledGhostShortcut({
  item,
  onSelect,
  onIconLoadError,
}: {
  item: GhostPluginListItem;
  onSelect: (id: string) => void;
  onIconLoadError?: () => void;
}) {
  return (
    <Tip text={item.name} side="bottom" delay={250}>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        className={cn(
          'group flex w-16 shrink-0 justify-center rounded-[12px] px-2 py-2',
          'transition-transform duration-150 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          'motion-reduce:transform-none motion-reduce:transition-none',
        )}
        aria-label={item.name}
      >
        <GhostPluginIcon
          iconDataUrl={item.iconDataUrl}
          iconId={item.id}
          iconName={item.name}
          onIconLoadError={onIconLoadError}
        />
      </button>
    </Tip>
  );
}

/** Installed shortcuts share one wrapping queue in both collapsed and expanded states. */
export function InstalledGhostQueue({
  items,
  expanded,
  onExpandedChange,
  onSelect,
  onIconLoadError,
}: {
  items: readonly GhostPluginListItem[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (id: string) => void;
  onIconLoadError?: () => void;
}) {
  const { t } = useTranslation();
  const hasOverflow = items.length > MAX_VISIBLE_INSTALLED_GHOSTS;
  const visibleItems = expanded ? items : items.slice(0, MAX_VISIBLE_INSTALLED_GHOSTS);

  return (
    <div
      data-testid="installed-plugin-queue"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1',
        expanded && 'plugin-motion-stagger',
      )}
    >
      {visibleItems.map((item) => (
        <InstalledGhostShortcut
          key={item.id}
          item={item}
          onSelect={onSelect}
          onIconLoadError={onIconLoadError}
        />
      ))}
      {hasOverflow ? (
        <button
          key="installed-overflow-toggle"
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          className={cn(
            'group flex w-16 shrink-0 justify-center rounded-[12px] px-2 py-2',
            'transition-transform duration-150 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'motion-reduce:transform-none motion-reduce:transition-none',
          )}
          aria-expanded={expanded}
          aria-label={t(
            expanded
              ? 'settings.ghosts.page.installedCollapse'
              : 'settings.ghosts.page.installedExpand',
            { count: items.length - MAX_VISIBLE_INSTALLED_GHOSTS },
          )}
        >
          {expanded ? (
            <span className="flex size-12 items-center justify-center rounded-[22%] border-[0.5px] border-[color-mix(in_srgb,var(--border-default)_62%,transparent)] bg-[color-mix(in_srgb,var(--surface-chip)_58%,transparent)] text-[var(--text-secondary)] shadow-[var(--plugin-icon-shadow)] transition-colors duration-150 group-hover:bg-[color-mix(in_srgb,var(--surface-chip)_78%,transparent)]">
              <ChevronUp size={18} strokeWidth={1.8} aria-hidden="true" />
            </span>
          ) : (
            <span className="grid size-12 grid-cols-2 grid-rows-2 place-content-center gap-1 rounded-[22%] border-[0.5px] border-[color-mix(in_srgb,var(--border-default)_62%,transparent)] bg-[color-mix(in_srgb,var(--surface-chip)_58%,transparent)] p-2 shadow-[var(--plugin-icon-shadow)] transition-colors duration-150 group-hover:bg-[color-mix(in_srgb,var(--surface-chip)_78%,transparent)]">
              {items
                .slice(MAX_VISIBLE_INSTALLED_GHOSTS, MAX_VISIBLE_INSTALLED_GHOSTS + 3)
                .map((item) => (
                  <span
                    key={item.id}
                    className="flex size-3.5 items-center justify-center overflow-hidden rounded-[5px] bg-[var(--surface-elevated)]"
                  >
                    <GhostPluginIcon
                      iconDataUrl={item.iconDataUrl}
                      iconId={item.id}
                      iconName={item.name}
                      size="mini"
                      onIconLoadError={onIconLoadError}
                    />
                  </span>
                ))}
              <span className="col-start-2 row-start-2 flex size-3.5 items-center justify-center rounded-[5px] bg-[var(--surface-elevated)] text-[9px] font-medium tabular-nums text-[var(--text-secondary)]">
                +{items.length - MAX_VISIBLE_INSTALLED_GHOSTS}
              </span>
            </span>
          )}
        </button>
      ) : null}
    </div>
  );
}
