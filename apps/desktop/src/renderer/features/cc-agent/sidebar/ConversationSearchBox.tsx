import { TaskTagDots } from '@/features/task-tags/TaskTags';
import { parseConversationSearchQuery, setConversationSearchAll } from '@cindy/maker-shared/conversation-search';
import { getSearchDraft, getSearchMatchAll, setSearchDraft, setSearchMatchAll, subscribeSearchDraft } from './conversationSearchDraft';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
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
import { isSharedTaskPeer } from '@cindy/device-link';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import { sessionsStore } from '@/lib/sessionsStore';
import { toast } from '@/lib/toast';
import { prefetchDirtyWorktreeForRemoval } from '@/lib/worktreeRemovalWarning';
import { SessionRenameInput } from '../SessionRenameInput';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';
import { getSessionDisplayTitle, toStoredSessionTitle } from '../lib/sessionDisplayTitle';
import {
  finishSessionDrag,
  isSplitGroupDragSource,
  startSessionDrag,
} from '../splitGroupDnd';
import {
  canOpenSearchResultTaskMenu,
  CONVERSATION_SEARCH_KEEPALIVE_SELECTOR,
  shouldOpenSearchResultInNewWindow,
  useHydratedSearchSession,
  type SearchResultSelectOptions,
  type SearchResultTaskMenuActions,
} from './searchResultTaskMenuModel';
import {
  consumeConversationSearchRequest,
  type ConversationSearchScopeRequest,
} from '@/state/conversationSearchRequest';
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
import { MENU_ITEM_CLASS, MENU_ROW_CLASS } from './menuStyles';
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
import { parseSnippetMarkup } from './snippetMarkup';
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
import { keywordRanges } from './keywordRanges';
import { FilterReminderDot } from './FilterReminderDot';
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

export interface UseConversationSearchParams {
  /** 是否驱动搜索:popover 传 open,内联恒为 true。gate 掉搜索 effect 与结果重算。 */
  enabled: boolean;
  navigate: NavigateFunction;
  allKnownProjects: ProjectNodeData[];
  /** Kept for callers; explicit local/SSH project scope uses the project node sessions. */
  allowedSessionIds?: readonly string[];
  projectFilterRequest?: ConversationSearchScopeRequest | null;
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
  const query = useSyncExternalStore(subscribeSearchDraft, getSearchDraft);
  const menuMatchAll = useSyncExternalStore(subscribeSearchDraft, getSearchMatchAll);
  const matchAll = menuMatchAll || parseConversationSearchQuery(query).all;
  // The menu controls matching without rewriting the user's input. Encode it
  // only at the existing string-based request boundary for remote compatibility.
  const requestQuery = matchAll ? setConversationSearchAll(query.trim(), true) : query.trim();
  const [active, setActive] = useState(false);
  const resume = useCallback(() => setActive(true), []);
  const setQuery = useCallback((next: string) => {
    setSearchDraft(next);
    setActive(true);
  }, []);
  const setMatchAll = useCallback((next: boolean) => {
    setSearchMatchAll(next);
    if (!next && parseConversationSearchQuery(query).all) {
      setSearchDraft(setConversationSearchAll(query, false));
    }
    setActive(true);
  }, [query]);
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
  const [lockedSessionGroup, setLockedSessionGroup] = useState<{
    name: string;
    sessionIds: string[];
    machineSelectionKey: string;
  } | null>(null);
  const [status, setStatus] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [response, setResponse] = useState<ConversationSearchResponse | null>(null);
  const requestSeqRef = useRef(0);
  const projectRequest = projectFilterRequest?.kind === 'session-group' ? null : projectFilterRequest;
  const groupRequest = projectFilterRequest?.kind === 'session-group' ? projectFilterRequest : null;
  const requestProjectKey = projectRequest?.projectKey ?? null;
  const requestProjectName = projectRequest?.projectName ?? null;
  const requestProjectSessionIds = projectFilterRequest?.sessionIds ?? EMPTY_SESSION_IDS;
  const requestProjectWorkingDir = projectRequest?.workingDir ?? null;
  const requestProjectDeviceId = projectRequest?.deviceLinkDeviceId ?? null;
  const requestGroupName = groupRequest?.groupName ?? null;
  const machineSelectionKey = JSON.stringify(
    machineSelection === MACHINE_ALL ? machineSelection : [...machineSelection].sort(),
  );
  const requestId = projectFilterRequest?.requestId ?? 0;

