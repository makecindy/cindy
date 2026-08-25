import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/AppText';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ConnectionBanner, useShowConnectionBanner } from '@/components/ConnectionBanner';
import { unresponsiveDevicesStore, useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import { goBackGuarded } from '@/utils/backGuard';
import { configureCollapseAnimation } from '@/utils/collapseAnimation';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { mapContentEqual } from '@/utils/valueEquality';
import { useStableValue } from '@/utils/useStableValue';
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  MainWindowEmptyState,
  MainWindowMetric,
  MainWindowOptionButton,
  RemoteListSyncingPlaceholder,
  ScreenHeader,
  SummaryStrip,
} from '@/components/MobilePrimitives';
import { buildMainWindowLayout } from '@/components/mainWindowLayout';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useRemoteSyncTask } from '@/device-link/remoteSyncTask';
import {
  automationGroupKey,
  buildSessionMessagePreviewIndex,
  buildRemoteSessionListContext,
  buildRemoteSessionSections,
  deviceSessionEmptyState,
  remoteSessionControlsSummary,
  remoteSessionFilterLabel,
  summarizeRemoteSessionOverview,
  type RemoteAutomationSessionGroup,
  type RemoteSessionListItem,
  type RemoteSessionScheduleInfo,
  type RemoteSessionStatusFilter,
} from '@/session/sessionList';
import {
  mobileSessionBulkActionButtonLabel,
  mobileSessionBulkPatch,
  pruneSessionSelection,
  sessionIdsForListItem,
  summarizeMobileSessionBulkAction,
  visibleMobileSessionBulkActions,
  visibleSessionIdsFromSections,
  type MobileSessionBulkAction,
} from '@/session/sessionSelection';
import { serializeNewSessionDeviceOptions } from '@/session/newSession';
import { ConversationSearchFilterSheet } from '@/session/ConversationSearchFilterSheet';
import { HomeSearchBar } from '@/session/HomeSearchBar';
import {
  conversationSearchAllowsLocalWrites,
  listConversationSearchProjects,
  shouldReplaceListWithSearchResults,
} from '@/session/conversationSearch';
import { useConversationSearch } from '@/session/useConversationSearch';
import { sessionMatchesProjectDir } from '@/session/mobileHome';
import { HomeSessionRow } from './index';
import { RenameSessionModal } from '@/session/RenameSessionModal';
import { SessionActionSheet } from '@/session/SessionActionSheet';
import { SwipeableSessionRow, type SessionSwipeControls } from '@/session/SwipeableSessionRow';
import type { SessionSwipeAction } from '@/session/swipeRowRegistry';
import { useSessionListActions } from '@/session/useSessionListActions';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import {
  remoteSessionStore,
  useRemoteMessageVersion,
  useRemoteSessions,
  useRemoteSessionStoreVersion,
} from '@/session/remoteSessionStore';
import {
  remoteScheduleEventStore,
  useRemoteScheduleEventSnapshot,
  useRemoteScheduleMirrorInvalidations,
} from '@/scheduler/remoteScheduleEvents';
import {
  getScheduleIndexInvalidationVersion,
  invalidateOfflineScheduleIndexFailureFor,
  invalidateRunningSessionScheduleEntries,
  loadSessionScheduleIndex,
  loadSessionScheduleIndexThrottled,
} from '@/session/scheduleIndex';
import { shouldSuppressRemoteListEmptyState } from '@/session/sessionEmptyState';
import type { RemoteSession } from '@/session/types';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

const LIST_LIMIT = 200;
// label 走 i18n key(在使用点 t() 求值),不在模块顶层冻结语言。
const STATUS_FILTERS: Array<{ value: RemoteSessionStatusFilter; labelKey: string }> = [
  { value: 'active', labelKey: 'devices.detail.filter.active' },
  { value: 'waiting', labelKey: 'devices.detail.filter.waiting' },
  { value: 'automation', labelKey: 'devices.detail.filter.automation' },
  { value: 'archived', labelKey: 'devices.detail.filter.archived' },
  { value: 'all', labelKey: 'devices.detail.filter.all' },
];
type RemoteListStatusFilter = Extract<RemoteSessionStatusFilter, 'active' | 'archived' | 'all'>;

