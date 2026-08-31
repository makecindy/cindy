import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Check,
  ChevronDown,
  Globe,
  MessageSquare,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NavigateFunction } from 'react-router-dom';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { consumeConversationSearchRequest } from '@/state/conversationSearchRequest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { searchConversations } from '@/lib/conversationSearchService';
import {
  mergeConversationSearchFanout,
  resolveConversationSearchOrigins,
  shouldReleaseConversationSearchLock,
  type ConversationSearchDevice,
} from '@/lib/conversationSearchFanout';
import {
  MACHINE_ALL,
  type MachineSelection,
} from '@/features/device-link/selectedMachineStore';
import { formatSidebarTime } from '../lib/formatSidebarTime';
import {
  getSearchSortBy,
  setSearchSortBy,
  subscribeSearchSortBy,
} from './conversationSearchPrefs';
import type {
  ConversationSearchAgentFilter,
  ConversationSearchLastActivityFilter,
  ConversationSearchResponse,
  ConversationSearchResultItem,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '../../../../shared/conversationSearch';
import { conversationSearchTitle } from '../../../../shared/conversationSearch';
import { highlightSegments } from '../lib/highlightSegments';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { conversationSearchResultKey } from '@/lib/conversationSearchFanout';
import {
  projectKeyComparisonKey,
  type ProjectNode as ProjectNodeData,
} from '../lib/projectGrouping';
import {
  buildProjectKeyComparisonSet,
  isProjectHidden,
} from '../lib/sidebarProjectVisibility';
import {
  getRemoteProjectMachineIdentity,
  projectDisplayLabelWithMachine,
} from '../lib/remoteProjectIdentity';

const DEBOUNCE_MS = 250;
const SEMANTIC_SEARCH_DEBOUNCE_MS = 900;
const SEARCH_LIMIT = 24;
const MAX_VISIBLE_HITS_PER_RESULT = 3;
const EMPTY_SESSION_IDS: string[] = [];
const EMPTY_SEARCH_DEVICES: ConversationSearchDevice[] = [];

type ProjectSelection = 'all' | string[];
type Option<T extends string> = {
  value: T;
  labelKey: string;
};

export function reconcileProjectSelectionWithVisibleProjects(
  selection: readonly string[],
  visibleProjects: readonly Pick<ProjectNodeData, 'projectKey'>[],
  localPlatform: string,
): string[] {
  const currentProjectKeyByComparison = new Map<string, string>();
  for (const project of visibleProjects) {
    const comparisonKey = projectKeyComparisonKey(project.projectKey, localPlatform);
    if (comparisonKey != null) currentProjectKeyByComparison.set(comparisonKey, project.projectKey);
  }

  const next: string[] = [];
  const seen = new Set<string>();
  for (const selectedProjectKey of selection) {
    const comparisonKey = projectKeyComparisonKey(selectedProjectKey, localPlatform);
    const currentProjectKey = comparisonKey == null
      ? null
      : currentProjectKeyByComparison.get(comparisonKey) ?? null;
    if (currentProjectKey == null || seen.has(currentProjectKey)) continue;
    seen.add(currentProjectKey);
    next.push(currentProjectKey);
  }
  return next;
}

/**
 * 排序三选项。与其它筛选选项同款:纯文字 + 选中勾,不配图标——它们只出现在筛选菜单的
 * 「排序」子菜单里(见 SearchFilterMenu),当前值已常显在父行右侧,图标不再承担区分职责。
 * (曾试过靶心/时钟系与箭头排序族图标,前者读不出排序,后者在收进子菜单后成了冗余。)
 */
const SORT_OPTIONS: ReadonlyArray<Option<ConversationSearchSortBy>> = [
  { value: 'relevance', labelKey: 'ccAgent.search.sort.relevance' },
  { value: 'activityDesc', labelKey: 'ccAgent.search.sort.activityDesc' },
  { value: 'activityAsc', labelKey: 'ccAgent.search.sort.activityAsc' },
];

const STATUS_OPTIONS: ReadonlyArray<Option<ConversationSearchStatusFilter>> = [
  { value: 'active', labelKey: 'ccAgent.sidebar.filterStatus.active' },
  { value: 'archived', labelKey: 'ccAgent.sidebar.filterStatus.archived' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterStatus.all' },
];

const AGENT_OPTIONS: ReadonlyArray<Option<ConversationSearchAgentFilter>> = [
  { value: 'all', labelKey: 'ccAgent.sidebar.filterVendor.all' },
  { value: 'cc', labelKey: 'ccAgent.sidebar.filterVendor.cc' },
  { value: 'codex', labelKey: 'ccAgent.sidebar.filterVendor.codex' },
  { value: 'pi', labelKey: 'ccAgent.sidebar.filterVendor.pi' },
];

const LAST_ACTIVITY_OPTIONS: ReadonlyArray<Option<ConversationSearchLastActivityFilter>> = [
  { value: '1d', labelKey: 'ccAgent.sidebar.filterLastActivity.1d' },
  { value: '3d', labelKey: 'ccAgent.sidebar.filterLastActivity.3d' },
  { value: '7d', labelKey: 'ccAgent.sidebar.filterLastActivity.7d' },
  { value: '30d', labelKey: 'ccAgent.sidebar.filterLastActivity.30d' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterLastActivity.all' },
];

const MENU_CONTENT_CLASS = cn(
  'w-[248px] rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1',
  'text-[var(--cmd-palette-item-text)] shadow-[var(--shadow-menu)]',
);

const SUB_CONTENT_CLASS = cn(
  'w-[240px] rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1',
  'text-[var(--cmd-palette-item-text)] shadow-[var(--shadow-menu)]',
);

const MENU_ROW_CLASS = cn(
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none',
  'text-[var(--cmd-palette-item-text)] transition-colors focus:bg-[var(--cmd-palette-item-hover)] data-[state=open]:bg-[var(--cmd-palette-item-hover)]',
);

const MENU_ITEM_CLASS = cn(
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none',
  'text-[var(--cmd-palette-item-text)] transition-colors focus:bg-[var(--cmd-palette-item-hover)]',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
);

export interface UseConversationSearchParams {
  /** 是否驱动搜索:popover 传 open,内联恒为 true。gate 掉搜索 effect 与结果重算。 */
  enabled: boolean;
  navigate: NavigateFunction;
  allKnownProjects: ProjectNodeData[];
  /** Kept for callers; explicit local/SSH project scope uses the project node sessions. */
  allowedSessionIds?: readonly string[];
  projectFilterRequest?: {
    projectKey: string;
    projectName: string;
    sessionIds: string[];
    workingDir?: string | null;
    deviceLinkDeviceId?: string | null;
    requestId: number;
  } | null;
  machineSelection?: MachineSelection;
  searchDevices?: readonly ConversationSearchDevice[];
  /** 收到「在此项目内搜索」请求(锁定项目)时回调:popover 用它打开面板,内联用它聚焦输入。 */
  onProgrammaticOpen?: () => void;
  /** 选中某条结果后回调(navigate 之前):popover 用它关闭面板并上报托盘。 */
  onResultChosen?: () => void;
}

/**
 * useConversationSearch —— 会话搜索状态机(query / 排序 / 筛选 / 项目锁定 / 两段防抖搜索)。
 * 从 ConversationSearchBox 抽出,供 popover 形态(rail 图标)与内联形态(展开侧栏首行)复用,
 * 保证两处搜索行为、防抖节奏、结果口径完全一致(不复制逻辑、不引入行为漂移)。
 * 排序选择跨会话记住(localStorage,见 conversationSearchPrefs);其余筛选每次回到默认。
 */
export function useConversationSearch({
  enabled,
  navigate,
  allKnownProjects,
  allowedSessionIds: _allowedSessionIds,
  projectFilterRequest,
  machineSelection = MACHINE_ALL,
  searchDevices = EMPTY_SEARCH_DEVICES,
  onProgrammaticOpen,
  onResultChosen,
}: UseConversationSearchParams) {
  const { t } = useTranslation();
  const localPlatform = window.electronAPI.platform;
  // 「尚未起名」会话的显示文案。main 拿它算标题匹配与命中下标、结果行拿它渲染
  // (两侧都过 conversationSearchTitle),所以它必须进请求 **和** effect 依赖:
  // 切语言后要重发一次搜索,否则下标还按旧语言的串算、高亮会错位。
  const unnamedLabel = t('ccAgent.common.unnamedSession');
  const [query, setQuery] = useState('');
  // 排序订阅共享偏好 store(持久化 + 跨实例同步),其余筛选每次回到默认
  // ——取舍与「为什么不是各自 useState」见 conversationSearchPrefs 的文件头。
  const sortBy = useSyncExternalStore(subscribeSearchSortBy, getSearchSortBy);
  const [statusFilter, setStatusFilter] = useState<ConversationSearchStatusFilter>('all');
  const [agentFilter, setAgentFilter] = useState<ConversationSearchAgentFilter>('all');
  const [lastActivityFilter, setLastActivityFilter] =
    useState<ConversationSearchLastActivityFilter>('all');
  const [projectSelection, setProjectSelection] = useState<ProjectSelection>('all');
  const [lockedProjectKey, setLockedProjectKey] = useState<string | null>(null);
  const [lockedProjectName, setLockedProjectName] = useState<string | null>(null);
  const [lockedProjectSessionIds, setLockedProjectSessionIds] = useState<string[]>([]);
  const [lockedProjectWorkingDir, setLockedProjectWorkingDir] = useState<string | null>(null);
  const [lockedProjectDeviceId, setLockedProjectDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [response, setResponse] = useState<ConversationSearchResponse | null>(null);
  const requestSeqRef = useRef(0);
  const semanticStartedSeqRef = useRef(0);
  const remoteResultsRef = useRef<ConversationSearchResultItem[]>([]);
  const requestProjectKey = projectFilterRequest?.projectKey ?? null;
  const requestProjectName = projectFilterRequest?.projectName ?? null;
  const requestProjectSessionIds = projectFilterRequest?.sessionIds ?? EMPTY_SESSION_IDS;
  const requestProjectWorkingDir = projectFilterRequest?.workingDir ?? null;
  const requestProjectDeviceId = projectFilterRequest?.deviceLinkDeviceId ?? null;
  const requestId = projectFilterRequest?.requestId ?? 0;

  const trimmed = query.trim();
  void _allowedSessionIds;
  const selectedProjectSessionIds = useMemo(() => {
    if (projectSelection === 'all') return null;
    const selected = buildProjectKeyComparisonSet(projectSelection, localPlatform);
    const selectedProjects = allKnownProjects.filter((project) => {
      const comparisonKey = projectKeyComparisonKey(project.projectKey, localPlatform);
      return comparisonKey != null && selected.has(comparisonKey);
    });
    let indexedSessionIds = selectedProjects
      .filter((project) => project.deviceLinkDeviceId == null)
      .flatMap((project) => project.sessions.map((session) => session.id));
    const lockedProjectComparisonKey = projectKeyComparisonKey(lockedProjectKey, localPlatform);
    const lockedMatchesSelection =
      lockedProjectComparisonKey != null &&
      selected.size === 1 &&
      selected.has(lockedProjectComparisonKey);
    if (
      indexedSessionIds.length === 0 &&
      !lockedProjectDeviceId &&
      lockedMatchesSelection &&
      lockedProjectSessionIds.length > 0
    ) {
      indexedSessionIds = lockedProjectSessionIds;
    }
    if (indexedSessionIds.length > 0) return indexedSessionIds;
    const selectedRemoteOnly =
      selectedProjects.some((project) => project.deviceLinkDeviceId != null) ||
      Boolean(lockedProjectDeviceId && lockedMatchesSelection);
    return selectedRemoteOnly ? null : [];
  }, [
    allKnownProjects,
    lockedProjectDeviceId,
    lockedProjectKey,
    lockedProjectSessionIds,
    localPlatform,
    projectSelection,
  ]);
  const selectedProjectTargets = useMemo(() => {
    if (projectSelection === 'all') return null;
    const selected = buildProjectKeyComparisonSet(projectSelection, localPlatform);
    const fromVisible = allKnownProjects
      .filter((project) => {
        const comparisonKey = projectKeyComparisonKey(project.projectKey, localPlatform);
        return comparisonKey != null && selected.has(comparisonKey);
      })
      .flatMap((project) => {
        const deviceId = project.deviceLinkDeviceId?.trim();
        const workingDir = project.workingDir?.trim();
        if (!deviceId || !workingDir) return [];
        return [{ deviceId, workingDir }];
      });
    if (fromVisible.length > 0) return fromVisible;
    const lockedComparison = projectKeyComparisonKey(lockedProjectKey, localPlatform);
    if (
      lockedProjectDeviceId &&
      lockedProjectWorkingDir &&
      lockedComparison &&
      selected.size === 1 &&
      selected.has(lockedComparison)
    ) {
      return [{
        deviceId: lockedProjectDeviceId,
        workingDir: lockedProjectWorkingDir,
      }];
    }
    return null;
  }, [
    allKnownProjects,
    localPlatform,
    lockedProjectDeviceId,
    lockedProjectKey,
    lockedProjectWorkingDir,
    projectSelection,
  ]);
  const searchOrigins = useMemo(
    () =>
      resolveConversationSearchOrigins({
        machineSelection,
        sessionIds: selectedProjectSessionIds,
        projectTargets: selectedProjectTargets,
        devices: searchDevices,
        getSessionDeviceId: (sessionId) => remoteProjectsStore.getSessionDeviceId(sessionId),
      }),
    [machineSelection, searchDevices, selectedProjectSessionIds, selectedProjectTargets],
  );
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (statusFilter !== 'all') count += 1;
    if (agentFilter !== 'all') count += 1;
    if (lastActivityFilter !== 'all') count += 1;
    if (projectSelection !== 'all') count += 1;
    return count;
  }, [agentFilter, lastActivityFilter, projectSelection, statusFilter]);

  useEffect(() => {
    if (!requestProjectKey) return;
    setLockedProjectKey(requestProjectKey);
    setLockedProjectName(requestProjectName);
    setLockedProjectSessionIds([...new Set(requestProjectSessionIds)]);
    setLockedProjectWorkingDir(requestProjectWorkingDir);
    setLockedProjectDeviceId(requestProjectDeviceId);
    setProjectSelection([requestProjectKey]);
    onProgrammaticOpen?.(); // popover:打开面板并上报托盘;内联:聚焦输入框
    setQuery('');
    setResponse(null);
    setStatus('idle');
    // 处理完即清零跨层请求:否则切到 rail(本组件卸载)再切回(重挂)时,本 effect 会在挂载
    // 阶段读到 stale current,把搜索框误弹出来(PR #246 review,镜像 pendingProjectFocus 的 consume)。
    consumeConversationSearchRequest();
  }, [
    requestId,
    requestProjectKey,
    requestProjectName,
    requestProjectSessionIds,
    requestProjectWorkingDir,
    requestProjectDeviceId,
    onProgrammaticOpen,
  ]);

  useEffect(() => {
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;
    semanticStartedSeqRef.current = 0;
    if (!enabled || !trimmed) {
      setStatus('idle');
      setResponse(null);
      return;
    }
    setStatus('searching');
    remoteResultsRef.current = [];
    const request = {
      query: trimmed,
      limit: SEARCH_LIMIT,
      sortBy,
      unnamedLabel,
      filters: {
        status: statusFilter,
        agentKind: agentFilter,
        lastActivity: lastActivityFilter,
        sessionIds: selectedProjectSessionIds,
      },
    } as const;
    const keywordTimer = window.setTimeout(() => {
      searchConversations({
        ...request,
        semanticMode: 'keyword',
      }, { origins: searchOrigins })
        .then((next) => {
          if (seq !== requestSeqRef.current) return;
          const remoteResults = next.remoteResults ?? next.results.filter((item) => item.session.deviceLinkDeviceId);
          remoteResultsRef.current = remoteResults;
          if (semanticStartedSeqRef.current === seq) {
            setResponse((current) => mergeConversationSearchFanout([
              {
                query: trimmed,
                results: (current?.results ?? []).filter((item) => !item.session.deviceLinkDeviceId),
                vectorUsed: current?.vectorUsed === true,
                vectorSkipReason: current?.vectorSkipReason ?? null,
                poolCapped: current?.poolCapped === true,
              },
              {
                query: trimmed,
                results: remoteResults,
                vectorUsed: false,
                vectorSkipReason: null,
                poolCapped: false,
              },
            ], SEARCH_LIMIT, sortBy));
            setStatus('done');
            return;
          }
          setResponse(next);
          setStatus('done');
        })
        .catch(() => {
          if (seq !== requestSeqRef.current) return;
          if (semanticStartedSeqRef.current === seq) return;
          setStatus('error');
        });
    }, DEBOUNCE_MS);
    const semanticTimer = window.setTimeout(() => {
      semanticStartedSeqRef.current = seq;
      searchConversations({
        ...request,
        semanticMode: 'hybrid',
      }, {
        origins: searchOrigins,
        reuseRemoteResults: remoteResultsRef.current,
      })
        .then((next) => {
          if (seq !== requestSeqRef.current) return;
          // Hybrid only refreshes local. Remotes stay on the keyword page;
          // merge the latest ref here so a slower local hybrid cannot wipe
          // hits that arrived after this request started.
          setResponse(mergeConversationSearchFanout([
            next,
            {
              query: trimmed,
              results: remoteResultsRef.current,
              vectorUsed: false,
              vectorSkipReason: null,
              poolCapped: false,
            },
          ], SEARCH_LIMIT, sortBy));
          setStatus('done');
        })
        .catch(() => {
          if (seq !== requestSeqRef.current) return;
          semanticStartedSeqRef.current = 0;
          setStatus((current) => current === 'searching' ? 'error' : current);
        });
    }, SEMANTIC_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(keywordTimer);
      window.clearTimeout(semanticTimer);
    };
  }, [
    agentFilter,
    lastActivityFilter,
    enabled,
    searchOrigins,
    selectedProjectSessionIds,
    selectedProjectTargets,
    sortBy,
    statusFilter,
    trimmed,
    unnamedLabel,
  ]);

  /**
   * 切换排序:写共享 store —— 立刻同步到所有挂载中的搜索实例(rail / 内联),
   * 并落 localStorage,下次打开搜索 / 重启客户端沿用同一排序。
   */
  const setSortBy = useCallback((next: ConversationSearchSortBy) => {
    setSearchSortBy(next);
  }, []);

  /** 清空 query / 结果 / 状态(popover 关闭时调用)。项目锁定保留。 */
  const reset = useCallback(() => {
    setQuery('');
    setResponse(null);
    setStatus('idle');
  }, []);

  /** 清除项目锁定,回到全局搜索(popover 触发钮点击时调用)。 */
  const clearLock = useCallback(() => {
    if (!lockedProjectKey) return;
    setLockedProjectKey(null);
    setLockedProjectName(null);
    setLockedProjectSessionIds([]);
    setLockedProjectWorkingDir(null);
    setLockedProjectDeviceId(null);
    setProjectSelection('all');
  }, [lockedProjectKey]);

  /** 筛选面板「重置」:清空各筛选;有项目锁定时回落到锁定项目。 */
  const resetFilters = useCallback(() => {
    setStatusFilter('all');
    setAgentFilter('all');
    setLastActivityFilter('all');
    setProjectSelection(lockedProjectKey ? [lockedProjectKey] : 'all');
  }, [lockedProjectKey]);

  const handleSelect = useCallback(
    async (
      item: ConversationSearchResultItem,
      hitOverride?: ConversationSearchResultItem['contentHit'],
    ) => {
      try {
        const remoteDeviceId = item.session.deviceLinkDeviceId;
        if (remoteDeviceId) {
          remoteProjectsStore.pinSessionOrigin(remoteDeviceId, item.session.id);
        }
        const baseRoute = await resolveSessionRoute(item.session.id, item.session);
        const hit = hitOverride ?? item.contentHit;
        // popover 形态:onResultChosen 关闭面板并通知托盘(SidebarActionBar 减 openChildCount),
        // 其 reset() 会清空 query。内联展开态不传 onResultChosen——选中结果后**刻意保留 query**,
        // 结果 overlay 继续显示,用户可连续点开多条结果;只有点搜索区域以外才收起(见 conversationSearchContext)。
        onResultChosen?.();
        navigate(baseRoute, {
          state: hit
            ? {
                searchJump: {
                  kind: 'conversation-search',
                  sessionId: item.session.id,
                  messageId: hit.messageId,
                  messageClientId: hit.messageClientId,
                },
              }
            : undefined,
        });
      } catch {
        setStatus('error');
      }
    },
    [navigate, onResultChosen],
  );

  const results = response?.results ?? [];

  return {
    query,
    setQuery,
    trimmed,
    sortBy,
    setSortBy,
    statusFilter,
    setStatusFilter,
    agentFilter,
    setAgentFilter,
    lastActivityFilter,
    setLastActivityFilter,
    projectSelection,
    setProjectSelection,
    lockedProjectKey,
    lockedProjectName,
    activeFilterCount,
    status,
    results,
    reset,
    clearLock,
    resetFilters,
    handleSelect,
  };
}

/**
 * SearchResultsBody —— 搜索结果区(空 / 加载 / 错误 / 无结果 / 结果列表)。
 * popover 与内联 overlay 共用;高度交由容器决定,`maxHeightClass` 供 popover 限高。
 */
export function SearchResultsBody({
  trimmed,
  status,
  results,
  onSelect,
  maxHeightClass,
}: {
  trimmed: string;
  status: 'idle' | 'searching' | 'done' | 'error';
  results: ConversationSearchResultItem[];
  onSelect: (item: ConversationSearchResultItem, hit?: ConversationSearchResultItem['contentHit']) => void;
  /** 结果列表滚动容器的高度约束(popover 传 max-h,内联铺满时省略)。 */
  maxHeightClass?: string;
}) {
  const { t } = useTranslation();
  if (!trimmed) {
    return (
      <div className="px-3 py-6 text-center text-12 text-[var(--cmd-palette-empty)]">
        {t('ccAgent.search.empty')}
      </div>
    );
  }
  if (status === 'searching') {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-6 text-12 text-[var(--cmd-palette-item-meta)]">
        <Spinner size={14} />
        {t('ccAgent.search.searching')}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="px-3 py-6 text-center text-12 text-[var(--error-fg)]">
        {t('ccAgent.search.failed')}
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-12 text-[var(--cmd-palette-empty)]">
        {t('ccAgent.search.noResults')}
      </div>
    );
  }
  return (
    <div className={cn('overflow-y-auto p-2', maxHeightClass)}>
      {results.map((item) => (
        <SearchResultRow
          key={conversationSearchResultKey(item)}
          item={item}
          query={trimmed}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export interface ConversationSearchBoxProps {
  navigate: NavigateFunction;
  allKnownProjects: ProjectNodeData[];
  allowedSessionIds: readonly string[];
  hiddenProjectKeys: ReadonlySet<string>;
  projectFilterRequest?: {
    projectKey: string;
    projectName: string;
    sessionIds: string[];
    workingDir?: string | null;
    deviceLinkDeviceId?: string | null;
    requestId: number;
  } | null;
  machineSelection?: MachineSelection;
  searchDevices?: readonly ConversationSearchDevice[];
  /** icon variant 触发钮 className 覆盖——rail 用 SIDEBAR_RAIL_ICON_BUTTON_CLASS。 */
  triggerClassName?: string;
  /** Popover open 态变化上报(供 SidebarActionBar 的 openChildCount 守卫;含程序化打开)。 */
  onOpenChange?: (open: boolean) => void;
}

/**
 * ConversationSearchBox —— rail(收窄)态的纯图标搜索钮 + Radix Popover 面板。
 * 展开侧栏改用内联搜索(SidebarInlineSearch),不再走本组件;这里只保留 rail 图标形态。
 * 搜索状态与结果渲染复用 useConversationSearch / SearchResultsBody。
 */
export function ConversationSearchBox({
  navigate,
  allKnownProjects,
  allowedSessionIds,
  hiddenProjectKeys,
  projectFilterRequest,
  machineSelection = MACHINE_ALL,
  searchDevices = EMPTY_SEARCH_DEVICES,
  triggerClassName,
  onOpenChange,
}: ConversationSearchBoxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // search.reset 在 search 声明后才拿得到,但 handleResultChosen 需先于 search 定义(要作为
  // 回调传入)——用 ref 转发,规避声明顺序的循环依赖。
  const searchResetRef = useRef<() => void>(() => {});

  const handleProgrammaticOpen = useCallback(() => {
    setOpen(true);
    onOpenChange?.(true); // 程序化打开:Radix 受控 open 不触发 onOpenChange,手动上报
  }, [onOpenChange]);
  const handleResultChosen = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
    // 程序化关闭 popover 不经 handleOpenChange(Radix 受控 open 不回调),必须在此显式 reset,
    // 否则去掉 handleSelect 的 setQuery('') 后,rail 选中结果重开 popover 会残留上次 query/结果。
    searchResetRef.current();
  }, [onOpenChange]);

  const search = useConversationSearch({
    enabled: open,
    navigate,
    allowedSessionIds,
    allKnownProjects,
    projectFilterRequest,
    machineSelection,
    searchDevices,
    onProgrammaticOpen: handleProgrammaticOpen,
    onResultChosen: handleResultChosen,
  });
  searchResetRef.current = search.reset;
  useEffect(() => {
    const lockedProjectKey = search.lockedProjectKey;
    if (lockedProjectKey) {
      if (
        isProjectHidden(
          lockedProjectKey,
          hiddenProjectKeys,
          window.electronAPI.platform,
        ) ||
        shouldReleaseConversationSearchLock({
          lockedProjectKey,
          visibleProjects: allKnownProjects,
          localPlatform: window.electronAPI.platform,
          machineSelection,
        })
      ) {
        search.reset();
        search.clearLock();
      }
      return;
    }
    if (search.projectSelection === 'all') return;
    const next = reconcileProjectSelectionWithVisibleProjects(
      search.projectSelection,
      allKnownProjects,
      window.electronAPI.platform,
    );
    if (
      next.length === search.projectSelection.length &&
      next.every((projectKey, index) => projectKey === search.projectSelection[index])
    ) return;
    search.setProjectSelection(next.length > 0 ? next : 'all');
  }, [
    allKnownProjects,
    hiddenProjectKeys,
    machineSelection,
    search.clearLock,
    search.lockedProjectKey,
    search.projectSelection,
    search.reset,
    search.setProjectSelection,
  ]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // Passive closes keep a project-menu lock; the global search trigger clears it explicitly.
      if (!next) search.reset();
      onOpenChange?.(next);
    },
    [onOpenChange, search],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Tip text={t('ccAgent.search.open')} side="right">
          <button
            type="button"
            onClick={search.clearLock}
            className={cn(
              triggerClassName ??
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-sidebar-item-hover',
            )}
            aria-label={t('ccAgent.search.open')}
          >
            <Search size={18} className="shrink-0" />
          </button>
        </Tip>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          'w-[min(640px,calc(100vw-32px))] rounded-xl border border-[var(--cmd-palette-border)]',
          'bg-[var(--cmd-palette-bg)] p-0 text-[var(--cmd-palette-item-text)] shadow-[var(--cmd-palette-shadow)]',
        )}
      >
        <div className="border-b border-[var(--cmd-palette-border)] p-2">
          <div className="flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3">
            <Search size={15} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
            <input
              ref={inputRef}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              placeholder={t('ccAgent.search.placeholder')}
              aria-label={t('ccAgent.search.placeholder')}
              className="min-w-0 flex-1 bg-transparent text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
            {search.query && (
              <Tip text={t('ccAgent.search.clear')} side="bottom">
                <button
                  type="button"
                  onClick={() => search.setQuery('')}
                  aria-label={t('ccAgent.search.clear')}
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-sidebar-item-hover hover:text-[var(--text-primary)]"
                >
                  <X size={13} />
                </button>
              </Tip>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <SearchFilterMenu
              status={search.statusFilter}
              agentKind={search.agentFilter}
              lastActivity={search.lastActivityFilter}
              projects={search.projectSelection}
              sortBy={search.sortBy}
              allKnownProjects={allKnownProjects}
              activeCount={search.activeFilterCount}
              lockedProjectKey={search.lockedProjectKey}
              lockedProjectName={search.lockedProjectName}
              onStatusChange={search.setStatusFilter}
              onAgentKindChange={search.setAgentFilter}
              onLastActivityChange={search.setLastActivityFilter}
              onProjectsChange={search.setProjectSelection}
              onSortChange={search.setSortBy}
              onReset={search.resetFilters}
            />
          </div>
        </div>
        <SearchResultsBody
          trimmed={search.trimmed}
          status={search.status}
          results={search.results}
          onSelect={search.handleSelect}
          maxHeightClass="max-h-[min(620px,calc(100vh-140px))]"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * SearchFilterMenu —— 搜索框旁**唯一**的选项钮:排序 + 各项筛选都收在这一个菜单里。
 * 排序曾是搜索框内并排的第二颗钮,已收进本菜单首行子菜单(2026-07 用户拍板):
 * 搜索框里只留一颗钮更干净,排序也不必在收起态用图标自证身份。
 * 排序**不计入** activeCount(它不收窄结果集,不该点亮「有筛选」红点);当前排序值
 * 常显在首行右侧,不用展开子菜单就能看到——这也是排序选项不需要图标的原因。
 */
export function SearchFilterMenu({
  status,
  agentKind,
  lastActivity,
  projects,
  sortBy,
  allKnownProjects,
  activeCount,
  lockedProjectKey,
  lockedProjectName,
  onStatusChange,
  onAgentKindChange,
  onLastActivityChange,
  onProjectsChange,
  onSortChange,
  onReset,
  compact,
  onOpenChange,
}: {
  status: ConversationSearchStatusFilter;
  agentKind: ConversationSearchAgentFilter;
  lastActivity: ConversationSearchLastActivityFilter;
  projects: ProjectSelection;
  sortBy: ConversationSearchSortBy;
  allKnownProjects: ProjectNodeData[];
  activeCount: number;
  lockedProjectKey: string | null;
  lockedProjectName: string | null;
  onStatusChange: (value: ConversationSearchStatusFilter) => void;
  onAgentKindChange: (value: ConversationSearchAgentFilter) => void;
  onLastActivityChange: (value: ConversationSearchLastActivityFilter) => void;
  onProjectsChange: (value: ProjectSelection) => void;
  onSortChange: (value: ConversationSearchSortBy) => void;
  onReset: () => void;
  /** 内嵌在搜索框内的紧凑形态:纯图标钮,无边框 / 标签,激活时右上角红点。 */
  compact?: boolean;
  /** 下拉开合上报(内联搜索框据此在菜单打开时保持展开态,不因失焦而收起)。 */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const localPlatform = window.electronAPI.platform;
  const statusValue = optionLabel(STATUS_OPTIONS, status, t);
  const agentValue = optionLabel(AGENT_OPTIONS, agentKind, t);
  const lastActivityValue = optionLabel(LAST_ACTIVITY_OPTIONS, lastActivity, t);
  const sortValue = optionLabel(SORT_OPTIONS, sortBy, t);
  const lockedProjectComparisonKey = projectKeyComparisonKey(lockedProjectKey, localPlatform);
  const lockedProject = lockedProjectComparisonKey
    ? allKnownProjects.find(
        (project) =>
          projectKeyComparisonKey(project.projectKey, localPlatform) ===
          lockedProjectComparisonKey,
      ) ?? null
    : null;
  const lockedProjectLabel = lockedProject
    ? projectDisplayLabelWithMachine(lockedProject)
    : lockedProjectName;
  const projectValue =
    lockedProjectKey && lockedProjectLabel
      ? lockedProjectLabel
      : projects === 'all'
      ? t('ccAgent.search.filter.allProjects')
      : t('ccAgent.sidebar.filterSelectedProjects', { count: projects.length });
  const selectedProjects =
    projects === 'all' ? null : buildProjectKeyComparisonSet(projects, localPlatform);
  const projectsLocked = lockedProjectKey !== null;

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // 排序也收在本菜单里,故 filterAria 文案本身多了 {{sort}} 段:整句由各语言自己
          // 决定语序与标点,不在代码里拼接多段译文(PR #963 review)。
          aria-label={t('ccAgent.search.filterAria', {
            sort: sortValue,
            status: statusValue,
            agent: agentValue,
            lastActivity: lastActivityValue,
            projects: projectValue,
          })}
          aria-pressed={activeCount > 0}
          className={
            compact
              ? cn(
                  SEARCH_TOOL_ICON_CLASS,
                  'relative',
                  activeCount > 0 && 'text-[var(--text-primary)]',
                )
              : cn(SEARCH_TOOL_BUTTON_CLASS, activeCount > 0 && 'bg-[var(--surface-chip)]')
          }
        >
          <SlidersHorizontal size={compact ? 14 : 13} className="shrink-0" />
          {compact ? (
            activeCount > 0 && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-[var(--status-bar-accent)]"
              />
            )
          ) : (
            <>
              <span className="truncate">
                {activeCount > 0
                  ? t('ccAgent.search.filter.active', { count: activeCount })
                  : t('ccAgent.search.filter.label')}
              </span>
              <ChevronDown size={13} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" sideOffset={6} className={MENU_CONTENT_CLASS}>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.search.filter.label')}
          </span>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onReset();
              }}
              className="shrink-0 rounded-full px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--text-primary)]"
            >
              {t('ccAgent.search.filter.reset')}
            </button>
          )}
        </div>

        {/* 排序放首行:先定「怎么排」,再谈「留哪些」;它总有值,也不参与 activeCount。 */}
        <MenuSubRow label={t('ccAgent.sidebar.filterSortByHeading')} value={sortValue}>
          {SORT_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={sortBy === option.value}
              onSelect={() => onSortChange(option.value)}
            />
          ))}
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterStatusHeading')} value={statusValue}>
          {STATUS_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={status === option.value}
              onSelect={() => onStatusChange(option.value)}
            />
          ))}
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterProjectsHeading')} value={projectValue}>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              if (projectsLocked) return;
              onProjectsChange('all');
            }}
            disabled={projectsLocked}
            className={MENU_ITEM_CLASS}
          >
            <span className="truncate">{t('ccAgent.search.filter.allProjects')}</span>
            {projects === 'all' && <Check size={15} className="ml-auto shrink-0 text-[var(--text-primary)]" />}
          </DropdownMenuItem>
          {allKnownProjects.length > 0 && (
            <DropdownMenuSeparator className="my-1 bg-[var(--cmd-palette-border)]" />
          )}
          <div className="max-h-[280px] overflow-y-auto">
            {allKnownProjects.map((project) => {
              const comparisonKey = projectKeyComparisonKey(project.projectKey, localPlatform);
              const selected = comparisonKey != null && (selectedProjects?.has(comparisonKey) ?? false);
              const remoteIdentity = getRemoteProjectMachineIdentity(project);
              return (
                <DropdownMenuItem
                  key={project.projectKey}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (projectsLocked) return;
                    onProjectsChange(
                      nextProjectSelection(projects, project.projectKey, localPlatform),
                    );
                  }}
                  disabled={projectsLocked}
                  className={MENU_ITEM_CLASS}
                >
                  {project.scope === 'remote' ? (
                    <Tip text={remoteIdentity?.displayLabel ?? project.remoteHostId ?? ''}>
                      <Globe
                        size={14}
                        strokeWidth={2}
                        className="shrink-0 text-[var(--folder-item-icon)]"
                      />
                    </Tip>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{project.displayName}</span>
                    {remoteIdentity ? (
                      <span className="block truncate text-xs text-[var(--cmd-palette-item-meta)]">
                        {remoteIdentity.displayLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                    {project.sessions.length}
                  </span>
                  {selected && <Check size={15} className="shrink-0 text-[var(--text-primary)]" />}
                </DropdownMenuItem>
              );
            })}
          </div>
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterAgentHeading')} value={agentValue}>
          {AGENT_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={agentKind === option.value}
              onSelect={() => onAgentKindChange(option.value)}
            />
          ))}
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterLastActivityHeading')} value={lastActivityValue}>
          {LAST_ACTIVITY_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={lastActivity === option.value}
              onSelect={() => onLastActivityChange(option.value)}
            />
          ))}
        </MenuSubRow>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuSubRow({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <span className="truncate">{label}</span>
        <span className="ml-auto max-w-[104px] truncate text-right text-[var(--cmd-palette-item-meta)]">
          {value}
        </span>
        <ChevronDown size={14} className="-rotate-90 shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={8} className={SUB_CONTENT_CLASS}>
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function SelectMenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={MENU_ITEM_CLASS}>
      <span className="truncate">{label}</span>
      {selected && <Check size={15} className="ml-auto shrink-0 text-[var(--text-primary)]" />}
    </DropdownMenuItem>
  );
}