  const trimmed = active ? query.trim() : '';
  void _allowedSessionIds;
  const selectedProjectSessionIds = useMemo(() => {
    if (lockedSessionGroup) return lockedSessionGroup.sessionIds;
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
    if (indexedSessionIds.length > 0) return [...new Set(indexedSessionIds)].sort();
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
    lockedSessionGroup,
  ]);
  const selectedProjectTargets = useMemo(() => {
    if (lockedSessionGroup) return null;
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
    lockedSessionGroup,
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
  // Store refreshes rebuild arrays even when the actual search scope is unchanged.
  const searchScopeKey = JSON.stringify({
    origins: searchOrigins
      .map((origin) => ({
        ...origin,
        sessionIds: origin.sessionIds ? [...origin.sessionIds].sort() : null,
        workingDirs: origin.workingDirs ? [...origin.workingDirs].sort() : null,
      }))
      .sort((a, b) => {
        const aKey = a.kind === 'local' ? '' : a.deviceId;
        const bKey = b.kind === 'local' ? '' : b.deviceId;
        return aKey.localeCompare(bKey);
      }),
    sessionIds: selectedProjectSessionIds,
  });
  const activeFilterCount = useMemo(() => {
    let count = matchAll ? 1 : 0;
    if (statusFilter !== 'all') count += 1;
    if (agentFilter !== 'all') count += 1;
    if (lastActivityFilter !== 'all') count += 1;
    if (projectSelection !== 'all' || lockedSessionGroup) count += 1;
    return count;
  }, [agentFilter, lastActivityFilter, projectSelection, statusFilter, lockedSessionGroup, matchAll]);

  useEffect(() => {
    if (!requestProjectKey && requestGroupName === null) return;
    setLockedSessionGroup(
      requestGroupName === null ? null : {
        name: requestGroupName,
        sessionIds: [...new Set(requestProjectSessionIds)].sort(),
        machineSelectionKey,
      },
    );
    setLockedProjectKey(requestProjectKey);
    setLockedProjectName(requestProjectName);
    setLockedProjectSessionIds([...new Set(requestProjectSessionIds)]);
    setLockedProjectWorkingDir(requestProjectWorkingDir);
    setLockedProjectDeviceId(requestProjectDeviceId);
    setProjectSelection(requestProjectKey ? [requestProjectKey] : 'all');
    onProgrammaticOpen?.(); // popover:打开面板并上报托盘;内联:聚焦输入框
    setActive(true);
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
    requestGroupName,
    machineSelectionKey,
    onProgrammaticOpen,
  ]);

  useEffect(() => {
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;
    if (!enabled || !trimmed) {
      setStatus('idle');
      setResponse(null);
      return;
    }
    setStatus('searching');
    const scope = JSON.parse(searchScopeKey) as {
      origins: ReturnType<typeof resolveConversationSearchOrigins>;
      sessionIds: string[] | null;
    };
    const request = {
      query: requestQuery,
      limit: SEARCH_LIMIT,
      sortBy,
      unnamedLabel,
      filters: {
        status: statusFilter,
        agentKind: agentFilter,
        lastActivity: lastActivityFilter,
        sessionIds: scope.sessionIds,
      },
    } as const;
    let keywordPage: ConversationSearchResponse | null = null;
    let semanticPage: ConversationSearchResponse | null = null;
    let keywordSettled = false;
    const hasLocalOrigin = !parseConversationSearchQuery(requestQuery).explicit
      && scope.origins.some((origin) => origin.kind === 'local');
    let semanticSettled = !hasLocalOrigin;
    const publishResults = () => {
      if (seq !== requestSeqRef.current) return;
      const localPage = semanticPage ?? keywordPage;
      if (!localPage) {
        if (keywordSettled && semanticSettled) setStatus('error');
        return;
      }
      // Only a completed hybrid page supersedes local keyword hits. Remote
      // hits always come from the keyword page, regardless of completion order.
      const next = mergeConversationSearchFanout(
        [
          {
            ...localPage,
            results: localPage.results.filter((item) => !item.session.deviceLinkDeviceId),
          },
          {
            query: trimmed,
            results:
              keywordPage?.remoteResults ??
              keywordPage?.results.filter((item) => item.session.deviceLinkDeviceId) ??
              [],
            vectorUsed: false,
            vectorSkipReason: null,
            poolCapped: keywordPage?.poolCapped ?? false,
          },
        ],
        SEARCH_LIMIT,
        sortBy,
      );
      // Empty results are definitive only after every applicable stage settles.
      // Either keyword or semantic search may still contribute a late hit.
      if (next.results.length === 0 && (!keywordSettled || !semanticSettled)) return;
      setResponse(next);
      setStatus('done');
    };
    const keywordTimer = window.setTimeout(() => {
      searchConversations(
        {
          ...request,
          semanticMode: 'keyword',
        },
        { origins: scope.origins },
      )
        .then((next) => {
          keywordPage = next;
        })
        .catch(() => {})
        .finally(() => {
          keywordSettled = true;
          publishResults();
        });
    }, DEBOUNCE_MS);
    const semanticTimer = window.setTimeout(() => {
      if (!hasLocalOrigin) return;
      searchConversations(
        {
          ...request,
          semanticMode: 'hybrid',
        },
        {
          origins: scope.origins,
          reuseRemoteResults: [],
        },
      )
        .then((next) => {
          semanticPage = next;
        })
        .catch(() => {})
        .finally(() => {
          semanticSettled = true;
          publishResults();
        });
    }, SEMANTIC_SEARCH_DEBOUNCE_MS);
    return () => {
      requestSeqRef.current += 1;
      window.clearTimeout(keywordTimer);
      window.clearTimeout(semanticTimer);
    };
  }, [
    agentFilter,
    lastActivityFilter,
    enabled,
    searchScopeKey,
    sortBy,
    statusFilter,
    trimmed,
    requestQuery,
    unnamedLabel,
  ]);

  /**
   * 切换排序:写共享 store —— 立刻同步到所有挂载中的搜索实例(rail / 内联),
   * 并落 localStorage,下次打开搜索 / 重启客户端沿用同一排序。
   */
  const setSortBy = useCallback((next: ConversationSearchSortBy) => {
    setSearchSortBy(next);
  }, []);

  /** 收起结果，保留输入和项目锁定；只有用户清空输入时才删除草稿。 */
  const dismiss = useCallback(() => {
    setActive(false);
    setResponse(null);
    setStatus('idle');
  }, []);

  /** 清除项目或任务组锁定，回到全局搜索。 */
  const clearLock = useCallback(() => {
    if (!lockedProjectKey && !lockedSessionGroup) return;
    setLockedSessionGroup(null);
    setLockedProjectKey(null);
    setLockedProjectName(null);
    setLockedProjectSessionIds([]);
    setLockedProjectWorkingDir(null);
    setLockedProjectDeviceId(null);
    setProjectSelection('all');
  }, [lockedProjectKey, lockedSessionGroup]);

  // A group lock is an explicit snapshot, not a synthetic project. Changing the
  // machine scope releases it, just as leaving a locked project's machine does.
  useEffect(() => {
    if (!lockedSessionGroup || lockedSessionGroup.machineSelectionKey === machineSelectionKey) return;
    dismiss();
    clearLock();
  }, [lockedSessionGroup, machineSelectionKey, dismiss, clearLock]);

  /** 筛选面板「重置」:清空各筛选;有项目锁定时回落到锁定项目。 */
  const resetFilters = useCallback(() => {
    setMatchAll(false);
    setStatusFilter('all');
    setAgentFilter('all');
    setLastActivityFilter('all');
    setProjectSelection(lockedProjectKey ? [lockedProjectKey] : 'all');
  }, [lockedProjectKey, setMatchAll]);

  const handleSelect = useCallback(
    async (
      item: ConversationSearchResultItem,
      hitOverride?: ConversationSearchResultItem['contentHit'],
      options?: SearchResultSelectOptions,
    ) => {
      try {
        const remoteDeviceId = item.session.deviceLinkDeviceId;
        if (remoteDeviceId) {
          remoteProjectsStore.pinSessionOrigin(remoteDeviceId, item.session.id);
        }
        const hit = hitOverride ?? item.contentHit;
        if (options?.openInNewWindow) {
          const openInNewWindow = window.electronAPI?.maker?.openSessionInNewWindow;
          if (openInNewWindow) {
            onResultChosen?.();
            try {
              await openInNewWindow(
                item.session.id,
                remoteDeviceId,
                hit?.messageClientId ?? null,
              );
            } catch {
              // Opening a secondary window is independent of search state; keep results intact.
            }
            return;
          }
        }
        const baseRoute = standardSessionRoute(item.session.id, remoteDeviceId);
        // popover 形态:onResultChosen 关闭面板并通知托盘(SidebarActionBar 减 openChildCount),
        // 两种形态都保留 query。内联展开态不传 onResultChosen，
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
    matchAll,
    setMatchAll,
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
    lockedSessionGroupName: lockedSessionGroup?.name ?? null,
    activeFilterCount,
    status,
    results,
    poolCapped: response?.poolCapped ?? false,
    dismiss,
    resume,
    clearLock,
    resetFilters,
    handleSelect,
  };
}

export type { SearchResultTaskMenuActions };

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
  leading,
  leadingCount = 0,
  poolCapped = false,
  taskMenu,
  statusFilter = 'all',
  onDragSessionStart,
  onDragSessionEnd,
}: {
  poolCapped?: boolean;
  trimmed: string;
  status: 'idle' | 'searching' | 'done' | 'error';
  results: ConversationSearchResultItem[];
  onSelect: (
    item: ConversationSearchResultItem,
    hit?: ConversationSearchResultItem['contentHit'],
    options?: SearchResultSelectOptions,
  ) => void;
  /** 结果列表滚动容器的高度约束(popover 传 max-h,内联铺满时省略)。 */
  maxHeightClass?: string;
  /** 排在会话结果之前的本地命中(伙伴 / 群聊);有命中时不显示「无结果」。 */
  leading?: React.ReactNode;
  leadingCount?: number;
  /** 任务右键菜单动作；省略时仅保留点击导航（如独立预览 fixture）。 */
  taskMenu?: SearchResultTaskMenuActions;
  /** 当前搜索的状态筛选；归档或恢复后立即按该口径过滤结果。 */
  statusFilter?: ConversationSearchStatusFilter;
  /** 拖拽开始/结束通知（供 rail Popover 在拖拽期间透明化并透传落点）。 */
  onDragSessionStart?: () => void;
  onDragSessionEnd?: (droppedInWindow: boolean) => void;
}) {
  const { t } = useTranslation();
  const [mutationState, setMutationState] = useState<{
    resultsRef: ConversationSearchResultItem[];
    localPatches: ReadonlyMap<string, Partial<Session>>;
    remotePatches: ReadonlyMap<string, Partial<Session>>;
    localDeletedIds: ReadonlySet<string>;
    remoteDeletedIds: ReadonlySet<string>;
  }>(() => ({
    resultsRef: results,
    localPatches: new Map(),
    remotePatches: new Map(),
    localDeletedIds: new Set(),
    remoteDeletedIds: new Set(),
  }));

  useEffect(() => {
    if (results.length === 0) return undefined;
    const localIds = new Set(
      results.filter((item) => !item.session.deviceLinkDeviceId).map((item) => item.session.id),
    );
    const remoteKeys = new Set(
      results
        .filter((item) => Boolean(item.session.deviceLinkDeviceId))
        .map((item) => `${item.session.deviceLinkDeviceId}:${item.session.id}`),
    );
    const remoteIds = new Set(
      results.filter((item) => Boolean(item.session.deviceLinkDeviceId)).map((item) => item.session.id),
    );
    const resetBase = () => ({
      resultsRef: results,
      localPatches: new Map<string, Partial<Session>>(),
      remotePatches: new Map<string, Partial<Session>>(),
      localDeletedIds: new Set<string>(),
      remoteDeletedIds: new Set<string>(),
    });
    const unsubLocal =
      localIds.size > 0
        ? sessionsStore.subscribePatches?.((sessionId, patch) => {
            if (!localIds.has(sessionId)) return;
            setMutationState((prev) => {
              const base = prev.resultsRef === results ? prev : resetBase();
              const nextPatches = new Map(base.localPatches);
              const existing = nextPatches.get(sessionId);
              nextPatches.set(sessionId, existing ? { ...existing, ...patch } : patch);
              const nextDeleted = new Set(base.localDeletedIds);
              if (patch.status === 'deleted') nextDeleted.add(sessionId);
              return {
                ...base,
                localPatches: nextPatches,
                localDeletedIds: nextDeleted,
              };
            });
          })
        : undefined;
    const unsubRemotePatch =
      remoteKeys.size > 0
        ? remoteProjectsStore.subscribePatches?.((deviceId, sessionId, patch) => {
            const key = `${deviceId}:${sessionId}`;
            if (!remoteKeys.has(key)) return;
            setMutationState((prev) => {
              const base = prev.resultsRef === results ? prev : resetBase();
              const nextPatches = new Map(base.remotePatches);
              const existing = nextPatches.get(key);
              nextPatches.set(key, existing ? { ...existing, ...patch } : patch);
              const nextDeleted = new Set(base.remoteDeletedIds);
              if (patch.status === 'deleted') nextDeleted.add(sessionId);
              return {
                ...base,
                remotePatches: nextPatches,
                remoteDeletedIds: nextDeleted,
              };
            });
          })
        : undefined;
    const unsubRemoteRemoved =
      remoteIds.size > 0
        ? remoteProjectsStore.subscribeRemoved?.((sessionId) => {
            if (!remoteIds.has(sessionId)) return;
            setMutationState((prev) => {
              const base = prev.resultsRef === results ? prev : resetBase();
              if (base.remoteDeletedIds.has(sessionId)) return base;
              const nextDeleted = new Set(base.remoteDeletedIds);
              nextDeleted.add(sessionId);
              return { ...base, remoteDeletedIds: nextDeleted };
            });
          })
        : undefined;
    return () => {
      unsubLocal?.();
      unsubRemotePatch?.();
      unsubRemoteRemoved?.();
    };
  }, [results]);

  const activeLocalPatches =
    mutationState.resultsRef === results ? mutationState.localPatches : null;
  const activeRemotePatches =
    mutationState.resultsRef === results ? mutationState.remotePatches : null;
  const activeLocalDeletedIds =
    mutationState.resultsRef === results ? mutationState.localDeletedIds : null;
  const activeRemoteDeletedIds =
    mutationState.resultsRef === results ? mutationState.remoteDeletedIds : null;

  const patchForItem = (item: ConversationSearchResultItem): Partial<Session> | undefined =>
    item.session.deviceLinkDeviceId
      ? activeRemotePatches?.get(`${item.session.deviceLinkDeviceId}:${item.session.id}`)
      : activeLocalPatches?.get(item.session.id);

  const visibleResults = useMemo(() => {
    if (results.length === 0) return results;
    return results.filter((item) => {
      const isRemote = Boolean(item.session.deviceLinkDeviceId);
      if (
        isRemote
          ? activeRemoteDeletedIds?.has(item.session.id)
          : activeLocalDeletedIds?.has(item.session.id)
      ) {
        return false;
      }
      const live = taskMenu?.resolveSession(item.session) ?? null;
      const patch = isRemote
        ? activeRemotePatches?.get(`${item.session.deviceLinkDeviceId}:${item.session.id}`)
        : activeLocalPatches?.get(item.session.id);
      const effectiveStatus = live?.status ?? patch?.status ?? item.session.status;
      if (effectiveStatus === 'deleted') return false;
      if (statusFilter !== 'all' && effectiveStatus !== statusFilter) return false;
      return true;
    });
  }, [
    activeLocalDeletedIds,
    activeLocalPatches,
    activeRemoteDeletedIds,
    activeRemotePatches,
    results,
    statusFilter,
    taskMenu,
  ]);

  if (trimmed && leadingCount > 0) {
    return (
      <div className={cn('overflow-y-auto p-2', maxHeightClass)}>
        {poolCapped && <p className="px-3 py-2 text-xs text-[var(--text-secondary)]">{t('ccAgent.search.match.partial')}</p>}
        {leading}
        {status === 'searching' ? (
          <div className="flex items-center justify-center gap-2 px-3 py-4 text-12 text-[var(--cmd-palette-item-meta)]">
            <Spinner size={14} />
            {t('ccAgent.search.searching')}
          </div>
        ) : status === 'error' ? (
          <ErrorNotice className="m-3" message={t('ccAgent.search.failed')} />
        ) : (
          visibleResults.map((item) => (
            <SearchResultRow
              key={conversationSearchResultKey(item)}
              item={item}
              query={trimmed}
              onSelect={onSelect}
              taskMenu={taskMenu}
              sessionPatch={patchForItem(item)}
              onDragSessionStart={onDragSessionStart}
              onDragSessionEnd={onDragSessionEnd}
            />
          ))
        )}
      </div>
    );
  }
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
      <ErrorNotice className="m-3" message={t('ccAgent.search.failed')} />
    );
  }
  if (visibleResults.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-12 text-[var(--cmd-palette-empty)]">
        {t(poolCapped ? 'ccAgent.search.match.partial' : 'ccAgent.search.noResults')}
      </div>
    );
  }
  return (
    <div className={cn('overflow-y-auto p-2', maxHeightClass)}>
      {poolCapped && <p className="px-3 py-2 text-xs text-[var(--text-secondary)]">{t('ccAgent.search.match.partial')}</p>}
      {visibleResults.map((item) => (
        <SearchResultRow
          key={conversationSearchResultKey(item)}
          item={item}
          query={trimmed}
          onSelect={onSelect}
          taskMenu={taskMenu}
          sessionPatch={patchForItem(item)}
          onDragSessionStart={onDragSessionStart}
          onDragSessionEnd={onDragSessionEnd}
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
  projectFilterRequest?: ConversationSearchScopeRequest | null;
  machineSelection?: MachineSelection;
  searchDevices?: readonly ConversationSearchDevice[];
  /** icon variant 触发钮 className 覆盖——rail 用 SIDEBAR_RAIL_ICON_BUTTON_CLASS。 */
  triggerClassName?: string;
  /** Popover open 态变化上报(供 SidebarActionBar 的 openChildCount 守卫;含程序化打开)。 */
  onOpenChange?: (open: boolean) => void;
  /** 挂载即打开:rail 从「更多」打开未勾选的搜索时,图标随打开一起出现。 */
  defaultOpen?: boolean;
  /** 搜索结果行的任务右键菜单动作（与侧栏任务右键一致）。 */
  taskMenu?: SearchResultTaskMenuActions;
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
  defaultOpen = false,
  taskMenu,
}: ConversationSearchBoxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const inputRef = useRef<HTMLInputElement>(null);

  // search.dismiss 在 search 声明后才拿得到,但 handleResultChosen 需先于 search 定义(要作为
  // 回调传入)——用 ref 转发,规避声明顺序的循环依赖。
  const searchDismissRef = useRef<() => void>(() => {});

  const handleProgrammaticOpen = useCallback(() => {
    setOpen(true);
    onOpenChange?.(true); // 程序化打开:Radix 受控 open 不触发 onOpenChange,手动上报
  }, [onOpenChange]);
  const handleResultChosen = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
    // 程序化关闭也收起结果，保留草稿供下次打开继续搜索。
    searchDismissRef.current();
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
  searchDismissRef.current = search.dismiss;
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
        search.dismiss();
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
    search.dismiss,
    search.setProjectSelection,
  ]);

  const [draggingResult, setDraggingResult] = useState(false);
  const dragFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      setDraggingResult(false);
      return;
    }
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(
    () => () => {
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    },
    [],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // Passive closes keep a project-menu lock; the global search trigger clears it explicitly.
      if (next) search.resume();
      else search.dismiss();
      onOpenChange?.(next);
    },
    [onOpenChange, search],
  );

  const handleDragSessionStart = useCallback(() => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      setDraggingResult(true);
    });
  }, []);

  const handleDragSessionEnd = useCallback(
    (droppedInWindow: boolean) => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      setDraggingResult(false);
      if (droppedInWindow) {
        handleOpenChange(false);
      }
    },
    [handleOpenChange],
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
        onContextMenu={(event) => event.stopPropagation()}
        onPointerDownOutside={(event) => {
          if (draggingResult) {
            event.preventDefault();
            return;
          }
          const target = event.target as Element | null;
          if (
            target?.closest(CONVERSATION_SEARCH_KEEPALIVE_SELECTOR) ||
            document.querySelector('[role="dialog"],[role="alertdialog"]')
          ) {
            event.preventDefault();
          }
        }}
        onFocusOutside={(event) => {
          if (draggingResult) {
            event.preventDefault();
            return;
          }
          const target = event.target as Element | null;
          if (
            target?.closest(CONVERSATION_SEARCH_KEEPALIVE_SELECTOR) ||
            document.querySelector('[role="dialog"],[role="alertdialog"]')
          ) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (draggingResult) {
            event.preventDefault();
            return;
          }
          const target = event.target as Element | null;
          if (
            target?.closest('[data-search-result-rename="true"]') ||
            document.querySelector('[role="dialog"],[role="alertdialog"]')
          ) {
            event.preventDefault();
          }
        }}
        className={cn(
          'z-float w-[min(640px,calc(100vw-32px))] rounded-xl border border-[var(--cmd-palette-border)]',
          'bg-[var(--cmd-palette-bg)] p-0 text-[var(--cmd-palette-item-text)] shadow-[shadow:var(--cmd-palette-shadow)]',
          draggingResult && 'pointer-events-none opacity-0',
        )}
      >
        <div className="border-b border-[var(--cmd-palette-border)] p-2">
          <div className="flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3">
            <Search size={15} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
            <input
              ref={inputRef}
              onFocus={search.resume}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              placeholder={t('ccAgent.search.placeholder')}
              aria-label={t('ccAgent.search.placeholder')}
              className="min-w-0 flex-1 bg-transparent text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)]"
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
              matchAll={search.matchAll}
              onMatchAllChange={search.setMatchAll}
              status={search.statusFilter}
              agentKind={search.agentFilter}
              lastActivity={search.lastActivityFilter}
              projects={search.projectSelection}
              sortBy={search.sortBy}
              allKnownProjects={allKnownProjects}
              activeCount={search.activeFilterCount}
              lockedProjectKey={search.lockedProjectKey}
              lockedProjectName={search.lockedProjectName}
              lockedSessionGroupName={search.lockedSessionGroupName}
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
          poolCapped={search.poolCapped}
          trimmed={search.trimmed}
          status={search.status}
          results={search.results}
          onSelect={search.handleSelect}
          maxHeightClass="max-h-[min(620px,calc(100vh-140px))]"
          taskMenu={taskMenu}
          statusFilter={search.statusFilter}
          onDragSessionStart={handleDragSessionStart}
          onDragSessionEnd={handleDragSessionEnd}
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
  matchAll = false,
  onMatchAllChange,
  status,
  agentKind,
  lastActivity,
  projects,
  sortBy,
  allKnownProjects,
  activeCount,
  lockedProjectKey,
  lockedProjectName,
  lockedSessionGroupName,
  onStatusChange,
  onAgentKindChange,
  onLastActivityChange,
  onProjectsChange,
  onSortChange,
  onReset,
  compact,
  onOpenChange,
}: {
  matchAll?: boolean;
  onMatchAllChange?: (value: boolean) => void;
  status: ConversationSearchStatusFilter;
  agentKind: ConversationSearchAgentFilter;
  lastActivity: ConversationSearchLastActivityFilter;
  projects: ProjectSelection;
  sortBy: ConversationSearchSortBy;
  allKnownProjects: ProjectNodeData[];
  activeCount: number;
  lockedProjectKey: string | null;
  lockedProjectName: string | null;
  lockedSessionGroupName?: string | null;
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
  const choosableProjects = allKnownProjects.filter((project) => !isTeammateProjectPath(project.workingDir) || project.sessions.some(session => !!session.companion?.taskProjectDir));
  const lockedProjectLabel = lockedProject
    ? projectDisplayLabelWithMachine(lockedProject)
    : lockedProjectName;
  const projectValue =
    lockedSessionGroupName ?? (
      lockedProjectKey && lockedProjectLabel
        ? lockedProjectLabel
        : projects === 'all'
          ? t('ccAgent.search.filter.allProjects')
          : t('ccAgent.sidebar.filterSelectedProjects', { count: projects.length })
    );
  const selectedProjects =
    projects === 'all' ? null : buildProjectKeyComparisonSet(projects, localPlatform);
  const projectsLocked = lockedProjectKey !== null || lockedSessionGroupName != null;

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
            activeCount > 0 && <FilterReminderDot />
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
      <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="w-[248px]">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.search.filter.label')}
          </span>
          {activeCount > 0 && (
            <Button
              variant="secondary"
              size="xxs"
              compact
              tone="quiet"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onReset();
              }}
            >
              {t('ccAgent.search.filter.reset')}
            </Button>
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

        {onMatchAllChange && (
          <MenuSubRow
            label={t('ccAgent.search.match.label')}
            value={t(matchAll ? 'ccAgent.search.match.all' : 'ccAgent.search.match.any')}
          >
            {[false, true].map((all) => (
              <SelectMenuItem
                key={String(all)}
                label={t(all ? 'ccAgent.search.match.all' : 'ccAgent.search.match.any')}
                selected={matchAll === all}
                onSelect={() => onMatchAllChange(all)}
              />
            ))}
            <DropdownMenuSeparator />
            <p className="max-w-64 px-2 py-1.5 text-xs text-[var(--text-secondary)]">{t('ccAgent.search.match.help')}</p>
          </MenuSubRow>
        )}

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
          {choosableProjects.length > 0 && (
            <DropdownMenuSeparator className="my-1 bg-[var(--cmd-palette-border)]" />
          )}
          <div className="max-h-[280px] overflow-y-auto">
            {choosableProjects.map((project) => {
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
      <DropdownMenuSubContent sideOffset={8} className="w-[240px]">
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
  taskMenu,
  sessionPatch,
  onDragSessionStart,
  onDragSessionEnd,
}: {
  item: ConversationSearchResultItem;
  query: string;
  onSelect: (
    item: ConversationSearchResultItem,
    hit?: ConversationSearchResultItem['contentHit'],
    options?: SearchResultSelectOptions,
  ) => void;
  taskMenu?: SearchResultTaskMenuActions;
  sessionPatch?: Partial<Session>;
  onDragSessionStart?: () => void;
  onDragSessionEnd?: (droppedInWindow: boolean) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [editValue, setEditValue] = useState('');
  const committedRef = useRef(false);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const dragStartTargetRef = useRef<Element | null>(null);
  const draggingActiveRef = useRef(false);
  const onDragSessionEndRef = useRef(onDragSessionEnd);
  onDragSessionEndRef.current = onDragSessionEnd;

  useEffect(
    () => () => {
      if (draggingActiveRef.current) {
        draggingActiveRef.current = false;
        onDragSessionEndRef.current?.(false);
      }
    },
    [],
  );

  const canOpenMenu = Boolean(taskMenu) && canOpenSearchResultTaskMenu(item.session);
  const liveSession = taskMenu?.resolveSession(item.session) ?? null;
  const remoteConnectionStatus =
    item.session.deviceLinkDeviceId && liveSession === null
      ? (taskMenu?.getRemoteConnectionStatus?.(item.session.deviceLinkDeviceId) ?? null)
      : null;
  const {
    session: resolvedSession,
    hydrationStatus,
    retryHydration,
    applyOutOfWindowPatch,
  } = useHydratedSearchSession({
    summary: item.session,
    liveSession,
    sessionPatch,
    menuOpen: menuPos !== null,
    remoteConnectionStatus,
  });

  const isSharedGuest = isSharedTaskPeer(resolvedSession.deviceLinkDeviceId ?? '');
  const remoteWritesBlocked = isSharedGuest || isRemoteSessionWriteBlocked(resolvedSession);
  const splitDragEnabled =
    !isSharedGuest &&
    menuPos === null &&
    isSplitGroupDragSource({
      editing: isEditing,
      orcaRole: resolvedSession.orcaRole,
      inSortableContainer: false,
    });

  const unnamedLabel = t('ccAgent.common.unnamedSession');
  // 与 main 的匹配串同源:未起名会话在结果行里也不能露出英文哨兵,且 titleMatchIndices
  // 就是按这个串算出来的,换成原始 title 会让高亮下标错位。重命名后关闭旧高亮下标。
  const displayTitle = conversationSearchTitle(resolvedSession.title, unnamedLabel);
  const titleMatchIndices =
    resolvedSession.title === item.session.title ? item.titleMatchIndices : [];
  const renamePrefillTitle = getSessionDisplayTitle(resolvedSession, unnamedLabel, t);
  const effectiveTags = resolvedSession.tags ?? item.session.tags;
  const effectiveWorkingDir = resolvedSession.workingDir;

  const primaryHit = item.contentHit;
  const allHits = item.contentHits ?? (primaryHit ? [primaryHit] : []);
  const visibleHits = expanded ? allHits : allHits.slice(0, MAX_VISIBLE_HITS_PER_RESULT);
  const hiddenHitCount = Math.max(0, allHits.length - visibleHits.length);
  const subtitle = primaryHit
    ? renderSnippet(primaryHit.snippet, query) ?? renderKeywordHighlights(primaryHit.preview, query)
    : effectiveWorkingDir || '';
  const activityIso = item.session.updatedAt;
  const activityText = formatSidebarTime(activityIso, t);
  const sourceText = primaryHit ? searchSourceLabel(primaryHit, t) : t('ccAgent.search.source.titleOnly');
  const deviceLabel = item.session.deviceLinkDeviceName?.trim() || null;
  const meta = [
    item.session.companion?.name,
    sourceText,
    activityText,
    deviceLabel,
    item.session.companion ? null : effectiveWorkingDir,
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

  const handleStartRename = useCallback(() => {
    setEditValue(renamePrefillTitle);
    committedRef.current = false;
    setIsEditing(true);
  }, [renamePrefillTitle]);

  const commitTitle = useCallback(
    (raw: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      const trimmedTitle = raw.trim();
      setIsEditing(false);
      const unchanged =
        !trimmedTitle ||
        trimmedTitle === renamePrefillTitle ||
        trimmedTitle === displayTitle ||
        trimmedTitle === resolvedSession.title;
      if (unchanged || !taskMenu) return;
      const prevTitle = resolvedSession.title;
      if (!liveSession && resolvedSession.deviceLinkDeviceId) {
        applyOutOfWindowPatch({ title: toStoredSessionTitle(resolvedSession, trimmedTitle) });
      }
      void Promise.resolve(taskMenu.onRename(resolvedSession.id, trimmedTitle, resolvedSession)).then(
        (ok) => {
          if (ok === false && !liveSession && resolvedSession.deviceLinkDeviceId) {
            applyOutOfWindowPatch({ title: prevTitle });
          }
        },
      );
    },
    [
      applyOutOfWindowPatch,
      displayTitle,
      liveSession,
      renamePrefillTitle,
      resolvedSession,
      taskMenu,
    ],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isEditing) {
        // 重命名输入框上的右键交给系统的可编辑菜单(剪切/复制/粘贴),只拦截冒泡。
        event.stopPropagation();
        return;
      }
      if (!canOpenMenu) return;
      event.preventDefault();
      event.stopPropagation();
      if (resolvedSession.deviceLinkDeviceId) {
        remoteProjectsStore.pinSessionOrigin(resolvedSession.deviceLinkDeviceId, resolvedSession.id);
      }
      if (!isSharedTaskPeer(resolvedSession.deviceLinkDeviceId ?? '')) {
        prefetchDirtyWorktreeForRemoval(resolvedSession.id, resolvedSession.deviceLinkDeviceId);
      }
      setMenuPos({ x: event.clientX, y: event.clientY });
    },
    [canOpenMenu, isEditing, resolvedSession.deviceLinkDeviceId, resolvedSession.id],
  );

  const handleCloseMenu = useCallback(() => setMenuPos(null), []);
  const handleReturnFocus = useCallback(() => {
    rowButtonRef.current?.focus();
  }, []);

  const handleOpenInNewWindowClick = useCallback(
    (hitOverride?: ConversationSearchResultItem['contentHit']) => {
      if (remoteWritesBlocked) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      void onSelect(item, hitOverride, { openInNewWindow: true });
    },
    [item, onSelect, remoteWritesBlocked, t],
  );

  const handleDragPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    dragStartTargetRef.current = event.target instanceof Element ? event.target : null;
  }, []);

  const clearDragStartTarget = useCallback(() => {
    dragStartTargetRef.current = null;
  }, []);

  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const started = startSessionDrag(event, {
        sessionId: resolvedSession.id,
        deviceId: resolvedSession.deviceLinkDeviceId,
        label: displayTitle,
        enabled: splitDragEnabled,
        needsDedicatedHandle: false,
        dragStartTarget: dragStartTargetRef.current,
      });
      dragStartTargetRef.current = null;
      if (started) {
        if (resolvedSession.deviceLinkDeviceId) {
          remoteProjectsStore.pinSessionOrigin(resolvedSession.deviceLinkDeviceId, resolvedSession.id);
        }
        draggingActiveRef.current = true;
        setIsDragging(true);
        onDragSessionStart?.();
      }
    },
    [
      displayTitle,
      onDragSessionStart,
      resolvedSession.deviceLinkDeviceId,
      resolvedSession.id,
      splitDragEnabled,
    ],
  );

  const handleDragEnd = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      dragStartTargetRef.current = null;
      finishSessionDrag(event, resolvedSession.id, resolvedSession.deviceLinkDeviceId);
      if (draggingActiveRef.current) {
        draggingActiveRef.current = false;
        setIsDragging(false);
        const droppedInWindow = Boolean(
          event.dataTransfer?.dropEffect && event.dataTransfer.dropEffect !== 'none',
        );
        onDragSessionEnd?.(droppedInWindow);
      }
    },
    [onDragSessionEnd, resolvedSession.deviceLinkDeviceId, resolvedSession.id],
  );

  const dragProps = {
    'data-split-group-drag-source': splitDragEnabled ? 'true' : undefined,
    draggable: splitDragEnabled,
    onPointerDownCapture: handleDragPointerDownCapture,
    onPointerUpCapture: clearDragStartTarget,
    onPointerCancelCapture: clearDragStartTarget,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
  } as const;

  const rowHeaderContent = (
    <>
      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--cmd-palette-item-icon)]">
        <MessageSquare size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {isEditing ? (
            <div data-search-result-rename="true" className="min-w-0 flex-1">
              <SessionRenameInput
                sessionId={resolvedSession.id}
                value={editValue}
                onValueChange={setEditValue}
                onCommit={commitTitle}
                onCancel={() => {
                  committedRef.current = true;
                  setIsEditing(false);
                  requestAnimationFrame(() => rowButtonRef.current?.focus());
                }}
                containerClassName="min-w-0 flex-1"
                inputClassName="h-6 text-13 font-medium text-[var(--text-primary)]"
              />
            </div>
          ) : (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="min-w-0 flex-[1_0_6rem] truncate text-13 font-medium text-[var(--text-primary)]">
                {highlightSegments(displayTitle, titleMatchIndices)}
              </span>
              <span className="max-w-full overflow-x-auto">
                <TaskTagDots tags={effectiveTags} />
              </span>
            </span>
          )}
          <Tip
            text={sourceText}
            side="top"
            delay={150}
            controlledOpen={menuPos !== null || isEditing || isDragging ? false : undefined}
            resetHoverOnControlChange
          >
            <Badge size="xs">
              {t(`ccAgent.search.kind.${item.matchKind}`)}
            </Badge>
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
    </>
  );

  return (
    <div
      data-sidebar-session-row="true"
      data-session-id={item.session.id}
      onContextMenu={handleContextMenu}
      className={cn(
        'rounded-lg transition-colors hover:bg-[var(--cmd-palette-item-hover)]',
        menuPos !== null && 'bg-[var(--cmd-palette-item-hover)]',
      )}
    >
      {isEditing ? (
        <div className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left">
          {rowHeaderContent}
        </div>
      ) : (
        <Tip
          text={tooltip}
          side="right"
          delay={250}
          controlledOpen={menuPos !== null || isDragging ? false : undefined}
          resetHoverOnControlChange
          contentClassName="max-w-[500px] break-words"
        >
          <button
            ref={rowButtonRef}
            type="button"
            {...dragProps}
            onClick={(event) => {
              if (shouldOpenSearchResultInNewWindow(event)) {
                event.preventDefault();
                handleOpenInNewWindowClick();
                return;
              }
              void onSelect(item);
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              handleOpenInNewWindowClick();
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left"
          >
            {rowHeaderContent}
          </button>
        </Tip>
      )}
      {visibleHits.length > 0 && (
        <div className="mt-0.5 space-y-1 px-3 pb-2 pl-10">
          {visibleHits.map((hit) => (
            <SearchHitRow
              key={hit.messageId}
              hit={hit}
              query={query}
              dragProps={dragProps}
              onSelect={() => { void onSelect(item, hit); }}
              onOpenInNewWindow={() => { handleOpenInNewWindowClick(hit); }}
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
                'flex w-full items-center rounded-lg border border-transparent px-2 py-1.5 text-left',
                'text-10 leading-none text-[var(--text-tertiary)]',
                'transition-colors hover:border-[var(--border-default)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)]',
              )}
            >
              {t('ccAgent.search.moreHits', { count: hiddenHitCount })}
            </button>
          )}
        </div>
      )}
      {canOpenMenu && taskMenu && (
        <taskMenu.MenuComponent
          session={resolvedSession}
          isLiveInStore={liveSession !== null}
          hydrationStatus={hydrationStatus}
          onRetryHydration={retryHydration}
          menuPos={menuPos}
          isEditing={isEditing}
          actions={taskMenu}
          onCloseMenu={handleCloseMenu}
          onStartRename={handleStartRename}
          onOutOfWindowPatch={applyOutOfWindowPatch}
          returnFocus={handleReturnFocus}
        />
      )}
    </div>
  );
}