export default function DeviceDetailScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  const params = useLocalSearchParams<{
    deviceId: string;
    deviceName?: string;
    name?: string;
    workingDir?: string;
    projectName?: string;
    automationGroupKey?: string;
    automationName?: string;
    automationWorkingDir?: string;
    automationSessionIds?: string;
    statusFilter?: string;
  }>();
  const deviceId = readRouteString(params.deviceId) ?? '';
  const deviceName = readRouteString(params.name) ?? readRouteString(params.deviceName) ?? deviceId;
  // 从首页「查看全部 N 条对话」进来时带 workingDir + 项目名 → 仅显示该项目的会话(项目作用域)。
  const projectWorkingDir = readRouteString(params.workingDir);
  const projectName = readRouteString(params.projectName);
  // 从自动化组「查看全部 N 次运行」进来时带组键 + 任务名 → 仅显示该任务的运行(自动化任务作用域)。
  const automationScopeKey = readRouteString(params.automationGroupKey);
  const automationScopeName = readRouteString(params.automationName);
  // 入口组行所在的项目目录(项目分组入口才带):组键不含项目 scope,跨项目任务按它把
  // 组键匹配限定在本项目内,页面显示与组行标称的 N 一致。
  const automationScopeDir = readRouteString(params.automationWorkingDir);
  // 入口带的 sessionId 快照:scheduleIndex 尚未加载完成时先按它立即显示,index 就绪后与组键匹配取并集。
  const automationScopeSessionIds = useMemo(
    () => parseSessionIdsParam(readRouteString(params.automationSessionIds)),
    [params.automationSessionIds],
  );
  const router = useRouter();
  // 前进导航统一走守卫 push,防止列表卡顿时连点把同一页压进栈 N 层(锁语义见 navigationLock.ts)。
  const guardedPush = useGuardedPush();
  const { width: screenWidth } = useWindowDimensions();
  const { connectionIssue, invoke, status, subscribe, unsubscribe } = useDeviceLink();
  const maker = useMobileMakerTransport(deviceId);
  const scheduleEventSnapshot = useRemoteScheduleEventSnapshot(deviceId);
  const scheduleMirrorInvalidations = useRemoteScheduleMirrorInvalidations();
  const allSessions = useRemoteSessions();
  // filter 必须 memo:裸 filter 每次渲染都产新数组,会让下游全部 [sessions, ...] 依赖的
  // useMemo 逐 emit 失效,派生链(索引 → sections → 全列表行)整体重建(2026-07-18
  // 重渲染风暴)。store 层已保证 allSessions 引用在内容未变时稳定,这里不能亲手打破。
  const sessions = useMemo(() => allSessions.filter((s) =>
    // 用展示用 canonicalDeviceId(设备归并结果)匹配,与首页项目卡一致 —— 被认领的 stale 会话也能显示,
    // 数量与卡片相符。deviceLinkDeviceId 仍是物理路由 key(openSession / patch 用它),不参与此处判断。
    (s.canonicalDeviceId ?? s.deviceLinkDeviceId) === deviceId
    && (!projectWorkingDir || sessionMatchesProjectDir(s.workingDir, projectWorkingDir))),
  [allSessions, deviceId, projectWorkingDir]);
  const messageVersion = useRemoteMessageVersion();
  const storeVersion = useRemoteSessionStoreVersion();
  const [statusFilter, setStatusFilter] = useState<RemoteSessionStatusFilter>(
    () => parseRouteStatusFilter(readRouteString(params.statusFilter)),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilterOpen, setSearchFilterOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 熔断 open(电脑端未响应):relay 可能仍 online,可见性与 banner 文案单独入参。
  const unresponsiveDevices = useUnresponsiveDevices();
  const deviceUnresponsive = !!deviceId && unresponsiveDevices.has(deviceId);
  const searchOrigins = useMemo(() => (deviceId ? [{
    deviceId,
    deviceName,
    reachable: !deviceUnresponsive,
  }] : []), [deviceId, deviceName, deviceUnresponsive]);
  const searchProjects = useMemo(
    () => listConversationSearchProjects(sessions, deviceId ? new Set([deviceId]) : undefined),
    [deviceId, sessions],
  );
  const indexedSearch = useConversationSearch({
    enabled: !automationScopeKey && !!deviceId,
    lockedWorkingDirs: projectWorkingDir ? [projectWorkingDir] : null,
    origins: searchOrigins,
    projects: searchProjects,
  });
  const searchQuery = indexedSearch.query;
  const setSearchQuery = indexedSearch.setQuery;
  const searchFilterA11y = t('devices.list.search.filterAria', {
    agent: t(`devices.list.search.filter.agent.${indexedSearch.agentFilter}`),
    lastActivity: t(`devices.list.search.filter.lastActivity.${indexedSearch.lastActivityFilter}`),
    projects: projectWorkingDir
      ? (projectName ?? projectWorkingDir)
      : indexedSearch.projectSelection === 'all'
        ? t('devices.list.search.filter.allProjects')
        : t('devices.list.search.filter.selectedProjects', { count: indexedSearch.projectSelection.length }),
    sort: t(`devices.list.search.filter.sort.${indexedSearch.sortBy}`),
    status: t(`devices.list.search.filter.status.${indexedSearch.statusFilter}`),
  });
  // 自动化 / 项目分支视图的条件挂载 banner:普通弱网断线也要有可见信号(防闪延迟后)
  const showConnectionBanner = useShowConnectionBanner(status, error, connectionIssue, deviceUnresponsive);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [expandedAutomationGroups, setExpandedAutomationGroups] = useState<string[]>([]);
  const [bulkActionPending, setBulkActionPending] = useState<MobileSessionBulkAction | null>(null);
  const [bulkConfirmAction, setBulkConfirmAction] = useState<MobileSessionBulkAction | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [scheduleIndex, setScheduleIndex] = useState<Map<string, RemoteSessionScheduleInfo>>(
    () => new Map(),
  );
  const {
    actionSheetSession,
    closeRenameSession,
    confirmRenameSession,
    handleSessionSheetAction,
    handleSessionSheetClosed,
    renameSessionDraft,
    renameSessionTarget,
    sessionSwipeControls,
    setActionSheetSession,
    setRenameSessionDraft,
    swipeRegistry,
  } = useSessionListActions();

  useEffect(() => {
    if (!deviceId || !scheduleMirrorInvalidations.has(deviceId)) return;
    setScheduleIndex((current) => invalidateRunningSessionScheduleEntries(
      current,
      sessions.map((session) => session.id),
    ));
  }, [deviceId, scheduleMirrorInvalidations, sessions]);

  const syncSessions = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await withTransientRemoteRetry(async () => {
        await subscribe(`device:${deviceId}`, deviceId, ['sessions']);
        return invoke<RemoteSession[]>(deviceId, 'local-db:sessions:list', [
          LIST_LIMIT,
          // 自动化任务作用域页承诺展示"该任务的全部 N 次运行",归档的 run 也算,
          // 必须拉全量;其余模式仍按当前筛选拉取。
          automationScopeKey ? 'all' : remoteListStatusFilter(statusFilter),
          // 首拉 / reseed / 筛选重拉都是权威快照，不并入被控端写前查询。
          { includePinned: true, fresh: true },
        ]);
      });
      remoteSessionStore.setDeviceSessions(deviceId, deviceName, Array.isArray(list) ? list : []);
      // A successful sessions:list is authoritative reachability evidence even when relay
      // presence was not replayed. Retire both offline caches before the schedule reload.
      remoteScheduleEventStore.clearDeviceMirrorInvalidation(deviceId);
      invalidateOfflineScheduleIndexFailureFor(deviceId);
      // 节流缓存与首页共用同一 key(deviceId):两页交替浏览时不重复全量拉取(单飞 + TTL,
      // 拥塞背景见 scheduleIndex 注释)。
      const invalidationVersion = getScheduleIndexInvalidationVersion(deviceId);
      void loadSessionScheduleIndexThrottled(deviceId, () => loadSessionScheduleIndex(maker, { isDeviceUnresponsive: () => unresponsiveDevicesStore.has(deviceId) }))
        .then((nextIndex) => {
          if (getScheduleIndexInvalidationVersion(deviceId) !== invalidationVersion) return;
          setScheduleIndex(nextIndex);
        })
        .catch(() => {
          if (getScheduleIndexInvalidationVersion(deviceId) !== invalidationVersion) return;
          setScheduleIndex(new Map());
        });
      setLastSyncedAt(Date.now());
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setLoading(false);
    }
  }, [automationScopeKey, deviceId, deviceName, invoke, maker, statusFilter, subscribe]);
  const loadSessions = useRemoteSyncTask(syncSessions);

  useEffect(() => {
    const unregisterReseed = remoteSessionStore.registerReseedHandler(deviceId, () => void loadSessions());
    return () => {
      unregisterReseed();
      void unsubscribe(`device:${deviceId}`, deviceId, ['sessions']).catch(() => undefined);
    };
  }, [deviceId, loadSessions, unsubscribe]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, statusFilter]);

  useEffect(() => {
    if (scheduleEventSnapshot.sessionIndexVersion > 0) void loadSessions();
  }, [loadSessions, scheduleEventSnapshot.sessionIndexVersion]);

  // schedule 列表变化(changed,含 pause / resume / 改绑)与 read / all-read 都 force
  // 刷新节流缓存——否则 30s TTL 内会继续显示旧 Pause / 未读状态。依赖专用 version
  // 计数而非 lastProjection 引用:后者每个事件都换新,会让 fired / deferred 等无关事件
  // 也重跑本 effect(review P1)。
  // 上方 loadSessions effect 随 sessionIndexVersion 同步触发,其内部 throttled 调用会
  // 单飞复用本次 force 拉起的在途 promise,不产生第二次全量拉取。
  useEffect(() => {
    if (
      scheduleEventSnapshot.scheduleListVersion === 0
      && scheduleEventSnapshot.unreadClearVersion === 0
    ) return;
    const invalidationVersion = getScheduleIndexInvalidationVersion(deviceId);
    void loadSessionScheduleIndexThrottled(deviceId, () => loadSessionScheduleIndex(maker, { isDeviceUnresponsive: () => unresponsiveDevicesStore.has(deviceId) }), { force: true })
      .then((nextIndex) => {
        if (getScheduleIndexInvalidationVersion(deviceId) !== invalidationVersion) return;
        setScheduleIndex(nextIndex);
      })
      .catch(() => {
        // 失败保留旧徽标,与整页 load 的容错口径一致。
      });
  }, [
    deviceId,
    maker,
    scheduleEventSnapshot.scheduleListVersion,
    scheduleEventSnapshot.unreadClearVersion,
  ]);

  // 派生索引依赖全局 messageVersion / storeVersion,逐 emit 重建出内容相同的新 Map;
  // useStableValue 在内容未变时保留旧引用,阻断 sections 派生链的无谓全量重建
  // (与首页同款处理,风暴背景见 devices/index.tsx 对应注释)。
  const messagePreviewIndexRaw = useMemo(
    () => buildSessionMessagePreviewIndex(
      sessions.map((session) => session.id),
      (sessionId) => remoteSessionStore.getMessages(sessionId),
    ),
    [messageVersion, sessions],
  );
  const messagePreviewIndex = useStableValue(messagePreviewIndexRaw, mapContentEqual);
  const pendingInteractionIndexRaw = useMemo(() => new Map(
    sessions
      .map((session) => [session.id, remoteSessionStore.getPendingInteractions(session.id).length] as const)
      .filter(([, count]) => count > 0),
  ), [sessions, storeVersion]);
  const pendingInteractionIndex = useStableValue(pendingInteractionIndexRaw, mapContentEqual);
  const filterCounts = useMemo(
    () => summarizeRemoteSessionOverview(sessions, pendingInteractionIndex, scheduleIndex),
    [pendingInteractionIndex, scheduleIndex, sessions],
  );

  const sections = useMemo(
    () => buildRemoteSessionSections(sessions, Date.now(), {
      messagePreviewIndex,
      pendingInteractionIndex,
      scheduleIndex,
      searchQuery,
      // 自动化任务作用域页无筛选 UI 且承诺"全部 N 次运行",statusFilter 固定 'all'
      // (本页 statusFilter state 停留在初值 'active',若沿用会把归档 run 滤掉)。
      statusFilter: automationScopeKey ? 'all' : statusFilter,
      // 未起名会话的显示文案:共享层不兜中文串,由这里给已解析的 i18n 值。
      unnamedLabel: t('session.menu.unnamedTitle'),
      // 项目作用域精简页与完整设备详情页都折叠自动化组(HomeSessionRow 支持组行
      // 展开,与首页交互一致);自动化任务作用域页本身就是"某任务的全部运行",必须平铺不折叠。
      groupAutomations: !automationScopeKey,
    }),
    [
      automationScopeKey,
      i18nInstance.language,
      messagePreviewIndex,
      pendingInteractionIndex,
      scheduleIndex,
      searchQuery,
      sessions,
      statusFilter,
      t,
    ],
  );
  const displaySections = useMemo(() => {
    if (automationScopeKey || !shouldReplaceListWithSearchResults(searchQuery, indexedSearch.status)) {
      return sections;
    }
    return [{ key: 'search', title: '', data: indexedSearch.results }];
  }, [automationScopeKey, indexedSearch.results, indexedSearch.status, searchQuery, sections]);
  const listContext = useMemo(
    () => buildRemoteSessionListContext({
      overview: filterCounts,
      searchQuery,
      sections: displaySections,
      statusFilter,
    }),
    [displaySections, filterCounts, searchQuery, statusFilter],
  );
  const visibleSessionIds = useMemo(() => visibleSessionIdsFromSections(displaySections), [displaySections]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds]);
  const selectedSessions = useMemo(() => {
    const selected = new Set(selectedSessionIds);
    return sessions.filter((session) => selected.has(session.id));
  }, [selectedSessionIds, sessions]);
  const bulkActionSummaries = useMemo(() => ({
    archive: summarizeMobileSessionBulkAction(selectedSessions, 'archive'),
    delete: summarizeMobileSessionBulkAction(selectedSessions, 'delete'),
    pin: summarizeMobileSessionBulkAction(selectedSessions, 'pin'),
    restore: summarizeMobileSessionBulkAction(selectedSessions, 'restore'),
    unpin: summarizeMobileSessionBulkAction(selectedSessions, 'unpin'),
  }), [i18nInstance.language, selectedSessions]);
  const bulkActionLayout = useMemo(
    () => visibleMobileSessionBulkActions(bulkActionSummaries),
    [bulkActionSummaries],
  );
  const bulkConfirmSummary = bulkConfirmAction ? bulkActionSummaries[bulkConfirmAction] : null;
  const selectionMode = selectedSessionIds.length > 0;
  const runningAutomationCount = filterCounts.runningAutomation;
  const controlsSummary = useMemo(
    () => remoteSessionControlsSummary(statusFilter, filterCounts),
    [filterCounts, statusFilter, t],
  );
  const windowLayout = buildMainWindowLayout({
    actionCount: 3,
    kind: 'detail',
    metricCount: 4,
    screenWidth,
  });
  const emptyState = useMemo(
    () => deviceSessionEmptyState(statusFilter, searchQuery),
    [searchQuery, statusFilter, t],
  );
  // 首同步完成前(lastSyncedAt === null)抑制"还没有对话"空状态,避免冷进(deep link)先闪空态
  // 再跳成真列表(规则 7:不闪空白/不跳变)。同步失败时 ConnectionBanner 已有错误 + 重试入口。
  // 抑制期渲染 RemoteListSyncingPlaceholder(800ms 内空白,超时浮现「正在同步」),
  // 慢链路 / 连接翻覆下首同步拖长时不再是无限期纯白。
  const suppressListEmptyState = shouldSuppressRemoteListEmptyState({
    itemCount: visibleSessionIds.length,
    hasSyncedThisOpen: lastSyncedAt !== null,
  });
  useEffect(() => {
    setSelectedSessionIds((prev) => {
      const next = pruneSessionSelection(prev, visibleSessionIds);
      return next.length === prev.length && next.every((id, index) => id === prev[index]) ? prev : next;
    });
  }, [visibleSessionIds]);

  const clearSelection = useCallback(() => {
    setSelectedSessionIds([]);
    setBulkConfirmAction(null);
    setBulkNotice(null);
  }, []);

  const openSession = useCallback((targetSessionId: string, focusClientId?: string) => {
    if (swipeRegistry.closeOpenRow()) return;
    // 打开会话是远端交互,用当前(可达)设备 endpoint = 页面级 deviceId(对被认领会话即 canonical 当前设备,
    // 其物理机就是当前设备、可达)。不用会话物理旧 shard id:re-link 后旧设备不可达会导致会话根本打不开。
    // 本地 store 乐观更新(bulk applySessionPatch)另按会话物理 shard 路由;纯 stale 会话(current shard 无
    // 副本)的本地乐观回显不完美是已知限制,与 Home 页固有一致(见 PR 描述「已知限制」)。
    guardedPush({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId: targetSessionId,
        deviceId,
        deviceName,
        ...(focusClientId ? { focusClientId } : {}),
      },
    });
  }, [deviceId, deviceName, guardedPush, swipeRegistry]);

  const toggleAutomationGroup = useCallback((key: string) => {
    // 与首页组展开共用同一条折叠动画,保持视觉连续性。
    configureCollapseAnimation();
    setExpandedAutomationGroups((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }, []);

  // 自动化组「查看全部 N 次运行」:与项目「查看全部」一致,进入该任务的专属列表页
  // (本路由的自动化任务作用域模式)。
  const openAutomationGroup = useCallback((group: RemoteAutomationSessionGroup) => {
    // 组内同项目时带上项目维度(baseKey 不含项目 scope,跨项目任务只显示
    // 本项目的 run,与组行标称的 N 一致)。
    const primaryWorkingDir = (group.items.find((item) => item.session.id === group.primarySessionId) ?? group.items[0])
      ?.session.workingDir?.trim();
    guardedPush({
      pathname: '/devices/[deviceId]',
      params: {
        deviceId,
        name: deviceName,
        automationGroupKey: group.baseKey,
        automationName: group.title,
        ...(primaryWorkingDir ? { automationWorkingDir: primaryWorkingDir } : {}),
        automationSessionIds: JSON.stringify(group.sessionIds),
      },
    });
  }, [deviceId, deviceName, guardedPush]);

  const toggleSelection = useCallback((sessionIds: readonly string[]) => {
    setBulkConfirmAction(null);
    setBulkNotice(null);
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      const allSelected = sessionIds.every((id) => next.has(id));
      for (const id of sessionIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return [...next];
    });
  }, []);

  const beginSelection = useCallback((sessionIds: readonly string[]) => {
    setBulkConfirmAction(null);
    setBulkNotice(null);
    setSelectedSessionIds((prev) => Array.from(new Set([...prev, ...sessionIds])));
  }, []);

  const executeBulkAction = useCallback(async (
    action: MobileSessionBulkAction,
    targets: readonly RemoteSession[],
  ) => {
    if (bulkActionPending !== null || targets.length === 0) return;
    setBulkActionPending(action);
    setBulkNotice(null);
    const patch = mobileSessionBulkPatch(action);
    // 乐观批量:先把全部目标当帧 applySessionPatch(行立即消失 / 重排 / 变化)、
    // 退出确认态并清空选择,RPC 转后台并发;失败的条目用点击时的会话快照原样
    // 还原(归档 / 删除行已移出列表,反向 patch 复活不了)并提示。页面内并发由
    // bulkActionPending 互斥,不需要写序守卫。
    // 本地乐观更新按会话物理 shard 路由(被认领的 stale 会话物理仍在旧 shard),
    // 与 Home 一致;否则 applySessionPatch 在错误 shard 找不到该会话、乐观更新
    // 丢失。远端 patch 走当前设备 transport(认领会话的物理机就是当前设备)。
    const rows = targets.map((session) => ({
      session,
      rowDeviceId: session.deviceLinkDeviceId ?? remoteSessionStore.getSessionDeviceId(session.id) ?? deviceId,
    }));
    for (const { session, rowDeviceId } of rows) {
      remoteSessionStore.applySessionPatch(rowDeviceId, session.id, patch);
    }
    setBulkConfirmAction(null);
    setSelectedSessionIds([]);
    try {
      const failed: typeof rows = [];
      await Promise.all(rows.map(async (row) => {
        try {
          const updated = await maker.patchSessionMeta(row.session.id, patch);
          if (updated) remoteSessionStore.applySessionPatch(row.rowDeviceId, row.session.id, updated);
        } catch {
          failed.push(row);
        }
      }));
      if (failed.length > 0) {
        for (const { session, rowDeviceId } of failed) {
          const shardName = remoteSessionStore.getSessions()
            .find((s) => s.deviceLinkDeviceId === rowDeviceId)?.deviceLinkDeviceName
            ?? session.deviceLinkDeviceName
            ?? rowDeviceId;
          remoteSessionStore.upsertDeviceSession(rowDeviceId, shardName, session);
        }
        setSelectedSessionIds(failed.map(({ session }) => session.id));
        setBulkNotice(t('devices.detail.bulk.partialFailure', { done: rows.length - failed.length, failed: failed.length }));
      }
      await loadSessions();
    } finally {
      setBulkActionPending(null);
    }
  }, [bulkActionPending, deviceId, loadSessions, maker, t]);

  const requestBulkAction = useCallback((action: MobileSessionBulkAction) => {
    const summary = bulkActionSummaries[action];
    if (summary.candidates.length === 0) {
      setBulkNotice(
        action === 'archive'
          ? t('devices.detail.bulk.noArchivable')
          : action === 'pin'
            ? t('devices.detail.bulk.noPinnable')
            : action === 'restore'
              ? t('devices.detail.bulk.noRestorable')
              : action === 'unpin'
                ? t('devices.detail.bulk.noUnpinnable')
                : t('devices.detail.bulk.noDeletable'),
      );
      return;
    }
    setBulkConfirmAction(action);
  }, [bulkActionSummaries, t]);

  const actionOverlays = (
    <>
      <ConversationSearchFilterSheet
        activeCount={indexedSearch.activeFilterCount}
        agentKind={indexedSearch.agentFilter}
        lastActivity={indexedSearch.lastActivityFilter}
        lockedProjects={!!projectWorkingDir}
        onAgentKindChange={indexedSearch.setAgentFilter}
        onClose={() => setSearchFilterOpen(false)}
        onLastActivityChange={indexedSearch.setLastActivityFilter}
        onProjectsChange={indexedSearch.setProjectSelection}
        onReset={indexedSearch.resetFilters}
        onSortChange={indexedSearch.setSortBy}
        onStatusChange={indexedSearch.setStatusFilter}
        projectSelection={indexedSearch.projectSelection}
        projects={searchProjects}
        sortBy={indexedSearch.sortBy}
        status={indexedSearch.statusFilter}
        topOffset={insets.top + 56}
        visible={searchFilterOpen}
      />
      <SessionListActionOverlays
        actionSheetSession={actionSheetSession}
        closeRenameSession={closeRenameSession}
        confirmRenameSession={confirmRenameSession}
        handleSessionSheetAction={handleSessionSheetAction}
        handleSessionSheetClosed={handleSessionSheetClosed}
        renameSessionDraft={renameSessionDraft}
        renameSessionTarget={renameSessionTarget}
        setActionSheetSession={setActionSheetSession}
        setRenameSessionDraft={setRenameSessionDraft}
      />
    </>
  );

  // 自动化任务作用域(从组行「查看全部 N 次运行」进入):干净布局 —— 头部 + 该任务全部运行的
  // 平铺列表,交互与项目作用域页同构。运行归属 = 入口 sessionId 快照 ∪ 组键匹配(scheduleIndex
  // 就绪后能捕获快照之外新产生的 run)。
  if (automationScopeKey) {
    const scopeIdSet = new Set(automationScopeSessionIds);
    const allItems = sections.flatMap((section) => section.data);
    // 组键升级:入口可能带 fallback 键(源页 scheduleIndex 未就绪时进入),本页 index 就绪后
    // 同批 run 的组键会变成 schedule:<id> —— 只按入口键匹配会把快照之外的 run(归档 / 新产生)
    // 漏掉。把快照内 run 的实际组键并入匹配集,让 fallback 键随 index 就绪自动升级到 schedule 键。
    const scopeKeys = new Set<string>([automationScopeKey]);
    for (const item of allItems) {
      if (!scopeIdSet.has(item.session.id)) continue;
      const key = automationGroupKey(item);
      if (key) scopeKeys.add(key);
    }
    const runItems = allItems.filter((item) => {
      if (scopeIdSet.has(item.session.id)) return true;
      const key = automationGroupKey(item);
      if (!key || !scopeKeys.has(key)) return false;
      // 入口带项目维度时,组键匹配的行还要落在同一项目(与首页项目分桶同一归一化语义);
      // 快照内的 id 是入口组的精确成员,不受此过滤影响。
      return !automationScopeDir || sessionMatchesProjectDir(item.session.workingDir, automationScopeDir);
    });
    return (
      <SafeAreaView style={styles.safeArea} testID="deviceDetail.screen">
        <ScreenHeader
          backTestID="deviceDetail.backButton"
          eyebrow={t('devices.detail.automationScope.eyebrow')}
          onBack={() => goBackGuarded(router)}
          subtitle={deviceName}
          title={automationScopeName ?? t('devices.detail.automationScope.title')}
          titleTestID="deviceDetail.title"
        />
        {showConnectionBanner ? (
          <ConnectionBanner
            deviceUnresponsive={deviceUnresponsive}
            error={error}
            issue={connectionIssue}
            lastSyncedAt={lastSyncedAt}
            loading={loading}
            onSync={() => void loadSessions()}
            status={status}
          />
        ) : null}
        <SectionList
          sections={runItems.length > 0 ? [{ key: 'automation-runs', title: '', data: runItems }] : []}
          keyExtractor={(item) => item.session.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={loadSessions} />}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={() => null}
          contentContainerStyle={[styles.listContent, { paddingBottom: spacing.xxl }]}
          testID="deviceDetail.automationRunList"
          renderItem={({ item }) => (
            <DeviceDetailSessionRow
              item={item}
              onOpenSession={(it) => openSession(
                it.session.id,
                'searchFocusClientId' in it ? (it as { searchFocusClientId?: string }).searchFocusClientId : undefined,
              )}
              swipe={sessionSwipeControls}
              testID={`deviceDetail.automationRunRow.${item.session.id}`}
            />
          )}
          ListEmptyComponent={
            <MainWindowEmptyState
              centered
              copy={t('devices.detail.automationScope.emptyCopy')}
              style={{
                marginTop: spacing.xxl,
                minHeight: windowLayout.emptyMinHeight,
                padding: windowLayout.emptyPadding,
              }}
              testID="deviceDetail.automationEmpty"
              title={t('devices.detail.automationScope.emptyTitle')}
            />
          }
        />
        {actionOverlays}
      </SafeAreaView>
    );
  }

  // 项目作用域(从首页「查看全部 N 条对话」进入):干净布局 —— 头部 + 直接的会话列表(复用首页
  // 干净会话行),不带整台电脑的控制台(metric pill / 分组 / 筛选 / 批量 / listContext)。
  // 整台电脑模式(无 workingDir)继续走下面完整的 console 布局。
  if (projectWorkingDir) {
    const projectItems = sections.flatMap((section) => section.data);
    return (
      <SafeAreaView style={styles.safeArea} testID="deviceDetail.screen">
        <ScreenHeader
          action={{
            label: t('devices.common.create'),
            // 在这个项目里建新对话:预填 workingDir。
            onPress: () => guardedPush({
              pathname: '/sessions/new',
              params: {
                deviceId,
                deviceName,
                workingDir: projectWorkingDir,
                deviceOptions: serializeNewSessionDeviceOptions([{ deviceId, name: deviceName }]),
              },
            }),
            testID: 'deviceDetail.newSessionButton',
          }}
          backTestID="deviceDetail.backButton"
          eyebrow={t('devices.detail.projectScope.eyebrow')}
          onBack={() => goBackGuarded(router)}
          subtitle={`${projectWorkingDir} · ${deviceName}`}
          title={projectName ?? deviceName}
          titleTestID="deviceDetail.title"
        />
        {showConnectionBanner ? (
          <ConnectionBanner
            deviceUnresponsive={deviceUnresponsive}
            error={error}
            issue={connectionIssue}
            lastSyncedAt={lastSyncedAt}
            loading={loading}
            onSync={() => void loadSessions()}
            status={status}
          />
        ) : null}
        <View style={styles.projectSearchChrome}>
          {searchOpen || !!searchQuery.trim() ? (
            <HomeSearchBar
              autoFocus={searchOpen && !searchQuery}
              filterA11y={searchFilterA11y}
              filterActive={indexedSearch.activeFilterCount > 0}
              onChangeQuery={setSearchQuery}
              onDismiss={() => setSearchOpen(false)}
              onOpenFilter={() => setSearchFilterOpen(true)}
              padded={false}
              query={searchQuery}
              testIDs={{
                clear: 'deviceDetail.projectSearchCloseButton',
                filter: 'deviceDetail.projectSearchFilterButton',
                input: 'deviceDetail.projectSearchInput',
                row: 'deviceDetail.projectSearchRow',
              }}
            />
          ) : (
            <MainWindowActionGroup
              density="compact"
              secondaryActions={[
                {
                  accessibilityLabel: t('devices.detail.search.openA11y'),
                  active: false,
                  label: t('devices.detail.search.label'),
                  onPress: () => setSearchOpen(true),
                  testID: 'deviceDetail.projectSearchToggleButton',
                },
              ]}
              testID="deviceDetail.projectSearchActions"
            />
          )}
        </View>
        <SectionList
          sections={displaySections}
          keyExtractor={(item) => item.automationGroup?.key ?? item.session.id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={loadSessions} />}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={() => null}
          contentContainerStyle={[styles.listContent, { paddingBottom: spacing.xxl }]}
          testID="deviceDetail.projectSessionList"
          renderItem={({ item, index, section }) => (
            <DeviceDetailSessionRow
              asBlock
              expandedAutomationGroups={expandedAutomationGroups}
              // 分割线唯一化(与首页同规则):紧邻自动化块上边界的行不画自己的缩进线,
              // 相邻两个块之间只保留一根全宽线(后块不画顶线)。
              hideDivider={!!section.data[index + 1]?.automationGroup}
              item={item}
              onOpenAutomationGroup={openAutomationGroup}
              onOpenSession={(it) => openSession(
                it.session.id,
                'searchFocusClientId' in it ? (it as { searchFocusClientId?: string }).searchFocusClientId : undefined,
              )}
              onToggleAutomationGroup={toggleAutomationGroup}
              suppressBlockTopBorder={!!section.data[index - 1]?.automationGroup}
              swipe={sessionSwipeControls}
              testID={`deviceDetail.projectSessionRow.${item.session.id}`}
            />
          )}
          ListEmptyComponent={suppressListEmptyState ? (
            <RemoteListSyncingPlaceholder testID="deviceDetail.projectSyncing" />
          ) : (
            <MainWindowEmptyState
              centered
              copy={searchQuery.trim() ? deviceSessionEmptyState(statusFilter, searchQuery).copy : t('devices.detail.projectScope.emptyCopy')}
              style={{
                marginTop: spacing.xxl,
                minHeight: windowLayout.emptyMinHeight,
                padding: windowLayout.emptyPadding,
              }}
              testID="deviceDetail.projectEmpty"
              title={searchQuery.trim() ? deviceSessionEmptyState(statusFilter, searchQuery).title : t('devices.detail.projectScope.emptyTitle')}
            />
          )}
        />
        {actionOverlays}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} testID="deviceDetail.screen">
      <ScreenHeader
        action={{
          label: t('devices.common.create'),
          onPress: () => guardedPush({
            pathname: '/sessions/new',
            params: {
              deviceId,
              deviceName,
              deviceOptions: serializeNewSessionDeviceOptions([{ deviceId, name: deviceName }]),
            },
          }),
          testID: 'deviceDetail.newSessionButton',
        }}
        backTestID="deviceDetail.backButton"
        eyebrow="Remote Device"
        onBack={() => goBackGuarded(router)}
        subtitle={projectWorkingDir
          ? t('devices.detail.subtitle.deviceActive', { deviceName, count: filterCounts.active })
          : t('devices.detail.subtitle.activeAndProjects', { count: filterCounts.active, projects: filterCounts.projectCount })}
        title={projectName ?? deviceName}
        titleTestID="deviceDetail.title"
      />

      <ConnectionBanner
        deviceUnresponsive={deviceUnresponsive}
        error={error}
        issue={connectionIssue}
        lastSyncedAt={lastSyncedAt}
        loading={loading}
        onSync={() => void loadSessions()}
        status={status}
      />

      <SummaryStrip
        style={{
          gap: windowLayout.summaryGap,
          paddingHorizontal: windowLayout.contentPaddingHorizontal,
          paddingVertical: windowLayout.contentPaddingVertical,
        }}
        testID="deviceDetail.summary"
      >
        <View style={[styles.summaryTopRow, { gap: windowLayout.metricGap }]}>
          <MainWindowMetric
            accessibilityLabel={t('devices.detail.metric.activeA11y')}
            label={t('devices.detail.metric.active')}
            onPress={() => setStatusFilter('active')}
            selected={statusFilter === 'active'}
            style={{ minHeight: windowLayout.metricMinHeight, minWidth: windowLayout.metricMinWidth }}
            testID="deviceDetail.metric.活动"
            variant="pill"
            value={filterCounts.active}
          />
          <MainWindowMetric
            accessibilityLabel={t('devices.detail.metric.waitingA11y')}
            label={t('devices.detail.metric.waiting')}
            onPress={() => setStatusFilter('waiting')}
            selected={statusFilter === 'waiting'}
            style={{ minHeight: windowLayout.metricMinHeight, minWidth: windowLayout.metricMinWidth }}
            testID="deviceDetail.metric.待处理"
            variant="pill"
            urgent={filterCounts.waiting > 0}
            value={filterCounts.waiting}
          />
          <MainWindowMetric
            accessibilityLabel={t('devices.detail.metric.automationA11y')}
            label={t('devices.detail.metric.automation')}
            onPress={() => setStatusFilter('automation')}
            selected={statusFilter === 'automation'}
            style={{ minHeight: windowLayout.metricMinHeight, minWidth: windowLayout.metricMinWidth }}
            testID="deviceDetail.metric.自动化"
            variant="pill"
            value={filterCounts.automation}
          />
          <View
            style={{ minWidth: windowLayout.metricMinWidth }}
            testID="deviceDetail.automationActions"
          >
            <MainWindowActionButton
              action={{
                accessibilityLabel: t('devices.detail.automationsButtonA11y'),
                label: `${t('devices.detail.plan')}${runningAutomationCount > 0 ? ` · ${runningAutomationCount}` : ''}`,
                onPress: () => guardedPush({
                  pathname: '/automations/[deviceId]',
                  params: { deviceId, name: deviceName },
                }),
                testID: 'deviceDetail.automationsButton',
              }}
              density="compact"
              style={{
                minHeight: windowLayout.metricMinHeight,
                minWidth: windowLayout.metricMinWidth,
              }}
            />
          </View>
          {loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
        </View>
      </SummaryStrip>

      <View
        style={[
          styles.controls,
          {
            gap: windowLayout.toolbarGap,
            paddingHorizontal: windowLayout.toolbarPaddingHorizontal,
            paddingVertical: windowLayout.toolbarPaddingVertical,
          },
        ]}
        testID="deviceDetail.sessionControls"
      >
        <View style={[styles.compactControlsRow, { gap: windowLayout.toolbarGap, minHeight: windowLayout.toolbarMinHeight }]}>
          <Text style={styles.controlsSummary} numberOfLines={1} testID="deviceDetail.controlsSummary">
            {controlsSummary}
          </Text>
          <MainWindowActionGroup
            density="compact"
            secondaryActions={[
              {
                accessibilityLabel: searchOpen ? t('devices.detail.search.closeA11y') : t('devices.detail.search.openA11y'),
                active: searchOpen || !!searchQuery.trim(),
                label: t('devices.detail.search.label'),
                onPress: () => {
                  if (searchOpen && !searchQuery.trim()) {
                    setSearchOpen(false);
                    return;
                  }
                  setSearchOpen(true);
                },
                testID: 'deviceDetail.searchToggleButton',
              },
              {
                accessibilityLabel: filtersOpen ? t('devices.detail.filters.collapseA11y') : t('devices.detail.filters.expandA11y'),
                active: filtersOpen,
                label: t('devices.detail.filters.label'),
                onPress: () => setFiltersOpen((value) => !value),
                testID: 'deviceDetail.filtersToggleButton',
              },
            ]}
            testID="deviceDetail.toolbarActions"
          />
        </View>

        {searchOpen || !!searchQuery.trim() ? (
          <HomeSearchBar
            autoFocus={searchOpen && !searchQuery}
            filterA11y={searchFilterA11y}
            filterActive={indexedSearch.activeFilterCount > 0}
            onChangeQuery={setSearchQuery}
            onOpenFilter={() => setSearchFilterOpen(true)}
            padded={false}
            query={searchQuery}
            testIDs={{
              clear: 'deviceDetail.searchCloseButton',
              filter: 'deviceDetail.searchFilterButton',
              input: 'deviceDetail.searchInput',
              row: 'deviceDetail.searchRow',
            }}
          />
        ) : null}

        {filtersOpen ? (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.segmentScroll}
              contentContainerStyle={styles.segmentScrollContent}
            >
              {STATUS_FILTERS.map((item) => {
                const label = t(item.labelKey);
                return (
                  <MainWindowOptionButton
                    accessibilityLabel={t('devices.detail.filter.a11y', { label })}
                    key={item.value}
                    label={remoteSessionFilterLabel(item.value, filterCounts, label)}
                    onPress={() => setStatusFilter(item.value)}
                    selected={statusFilter === item.value}
                    testID={`deviceDetail.statusFilter.${item.value}`}
                  />
                );
              })}
            </ScrollView>
          </>
        ) : null}
        {selectionMode ? (
          <View style={styles.selectionBar} testID="deviceDetail.selectionBar">
            <View style={styles.selectionHeaderRow}>
              <View style={styles.selectionTitleBlock}>
                <Text style={styles.selectionText} testID="deviceDetail.selectionCount">
                  {t('devices.detail.selection.count', { count: selectedSessionIds.length })}
                </Text>
                <Text style={styles.selectionMeta}>
                  {bulkActionLayout.primary.length + bulkActionLayout.destructive.length > 0
                    ? t('devices.detail.selection.canAct')
                    : t('devices.detail.selection.cannotAct')}
                </Text>
              </View>
              <MainWindowActionGroup
                density="compact"
                secondaryActions={[
                  {
                    accessibilityLabel: t('devices.detail.selection.clearA11y'),
                    disabled: bulkActionPending !== null,
                    label: t('devices.common.cancel'),
                    onPress: clearSelection,
                    testID: 'deviceDetail.clearSelectionButton',
                  },
                ]}
                testID="deviceDetail.selectionHeaderActions"
              />
            </View>
            {bulkActionLayout.primary.length > 0 ? (
              <MainWindowActionGroup
                secondaryActions={bulkActionLayout.primary.map((action) => ({
                  accessibilityLabel: bulkActionAccessibilityLabel(action, t),
                  disabled: bulkActionPending !== null,
                  label: bulkActionPending === action
                    ? bulkActionPendingLabel(action, t)
                    : mobileSessionBulkActionButtonLabel(bulkActionSummaries[action]),
                  onPress: () => requestBulkAction(action),
                  testID: bulkActionTestID(action),
                }))}
                testID="deviceDetail.bulkPrimaryActions"
              />
            ) : null}
            {bulkActionLayout.destructive.length > 0 ? (
              <MainWindowActionGroup
                dangerActions={bulkActionLayout.destructive.map((action) => ({
                  accessibilityLabel: bulkActionAccessibilityLabel(action, t),
                  disabled: bulkActionPending !== null,
                  label: bulkActionPending === action
                    ? bulkActionPendingLabel(action, t)
                    : mobileSessionBulkActionButtonLabel(bulkActionSummaries[action]),
                  onPress: () => requestBulkAction(action),
                  testID: bulkActionTestID(action),
                  tone: 'danger',
                }))}
                testID="deviceDetail.bulkDangerActions"
              />
            ) : null}
            {bulkConfirmSummary ? (
              <View style={styles.bulkConfirmCard} testID="deviceDetail.bulkConfirmCard">
                <Text style={styles.bulkConfirmTitle}>{bulkConfirmSummary.title}</Text>
                <Text style={styles.bulkConfirmText}>{bulkConfirmSummary.description}</Text>
                <MainWindowActionGroup
                  primaryActions={[
                    {
                      accessibilityLabel: bulkActionAccessibilityLabel(bulkConfirmSummary.action, t),
                      disabled: bulkActionPending !== null || bulkConfirmSummary.candidates.length === 0,
                      label: bulkActionPending === bulkConfirmSummary.action
                        ? bulkActionPendingLabel(bulkConfirmSummary.action, t)
                        : bulkConfirmSummary.confirmText,
                      onPress: () => void executeBulkAction(bulkConfirmSummary.action, bulkConfirmSummary.candidates),
                      testID: 'deviceDetail.bulkConfirmButton',
                      tone: 'primary',
                    },
                  ]}
                  cancelAction={{
                    accessibilityLabel: t('devices.detail.bulk.cancelA11y'),
                    disabled: bulkActionPending !== null,
                    label: t('devices.common.cancel'),
                    onPress: () => setBulkConfirmAction(null),
                    testID: 'deviceDetail.bulkConfirmCancelButton',
                  }}
                  testID="deviceDetail.bulkConfirmActions"
                />
              </View>
            ) : null}
            {bulkActionLayout.primary.length === 0 && bulkActionLayout.destructive.length === 0 ? (
              <Text style={styles.bulkNotice}>{t('devices.detail.bulk.noneModifiable')}</Text>
            ) : null}
          </View>
        ) : null}
        {bulkNotice ? (
          <Text style={styles.bulkNotice} testID="deviceDetail.bulkNotice">{bulkNotice}</Text>
        ) : null}

        <View style={styles.listContextCard} testID="deviceDetail.listContext">
          <View style={styles.listContextHeader}>
            <Text style={styles.listContextTitle} numberOfLines={1}>
              {listContext.title}
            </Text>
            <Text style={styles.listContextCount} testID="deviceDetail.listContextCount">
              {listContext.resultCount}
            </Text>
          </View>
          <Text style={styles.listContextDetail} numberOfLines={1}>
            {listContext.detail}
          </Text>
          <Text style={styles.listContextHint}>
            {listContext.hint}
          </Text>
        </View>
      </View>

      <SectionList
        sections={displaySections}
        keyExtractor={(item) => item.automationGroup?.key ?? item.session.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadSessions} />}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingHorizontal: windowLayout.listPaddingHorizontal,
            paddingVertical: windowLayout.listPaddingVertical,
          },
        ]}
        testID="deviceDetail.sessionList"
        renderSectionHeader={({ section }) => (
          section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null
        )}
        ListEmptyComponent={suppressListEmptyState ? (
          <RemoteListSyncingPlaceholder testID="deviceDetail.syncing" />
        ) : (
          <MainWindowEmptyState
            centered
            copy={emptyState.copy}
            style={{
              marginTop: spacing.xxl,
              minHeight: windowLayout.emptyMinHeight,
              padding: windowLayout.emptyPadding,
            }}
            testID="deviceDetail.empty"
            title={emptyState.title}
          />
        )}
        renderItem={({ item }) => (
          <DeviceDetailSessionRow
            expandedAutomationGroups={expandedAutomationGroups}
            item={item}
            onLongPress={conversationSearchAllowsLocalWrites(item)
              ? () => beginSelection(sessionIdsForListItem(item))
              : undefined}
            onOpenAutomationGroup={item.automationGroup ? openAutomationGroup : undefined}
            onOpenSession={(it) => openSession(
                it.session.id,
                'searchFocusClientId' in it ? (it as { searchFocusClientId?: string }).searchFocusClientId : undefined,
              )}
            onPressSelection={conversationSearchAllowsLocalWrites(item)
              ? () => toggleSelection(sessionIdsForListItem(item))
              : undefined}
            onToggleAutomationGroup={toggleAutomationGroup}
            selected={sessionIdsForListItem(item).every((id) => selectedSessionIdSet.has(id))}
            selectionMode={selectionMode}
            swipe={conversationSearchAllowsLocalWrites(item) ? sessionSwipeControls : undefined}
            testID="deviceDetail.sessionRow"
          />
        )}
      />
      {actionOverlays}
    </SafeAreaView>
  );
}