function optionLabel<T extends string>(
  options: ReadonlyArray<Option<T>>,
  value: T,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(options.find((option) => option.value === value)?.labelKey ?? '');
}

function nextProjectSelection(
  prev: ProjectSelection,
  projectKey: string,
  localPlatform: string,
): ProjectSelection {
  if (prev === 'all') return [projectKey];
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  if (comparisonKey == null) return prev;
  if (prev.some((key) => projectKeyComparisonKey(key, localPlatform) === comparisonKey)) {
    const next = prev.filter(
      (key) => projectKeyComparisonKey(key, localPlatform) !== comparisonKey,
    );
    return next.length > 0 ? next : 'all';
  }
  return [...prev, projectKey];
}

function SearchResultRow({
  item,
  query,
  onSelect,
}: {
  item: ConversationSearchResultItem;
  query: string;
  onSelect: (item: ConversationSearchResultItem, hit?: ConversationSearchResultItem['contentHit']) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // 与 main 的匹配串同源:未起名会话在结果行里也不能露出英文哨兵,且 titleMatchIndices
  // 就是按这个串算出来的,换成原始 title 会让高亮下标错位。
  const displayTitle = conversationSearchTitle(item.session.title, t('ccAgent.common.unnamedSession'));
  const primaryHit = item.contentHit;
  const allHits = item.contentHits ?? (primaryHit ? [primaryHit] : []);
  const visibleHits = expanded ? allHits : allHits.slice(0, MAX_VISIBLE_HITS_PER_RESULT);
  const hiddenHitCount = Math.max(0, allHits.length - visibleHits.length);
  const subtitle = primaryHit
    ? renderSnippet(primaryHit.snippet, query) ?? renderKeywordHighlights(primaryHit.preview, query)
    : item.session.workingDir || '';
  const activityIso = item.session.updatedAt;
  const activityText = formatSidebarTime(activityIso, t);
  const sourceText = primaryHit ? searchSourceLabel(primaryHit, t) : t('ccAgent.search.source.titleOnly');
  const deviceLabel = item.session.deviceLinkDeviceName?.trim() || null;
  const meta = [
    sourceText,
    activityText,
    deviceLabel,
    item.session.workingDir,
  ].filter(Boolean).join(' · ');
  const tooltip = (
    <div className="space-y-2">
      <div className="font-medium leading-snug">{displayTitle}</div>
      {primaryHit?.preview && (
        <div className="border-t border-[var(--cmd-palette-border)] pt-2 text-12 leading-snug text-[var(--tooltip-text)]">
          {renderSnippet(primaryHit.snippet, query) ?? renderKeywordHighlights(primaryHit.preview, query)}
        </div>
      )}
    </div>
  );

  return (
    <div
      data-sidebar-session-row="true"
      data-session-id={item.session.id}
      className={cn(
        'rounded-lg transition-colors hover:bg-[var(--cmd-palette-item-hover)]',
      )}
    >
      <Tip text={tooltip} side="right" delay={250} contentClassName="max-w-[500px] break-words">
        <button
          type="button"
          onClick={() => { void onSelect(item); }}
          className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left"
        >
          <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--cmd-palette-item-icon)]">
            <MessageSquare size={13} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                {highlightSegments(displayTitle, item.titleMatchIndices)}
              </span>
              <Tip text={sourceText} side="top" delay={150}>
                <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 leading-none text-[var(--text-tertiary)]">
                  {t(`ccAgent.search.kind.${item.matchKind}`)}
                </span>
              </Tip>
            </div>
            {meta && (
              <div className="mt-1 truncate text-11 leading-none text-[var(--text-tertiary)]">
                {meta}
              </div>
            )}
            {visibleHits.length === 0 && subtitle && (
              <div className="mt-1.5 line-clamp-4 text-12 leading-snug text-[var(--text-secondary)]">
                {subtitle}
              </div>
            )}
          </div>
        </button>
      </Tip>
      {visibleHits.length > 0 && (
        <div className="mt-0.5 space-y-1 px-3 pb-2 pl-10">
          {visibleHits.map((hit) => (
            <SearchHitRow
              key={hit.messageId}
              hit={hit}
              query={query}
              onSelect={() => { void onSelect(item, hit); }}
            />
          ))}
          {hiddenHitCount > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(true);
              }}
              className={cn(
                'flex w-full items-center rounded-md border border-transparent px-2 py-1.5 text-left',
                'text-10 leading-none text-[var(--text-tertiary)]',
                'transition-colors hover:border-[var(--border-default)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)]',
              )}
            >
              {t('ccAgent.search.moreHits', { count: hiddenHitCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SearchHitRow({
  hit,
  query,
  onSelect,
}: {
  hit: NonNullable<ConversationSearchResultItem['contentHit']>;
  query: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const sourceText = searchSourceLabel(hit, t);
  const content = renderSnippet(hit.snippet, query) ?? renderKeywordHighlights(hit.preview, query);
  const hitTime = formatSidebarTime(hit.createdAt, t);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cn(
        'flex w-full items-start rounded-md border border-transparent px-2 py-1.5 text-left',
        'transition-colors hover:border-[var(--border-default)] hover:bg-[var(--surface-elevated)]',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block line-clamp-2 text-12 leading-snug text-[var(--text-secondary)]">
          {content}
        </span>
        <span className="mt-0.5 block truncate text-10 leading-none text-[var(--text-tertiary)]">
          {hitTime} · {sourceText}
        </span>
      </span>
    </button>
  );
}

function searchSourceLabel(
  hit: NonNullable<ConversationSearchResultItem['contentHit']>,
  t: (key: string) => string,
): string {
  if (hit.ftsRank !== null && hit.vectorRank !== null) return t('ccAgent.search.source.keywordAndSemantic');
  if (hit.ftsRank !== null) return t('ccAgent.search.source.keyword');
  if (hit.vectorRank !== null) return t('ccAgent.search.source.semantic');
  return t('ccAgent.search.source.content');
}

function renderSnippet(snippet: string | null | undefined, query: string): React.ReactNode | null {
  const text = snippet?.trim();
  if (!text) return null;
  const parts = text.split(/(<\/?mark>)/g);
  const out: React.ReactNode[] = [];
  let marked = false;
  parts.forEach((part, index) => {
    if (!part) return;
    if (part === '<mark>') {
      marked = true;
      return;
    }
    if (part === '</mark>') {
      marked = false;
      return;
    }
    if (marked) {
      out.push(
        <mark key={`${index}-${part}`} className={SEARCH_MARK_CLASS}>
          {part}
        </mark>,
      );
    } else {
      out.push(
        <Fragment key={`${index}-${part}`}>
          {renderKeywordHighlights(part, query)}
        </Fragment>,
      );
    }
  });
  return out.length > 0 ? out : null;
}

function renderKeywordHighlights(text: string, query: string): React.ReactNode {
  if (!text) return '';
  const ranges = keywordRanges(text, query);
  if (ranges.length === 0) return text;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) out.push(text.slice(cursor, range.start));
    out.push(
      <mark key={`${index}-${range.start}-${range.end}`} className={SEARCH_MARK_CLASS}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function keywordRanges(text: string, query: string): Array<{ start: number; end: number }> {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return [];

  const lowerText = text.toLocaleLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    const lowerToken = token.toLocaleLowerCase();
    let index = lowerText.indexOf(lowerToken);
    while (index >= 0) {
      const next = { start: index, end: index + token.length };
      if (!ranges.some((range) => rangesOverlap(range, next))) {
        ranges.push(next);
      }
      index = lowerText.indexOf(lowerToken, index + lowerToken.length);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

const SEARCH_MARK_CLASS =
  'rounded-[2px] bg-search-match-bg px-0.5 font-medium text-search-match-fg';

const SEARCH_TOOL_BUTTON_CLASS = cn(
  'flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-[var(--border-default)]',
  'bg-[var(--surface-elevated)] px-2.5 text-12 text-[var(--text-secondary)]',
  'transition-colors hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--text-primary)]',
);

/** 紧凑形态:内嵌搜索框内的纯图标钮,无边框 / 无底色,hover 才起底(见 SidebarInlineSearch)。 */
const SEARCH_TOOL_ICON_CLASS = cn(
  'flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)]',
  'transition-colors hover:bg-sidebar-item-hover hover:text-[var(--text-primary)]',
);