function SearchHitRow({
  hit,
  query,
  dragProps,
  onSelect,
  onOpenInNewWindow,
}: {
  hit: NonNullable<ConversationSearchResultItem['contentHit']>;
  query: string;
  dragProps: {
    'data-split-group-drag-source'?: 'true';
    draggable: boolean;
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUpCapture: () => void;
    onPointerCancelCapture: () => void;
    onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
    onDragEnd: (event: ReactDragEvent<HTMLElement>) => void;
  };
  onSelect: () => void;
  onOpenInNewWindow: () => void;
}) {
  const { t } = useTranslation();
  const sourceText = searchSourceLabel(hit, t);
  const content = renderSnippet(hit.snippet, query) ?? renderKeywordHighlights(hit.preview, query);
  const hitTime = formatSidebarTime(hit.createdAt, t);

  return (
    <button
      type="button"
      {...dragProps}
      onClick={(event) => {
        event.stopPropagation();
        if (shouldOpenSearchResultInNewWindow(event)) {
          event.preventDefault();
          onOpenInNewWindow();
          return;
        }
        onSelect();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenInNewWindow();
      }}
      className={cn(
        'flex w-full items-start rounded-lg border border-transparent px-2 py-1.5 text-left',
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
  // 侧栏 snippet 是原文切片，不是 buildSnippetFromContent 哨兵协议。不要传 protocol:true。
  const parts = parseSnippetMarkup(snippet);
  if (!parts) return null;
  return parts.map((part, index) => {
    if (part.marked) {
      return (
        <mark key={`${index}-${part.text}`} className={SEARCH_MARK_CLASS}>
          {part.text}
        </mark>
      );
    }
    return (
      <Fragment key={`${index}-${part.text}`}>
        {renderKeywordHighlights(part.text, query)}
      </Fragment>
    );
  });
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