function DeviceDetailSessionRow({
  asBlock = false,
  expandedAutomationGroups,
  hideDivider = false,
  item,
  onLongPress,
  onOpenAutomationGroup,
  onOpenSession,
  onPressSelection,
  onToggleAutomationGroup,
  selected = false,
  selectionMode = false,
  suppressBlockTopBorder = false,
  swipe,
  testID,
}: {
  asBlock?: boolean;
  expandedAutomationGroups?: readonly string[];
  hideDivider?: boolean;
  item: RemoteSessionListItem;
  onLongPress?: () => void;
  onOpenAutomationGroup?: (group: RemoteAutomationSessionGroup) => void;
  onOpenSession(item: RemoteSessionListItem): void;
  onPressSelection?: () => void;
  onToggleAutomationGroup?: (key: string) => void;
  selected?: boolean;
  selectionMode?: boolean;
  suppressBlockTopBorder?: boolean;
  swipe?: SessionSwipeControls;
  testID: string;
}) {
  const consoleList = testID === 'deviceDetail.sessionRow';
  const row = (
    <HomeSessionRow
      asBlock={asBlock}
      automationChildTestID={consoleList ? 'deviceDetail.automationGroupChild' : undefined}
      automationChildrenTestID={consoleList ? 'deviceDetail.automationGroupChildren' : undefined}
      expandedAutomationGroups={expandedAutomationGroups}
      groupRowTestID={consoleList ? 'deviceDetail.automationGroupRow' : undefined}
      hideDivider={hideDivider}
      item={item}
      onLongPress={onLongPress}
      onOpenAutomationGroup={onOpenAutomationGroup}
      onOpenSession={onOpenSession}
      onPressSelection={onPressSelection}
      onToggleAutomationGroup={onToggleAutomationGroup}
      selected={selected}
      selectionMarkTestID={consoleList ? 'deviceDetail.sessionSelectionMark' : undefined}
      selectionMode={selectionMode}
      suppressBlockTopBorder={suppressBlockTopBorder}
      swipe={selectionMode ? undefined : swipe}
      testID={testID}
      titleTestIDPrefix="deviceDetail.sessionRowTitle"
    />
  );
  if (!swipe || selectionMode || item.automationGroup) return row;
  return (
    <SwipeableSessionRow
      onArchive={swipe.onArchive}
      onShowOptions={swipe.onShowOptions}
      onTogglePin={swipe.onTogglePin}
      registry={swipe.registry}
      session={item.session as RemoteSession}
      testID={`${testID}.swipe`}
    >
      {row}
    </SwipeableSessionRow>
  );
}

function SessionListActionOverlays({
  actionSheetSession,
  closeRenameSession,
  confirmRenameSession,
  handleSessionSheetAction,
  handleSessionSheetClosed,
  renameSessionDraft,
  renameSessionTarget,
  setActionSheetSession,
  setRenameSessionDraft,
}: {
  actionSheetSession: RemoteSession | null;
  closeRenameSession(): void;
  confirmRenameSession(): void;
  handleSessionSheetAction(action: SessionSwipeAction): void;
  handleSessionSheetClosed(): void;
  renameSessionDraft: string;
  renameSessionTarget: RemoteSession | null;
  setActionSheetSession(session: RemoteSession | null): void;
  setRenameSessionDraft(value: string): void;
}) {
  return (
    <>
      <SessionActionSheet
        onAction={handleSessionSheetAction}
        onClose={() => setActionSheetSession(null)}
        onClosed={handleSessionSheetClosed}
        pinnedAt={actionSheetSession?.pinnedAt}
        status={actionSheetSession?.status}
        visible={actionSheetSession !== null}
      />
      <RenameSessionModal
        draft={renameSessionDraft}
        onCancel={closeRenameSession}
        onChangeDraft={setRenameSessionDraft}
        onConfirm={confirmRenameSession}
        saving={false}
        visible={renameSessionTarget !== null}
      />
    </>
  );
}

function remoteListStatusFilter(filter: RemoteSessionStatusFilter): RemoteListStatusFilter {
  if (filter === 'archived') return 'archived';
  if (filter === 'all' || filter === 'waiting' || filter === 'automation') return 'all';
  return 'active';
}

function bulkActionPendingLabel(action: MobileSessionBulkAction, t: TFunction): string {
  if (action === 'pin') return t('devices.detail.bulk.pinning');
  if (action === 'unpin') return t('devices.detail.bulk.unpinning');
  if (action === 'archive') return t('devices.detail.bulk.archiving');
  if (action === 'restore') return t('devices.detail.bulk.restoring');
  return t('devices.detail.bulk.deleting');
}

function bulkActionAccessibilityLabel(action: MobileSessionBulkAction, t: TFunction): string {
  if (action === 'pin') return t('devices.detail.bulk.pinA11y');
  if (action === 'unpin') return t('devices.detail.bulk.unpinA11y');
  if (action === 'archive') return t('devices.detail.bulk.archiveA11y');
  if (action === 'restore') return t('devices.detail.bulk.restoreA11y');
  return t('devices.detail.bulk.deleteA11y');
}

function bulkActionTestID(action: MobileSessionBulkAction): string {
  if (action === 'pin') return 'deviceDetail.bulkPinButton';
  if (action === 'unpin') return 'deviceDetail.bulkUnpinButton';
  if (action === 'archive') return 'deviceDetail.bulkArchiveButton';
  if (action === 'restore') return 'deviceDetail.bulkRestoreButton';
  return 'deviceDetail.bulkDeleteButton';
}

/** 解析自动化作用域入口带的 sessionId 快照(JSON 数组);解析失败按空快照处理,仅靠组键匹配。 */
function parseSessionIdsParam(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseRouteStatusFilter(value: string | null): RemoteSessionStatusFilter {
  if (
    value === 'active'
    || value === 'waiting'
    || value === 'automation'
    || value === 'archived'
    || value === 'all'
  ) {
    return value;
  }
  return 'active';
}

function readRouteString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim().length > 0);
    return first ?? null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  summaryTopRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  listContent: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  controls: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  compactControlsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 38,
  },
  controlsSummary: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  projectSearchChrome: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  searchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  searchInput: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  searchCloseButton: {
    minHeight: 38,
  },
  segmentScroll: {
    marginHorizontal: -spacing.lg,
  },
  segmentScrollContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  selectionBar: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  selectionHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  selectionTitleBlock: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  selectionText: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  selectionMeta: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  bulkConfirmCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  bulkConfirmTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  bulkConfirmText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  bulkNotice: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  listContextCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  listContextHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  listContextTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  listContextCount: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  listContextDetail: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  listContextHint: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    paddingBottom: spacing.xs,
    paddingTop: spacing.md,
  },
});
