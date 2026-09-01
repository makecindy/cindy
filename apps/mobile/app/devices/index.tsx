import { useFocusEffect } from 'expo-router';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { DeviceLinkError, type DeviceView, type PresenceSnapshot } from '@cindy/device-link';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  LoaderCircle,
  Menu,
  MessagesSquare,
  Lock,
  Pencil,
  Pin,
  RefreshCw,
  RadioTower,
  SquarePen,
  UsersRound,
  X,
} from 'lucide-react-native';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import Reanimated, { runOnJS, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '@/auth/AuthContext';
import { configureCollapseAnimation } from '@/utils/collapseAnimation';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { MobileVendorIcon } from '@/components/MobileVendorIcon';
import {
  MainWindowActionGroup,
  MainWindowEmptyState,
  StatusDot,
} from '@/components/MobilePrimitives';
import { RemoteAccessGuide } from '@/components/RemoteAccessGuide';
import { HomeChromeDrawer } from '@/session/HomeChromeDrawer';
import { AccountSwitcherSheet } from '@/session/AccountSwitcherSheet';
import { HomeChromeFrost } from '@/session/HomeChromeFrost';
import { HomeGlassMenuPanel, HomeMenuScrim } from '@/session/HomeGlassMenuPanel';
import { HomeHeaderGlassButton } from '@/session/HomeHeaderGlassButton';
import { HomeSearchBar } from '@/session/HomeSearchBar';
import {
  HomeNativeStackHeader,
  NativePullDownMenu,
  usesNativePullDownMenu,
  usesNativeStackHeader,
  usesSystemActionMenu,
} from '@/platform/chrome';
import {
  buildHomeDisplayPullDownActions,
  buildHomeScopePullDownActions,
  homeDisplayMenuPatch,
  parseHomeScopePullDownAction,
  type HomeDisplayMenuKey,
} from '@/session/homeChromeMenus';
import { useConversationSearchFilterMenu } from '@/session/useConversationSearchFilterMenu';
import { buildMainWindowLayout } from '@/components/mainWindowLayout';
import { useScreenEdgePadding } from '@/components/screenEdgeInsets';
import { isAccessRevokedError } from '@/device-link/accessRevoked';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  createEmptyDeviceIdentityCache,
  loadDeviceIdentityCache,
  reconcileDeviceIdentities,
  saveDeviceIdentityCache,
} from '@/device-link/deviceIdentityStore';
import { toDeviceListItems } from '@/device-link/devices';
import {
  collectFreshPresenceDeviceIds,
  createPresenceFreshnessTracker,
  deviceMirrorCleanupDisposition,
  markPresenceFresh,
  mergeDeviceViewsWithFreshPresence,
  patchDeviceViewsWithPresence,
} from '@/device-link/presenceDevices';
import {
  connectionIssueHint,
  connectionIssueTitle,
  describeRemoteError,
  formatRemoteError,
} from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { revokedDevicesStore, useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import {
  remoteScheduleEventStore,
  useRemoteScheduleMirrorInvalidations,
} from '@/scheduler/remoteScheduleEvents';
import { ConversationSearchFilterSheet } from '@/session/ConversationSearchFilterSheet';
import {
  conversationSearchAllowsLocalWrites,
  conversationSearchOriginsFromDeviceModels,
  listConversationSearchProjects,
  shouldReplaceListWithSearchResults,
} from '@/session/conversationSearch';
import { useConversationSearch } from '@/session/useConversationSearch';
import {
  buildMobileHomePresentation,
  excludeOrcaWorkerSessions,
  type MobileHomeDeviceFilterItem,
  type MobileHomeProjectGroup,
} from '@/session/mobileHome';
import {
  advanceCurrentViewedPriorityHold,
  advanceViewedPriorityHold,
  collectHomePriorityContext,
  holdViewedPriorityRank,
  homeViewedPriorityHold,
  type HomeListSortBy,
  type HomeStatusFilter,
} from '@/session/homeListPriority';
import {
  projectDropIndexFromY,
  reorderVisibleProjectByDropIndex,
  resolveVirtualizedDropIndex,
  snapshotManualProjectOrder,
  type HomeProjectOrder,
} from '@/session/homeProjectOrder';
import {
  applyHostProjectOrder,
  controllerKeysFromHost,
  fetchHostProjectOrder,
  rememberRemoteProjectOrderStamp,
  subscribeRemoteProjectOrderChanged,
} from '@/session/remoteProjectOrder';
import {
  createProjectOrderFetchFence,
  isHostProjectOrderReachable,
  projectOrderWriteLedger,
  resolveDisplayedProjectOrder,
  resolveProjectOrderWriteScope,
  UNAVAILABLE_PROJECT_ORDER_SNAPSHOT,
  type SyncedProjectOrderSnapshot,
} from '@cindy/maker-shared/project-order-sync';
import { buildHomeSections, homeRowBefore, isFolderHomeRow, type HomeRow, type HomeSection } from '@/session/homeSections';
import {
  readHomeViewPreferences,
  saveHomeViewPreferences,
  type HomeViewPreferences,
} from '@/session/homeViewPreferenceStore';
import {
  getCachedHomeListSnapshot,
  scheduleHomeListSnapshotPersist,
} from '@/session/mobileHomeListCache';
import { startBoundedStartupRead } from '@/session/mobileHomeStartup';
import {
  diffHomeDeviceSyncScope,
  HomeDeviceSyncLimiter,
  resolveHomeDeviceSyncIds,
  runHomeDeviceSyncBatch,
} from '@/session/homeDeviceSync';
import { serializeNewSessionDeviceOptions } from '@/session/newSession';
import {
  buildRemoteSessionCardPreview,
  buildSessionMessagePreviewIndex,
  formatRemoteSessionSidebarTime,
  getRemoteSessionPreviewCollapse,
  type RemoteAutomationSessionGroup,
  type RemoteSessionListItem,
  type RemoteSessionLiveActivity,
  type RemoteSessionScheduleInfo,
  type RemoteSessionStatusFilter,
} from '@/session/sessionList';
import {
  remoteSessionStore,
  useRemoteMessageVersion,
  useRemoteSessions,
  useRemoteSessionStoreVersion,
  useSessionRunning,
} from '@/session/remoteSessionStore';
import { dataPropsEqual, mapContentEqual } from '@/utils/valueEquality';
import { useStableValue } from '@/utils/useStableValue';
import { useMinuteNow } from '@/utils/useMinuteNow';
import {
  getScheduleIndexInvalidationVersion,
  invalidateOfflineScheduleIndexFailureFor,
  invalidateRunningSessionScheduleEntries,
  invalidateScheduleIndexForDevice,
  loadDeviceSessionScheduleIndex,
  loadSessionScheduleIndexThrottled,
  replaceSessionScheduleIndexEntries,
} from '@/session/scheduleIndex';
import { createScheduleIndexDeferRegistry } from '@/session/scheduleIndexDefer';
import { resolveMobileSessionRightStatus } from '@/session/sessionRightStatus';
import { AutomationTimerIcon } from '@/session/AutomationTimerIcon';
import { RenameSessionModal } from '@/session/RenameSessionModal';
import { SessionOptionsPresenter } from '@/session/SessionOptionsExpoSheet';
import { SwipeableSessionRow, type SessionSwipeControls } from '@/session/SwipeableSessionRow';
import { createSwipeRowRegistry } from '@/session/swipeRowRegistry';
import { useSessionListActions } from '@/session/useSessionListActions';
import { useModalFadeLifecycle } from '@/session/useModalFadeLifecycle';
import type { RemoteSession } from '@/session/types';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

const LIST_LIMIT = 200;
const DEVICE_LIST_TIMEOUT_MS = 12_000;
const HOME_LIST_SUBSCRIPTION_OWNER = 'device-list';
// 项目组与自动化组展开后的子列表共用同一个预览限量(设备详情页也 import 复用,避免两处漂移)。
export const PROJECT_PREVIEW_LIMIT = 5;
const HOME_SESSION_ROW_HEIGHT = 78;
const HOME_SESSION_SINGLE_LINE_ROW_HEIGHT = 60;
const CINDY_LIST_GUTTER = 20;
const CINDY_LIST_FAB_SIZE = 55;
const CINDY_LIST_FAB_BOTTOM = 45;
const HOME_HEADER_MIN_HEIGHT = 48;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type RemoteListStatusFilter = Extract<RemoteSessionStatusFilter, 'active' | 'archived' | 'all'>;
type HomeDeviceConnectionState = 'idle' | 'syncing' | 'failed';

type ProjectHeaderLayout = { height: number; key: string; y: number };

type ProjectDragSession = {
  count: number;
  height: number;
  hoverIndex: number;
  key: string;
  layouts: ProjectHeaderLayout[];
  originY: number;
  rootY: number;
  title: string;
  width: number;
  x: number;
};
type HydrateDeviceSessionsResult = {
  failure: string | null;
  needsRerun?: boolean;
  offline: boolean;
  superseded: boolean;
};

type HomeHydrateInFlightEntry = {
  accountGeneration: number;
  device: DeviceView;
  homeSyncGeneration: number;
  promise: Promise<HydrateDeviceSessionsResult>;
  rerunRequested: boolean;
};

type HydrateDeviceSessions = (
  device: DeviceView,
  expectedAccountGeneration?: number,
  options?: { trailingIfInFlight?: boolean },
) => Promise<HydrateDeviceSessionsResult>;

class HomeSyncScopeSupersededError extends Error {
  constructor() {
    super('Home sync scope superseded');
    this.name = 'HomeSyncScopeSupersededError';
  }
}

export default function HomeScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  // 所有前进导航(进会话 / 新建 / 设置 / 组页面)统一走守卫 push:列表卡顿时的
  // 连点会各自触发一次裸 push,把同一页压进栈 N 层(返回也要 N 次)。
  const guardedPush = useGuardedPush();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const auth = useAuth();
  const { accountGeneration, apiFetch, deviceId: selfDeviceId, user } = auth;
  // 首页列表持久缓存按账号键控(401 掉线换号不串数据);首页仅登录后可达,user 理应非空。
  const homeCacheUserId = user?.id ?? '';
  const {
    connectionEpoch,
    connectionIssue,
    invoke,
    lastPresenceSnapshot,
    status,
    subscribe,
    unsubscribe,
  } = useDeviceLink();
  const revokedDevices = useRevokedDevices();
  const sessions = useRemoteSessions();
  const messageVersion = useRemoteMessageVersion();
  const storeVersion = useRemoteSessionStoreVersion();
  const syncInFlightRef = useRef<Promise<void> | null>(null);
  const syncQueuedRef = useRef<{ visible?: boolean } | null>(null);
  const loadHomeRef = useRef<(options?: { visible?: boolean }) => Promise<void>>(async () => undefined);
  const devicesRef = useRef<DeviceView[]>([]);
  // HomeScreen stays mounted while switching saved accounts. Keep an owner generation beside every
  // local projection so requests started by the previous account cannot repopulate the new screen.
  const homeAccountGenerationRef = useRef(accountGeneration);
  homeAccountGenerationRef.current = accountGeneration;
  // schedule-index hydration 延后任务登记表(按设备 id 索引):为同一设备注册新延后任务前取消上一轮
  // pending 的,避免 800ms 窗口内多次 hydrate 时较早回调用旧快照覆盖新状态(并发覆盖竞态);卸载时 cancelAll。
  const scheduleIndexDeferRegistryRef = useRef(createScheduleIndexDeferRegistry());
  const scheduleEventVersionsRef = useRef(new Map<string, number>());
  // Home 只拥有当前显示范围内的 `sessions` topic。target 包含已领取但仍在共享
  // 六路队列中等待的设备；owned 只包含已经真正调用 subscribe 的设备。两者必须
  // 分开，否则切换范围会为尚未订阅的排队设备发出一批无意义 unsubscribe。
  const homeSyncTargetDeviceIdsRef = useRef(new Set<string>());
  const homeListOwnedDeviceIdsRef = useRef(new Set<string>());
  // Per-device generation fences A → B → A scope switches. Membership alone is not
  // sufficient: an old A request may settle after A has been reacquired and must not
  // overwrite the newer snapshot or release the newer owner's subscription.
  const homeSyncGenerationByDeviceRef = useRef(new Map<string, number>());
  // Reconnect rehydrate, presence recovery and Home refresh can all request the same device
  // at once. Share one authoritative list pull per device + scope generation.
  const homeHydrateInFlightByDeviceRef = useRef(new Map<string, HomeHydrateInFlightEntry>());
  const hydrateDeviceSessionsRef = useRef<HydrateDeviceSessions>(async () => ({
    failure: null,
    offline: false,
    superseded: true,
  }));
  const homeDeviceSyncLimiterRef = useRef(new HomeDeviceSyncLimiter());
  const deviceIdentityCacheRef = useRef(createEmptyDeviceIdentityCache());
  // A timed-out SecureStore read may still complete. Do not persist an empty/rebuilt
  // cache until that read settles and its stored identities have been reapplied.
  const deviceIdentityCachePersistReadyRef = useRef(false);
  const deviceIdentityCachePersistPendingRef = useRef(false);
  // presence 补丁新鲜度:loadHome 用它判断哪些设备在 REST 快照发起后又收到过 presence-changed,
  // 避免用过期快照把它们改回离线(否则出现「会话都同步出来了、新建对话按钮却灰着」的卡死态)。
  const presenceFreshnessRef = useRef(createPresenceFreshnessTracker());
  // 最近一次已登记 freshness 的快照对象:presence effect 因其它依赖变化重跑时,旧快照不能再算「新」。
  const lastPresenceSnapshotProcessedRef = useRef<PresenceSnapshot | null>(null);
  // loadHome 完成时刻的 ref 镜像:首页列表缓存的种入回调用它判断「fresh 是否已先到」,
  // 避免极端竞态下(AsyncStorage 比整轮 loadHome 还慢)用缓存复活已被 removeDevice 清掉的 shard。
  const lastSyncedAtRef = useRef<number | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [deviceIdentityCacheReady, setDeviceIdentityCacheReady] = useState(false);
  // 首页列表缓存(设备+会话快照)是否已尝试种入:首次 loadHome 等它先落地,保证「先画缓存、
  // fresh 回来再覆盖」的顺序确定性(规则 7),缓存为空时该状态同样置 true、行为与现状一致。
  const [homeListCacheHydrated, setHomeListCacheHydrated] = useState(false);
  // 首次网络同步必须等设备筛选偏好恢复，否则单机用户会先按默认“全部”拉一轮所有电脑。
  const [homeViewPreferencesHydrated, setHomeViewPreferencesHydrated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const selectedDeviceIdRef = useRef<string | null>(selectedDeviceId);
  selectedDeviceIdRef.current = selectedDeviceId;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilterOpen, setSearchFilterOpen] = useState(false);
  // 恢复偏好时暂存的设备名:设备列表尚未同步回来前表头用它兜底,避免显示成占位文案。
  const [restoredDeviceName, setRestoredDeviceName] = useState<string | null>(null);
  // 用户已手动切换过筛选/分组后,迟到的偏好恢复不再覆盖用户操作。
  const viewPrefsTouchedRef = useRef(false);
  const leftHomeForSessionRef = useRef(false);
  // 恢复自偏好的设备选择还没做过首次同步后的可用性校验(一次性,校验后或用户手动选择后清掉)。
  const restoredSelectionUnvalidatedRef = useRef(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [chromeMenuOpen, setChromeMenuOpen] = useState(false);
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [chromeMenuCloseInstant, setChromeMenuCloseInstant] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // 菜单关闭动画完成(Modal 卸载)后要执行的动作。iOS 上两个兄弟 Modal 重叠时,第二个 Modal
  // 是叠在菜单 Modal 的 VC 上 present 的,菜单淡出后卸载会把它连带 dismiss 掉——所以从菜单里
  // 打开重命名 / 撤销授权弹窗必须等菜单完全卸载(onClosed)后再挂载,不能同一帧直接 set。
  const pendingMenuActionRef = useRef<(() => void) | null>(null);
  const pendingAccountSwitcherActionRef = useRef<(() => void) | null>(null);
  const [renameTarget, setRenameTarget] = useState<MobileHomeDeviceFilterItem | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const {
    actionSheetSession,
    archiveSession,
    closeRenameSession,
    confirmRenameSession,
    handleSessionSheetAction,
    handleSessionSheetClosed,
    renameSessionDraft,
    renameSessionTarget,
    sessionSwipeControls,
    setActionSheetSession,
    setRenameSessionDraft,
    showSessionOptions,
    swipeRegistry,
    toggleSessionPinned,
  } = useSessionListActions();
  // 实测 header 高度(onLayout),用于下拉菜单定位;字体放大等导致 header 超过 HOME_HEADER_MIN_HEIGHT 时不再错位。
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);
  const [headerFrosted, setHeaderFrosted] = useState(false);
  const [groupByProject, setGroupByProject] = useState(true);
  const [groupDialogue, setGroupDialogue] = useState(false);
  const [sortBy, setSortBy] = useState<HomeListSortBy>('recency');
  const [projectOrder, setProjectOrder] = useState<HomeProjectOrder>('activity');
  const [manualProjectOrder, setManualProjectOrder] = useState<string[]>([]);
  const [hostProjectOrders, setHostProjectOrders] = useState<ReadonlyMap<string, SyncedProjectOrderSnapshot>>(() => new Map());
  const projectOrderFetchFenceRef = useRef(createProjectOrderFetchFence());
  const visualProjectKeysRef = useRef<string[]>([]);
  const homeRootRef = useRef<View>(null);
  const projectHeaderRefs = useRef(new Map<string, View>());
  const projectDragRef = useRef<ProjectDragSession | null>(null);
  const projectDragEpochRef = useRef(0);
  const [projectDrag, setProjectDrag] = useState<ProjectDragSession | null>(null);
  const projectDragY = useSharedValue(0);
  const [dialogueShowAll, setDialogueShowAll] = useState(false);
  const [priorityHoldEpoch, setPriorityHoldEpoch] = useState(0);
  // deviceId of the revoked-access device whose explanation tip is open (null = closed).
  const [revokedTipDeviceId, setRevokedTipDeviceId] = useState<string | null>(null);
  // 重试申请访问的 in-flight 设备集合(状态供 UI,ref 供并发去重)。用 Set 而非单值:
  // 引导页可对多台被撤销设备并发重试,单值会被后完成的请求提前清掉、还允许重复触发。
  const [retryingDeviceIds, setRetryingDeviceIds] = useState<ReadonlySet<string>>(new Set());
  const retryingDeviceIdsRef = useRef<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<HomeStatusFilter>('active');
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<string[]>([]);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  // 已展开的自动化组 key(页面级 state:SectionList 虚拟化回收行组件时展开态不丢)。
  const [expandedAutomationGroups, setExpandedAutomationGroups] = useState<string[]>([]);
  const [rawDeviceConnectionStates, setDeviceConnectionStates] = useState<Record<string, HomeDeviceConnectionState>>({});
  // 熔断 open(电脑端未响应)的设备复用既有 failed 渲染路径(红圈),不新增视觉:
  // 内部态映射覆盖在 hydrate 状态之上,熔断关闭后自动回落到原状态。
  const unresponsiveDevices = useUnresponsiveDevices();
  const deviceConnectionStates = useMemo<Record<string, HomeDeviceConnectionState>>(() => {
    if (unresponsiveDevices.size === 0) return rawDeviceConnectionStates;
    const merged: Record<string, HomeDeviceConnectionState> = { ...rawDeviceConnectionStates };
    for (const deviceId of unresponsiveDevices) merged[deviceId] = 'failed';
    return merged;
  }, [rawDeviceConnectionStates, unresponsiveDevices]);
  const [scheduleIndex, setScheduleIndex] = useState<Map<string, RemoteSessionScheduleInfo>>(() => new Map());
  const scheduleMirrorInvalidations = useRemoteScheduleMirrorInvalidations();

  // Clear the entire account-owned Home projection before paint. The generation ref is already
  // updated during render, so every older async continuation is fenced even before this reset runs.
  useLayoutEffect(() => {
    syncInFlightRef.current = null;
    syncQueuedRef.current = null;
    devicesRef.current = [];
    homeSyncTargetDeviceIdsRef.current.clear();
    homeListOwnedDeviceIdsRef.current.clear();
    homeSyncGenerationByDeviceRef.current.clear();
    homeHydrateInFlightByDeviceRef.current.clear();
    scheduleIndexDeferRegistryRef.current.cancelAll();
    scheduleEventVersionsRef.current.clear();
    presenceFreshnessRef.current = createPresenceFreshnessTracker();
    lastPresenceSnapshotProcessedRef.current = null;
    lastSyncedAtRef.current = null;
    restoredSelectionUnvalidatedRef.current = false;
    retryingDeviceIdsRef.current.clear();
    projectOrderFetchFenceRef.current = createProjectOrderFetchFence();
    projectDragEpochRef.current += 1;
    projectDragRef.current = null;

    setDevices([]);
    setHomeListCacheHydrated(false);
    setRefreshing(false);
    setError(null);
    setLastSyncedAt(null);
    setSelectedDeviceId(null);
    setRestoredDeviceName(null);
    setDeviceConnectionStates({});
    setScheduleIndex(new Map());
    setHostProjectOrders(new Map());
    setRevokedTipDeviceId(null);
    setRetryingDeviceIds(new Set());
    setRenameTarget(null);
    setRenameDraft('');
    setRenameSaving(false);
    setProjectDrag(null);
  }, [accountGeneration]);

  const updateDeviceConnectionState = useCallback((deviceId: string, state: HomeDeviceConnectionState) => {
    setDeviceConnectionStates((current) => updateHomeDeviceConnectionState(current, deviceId, state));
  }, []);

  const isCurrentHomeSyncTarget = useCallback((deviceId: string, generation?: number) => {
    const selected = selectedDeviceIdRef.current;
    return (
      (!selected || selected === deviceId)
      && homeSyncTargetDeviceIdsRef.current.has(deviceId)
      && (
        generation === undefined
        || homeSyncGenerationByDeviceRef.current.get(deviceId) === generation
      )
    );
  }, []);

  const advanceHomeSyncGeneration = useCallback((deviceId: string) => {
    const next = (homeSyncGenerationByDeviceRef.current.get(deviceId) ?? 0) + 1;
    homeSyncGenerationByDeviceRef.current.set(deviceId, next);
    return next;
  }, []);

  const releaseHomeListOwner = useCallback((deviceId: string) => {
    if (!homeListOwnedDeviceIdsRef.current.delete(deviceId)) return;
    updateDeviceConnectionState(deviceId, 'idle');
    // unsubscribe 会同步先撤销 registry owner，再等待远端 ACK；即使弱网下 ACK 失败，
    // 下一次重连也不会恢复这台已不可见设备。缓存刻意不删，切回来先画旧快照。
    void unsubscribe(HOME_LIST_SUBSCRIPTION_OWNER, deviceId, ['sessions']).catch(() => undefined);
  }, [unsubscribe, updateDeviceConnectionState]);

  const reconcileHomeDeviceSyncScope = useCallback((desiredDeviceIds: readonly string[]) => {
    const diff = diffHomeDeviceSyncScope(homeSyncTargetDeviceIdsRef.current, desiredDeviceIds);
    homeSyncTargetDeviceIdsRef.current = new Set(desiredDeviceIds);

    for (const deviceId of diff.release) {
      advanceHomeSyncGeneration(deviceId);
      releaseHomeListOwner(deviceId);
    }
    for (const deviceId of diff.acquire) {
      advanceHomeSyncGeneration(deviceId);
    }
    return diff;
  }, [advanceHomeSyncGeneration, releaseHomeListOwner]);

  useEffect(() => () => {
    const owned = [...homeListOwnedDeviceIdsRef.current];
    homeListOwnedDeviceIdsRef.current.clear();
    homeSyncTargetDeviceIdsRef.current.clear();
    for (const deviceId of owned) advanceHomeSyncGeneration(deviceId);
    for (const deviceId of owned) {
      void unsubscribe(HOME_LIST_SUBSCRIPTION_OWNER, deviceId, ['sessions']).catch(() => undefined);
    }
  }, [advanceHomeSyncGeneration, unsubscribe]);

  const reconcileDeviceViews = useCallback((nextRawDevices: readonly DeviceView[]) => {
    const result = reconcileDeviceIdentities(nextRawDevices, deviceIdentityCacheRef.current);
    deviceIdentityCacheRef.current = result.cache;
    if (result.cacheChanged) {
      if (deviceIdentityCachePersistReadyRef.current) void saveDeviceIdentityCache(result.cache);
      else deviceIdentityCachePersistPendingRef.current = true;
    }
    return result;
  }, []);

  const softInvalidateDeviceMirror = useCallback((deviceId: string) => {
    const sessionIds = remoteSessionStore.getSessions()
      .filter((session) => session.deviceLinkDeviceId === deviceId)
      .map((session) => session.id);
    invalidateScheduleIndexForDevice(deviceId);
    remoteScheduleEventStore.invalidateDeviceMirror(deviceId);
    remoteSessionStore.markDeviceOffline(deviceId);
    setScheduleIndex((current) => invalidateRunningSessionScheduleEntries(current, sessionIds));
  }, []);

  const markDeviceOffline = useCallback((deviceId: string) => {
    // 普通离线是可恢复的传输状态:保留 session/messages,只清 live 投影并失效
    // message marker。恢复后会话立即显示 last-known 内容,后台 reopen 再补最新窗口。
    softInvalidateDeviceMirror(deviceId);
    setDevices((current) => {
      const next = reconcileDeviceViews(markDeviceViewsOffline(current, new Set([deviceId]))).devices;
      devicesRef.current = next;
      return next;
    });
  }, [reconcileDeviceViews, softInvalidateDeviceMirror]);

  const refreshDeviceScheduleIndex = useCallback((
    deviceId: string,
    sessionIds: readonly string[],
    options?: { accountGeneration?: number; force?: boolean; homeSyncGeneration?: number },
  ) => {
    const expectedAccountGeneration = options?.accountGeneration ?? accountGeneration;
    const expectedHomeSyncGeneration = options?.homeSyncGeneration
      ?? homeSyncGenerationByDeviceRef.current.get(deviceId);
    if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
    if (
      expectedHomeSyncGeneration === undefined
      || !isCurrentHomeSyncTarget(deviceId, expectedHomeSyncGeneration)
    ) return;
    // 节流(单飞 + 30s TTL):focus / hydrate / schedule 推送三个触发源高频交叠,每次都全量
    // 重放 1+N×listRuns 会拥塞 device-link 管道、拖慢会话打开的关键读(见 scheduleIndex 注释)。
    // force = 已读类权威信号(read / all-read 推送),必须绕过 TTL 立即重拉——否则「看完
    // 返回首页」这个最常见路径永远命中 30s 内的陈旧缓存,未读徽标清不掉(review P1)。
    const invalidationVersion = getScheduleIndexInvalidationVersion(deviceId);
    void homeDeviceSyncLimiterRef.current.run(async () => {
      if (
        homeAccountGenerationRef.current !== expectedAccountGeneration
        || !isCurrentHomeSyncTarget(deviceId, expectedHomeSyncGeneration)
      ) return null;
      return loadSessionScheduleIndexThrottled(
        deviceId,
        () => loadDeviceSessionScheduleIndex(deviceId, invoke),
        { force: options?.force },
      );
    })
      .then((nextIndex) => {
        if (!nextIndex) return;
        if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
        if (!isCurrentHomeSyncTarget(deviceId, expectedHomeSyncGeneration)) return;
        if (getScheduleIndexInvalidationVersion(deviceId) !== invalidationVersion) return;
        setScheduleIndex((current) => replaceSessionScheduleIndexEntries(
          current,
          sessionIds,
          nextIndex,
        ));
      })
      .catch(() => {
        // 网络失败时保留旧数据,不清零已有徽标——数据清零只应由明确的"已读"事件触发。
      });
  }, [accountGeneration, invoke, isCurrentHomeSyncTarget]);

  const hydrateDeviceSessionsOnce = useCallback((
    device: DeviceView,
    expectedAccountGeneration: number,
    expectedHomeSyncGeneration: number,
  ): Promise<HydrateDeviceSessionsResult> => homeDeviceSyncLimiterRef.current.run(async () => {
    if (
      homeAccountGenerationRef.current !== expectedAccountGeneration
      || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
    ) {
      return { failure: null, offline: false, superseded: true };
    }
    updateDeviceConnectionState(device.deviceId, 'syncing');
    try {
      const [
        list,
        activeSessions,
        activeSessionSnapshotEpoch,
        sessionListMutationEpoch,
      ] = await withTransientRemoteRetry(async () => {
        if (
          homeAccountGenerationRef.current !== expectedAccountGeneration
          || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
        ) {
          throw new HomeSyncScopeSupersededError();
        }
        homeListOwnedDeviceIdsRef.current.add(device.deviceId);
        await subscribe(HOME_LIST_SUBSCRIPTION_OWNER, device.deviceId, ['sessions']);
        if (
          homeAccountGenerationRef.current !== expectedAccountGeneration
          || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
        ) {
          throw new HomeSyncScopeSupersededError();
        }
        // Capture inside the retry callback so every maker:list-active attempt gets its own
        // fence. A newer retry push received while this request is in flight must survive
        // the older snapshot, while progress predating this attempt can be cleared.
        const activeSessionSnapshotEpoch = remoteSessionStore.captureActiveSessionSnapshotEpoch();
        const sessionListMutationEpoch = remoteSessionStore.captureDeviceSessionListMutationEpoch(
          device.deviceId,
        );
        const [list, activeSessions] = await Promise.all([
          invoke<RemoteSession[]>(device.deviceId, 'local-db:sessions:list', [
            LIST_LIMIT,
            remoteListStatusFilter(statusFilter),
            // hydrate / 重连是权威重拉，绕开被控端写前的同参数 in-flight list。
            { includePinned: true, fresh: true },
          ]),
          // `sessions` topic replay covers list-level Agent Island activity, but the authoritative
          // "turn currently running" snapshot is maker:list-active. Pull it with the list so Home
          // does not need a session-detail round trip before showing running rows.
          invoke<unknown[]>(device.deviceId, 'maker:list-active', []).catch((err) => {
            if (isOptionalActiveSessionSnapshotError(err)) return null;
            throw err;
          }),
        ]);
        return [
          list,
          activeSessions,
          activeSessionSnapshotEpoch,
          sessionListMutationEpoch,
        ] as const;
      });
      if (
        homeAccountGenerationRef.current !== expectedAccountGeneration
        || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
      ) {
        return { failure: null, offline: false, superseded: true };
      }
      if (!remoteSessionStore.isDeviceSessionListMutationEpochCurrent(
        device.deviceId,
        sessionListMutationEpoch,
      )) {
        // A list-level push landed after this snapshot started. Keep the live mutation and
        // run one trailing authoritative pull; applying this older whole-list response would
        // roll back sessions:patched or hide a just-created task.
        return {
          failure: null,
          needsRerun: true,
          offline: false,
          superseded: true,
        };
      }
      const nextSessions = Array.isArray(list) ? list : [];
      remoteSessionStore.setDeviceSessions(
        device.deviceId,
        device.name,
        nextSessions,
      );
      if (Array.isArray(activeSessions)) {
        remoteSessionStore.setActiveSessionSnapshots(
          device.deviceId,
          activeSessions,
          activeSessionSnapshotEpoch,
        );
      }
      // schedule-index(1+N 个 listRuns)是次要徽标数据,延后发,避开"开 app→立刻点会话"时和会话关键读
      // 抢同一条 WS 管道(见 scheduleIndexDefer / issue #324)。home 自动化分组与名称已由 fallbackScheduleInfo
      // 兜底,徽标晚半拍出现即可。
      // 按设备 id 登记:同设备上一轮还没执行的延后任务会被先取消,避免较早回调用旧 nextSessions 覆盖新状态。
      scheduleIndexDeferRegistryRef.current.schedule(device.deviceId, () => {
        void (async () => {
          while (syncInFlightRef.current) await syncInFlightRef.current;
          if (
            homeAccountGenerationRef.current !== expectedAccountGeneration
            || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
          ) return;
          refreshDeviceScheduleIndex(device.deviceId, nextSessions.map((session) => session.id), {
            accountGeneration: expectedAccountGeneration,
            homeSyncGeneration: expectedHomeSyncGeneration,
          });
        })();
      });
      updateDeviceConnectionState(device.deviceId, 'idle');
      // hydrate 成功后去抖回写首页列表缓存(collect 在定时器触发时才读 store,拿届时最新快照;
      // 多设备并发 hydrate 只落盘一次)。不在 store 每次变更时写盘。缓存按账号键控。
      scheduleHomeListSnapshotPersist(homeCacheUserId, () => remoteSessionStore.getSessions());
      return { failure: null, offline: false, superseded: false };
    } catch (err) {
      if (
        err instanceof HomeSyncScopeSupersededError
        || homeAccountGenerationRef.current !== expectedAccountGeneration
        || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
      ) {
        return { failure: null, offline: false, superseded: true };
      }
      const offline = isDeviceOfflineError(err);
      if (offline) markDeviceOffline(device.deviceId);
      updateDeviceConnectionState(device.deviceId, 'failed');
      return {
        failure: `${device.name}: ${formatRemoteError(err)}`,
        offline,
        superseded: false,
      };
    }
  }, 'foreground'), [homeCacheUserId, invoke, isCurrentHomeSyncTarget, markDeviceOffline, refreshDeviceScheduleIndex, statusFilter, subscribe, updateDeviceConnectionState]);

  const hydrateDeviceSessions = useCallback((
    device: DeviceView,
    expectedAccountGeneration = accountGeneration,
    options: { trailingIfInFlight?: boolean } = {},
  ): Promise<HydrateDeviceSessionsResult> => {
    const expectedHomeSyncGeneration = homeSyncGenerationByDeviceRef.current.get(device.deviceId);
    if (
      expectedHomeSyncGeneration === undefined
      || homeAccountGenerationRef.current !== expectedAccountGeneration
      || !isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)
    ) {
      return Promise.resolve({ failure: null, offline: false, superseded: true });
    }

    const existing = homeHydrateInFlightByDeviceRef.current.get(device.deviceId);
    if (
      existing
      && existing.accountGeneration === expectedAccountGeneration
      && existing.homeSyncGeneration === expectedHomeSyncGeneration
    ) {
      existing.device = device;
      if (options.trailingIfInFlight) existing.rerunRequested = true;
      return existing.promise;
    }

    const promise = hydrateDeviceSessionsOnce(
      device,
      expectedAccountGeneration,
      expectedHomeSyncGeneration,
    );
    const entry: HomeHydrateInFlightEntry = {
      accountGeneration: expectedAccountGeneration,
      device,
      homeSyncGeneration: expectedHomeSyncGeneration,
      promise,
      rerunRequested: false,
    };
    homeHydrateInFlightByDeviceRef.current.set(device.deviceId, entry);
    const settle = (needsRerun: boolean) => {
      if (homeHydrateInFlightByDeviceRef.current.get(device.deviceId) !== entry) return;
      homeHydrateInFlightByDeviceRef.current.delete(device.deviceId);
      if (
        !needsRerun
        && !entry.rerunRequested
      ) return;
      if (
        homeAccountGenerationRef.current !== entry.accountGeneration
        || !isCurrentHomeSyncTarget(device.deviceId, entry.homeSyncGeneration)
      ) return;
      void hydrateDeviceSessionsRef.current(entry.device, entry.accountGeneration);
    };
    void promise.then(
      (result) => settle(result.needsRerun === true),
      () => settle(false),
    );
    return promise;
  }, [accountGeneration, hydrateDeviceSessionsOnce, isCurrentHomeSyncTarget]);
  hydrateDeviceSessionsRef.current = hydrateDeviceSessions;

  const probeRevokedDeviceAccess = useCallback(async (
    deviceId: string,
    expectedAccountGeneration = accountGeneration,
  ): Promise<boolean> => {
    if (homeAccountGenerationRef.current !== expectedAccountGeneration) return false;
    try {
      // sessions:list limit=1 是既有的最小被控端响应性探测；不要为了探测给不可见设备
      // 持有 `sessions` topic，也不要把这一行写回完整列表缓存。
      await withTransientRemoteRetry(() => invoke<unknown[]>(deviceId, 'local-db:sessions:list', [
        1,
        'active',
        { includePinned: true, fresh: true },
      ]), { maxAttempts: 3 });
      return homeAccountGenerationRef.current === expectedAccountGeneration;
    } catch {
      return false;
    }
  }, [accountGeneration, invoke]);

  const loadHome = useCallback(async (options: { visible?: boolean } = {}) => {
    const accountGenerationAtStart = accountGeneration;
    if (homeAccountGenerationRef.current !== accountGenerationAtStart) return;
    if (!deviceIdentityCacheReady) return;
    const visible = options.visible === true;
    if (visible) setRefreshing(true);
    if (syncInFlightRef.current) {
      syncQueuedRef.current = options;
      return syncInFlightRef.current.finally(() => {
        if (visible && homeAccountGenerationRef.current === accountGenerationAtStart) {
          setRefreshing(false);
        }
      });
    }

    const rawTask = (async () => {
      setError(null);
      // 记录 REST 请求发起时的 presence 纪元:在请求飞行期间收到过 presence 补丁的设备,
      // 以 devicesRef 里的实时状态为准,不被"请求发起时刻"的过期 REST 快照改回离线。
      // 典型场景:开 App 时桌面端正好重连——REST 快照还是 offline,presence-changed(online)
      // 已把设备补成在线并 hydrate 出会话;若整体覆盖,presence 不会再广播事件来纠正,
      // 首页会卡死在「会话都在、设备全不可用(新建对话按钮灰)」直到手动下拉刷新。
      const presenceEpochAtFetchStart = presenceFreshnessRef.current.epoch;
      const mergeFreshPresence = (list: readonly DeviceView[]) => mergeDeviceViewsWithFreshPresence(
        list,
        devicesRef.current,
        collectFreshPresenceDeviceIds(presenceFreshnessRef.current, presenceEpochAtFetchStart),
      );
      // 设备清单 REST 是整轮同步的闸门:它一次失败整个 loadHome 就失败,而每设备的
      // WS hydrate 已有瞬时重试——闸门自己也必须重试,否则一次弱网抖动就把首页
      // 卡在「同步失败」等手动下拉。maxAttempts 收敛到 3:它前置于全部 hydrate,
      // 不值得为它烧满 6 次退避。
      const res = await withTransientRemoteRetry(
        () => {
          if (homeAccountGenerationRef.current !== accountGenerationAtStart) {
            throw new Error('Home account generation superseded');
          }
          return apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
            baseUrl: DEVICE_LINK_API_BASE_URL,
            timeoutMs: DEVICE_LIST_TIMEOUT_MS,
          });
        },
        { maxAttempts: 3 },
      );
      if (homeAccountGenerationRef.current !== accountGenerationAtStart) return;
      const now = Date.now();
      const serverDevices = mergeFreshPresence(reconcileDeviceViews(res.devices).devices);
      const deviceRows = toDeviceListItems(serverDevices, now, revokedDevices);
      const availableRows = deviceRows.filter((item) => item.canOpen);
      const syncDeviceIds = resolveHomeDeviceSyncIds(
        availableRows.map((item) => ({ canOpen: true, deviceId: item.device.deviceId })),
        selectedDeviceIdRef.current,
      );
      const syncDeviceIdSet = new Set(syncDeviceIds);
      const syncRows = availableRows.filter((item) => syncDeviceIdSet.has(item.device.deviceId));
      const selectedDeviceIdAtSyncStart = selectedDeviceIdRef.current;
      reconcileHomeDeviceSyncScope(syncDeviceIds);
      // 设备清单 / presence 不等列表 fan-out：先发布全量设备状态，再用最多 6 个 worker
      // 补当前显示范围。scope effect 看到的 owner 已在上面领取，不会重复派发。
      devicesRef.current = serverDevices;
      setDevices(serverDevices);
      setDeviceConnectionStates((current) => pruneHomeDeviceConnectionStates(
        current,
        new Set(availableRows.map((item) => item.device.deviceId)),
      ));
      // 单次 REST 快照里的 offline 只是可恢复状态,不能硬删刚同步的会话/消息;
      // 显式关闭远控或撤权才是权限终态,继续清敏感镜像。
      for (const item of deviceRows) {
        const disposition = deviceMirrorCleanupDisposition(item.state);
        if (disposition === 'soft') softInvalidateDeviceMirror(item.device.deviceId);
        if (disposition === 'hard') {
          invalidateScheduleIndexForDevice(item.device.deviceId);
          remoteScheduleEventStore.clearDevice(item.device.deviceId);
          remoteScheduleEventStore.clearDeviceMirrorInvalidation(item.device.deviceId);
          remoteSessionStore.removeDevice(item.device.deviceId);
        }
      }
      // 整表对账:REST 全量清单对“设备是否仍绑定”是权威。冷启动从缓存种入、
      // 随后被解绑(完全不在清单里)的设备不会出现在状态分类里,按差集硬清 shard;
      // 这与短暂 offline 不同,否则幽灵项会被快照回写无限续存。
      const knownDeviceIds = new Set(deviceRows.map((item) => item.device.deviceId));
      const ghostDeviceIds = new Set<string>();
      for (const session of remoteSessionStore.getSessions()) {
        const shardId = session.deviceLinkDeviceId;
        if (shardId && !knownDeviceIds.has(shardId)) ghostDeviceIds.add(shardId);
      }
      for (const deviceId of ghostDeviceIds) {
        invalidateScheduleIndexForDevice(deviceId);
        remoteScheduleEventStore.clearDevice(deviceId);
        remoteScheduleEventStore.clearDeviceMirrorInvalidation(deviceId);
        remoteSessionStore.removeDevice(deviceId);
      }

      const failures: string[] = [];
      const offlineDeviceIds = new Set<string>();
      const hydrateResults = await runHomeDeviceSyncBatch(syncRows, async (item) => {
        const result = await hydrateDeviceSessions(item.device, accountGenerationAtStart);
        return { deviceId: item.device.deviceId, result };
      });
      for (const { deviceId, result } of hydrateResults) {
        if (result.superseded || homeAccountGenerationRef.current !== accountGenerationAtStart) continue;
        if (result.failure) failures.push(result.failure);
        if (result.offline) {
          offlineDeviceIds.add(deviceId);
        } else if (!result.failure) {
          // REST + hydrate success is authoritative reachability evidence even when relay
          // presence was not replayed on this connection. Retire any prior offline marker
          // so unrelated device invalidations cannot re-clear this device's running badges.
          remoteScheduleEventStore.clearDeviceMirrorInvalidation(deviceId);
          invalidateOfflineScheduleIndexFailureFor(deviceId);
        }
      }
      if (homeAccountGenerationRef.current !== accountGenerationAtStart) return;

      // 收尾再合并一次:hydrate 阶段(可能持续数秒)里新到的 presence 补丁同样不能被覆盖掉。
      const nextDevices = reconcileDeviceViews(
        mergeFreshPresence(markDeviceViewsOffline(serverDevices, offlineDeviceIds)),
      ).devices;
      devicesRef.current = nextDevices;
      setDevices(nextDevices);
      lastSyncedAtRef.current = now;
      setLastSyncedAt(now);
      if (selectedDeviceIdRef.current === selectedDeviceIdAtSyncStart) {
        setError(failures.length > 0 ? failures.slice(0, 2).join('；') : null);
      }
      // loadHome 整轮成功后也回写一次:覆盖「设备全部下线 / 会话清空」的收敛场景——
      // 此时没有任何 hydrate 成功,只有这里能把缓存里的陈旧设备清掉。
      scheduleHomeListSnapshotPersist(homeCacheUserId, () => remoteSessionStore.getSessions());
    })();

    const task = rawTask
      .catch((err) => {
        if (homeAccountGenerationRef.current !== accountGenerationAtStart) return;
        setError(formatRemoteError(err));
      })
      .finally(() => {
        if (syncInFlightRef.current !== task) return;
        syncInFlightRef.current = null;
        const queued = syncQueuedRef.current;
        if (queued) {
          syncQueuedRef.current = null;
          void loadHomeRef.current(queued);
        }
      });

    syncInFlightRef.current = task;
    return task.finally(() => {
      if (visible && homeAccountGenerationRef.current === accountGenerationAtStart) setRefreshing(false);
    });
  }, [accountGeneration, apiFetch, deviceIdentityCacheReady, homeCacheUserId, hydrateDeviceSessions, reconcileDeviceViews, reconcileHomeDeviceSyncScope, revokedDevices, softInvalidateDeviceMirror]);
  loadHomeRef.current = loadHome;

  // 冷启动先画缓存:上次 loadHome 成功的设备+会话快照种入 store,先把列表画出来(消除首屏强制
  // spinner);loadHome 返回后由 setDeviceSessions / removeDevice 正常覆盖收敛。缓存为空时列表
  // 保持空、现有 spinner 行为不变。缓存画出的设备只标记「同步中」既有中间态(设备菜单脉冲点),
  // 不进入 devices state——它们不是 live 设备,新建对话的可用性判定仍以 live 数据为准。
  useEffect(() => {
    const expectedAccountGeneration = accountGeneration;
    // 缓存按账号键控:userId 未就绪(理论上首页必已登录,防御性兜底)时不读,直接放行首帧。
    if (!homeCacheUserId) {
      setHomeListCacheHydrated(true);
      return;
    }
    let cancelled = false;
    const read = startBoundedStartupRead(
      getCachedHomeListSnapshot(homeCacheUserId),
      [],
    );
    const applySnapshot = async (snapshot: Awaited<ReturnType<typeof getCachedHomeListSnapshot>>) => {
      await syncInFlightRef.current;
      if (
        cancelled
        || homeAccountGenerationRef.current !== expectedAccountGeneration
        || lastSyncedAtRef.current !== null
      ) return;
      for (const device of snapshot) {
        remoteSessionStore.hydrateDeviceSessionsIfEmpty(device.deviceId, device.deviceName, device.sessions);
        updateDeviceConnectionState(device.deviceId, 'syncing');
      }
    };
    void read.initial
      .then((initial) => {
        void applySnapshot(initial.value);
        if (initial.timedOut) void read.completion.then((late) => {
          if (late.ok) void applySnapshot(late.value);
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && homeAccountGenerationRef.current === expectedAccountGeneration) {
          setHomeListCacheHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountGeneration, homeCacheUserId, updateDeviceConnectionState]);

  useEffect(() => {
    let cancelled = false;
    const read = startBoundedStartupRead(
      loadDeviceIdentityCache(),
      createEmptyDeviceIdentityCache(),
    );
    void read.initial
      .then(async (initial) => {
        if (cancelled) return;
        deviceIdentityCacheRef.current = initial.value;
        deviceIdentityCachePersistReadyRef.current = !initial.timedOut;
        setDeviceIdentityCacheReady(true);
        if (!initial.timedOut) return;

        const late = await read.completion;
        if (cancelled) return;
        if (late.ok) {
          deviceIdentityCacheRef.current = late.value;
          deviceIdentityCachePersistReadyRef.current = true;
          const reconciled = reconcileDeviceViews(devicesRef.current);
          devicesRef.current = reconciled.devices;
          if (reconciled.viewsChanged) setDevices(reconciled.devices);
          return;
        }

        deviceIdentityCachePersistReadyRef.current = true;
        if (deviceIdentityCachePersistPendingRef.current) void saveDeviceIdentityCache(deviceIdentityCacheRef.current);
      });
    return () => {
      cancelled = true;
    };
  }, [reconcileDeviceViews]);

  // 冷启动恢复上次的首页视图偏好(设备范围 + 显示菜单);用户已手动操作过则不覆盖。
  useEffect(() => {
    const expectedAccountGeneration = homeAccountGenerationRef.current;
    let cancelled = false;
    const read = startBoundedStartupRead<HomeViewPreferences | null>(
      readHomeViewPreferences(),
      null,
    );
    const applyPreferences = (preferences: HomeViewPreferences | null) => {
      if (!preferences) return;
      if (
        cancelled
        || homeAccountGenerationRef.current !== expectedAccountGeneration
        || viewPrefsTouchedRef.current
      ) return;
      setGroupByProject(preferences.groupByProject);
      setGroupDialogue(preferences.groupDialogue);
      setSortBy(preferences.sortBy);
      setStatusFilter(preferences.statusFilter);
      setProjectOrder(preferences.projectOrder);
      setManualProjectOrder(preferences.manualProjectOrder);
      if (preferences.selectedDevice) {
        setSelectedDeviceId(preferences.selectedDevice.deviceId);
        setRestoredDeviceName(preferences.selectedDevice.name);
        restoredSelectionUnvalidatedRef.current = true;
      }
    };
    void read.initial
      .then((initial) => {
        applyPreferences(initial.value);
        if (initial.timedOut) {
          // Native storage can occasionally settle after the startup budget. Let Home start
          // with its safe defaults, then narrow the live scope if the untouched preference
          // eventually arrives; a permanently stuck read can no longer block networking.
          void read.completion.then((late) => {
            if (late.ok) applyPreferences(late.value);
          });
        }
      })
      .finally(() => {
        // The preference values are generation-fenced above, but this startup gate belongs to
        // the mounted Home screen rather than to one account. If the user switches accounts while
        // the bounded read is settling, the old values must stay ignored while the new account is
        // still allowed to start networking with safe defaults.
        if (!cancelled) setHomeViewPreferencesHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载时取消所有延后中的 schedule-index hydration 定时器,避免回调在卸载后 setScheduleIndex。
  useEffect(() => {
    const registry = scheduleIndexDeferRegistryRef.current;
    return () => {
      registry.cancelAll();
    };
  }, []);

  useEffect(() => {
    if (scheduleMirrorInvalidations.size === 0) return;
    const invalidatedDeviceIds = new Set(scheduleMirrorInvalidations.keys());
    const sessionIds = remoteSessionStore.getSessions()
      .filter((session) => !!session.deviceLinkDeviceId && invalidatedDeviceIds.has(session.deviceLinkDeviceId))
      .map((session) => session.id);
    setScheduleIndex((current) => invalidateRunningSessionScheduleEntries(current, sessionIds));
  }, [scheduleMirrorInvalidations]);

  useEffect(() => remoteScheduleEventStore.subscribe(() => {
    const deviceIds = new Set<string>();
    for (const device of devicesRef.current) deviceIds.add(device.deviceId);
    for (const session of remoteSessionStore.getSessions()) {
      if (session.deviceLinkDeviceId) deviceIds.add(session.deviceLinkDeviceId);
    }

    for (const deviceId of deviceIds) {
      if (!homeSyncTargetDeviceIdsRef.current.has(deviceId)) continue;
      const snapshot = remoteScheduleEventStore.getSnapshot(deviceId);
      const version = snapshot.version;
      if (version === 0) {
        scheduleEventVersionsRef.current.delete(deviceId);
        continue;
      }
      if (version === (scheduleEventVersionsRef.current.get(deviceId) ?? 0)) continue;
      scheduleEventVersionsRef.current.set(deviceId, version);
      const projection = snapshot.lastProjection;
      if (projection?.refresh.sessionIndex !== true && projection?.runPatch.status !== 'running') continue;
      const sessionIds = remoteSessionStore.getSessions()
        .filter((session) => session.deviceLinkDeviceId === deviceId)
        .map((session) => session.id);
      // scheduler 触发的新一次运行不会广播 local-db:sessions:created(桌面 runner 只发
      // schedule 事件),新 run 的会话不会自己进列表。事件带的 sessionId 不在本地列表时,
      // 先触发该设备重拉会话列表 —— hydrate 完成后其内部的 defer 会用新列表刷新 schedule
      // 索引(此处用旧列表刷,新会话的 running/未读条目会被 replaceSessionScheduleIndexEntries
      // 按 sessionIds 白名单丢弃,手机将一直看不到"任务正在运行")。
      const boundSessionId = projection.runPatch.sessionId;
      if (boundSessionId && !sessionIds.includes(boundSessionId)) {
        remoteSessionStore.requestReseed(deviceId);
        continue;
      }
      // schedule 列表变化(changed,含 pause / resume / 改绑)与 read / all-read 都是低频
      // 权威信号,force 穿透节流保证状态即时更新;fired / running 等高频事件照常吃 TTL
      // (全量 force 会把 listRuns 风暴请回来)。
      refreshDeviceScheduleIndex(deviceId, sessionIds, {
        force: projection.refresh.scheduleList === true
          || projection.unreadImpact === 'may-clear-schedule'
          || projection.unreadImpact === 'clear-all',
      });
    }
  }), [refreshDeviceScheduleIndex]);

  // 从自动化 / 会话页返回首页时,兜底刷新一次 scheduleIndex:
  // markScheduleRunsRead 的桌面广播若在导航切换途中丢失(silent swallow / 弱网 / tap listener
  // 未挂),之前依赖 remoteScheduleEventStore.subscribe 的路径就永远不会补跑,首页那颗
  // "已完成未读"绿点会一直挂着。useFocusEffect 每次 focus 都按当前设备清一遍未读徽标,
  // 命中真实变化才会 setScheduleIndex(entries 等值比较),不触发无谓 re-render。
  useFocusEffect(
    useCallback(() => {
      for (const device of devicesRef.current) {
        if (!homeSyncTargetDeviceIdsRef.current.has(device.deviceId)) continue;
        const sessionIds = remoteSessionStore.getSessions()
          .filter((session) => session.deviceLinkDeviceId === device.deviceId)
          .map((session) => session.id);
        if (sessionIds.length === 0) continue;
        refreshDeviceScheduleIndex(device.deviceId, sessionIds);
      }
    }, [refreshDeviceScheduleIndex]),
  );

  // 初次加载 + 每次重连(connectionEpoch 变化)都全量刷新。presence 只在状态"变化"时广播、
  // 服务端没有面向新连接的全量重放,后台期间(client.stop)漏掉的上/下线事件只能靠重连时
  // 重拉 REST 快照兜底,否则设备可用性会一直停留在断线前的旧状态。loadHome 内部有
  // syncInFlight 去重,冷启动时与上线瞬间的两次触发只会实际执行一次。
  // 首次触发同时等首页列表缓存种入完成(homeListCacheHydrated,AsyncStorage 读一个小 key,毫秒级):
  // 保证缓存先画、fresh 后覆盖的顺序确定,避免 loadHome 清理下线设备后缓存又把 stale shard 种回去。
  const startSilentHomeSync = useCallback(() => {
    if (!deviceIdentityCacheReady || !homeListCacheHydrated || !homeViewPreferencesHydrated) return;
    void loadHome({ visible: false });
  }, [deviceIdentityCacheReady, homeListCacheHydrated, homeViewPreferencesHydrated, loadHome]);

  // Android can recreate the activity or resume the JS runtime without a fresh React
  // mount. Foreground is therefore an authoritative trigger alongside the initial mount
  // and reconnect; loadHome single-flights these overlapping cold-start calls.
  useFocusEffect(
    useCallback(() => {
      startSilentHomeSync();
    }, [startSilentHomeSync]),
  );

  useEffect(() => {
    startSilentHomeSync();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') startSilentHomeSync();
    });
    return () => subscription.remove();
  }, [connectionEpoch, startSilentHomeSync]);

  // 把当前权威设备列表注入 remoteSessionStore,让 store 给所有 useRemoteSessions 消费者(首页项目卡、
  // 设备详情页)统一算展示用 canonicalDeviceId:re-link 后残留的 stale shard 会话按设备名唯一匹配认领回
  // 当前设备,首页归并进哪张卡、详情页就能看到同样这批会话(消除「卡片 N 条、点进去 N-1 条」)。
  useEffect(() => {
    remoteSessionStore.setDeviceIdentity(devices.map((device) => ({ deviceId: device.deviceId, name: device.name })));
  }, [devices]);

  useEffect(() => {
    if (!deviceIdentityCacheReady || !lastPresenceSnapshot) return;
    if (lastPresenceSnapshotProcessedRef.current !== lastPresenceSnapshot) {
      lastPresenceSnapshotProcessedRef.current = lastPresenceSnapshot;
      markPresenceFresh(presenceFreshnessRef.current, lastPresenceSnapshot.deviceId);
    }
    const result = patchDeviceViewsWithPresence(
      devicesRef.current,
      lastPresenceSnapshot,
      selfDeviceId,
    );
    const reconciled = reconcileDeviceViews(result.devices);
    devicesRef.current = reconciled.devices;
    if (result.changed || reconciled.viewsChanged) setDevices(reconciled.devices);
    const hydratedDevice = result.device
      ? reconciled.devices.find((device) => device.deviceId === result.device?.deviceId) ?? result.device
      : null;
    if (!hydratedDevice || !result.becameControllable || !isCurrentHomeSyncTarget(hydratedDevice.deviceId)) return;
    void hydrateDeviceSessions(hydratedDevice).then((hydrateResult) => {
      if (hydrateResult.superseded) return;
      if (hydrateResult.failure) setError(hydrateResult.failure);
      else setError(null);
    });
  }, [deviceIdentityCacheReady, hydrateDeviceSessions, isCurrentHomeSyncTarget, lastPresenceSnapshot, reconcileDeviceViews, selfDeviceId]);

  // Auto-heal revoked access: a host only signals a re-grant by accepting a fresh request, so on
  // every (re)connect silently re-probe each revoked device. The one-row invoke clears the
  // in-memory revoked mark on success (withAccessRevokedHandling) without retaining a hidden
  // list subscription. Scope reconciliation then hydrates it only when it is actually visible.
  useEffect(() => {
    if (status !== 'online') return;
    const revoked = revokedDevicesStore.getSnapshot();
    if (revoked.size === 0) return;
    void runHomeDeviceSyncBatch([...revoked], (deviceId) => (
      homeDeviceSyncLimiterRef.current.run(() => probeRevokedDeviceAccess(deviceId))
    ));
  }, [connectionEpoch, probeRevokedDeviceAccess, status]);

  // Close the revoked tip automatically once access is restored (auto-heal or manual retry).
  useEffect(() => {
    if (revokedTipDeviceId && !revokedDevices.has(revokedTipDeviceId)) setRevokedTipDeviceId(null);
  }, [revokedDevices, revokedTipDeviceId]);

  const retryRevokedDevice = useCallback(async (deviceId: string) => {
    const expectedAccountGeneration = accountGeneration;
    const device = devicesRef.current.find((item) => item.deviceId === deviceId);
    if (!device) return;
    // 同设备重试仍在飞行中时直接忽略,防止连点/引导页重复触发叠加请求。
    if (retryingDeviceIdsRef.current.has(deviceId)) return;
    retryingDeviceIdsRef.current.add(deviceId);
    setRetryingDeviceIds(new Set(retryingDeviceIdsRef.current));
    try {
      await homeDeviceSyncLimiterRef.current.run(
        () => probeRevokedDeviceAccess(device.deviceId, expectedAccountGeneration),
        'foreground',
      );
    } finally {
      if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
      // Retry state is scoped per device; only clear this request to avoid clearing another in-flight retry.
      retryingDeviceIdsRef.current.delete(deviceId);
      setRetryingDeviceIds(new Set(retryingDeviceIdsRef.current));
    }
    // probe invoke clears the revoked mark on success; the tip-close effect handles dismissal.
  }, [accountGeneration, probeRevokedDeviceAccess]);

  const openRenameDevice = useCallback((item: MobileHomeDeviceFilterItem) => {
    if (!item.deviceId) return;
    const begin = () => {
      setRenameTarget(item);
      setRenameDraft(item.label);
      setError(null);
    };
    // 自定义范围菜单还没卸掉时不能直接挂重命名 Modal。
    // 原生 UIMenu 没有这层 Modal,可以立刻打开。
    if (deviceMenuOpen) {
      pendingMenuActionRef.current = begin;
      setDeviceMenuOpen(false);
      return;
    }
    begin();
  }, [deviceMenuOpen]);

  // 菜单 Modal 完全关闭(淡出结束 + 卸载)后,执行延后的弹窗动作。
  const handleDeviceMenuClosed = useCallback(() => {
    const action = pendingMenuActionRef.current;
    if (!action) return;
    pendingMenuActionRef.current = null;
    action();
  }, []);

  const handleChromeMenuClosed = useCallback(() => {
    const action = pendingMenuActionRef.current;
    if (!action) return;
    pendingMenuActionRef.current = null;
    action();
  }, []);

  // 菜单展开时清掉上一轮残留的延后动作(例如淡出中途被重新展开,onClosed 未触发的情况)。
  const openDeviceMenu = useCallback(() => {
    pendingMenuActionRef.current = null;
    setDisplaySettingsOpen(false);
    setChromeMenuOpen(false);
    setDeviceMenuOpen(true);
  }, []);

  const openChromeMenu = useCallback(() => {
    pendingMenuActionRef.current = null;
    setDeviceMenuOpen(false);
    setDisplaySettingsOpen(false);
    setChromeMenuCloseInstant(false);
    setChromeMenuOpen(true);
  }, []);

  const openDisplaySettings = useCallback(() => {
    pendingMenuActionRef.current = null;
    setDeviceMenuOpen(false);
    setChromeMenuOpen(false);
    setDisplaySettingsOpen(true);
  }, []);

  const onListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > 8;
    setHeaderFrosted((current) => (current === next ? current : next));
  }, []);

  const closeRenameDevice = useCallback(() => {
    if (renameSaving) return;
    setRenameTarget(null);
    setRenameDraft('');
  }, [renameSaving]);

  const confirmRenameDevice = useCallback(async () => {
    const expectedAccountGeneration = accountGeneration;
    const target = renameTarget;
    const name = renameDraft.trim();
    if (!target?.deviceId || !name || renameSaving) return;
    if (name === target.label.trim()) {
      setRenameTarget(null);
      setRenameDraft('');
      return;
    }

    setRenameSaving(true);
    try {
      const res = await apiFetch<{ deviceId: string; name: string }>(
        `/api/device-link/devices/${encodeURIComponent(target.deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          body: { name },
          method: 'PATCH',
          timeoutMs: DEVICE_LIST_TIMEOUT_MS,
        },
      );
      if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
      const nextName = res.name;
      setDevices((current) => {
        const nextRaw = current.map((device) =>
          device.deviceId === target.deviceId ? { ...device, name: nextName } : device);
        const next = reconcileDeviceViews(nextRaw).devices;
        devicesRef.current = next;
        return next;
      });
      remoteSessionStore.renameDevice(target.deviceId, nextName);
      setRenameTarget(null);
      setRenameDraft('');
      void loadHome({ visible: false });
    } catch (err) {
      if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
      setError(formatRemoteError(err));
    } finally {
      if (homeAccountGenerationRef.current === expectedAccountGeneration) setRenameSaving(false);
    }
  }, [accountGeneration, apiFetch, loadHome, reconcileDeviceViews, renameDraft, renameSaving, renameTarget]);

  const deviceRows = useMemo(
    () => toDeviceListItems(devices, Date.now(), revokedDevices),
    [devices, i18nInstance.resolvedLanguage, revokedDevices],
  );
  const homeSyncDeviceIds = useMemo(() => resolveHomeDeviceSyncIds(
    deviceRows.map((item) => ({
      canOpen: item.canOpen,
      deviceId: item.device.deviceId,
    })),
    selectedDeviceId,
  ), [deviceRows, selectedDeviceId]);
  const homeSyncDeviceIdSet = useMemo(() => new Set(homeSyncDeviceIds), [homeSyncDeviceIds]);
  const homeSyncRows = useMemo(
    () => deviceRows.filter((item) => homeSyncDeviceIdSet.has(item.device.deviceId)),
    [deviceRows, homeSyncDeviceIdSet],
  );

  useEffect(() => {
    const expectedAccountGeneration = accountGeneration;
    const selectedDeviceIdAtStart = selectedDeviceId;
    const diff = reconcileHomeDeviceSyncScope(homeSyncDeviceIds);
    if (diff.acquire.length === 0) return;
    const acquireIds = new Set(diff.acquire);
    const rows = homeSyncRows.filter((item) => acquireIds.has(item.device.deviceId));
    void runHomeDeviceSyncBatch(rows, async (item) => (
      hydrateDeviceSessions(item.device, expectedAccountGeneration)
    )).then((results) => {
      if (
        homeAccountGenerationRef.current !== expectedAccountGeneration
        || selectedDeviceIdRef.current !== selectedDeviceIdAtStart
      ) return;
      const failures = results
        .filter((result) => !result.superseded && result.failure)
        .map((result) => result.failure as string);
      if (failures.length > 0) setError(failures.slice(0, 2).join('；'));
      else if (results.some((result) => !result.superseded)) setError(null);
    });
  }, [accountGeneration, homeSyncDeviceIds, homeSyncRows, hydrateDeviceSessions, reconcileHomeDeviceSyncScope, selectedDeviceId]);

  useEffect(() => {
    const unregisters = homeSyncRows.map((item) =>
      remoteSessionStore.registerReseedHandler(item.device.deviceId, () => {
        void hydrateDeviceSessions(item.device, accountGeneration, {
          trailingIfInFlight: true,
        }).then((hydrateResult) => {
          if (hydrateResult.superseded) return;
          if (hydrateResult.failure) setError(hydrateResult.failure);
          else setError(null);
        });
      }),
    );
    return () => {
      for (const unregister of unregisters) unregister();
    };
  }, [accountGeneration, homeSyncRows, hydrateDeviceSessions]);

  const deviceModels = useMemo(() => deviceRows.map((item) => ({
    canOpen: item.canOpen,
    deviceId: item.device.deviceId,
    name: item.device.name,
    state: item.state,
    statusDetail: item.statusDetail,
    statusLabel: item.statusLabel,
  })), [deviceRows]);
  useEffect(() => {
    remoteSessionStore.setConversationSearchDeviceModels(deviceModels.map((item) => ({
      canOpen: item.canOpen,
      deviceId: item.deviceId,
      name: item.name,
      state: item.state,
    })));
  }, [deviceModels]);
  const searchOrigins = useMemo(() => conversationSearchOriginsFromDeviceModels(
    deviceModels,
    {
      selectedDeviceId,
      unresponsiveDeviceIds: unresponsiveDevices,
    },
  ), [deviceModels, selectedDeviceId, unresponsiveDevices]);
  const searchProjects = useMemo(
    () => listConversationSearchProjects(
      excludeOrcaWorkerSessions(sessions),
      new Set(searchOrigins.map((origin) => origin.deviceId)),
    ),
    [searchOrigins, sessions],
  );
  const indexedSearch = useConversationSearch({
    enabled: true,
    origins: searchOrigins,
    projects: searchProjects,
  });
  const searchQuery = indexedSearch.query;
  const searchFilterA11y = t('devices.list.search.filterAria', {
    agent: t(`devices.list.search.filter.agent.${indexedSearch.agentFilter}`),
    lastActivity: t(`devices.list.search.filter.lastActivity.${indexedSearch.lastActivityFilter}`),
    projects: indexedSearch.projectSelection === 'all'
      ? t('devices.list.search.filter.allProjects')
      : t('devices.list.search.filter.selectedProjects', { count: indexedSearch.projectSelection.length }),
    sort: t(`devices.list.search.filter.sort.${indexedSearch.sortBy}`),
    status: t(`devices.list.search.filter.status.${indexedSearch.statusFilter}`),
  });
  const searchFilterMenu = useConversationSearchFilterMenu({
    activeCount: indexedSearch.activeFilterCount,
    agentKind: indexedSearch.agentFilter,
    lastActivity: indexedSearch.lastActivityFilter,
    lockedProjects: false,
    onAgentKindChange: indexedSearch.setAgentFilter,
    onLastActivityChange: indexedSearch.setLastActivityFilter,
    onProjectsChange: indexedSearch.setProjectSelection,
    onReset: indexedSearch.resetFilters,
    onSortChange: indexedSearch.setSortBy,
    onStatusChange: indexedSearch.setStatusFilter,
    projectSelection: indexedSearch.projectSelection,
    projects: searchProjects,
    sortBy: indexedSearch.sortBy,
    status: indexedSearch.statusFilter,
  });
  useEffect(() => {
    const expectedAccountGeneration = accountGeneration;
    const ids = homeSyncDeviceIds;
    if (ids.length === 0) return undefined;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const fence = createProjectOrderFetchFence();
    projectOrderFetchFenceRef.current = fence;
    const load = async (attempt: number) => {
      // Project ordering is secondary Home metadata. Let the bounded sessions-list batch
      // finish first so cold start/reconnect does not create a second overlapping six-device
      // fan-out. A queued refresh is included as well; live pushes remain fenced below.
      while (syncInFlightRef.current) {
        await syncInFlightRef.current;
        if (cancelled || homeAccountGenerationRef.current !== expectedAccountGeneration) return;
      }
      const tokens = new Map(ids.map((deviceId) => [deviceId, fence.begin(deviceId)]));
      const entries = await runHomeDeviceSyncBatch(ids, async (deviceId) => {
        const result = await homeDeviceSyncLimiterRef.current.run(async () => {
          if (
            cancelled
            || homeAccountGenerationRef.current !== expectedAccountGeneration
            || !homeSyncTargetDeviceIdsRef.current.has(deviceId)
          ) return { kind: 'transient' } as const;
          return fetchHostProjectOrder(invoke, deviceId);
        });
        return [deviceId, result] as const;
      });
      if (cancelled || homeAccountGenerationRef.current !== expectedAccountGeneration) return;
      for (const [deviceId, result] of entries) {
        if (!fence.shouldApplyFetch(deviceId, tokens.get(deviceId) ?? 0)) continue;
        if (result.kind === 'ok') rememberRemoteProjectOrderStamp(deviceId, result.snapshot.ownerStamp);
      }
      setHostProjectOrders((current) => {
        const next = new Map(current);
        for (const [deviceId, result] of entries) {
          if (!fence.shouldApplyFetch(deviceId, tokens.get(deviceId) ?? 0)) continue;
          if (result.kind === 'ok') next.set(deviceId, result.snapshot);
          else if (result.kind === 'unavailable') next.set(deviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
        }
        return next;
      });
      if (attempt < 3 && entries.some(([, result]) => result.kind === 'transient')) {
        retryTimer = setTimeout(() => {
          void load(attempt + 1);
        }, 2000);
      }
    };
    void load(1);
    const unsubscribe = subscribeRemoteProjectOrderChanged((deviceId, snapshot) => {
      if (
        cancelled
        || homeAccountGenerationRef.current !== expectedAccountGeneration
        || !ids.includes(deviceId)
      ) return;
      fence.noteLiveUpdate(deviceId);
      setHostProjectOrders((current) => {
        const next = new Map(current);
        next.set(deviceId, snapshot);
        return next;
      });
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [accountGeneration, homeSyncDeviceIds, invoke]);
  const revokedTipDeviceName = useMemo(
    () => revokedTipDeviceId
      ? deviceModels.find((item) => item.deviceId === revokedTipDeviceId)?.name ?? t('devices.list.thisComputer')
      : null,
    [deviceModels, revokedTipDeviceId, t],
  );
  // 三个派生索引的依赖挂在全局 messageVersion / storeVersion 上,桌面端活跃期逐 emit
  // 重建出内容相同的新 Map——若不做内容稳定化,home → sections → 全列表行整链每次
  // emit 都重建(2026-07-18 重渲染风暴 trace 实锤)。useStableValue 在内容未变时保留
  // 旧引用,下游 useMemo 依赖即可短路;内容真变(某会话预览/交互数/活动态变化)照常穿透。
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
  const liveActivityIndexRaw = useMemo(() => {
    const entries: Array<[string, RemoteSessionLiveActivity]> = [];
    for (const session of sessions) {
      const liveActivity = remoteSessionStore.getSessionLiveActivity(session.id);
      if (liveActivity) entries.push([session.id, liveActivity]);
    }
    return new Map(entries);
  }, [sessions, storeVersion]);
  const liveActivityIndex = useStableValue(liveActivityIndexRaw, mapContentEqual);
  // 列表隐藏 Orca worker 子会话(本期不支持进 worker 聊天);Lead + 普通会话保留。仅 mobile 侧过滤。
  const homeSessions = useMemo(() => excludeOrcaWorkerSessions(sessions), [sessions]);
  const home = useMemo(
    () => buildMobileHomePresentation({
      devices: deviceModels,
      liveActivityIndex,
      messagePreviewIndex,
      pendingInteractionIndex,
      scheduleIndex,
      searchQuery,
      selectedDeviceId,
      sessions: homeSessions,
      statusFilter,
      // 未起名会话的显示文案:共享层不兜中文串,由这里给已解析的 i18n 值。
      unnamedLabel: t('session.menu.unnamedTitle'),
    }),
    [deviceModels, liveActivityIndex, messagePreviewIndex, pendingInteractionIndex, scheduleIndex, searchQuery, selectedDeviceId, homeSessions, statusFilter, t],
  );
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of homeSessions) {
      if (remoteSessionStore.isSessionRunning(session.id)) ids.add(session.id);
      if (liveActivityIndex.get(session.id)?.phase === 'running') ids.add(session.id);
      if (scheduleIndex.get(session.id)?.running) ids.add(session.id);
    }
    return ids;
  }, [homeSessions, liveActivityIndex, scheduleIndex, storeVersion]);
  const homePriorityItems = useMemo(
    () => [...home.pinned, ...home.chats, ...home.projects.flatMap((project) => project.sessions)],
    [home],
  );
  const priorityContext = useMemo(
    () => collectHomePriorityContext(homePriorityItems, runningSessionIds, homeViewedPriorityHold),
    [homePriorityItems, priorityHoldEpoch, runningSessionIds],
  );
  useEffect(() => {
    if (!leftHomeForSessionRef.current) return;
    // 首页留在导航栈中时仍会收到详情页任务的运行 / 等待状态更新。同步推进 hold,
    // 避免新一轮跑完后旧 unread / waiting 档位重新生效,直到返回首页才跳位。
    if (!advanceCurrentViewedPriorityHold(homeViewedPriorityHold, priorityContext, Date.now())) {
      return;
    }
    setPriorityHoldEpoch((epoch) => epoch + 1);
  }, [priorityContext]);
  const selectedHostOrder = selectedDeviceId ? hostProjectOrders.get(selectedDeviceId) : undefined;
  const hostManualProjectOrder = selectedDeviceId && selectedHostOrder
    ? controllerKeysFromHost(selectedDeviceId, selectedHostOrder)
    : [];
  const displayed = resolveDisplayedProjectOrder(
    resolveProjectOrderWriteScope(selectedDeviceId ? [selectedDeviceId] : 'all', 'local'),
    selectedHostOrder,
    { manualProjectOrder, projectOrder },
    hostManualProjectOrder,
  );
  const displayedProjectOrder = displayed.projectOrder;
  const displayedManualProjectOrder = displayed.manualProjectOrder;
  const homeSections = useMemo(
    () => buildHomeSections(home, groupByProject, pinnedCollapsed, {
      dialogueTitle: t('devices.list.menu.dialogueFolder'),
      groupDialogue,
      manualProjectOrder: displayedManualProjectOrder,
      priorityContext,
      projectOrder: displayedProjectOrder,
      sortBy,
    }),
    [displayedManualProjectOrder, displayedProjectOrder, groupByProject, groupDialogue, home, pinnedCollapsed, priorityContext, sortBy, t],
  );
  const sections = useMemo(() => {
    if (!shouldReplaceListWithSearchResults(searchQuery, indexedSearch.status)) return homeSections;
    return [{
      data: indexedSearch.results.map((item) => ({
        item,
        key: `search:${(item.session as { deviceLinkDeviceId?: string | null }).deviceLinkDeviceId ?? 'local'}:${item.session.id}`,
        kind: 'session' as const,
        source: 'search' as const,
        sourceLabel: selectedDeviceId
          ? undefined
          : ((item.session as { deviceLinkDeviceName?: string | null }).deviceLinkDeviceName ?? undefined),
      })),
      key: 'search',
      title: null,
    }];
  }, [homeSections, indexedSearch.results, indexedSearch.status, searchQuery, selectedDeviceId]);
  if (displayedProjectOrder !== 'custom') {
    visualProjectKeysRef.current = sections.flatMap((section) => section.data)
      .filter((row): row is Extract<HomeRow, { kind: 'project' }> => row.kind === 'project')
      .map((row) => row.project.key);
  }
  const visibleProjectKeys = useMemo(
    () => sections.flatMap((section) => section.data)
      .filter((row): row is Extract<HomeRow, { kind: 'project' }> => row.kind === 'project')
      .map((row) => row.project.key),
    [sections],
  );

  useFocusEffect(
    useCallback(() => {
      if (!leftHomeForSessionRef.current) return;
      leftHomeForSessionRef.current = false;
      advanceViewedPriorityHold(homeViewedPriorityHold, undefined, priorityContext, Date.now());
      setPriorityHoldEpoch((epoch) => epoch + 1);
    }, [priorityContext]),
  );
  const windowLayout = buildMainWindowLayout({
    actionCount: 1,
    kind: 'list',
    metricCount: 3,
    screenWidth,
  });
  const connectionError = describeRemoteError(error);
  const initialHomeSettled = deviceIdentityCacheReady && lastSyncedAt !== null;
  const initialHomeLoading = !initialHomeSettled && !connectionError;
  const initialHomeError = !initialHomeSettled && !!connectionError;
  // 首次同步完成后校验恢复/当前选中的设备,不成立时回退「所有对话」并同步持久化:
  // - 设备已不存在(解绑):home.selectedDeviceId 是归一化后的口径,查不到会变 null,
  //   若不回退,表头显示旧设备名而列表实际展示全部会话,两者口径不一致。
  // - 恢复自偏好的设备仍在列表但已不可用(canOpen=false,含 access_revoked / 远程控制关闭):
  //   loadHome 已移除其会话、pickPrimaryDevice 也返回 null,继续停留会卡在空列表 +
  //   新建按钮置灰。只对恢复的选择做一次性校验,不改变用户会话内手动选择后设备
  //   转为离线的既有行为(手动选择时设备必然可用)。
  useEffect(() => {
    if (!initialHomeSettled || !selectedDeviceId) return;
    const missing = home.selectedDeviceId === null;
    let restoredUnavailable = false;
    if (!missing && restoredSelectionUnvalidatedRef.current) {
      const filter = home.deviceFilters.find((item) => item.deviceId === selectedDeviceId);
      restoredUnavailable = !!filter && !filter.available;
      restoredSelectionUnvalidatedRef.current = false;
    }
    if (!missing && !restoredUnavailable) return;
    setSelectedDeviceId(null);
    setRestoredDeviceName(null);
    void saveHomeViewPreferences({ selectedDevice: null });
  }, [home.deviceFilters, home.selectedDeviceId, initialHomeSettled, selectedDeviceId]);
  // 连接层失败原因比请求级 error 更根因:unstable 在 online 时也需保持可见。
  const activeConnectionIssue = status !== 'online' || connectionIssue?.kind === 'unstable' ? connectionIssue : null;
  const showConnectionRow = !!connectionError || status !== 'online' || connectionIssue?.kind === 'unstable';
  const connectionTone = activeConnectionIssue
    ? 'off'
    : connectionError ? 'muted' : status === 'online' ? 'ready' : status === 'connecting' ? 'busy' : 'off';
  const connectionTitle = activeConnectionIssue
    ? connectionIssueTitle(activeConnectionIssue.kind)
    : connectionError ? t('devices.list.syncFailed') : homeConnectionTitle(status, t);
  const connectionCopy = activeConnectionIssue
    ? connectionIssueHint(activeConnectionIssue.kind)
    : connectionError;
  const emptyStateTitle = initialHomeError ? t('devices.list.syncFailed') : home.emptyTitle;
  const emptyStateCopy = initialHomeError ? (connectionError ?? t('devices.list.requestFailed')) : home.emptyCopy;
  // 无可控制电脑的引导态(landing)可见性,与 ListEmptyComponent 的分支同口径。
  // 引导态下首页没有可筛选的对话:表头「所有对话 ▾」退化为纯品牌标题、新建 FAB 隐藏,
  // 避免在产品说明页上摆一堆无意义的入口。
  const homeListItemCount = sections.reduce((count, section) => count + section.data.length, 0);
  const showRemoteGuide = homeListItemCount === 0
    && !initialHomeLoading
    && !initialHomeError
    && home.pinned.length === 0
    && home.emptyKind === 'noDevice'
    && home.emptyNoDevice !== null;
  const retryRevokedGuideDevices = useCallback(() => {
    const revoked = home.emptyNoDevice?.reason === 'accessRevoked' ? home.emptyNoDevice.devices : [];
    for (const device of revoked) void retryRevokedDevice(device.deviceId);
  }, [home.emptyNoDevice, retryRevokedDevice]);
  const hasOpenableLiveDevice = deviceModels.some((item) => item.canOpen);
  // 首次 loadHome 落地前(含失败态)FAB 只认 live 设备:缓存画出的会话会让 primaryDevice 合成出
  // 「可用」项,但缓存设备不能当 live 设备直接开新会话——列表先画出来,新建入口等 live 数据。
  const newSessionDisabled = !home.primaryDevice || (!initialHomeSettled && !hasOpenableLiveDevice);
  const newSessionDeviceOptions = useMemo(
    () => deviceModels
      .filter((item) => item.canOpen)
      .map((item) => ({ deviceId: item.deviceId, name: item.name })),
    [deviceModels],
  );
  const selectedDeviceLabel = useMemo(() => {
    if (!selectedDeviceId) return t('devices.list.allConversations');
    // 设备列表尚未同步回来时,用偏好里存的设备名兜底,避免冷启动表头闪占位文案。
    return home.deviceFilters.find((item) => item.deviceId === selectedDeviceId)?.label
      ?? restoredDeviceName
      ?? t('devices.list.thisComputer');
  }, [home.deviceFilters, restoredDeviceName, selectedDeviceId, t]);

  const openSession = useCallback((item: RemoteSessionListItem) => {
    // 有行处于滑开状态时,点击(本行或他行)只负责收起,不进会话(iOS 列表滑动操作惯例)。
    if (swipeRegistry.closeOpenRow()) return;
    holdViewedPriorityRank(homeViewedPriorityHold, item.session.id, priorityContext);
    advanceViewedPriorityHold(homeViewedPriorityHold, item.session.id, priorityContext, Date.now());
    leftHomeForSessionRef.current = true;
    setPriorityHoldEpoch((epoch) => epoch + 1);
    const session = item.session as RemoteSession;
    // 打开会话走可达优先(与详情页 openSession 口径一致):被认领的 stale 会话优先用 canonicalDeviceId
    // (当前可达设备),否则 re-link 后旧 deviceId 不可达会导致「首页卡片点开打不开」。回退物理 id / store 索引。
    const deviceId = session.canonicalDeviceId ?? session.deviceLinkDeviceId ?? remoteSessionStore.getSessionDeviceId(session.id);
    if (!deviceId) {
      setError(t('devices.list.error.sessionDeviceNotFound'));
      return;
    }
    const focusClientId = 'searchFocusClientId' in item
      ? (item as { searchFocusClientId?: string }).searchFocusClientId
      : undefined;
    guardedPush({
      pathname: '/sessions/[sessionId]',
      params: {
        deviceId,
        deviceName: session.deviceLinkDeviceName ?? deviceId,
        sessionId: session.id,
        ...(focusClientId ? { focusClientId } : {}),
      },
    });
  }, [guardedPush, priorityContext, swipeRegistry, t]);

  const openNewSession = useCallback((project?: MobileHomeProjectGroup) => {
    const deviceId = project?.deviceId ?? home.primaryDevice?.deviceId;
    const deviceName = project?.deviceName ?? home.primaryDevice?.label ?? deviceId ?? '';
    if (!deviceId) {
      setError(t('devices.list.error.noDevice'));
      return;
    }
    guardedPush({
      pathname: '/sessions/new',
      params: {
        deviceId,
        deviceName,
        deviceOptions: serializeNewSessionDeviceOptions(newSessionDeviceOptions),
        ...(project?.workingDir ? { workingDir: project.workingDir } : {}),
        // 列表正筛选某台电脑时,新建默认跟随这台电脑(显式指定,盖过"上次选择"的
        // 记忆);"所有对话"下不带标记,新建页回落 newSessionPreferences 的记忆设备。
        ...(selectedDeviceId ? { deviceExplicit: '1' } : {}),
      },
    });
  }, [guardedPush, home.primaryDevice, newSessionDeviceOptions, selectedDeviceId, t]);

  const logout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await auth.logout();
    } catch (error) {
      Alert.alert(t('devices.list.alert.actionFailed'), formatRemoteError(error));
    } finally {
      setLoggingOut(false);
    }
  }, [auth, loggingOut, t]);

  const toggleProject = useCallback((key: string) => {
    configureCollapseAnimation();
    setCollapsedProjectKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }, []);

  const showAllDialogueSessions = useCallback(() => {
    setDialogueShowAll(true);
  }, []);

  const applyDisplayView = useCallback((patch: {
    groupByProject?: boolean;
    groupDialogue?: boolean;
    sortBy?: HomeListSortBy;
    statusFilter?: HomeStatusFilter;
    projectOrder?: HomeProjectOrder;
    manualProjectOrder?: string[];
  }) => {
    const expectedAccountGeneration = accountGeneration;
    viewPrefsTouchedRef.current = true;
    let nextPatch = patch;
    if (
      !selectedDeviceId
      && patch.projectOrder === 'custom'
      && projectOrder !== 'custom'
      && manualProjectOrder.length === 0
    ) {
      nextPatch = {
        ...patch,
        manualProjectOrder: snapshotManualProjectOrder(
          visualProjectKeysRef.current,
          home.projects.map((project) => project.key),
        ),
      };
    }
    if (nextPatch.groupByProject !== undefined) setGroupByProject(nextPatch.groupByProject);
    if (nextPatch.groupDialogue !== undefined) setGroupDialogue(nextPatch.groupDialogue);
    if (nextPatch.sortBy !== undefined) setSortBy(nextPatch.sortBy);
    if (nextPatch.statusFilter !== undefined) setStatusFilter(nextPatch.statusFilter);
    if (selectedDeviceId && nextPatch.projectOrder) {
      if (!isHostProjectOrderReachable(hostProjectOrders.get(selectedDeviceId))) {
        if (nextPatch.projectOrder !== undefined) setProjectOrder(nextPatch.projectOrder);
        if (nextPatch.manualProjectOrder !== undefined) setManualProjectOrder(nextPatch.manualProjectOrder);
        void saveHomeViewPreferences(nextPatch);
        return;
      }
      void applyHostProjectOrder(invoke, selectedDeviceId, {
        manualProjectOrder: nextPatch.projectOrder === 'custom'
          ? snapshotManualProjectOrder(
            visualProjectKeysRef.current,
            home.projects.map((project) => project.key),
          )
          : hostManualProjectOrder,
        knownHostKeys: hostProjectOrders.get(selectedDeviceId)?.manualProjectOrder,
        ownerStamp: hostProjectOrders.get(selectedDeviceId)?.ownerStamp,
        projectOrder: nextPatch.projectOrder,
      }).then((result) => {
        if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
        if (result.kind === 'unavailable') {
          projectOrderFetchFenceRef.current.noteLiveUpdate(selectedDeviceId);
          setHostProjectOrders((current) => {
            const next = new Map(current);
            next.set(selectedDeviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
            return next;
          });
          if (nextPatch.projectOrder !== undefined) setProjectOrder(nextPatch.projectOrder);
          if (nextPatch.manualProjectOrder !== undefined) {
            setManualProjectOrder(nextPatch.manualProjectOrder);
          }
          void saveHomeViewPreferences(nextPatch);
          return;
        }
        if (result.kind !== 'ok') return;
        projectOrderFetchFenceRef.current.noteLiveUpdate(selectedDeviceId);
        setHostProjectOrders((current) => {
          const next = new Map(current);
          next.set(selectedDeviceId, result.snapshot);
          return next;
        });
      });
      const { projectOrder: _hostOrder, manualProjectOrder: _hostKeys, ...viewerPatch } = nextPatch;
      if (Object.keys(viewerPatch).length > 0) void saveHomeViewPreferences(viewerPatch);
      return;
    }
    if (nextPatch.projectOrder !== undefined) setProjectOrder(nextPatch.projectOrder);
    if (nextPatch.manualProjectOrder !== undefined) setManualProjectOrder(nextPatch.manualProjectOrder);
    void saveHomeViewPreferences(nextPatch);
  }, [accountGeneration, home.projects, hostManualProjectOrder, hostProjectOrders, invoke, manualProjectOrder.length, projectOrder, selectedDeviceId]);

  const beginProjectDrag = useCallback((input: {
    absoluteY: number;
    count: number;
    key: string;
    title: string;
  }) => {
    const expectedAccountGeneration = accountGeneration;
    const epoch = projectDragEpochRef.current + 1;
    projectDragEpochRef.current = epoch;
    const keys = visibleProjectKeys;
    const layouts: ProjectHeaderLayout[] = [];
    let pending = keys.length;
    const finish = () => {
      if (
        homeAccountGenerationRef.current !== expectedAccountGeneration
        || projectDragEpochRef.current !== epoch
        || layouts.length === 0
      ) return;
      layouts.sort((a, b) => a.y - b.y);
      const self = layouts.find((item) => item.key === input.key);
      if (!self) return;
      const session: ProjectDragSession = {
        count: input.count,
        height: self.height,
        hoverIndex: projectDropIndexFromY(layouts.filter((item) => item.key !== input.key), input.absoluteY),
        key: input.key,
        layouts,
        originY: self.y,
        rootY: 0,
        title: input.title,
        width: 0,
        x: 0,
      };
      const header = projectHeaderRefs.current.get(input.key);
      header?.measureInWindow((x, _y, width) => {
        homeRootRef.current?.measureInWindow((_rootX, rootY) => {
          if (
            homeAccountGenerationRef.current !== expectedAccountGeneration
            || projectDragEpochRef.current !== epoch
          ) return;
          session.x = x;
          session.width = width;
          session.rootY = rootY;
          projectDragRef.current = session;
          projectDragY.value = self.y - rootY;
          setProjectDrag(session);
        });
      });
    };
    if (pending === 0) return;
    for (const key of keys) {
      const node = projectHeaderRefs.current.get(key);
      if (!node) {
        pending -= 1;
        if (pending === 0) finish();
        continue;
      }
      node.measureInWindow((_x, y, _width, height) => {
        layouts.push({ height, key, y });
        pending -= 1;
        if (pending === 0) finish();
      });
    }
  }, [accountGeneration, projectDragY, visibleProjectKeys]);

  const moveProjectDrag = useCallback((absoluteY: number) => {
    const session = projectDragRef.current;
    if (!session) return;
    // 跟手:幽灵行顶边 = 手指 Y - 半行高,避免跳到触点下方。
    projectDragY.value = absoluteY - session.height / 2 - session.rootY;
    const hoverIndex = projectDropIndexFromY(
      session.layouts.filter((item) => item.key !== session.key),
      absoluteY,
    );
    if (hoverIndex === session.hoverIndex) return;
    const next = { ...session, hoverIndex };
    projectDragRef.current = next;
    setProjectDrag(next);
  }, [projectDragY]);

  const endProjectDrag = useCallback(() => {
    const expectedAccountGeneration = accountGeneration;
    projectDragEpochRef.current += 1;
    const session = projectDragRef.current;
    projectDragRef.current = null;
    setProjectDrag(null);
    if (!session) return;
    const scope = resolveProjectOrderWriteScope(selectedDeviceId ? [selectedDeviceId] : 'all', 'local');
    const ledger = projectOrderWriteLedger(
      scope,
      selectedDeviceId ? hostProjectOrders.get(selectedDeviceId) : undefined,
    );
    const persistViewer = (next: string[]) => {
      if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
      viewPrefsTouchedRef.current = true;
      setProjectOrder('custom');
      setManualProjectOrder(next);
      void saveHomeViewPreferences({ projectOrder: 'custom', manualProjectOrder: next });
    };
    const mountedKeysByY = session.layouts.map((item) => item.key);
    if (ledger === 'host' && selectedDeviceId) {
      const visibleKeys = home.projects
        .filter((item) => item.deviceId === selectedDeviceId)
        .map((item) => item.key);
      // 虚拟化下 session.hoverIndex 只在已挂载子集从 0 计,先翻译成完整可见列表的插入位;
      // 翻译不出(源行未测到 / 已挂载子集为空)则中止,不写主机账本。
      const dropIndex = resolveVirtualizedDropIndex(
        visibleKeys,
        mountedKeysByY,
        session.key,
        session.hoverIndex,
      );
      if (dropIndex === null) return;
      const currentKeys = controllerKeysFromHost(
        selectedDeviceId,
        hostProjectOrders.get(selectedDeviceId) ?? UNAVAILABLE_PROJECT_ORDER_SNAPSHOT,
      );
      const next = reorderVisibleProjectByDropIndex(
        currentKeys.length > 0 ? currentKeys : visibleKeys,
        visibleKeys,
        session.key,
        dropIndex,
      );
      if (!next) return;
      void applyHostProjectOrder(invoke, selectedDeviceId, {
        knownHostKeys: hostProjectOrders.get(selectedDeviceId)?.manualProjectOrder,
        manualProjectOrder: next,
        ownerStamp: hostProjectOrders.get(selectedDeviceId)?.ownerStamp,
        projectOrder: 'custom',
      }).then((result) => {
        if (homeAccountGenerationRef.current !== expectedAccountGeneration) return;
        if (result.kind === 'unavailable') {
          projectOrderFetchFenceRef.current.noteLiveUpdate(selectedDeviceId);
          setHostProjectOrders((current) => {
            const nextOrders = new Map(current);
            nextOrders.set(selectedDeviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
            return nextOrders;
          });
          persistViewer(next);
          return;
        }
        if (result.kind !== 'ok') return;
        projectOrderFetchFenceRef.current.noteLiveUpdate(selectedDeviceId);
        setHostProjectOrders((current) => {
          const nextOrders = new Map(current);
          nextOrders.set(selectedDeviceId, result.snapshot);
          return nextOrders;
        });
      });
      return;
    }
    const dropIndex = resolveVirtualizedDropIndex(
      visibleProjectKeys,
      mountedKeysByY,
      session.key,
      session.hoverIndex,
    );
    if (dropIndex === null) return;
    const next = reorderVisibleProjectByDropIndex(
      manualProjectOrder,
      visibleProjectKeys,
      session.key,
      dropIndex,
    );
    if (!next) return;
    persistViewer(next);
  }, [accountGeneration, home.projects, hostProjectOrders, invoke, manualProjectOrder, selectedDeviceId, visibleProjectKeys]);
  useEffect(() => {
    if (!groupDialogue) setDialogueShowAll(false);
  }, [groupDialogue]);

  // 自动化组展开/收起,与项目组共用同一条折叠动画,保持视觉连续性。
  const toggleAutomationGroup = useCallback((key: string) => {
    configureCollapseAnimation();
    setExpandedAutomationGroups((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }, []);

  // 自动化组「查看全部 N 次运行」:与项目组「查看全部」一致,进入该任务的专属列表页
  // (设备详情页的自动化任务作用域模式),不在列表里原地铺开。
  const openAutomationGroup = useCallback((group: RemoteAutomationSessionGroup) => {
    const session = group.items[0]?.session as RemoteSession | undefined;
    if (!session) return;
    // 设备解析与 openSession 同口径:可达优先(canonicalDeviceId),回退物理 id / store 索引。
    const deviceId = session.canonicalDeviceId ?? session.deviceLinkDeviceId ?? remoteSessionStore.getSessionDeviceId(session.id);
    if (!deviceId) {
      setError(t('devices.list.error.taskDeviceNotFound'));
      return;
    }
    // 项目组内的组行(有 workingDir)带上项目维度:baseKey 不含项目 scope,同一任务跨
    // 项目时目标页只该显示本项目的 run(与组行标称的 N 一致)。dialogue 组无目录,不带。
    const workingDir = session.workingDir?.trim();
    guardedPush({
      pathname: '/devices/[deviceId]',
      params: {
        deviceId,
        name: session.deviceLinkDeviceName ?? deviceId,
        automationGroupKey: group.baseKey,
        automationName: group.title,
        ...(workingDir ? { automationWorkingDir: workingDir } : {}),
        // 快照兜底:目标页 scheduleIndex 尚未加载完成时,先按这批 id 立即显示组内运行,
        // index 就绪后再与组键匹配结果取并集(能捕获新产生的 run)。
        automationSessionIds: JSON.stringify(group.sessionIds),
      },
    });
  }, [guardedPush, t]);

  // 置顶组与项目组一致:点表头收起/展开,共用同一条收起动画。
  const togglePinned = useCallback(() => {
    configureCollapseAnimation();
    setPinnedCollapsed((collapsed) => !collapsed);
  }, []);

  const openProjectSessions = useCallback((project: MobileHomeProjectGroup) => {
    if (!project.deviceId) return;
    guardedPush({
      pathname: '/devices/[deviceId]',
      // 带上 workingDir + 项目名,让目标页只显示「这个项目」的会话(名副其实地"查看全部 N 条")。
      // 未归类组(workingDir 为空)不传过滤参数,退化为整台设备的会话列表。
      // statusFilter 跟首页当前筛选走,归档/全部入口不能掉回默认 active。
      params: {
        deviceId: project.deviceId,
        name: project.deviceName,
        statusFilter,
        ...(project.workingDir
          ? { workingDir: project.workingDir, projectName: project.title }
          : {}),
      },
    });
  }, [guardedPush, statusFilter]);

  // renderItem 提取为稳定引用:打开「选项」sheet 等与列表数据无关的页面状态变更不再改变
  // renderItem 身份,SectionList 可见行不随之全量重渲染(review P2:每行 Swipeable 动画树
  // 较重)。行内滑动回调全部走「稳定引用 + session 入参」,不为每行现造闭包。
  // 每行输出整体交给 per-item memo 的 HomeListRow(风暴修复第二刀,见其注释):这里只
  // 计算邻接派生位(分割线唯一化 / 置顶尾行 / 折叠位)并以标量 props 传入,保证单行
  // 数据变化只重建该行的包装树。
  const renderHomeRow = useCallback(({ item, index, section }: {
    item: HomeRow;
    index: number;
    section: HomeSection;
  }) => (
    <HomeListRow
      expandedAutomationGroups={expandedAutomationGroups}
      isLastPinnedRow={section.key === 'pinned' && index === section.data.length - 1 && sections.length > 1}
      item={item}
      nextIsBlock={isBlockHomeRow(section.data[index + 1])}
      onArchive={archiveSession}
      onOpenAutomationGroup={openAutomationGroup}
      onOpenProjectSessions={openProjectSessions}
      onOpenSession={openSession}
      onShowOptions={showSessionOptions}
      onToggleAutomationGroup={toggleAutomationGroup}
      onProjectDragEnd={displayedProjectOrder === 'custom' ? endProjectDrag : undefined}
      onProjectDragMove={displayedProjectOrder === 'custom' ? moveProjectDrag : undefined}
      onProjectDragStart={displayedProjectOrder === 'custom' ? beginProjectDrag : undefined}
      onShowAllDialogue={showAllDialogueSessions}
      onToggleProject={toggleProject}
      projectDragging={projectDrag?.key === (item.kind === 'project' ? item.project.key : '')}
      projectHeaderRefs={projectHeaderRefs}
      onTogglePin={toggleSessionPinned}
      prevIsBlock={isBlockHomeRow(homeRowBefore(sections, section.key, index))}
      projectCollapsed={isFolderHomeRow(item) && collapsedProjectKeys.includes(item.project.key)}
      registry={swipeRegistry}
      showAllDialogue={dialogueShowAll}
      swipe={sessionSwipeControls}
    />
  ), [
    archiveSession,
    collapsedProjectKeys,
    dialogueShowAll,
    beginProjectDrag,
    endProjectDrag,
    moveProjectDrag,
    projectDrag,
    displayedProjectOrder,
    showAllDialogueSessions,
    visibleProjectKeys,
    expandedAutomationGroups,
    openAutomationGroup,
    openProjectSessions,
    openSession,
    pinnedCollapsed,
    sections,
    sessionSwipeControls,
    showSessionOptions,
    swipeRegistry,
    toggleAutomationGroup,
    toggleProject,
    toggleSessionPinned,
  ]);

  // 底部边到边:列表填满到物理屏底(内容滚到 home indicator 下方),用 inset 兜底而非靠 SafeAreaView 留白带。
  const insets = useSafeAreaInsets();
  // top/left/right 三边不用原生 SafeAreaView 而是手动 padding:原生实现旋转时有概率
  // 漏更新,横屏 insets 残留到竖屏导致整页错位几秒(残留判定与取舍见 screenEdgeInsets.ts)。
  const edgePadding = useScreenEdgePadding({
    insets,
    windowHeight: screenHeight,
    windowWidth: screenWidth,
  });

  const selectHomeScope = useCallback((item: MobileHomeDeviceFilterItem) => {
    if (item.deviceId && item.state === 'access_revoked') {
      const deviceId = item.deviceId;
      if (usesSystemActionMenu()) {
        setRevokedTipDeviceId(deviceId);
        return;
      }
      pendingMenuActionRef.current = () => setRevokedTipDeviceId(deviceId);
      setDeviceMenuOpen(false);
      return;
    }
    viewPrefsTouchedRef.current = true;
    restoredSelectionUnvalidatedRef.current = false;
    setSelectedDeviceId(item.deviceId);
    setRestoredDeviceName(null);
    setDeviceMenuOpen(false);
    void saveHomeViewPreferences({
      selectedDevice: item.deviceId ? { deviceId: item.deviceId, name: item.label } : null,
    });
  }, []);

  const nativeHomeMenus = usesNativePullDownMenu();
  const homeScopePullDownActions = useMemo(
    () => buildHomeScopePullDownActions(
      home.deviceFilters,
      t('devices.list.allConversations'),
      {
        openLabel: t('devices.list.menu.openDevice'),
        renameLabel: t('devices.list.menu.renameDevice'),
        showTasksLabel: t('devices.list.menu.showDeviceTasks'),
      },
    ),
    [home.deviceFilters, t],
  );
  const handleHomeScopeAction = useCallback((id: string) => {
    const parsed = parseHomeScopePullDownAction(id);
    if (parsed.kind === 'open') {
      const item = home.deviceFilters.find((filter) => filter.deviceId === parsed.deviceId);
      if (!item?.deviceId) return;
      guardedPush({
        pathname: '/devices/[deviceId]',
        params: { deviceId: item.deviceId, name: item.label },
      });
      return;
    }
    if (parsed.kind === 'rename') {
      const item = home.deviceFilters.find((filter) => filter.deviceId === parsed.deviceId);
      if (item) openRenameDevice(item);
      return;
    }
    const item = home.deviceFilters.find((filter) => filter.id === parsed.filterId);
    if (item) selectHomeScope(item);
  }, [guardedPush, home.deviceFilters, openRenameDevice, selectHomeScope]);
  const homeDisplayPullDownActions = useMemo(
    () => buildHomeDisplayPullDownActions({
      groupByProject,
      groupByProjectLabel: t('devices.list.menu.groupByProject'),
      groupDialogue,
      groupDialogueLabel: t('devices.list.menu.groupDialogue'),
      groupHeading: t('devices.list.menu.groupHeading'),
      projectOrder: displayedProjectOrder,
      projectOrderActivityLabel: t('devices.list.menu.projectOrderActivity'),
      projectOrderCustomLabel: t('devices.list.menu.projectOrderManual'),
      projectOrderHeading: t('devices.list.menu.projectOrderHeading'),
      showProjectOrder: true,
      sortBy,
      sortByPriorityLabel: t('devices.list.menu.sortByPriority'),
      sortByTimeLabel: t('devices.list.menu.sortByTime'),
      sortHeading: t('devices.list.menu.sortHeading'),
      statusActiveLabel: t('devices.list.menu.statusActive'),
      statusAllLabel: t('devices.list.menu.statusAll'),
      statusArchivedLabel: t('devices.list.menu.statusArchived'),
      statusFilter,
      statusHeading: t('devices.list.menu.statusHeading'),
    }),
    [displayedProjectOrder, groupByProject, groupDialogue, sortBy, statusFilter, t],
  );

  const nativeHomeHeader = usesNativeStackHeader();
  const chromeHeight = nativeHomeHeader
    ? (headerHeight ?? 0)
    : (headerHeight ?? edgePadding.paddingTop + HOME_HEADER_MIN_HEIGHT);
  return (
    <View
      ref={homeRootRef}
      style={[styles.safeArea, { paddingLeft: edgePadding.paddingLeft, paddingRight: edgePadding.paddingRight }]}
      testID="devices.screen"
    >
      {nativeHomeHeader ? (
        <HomeNativeStackHeader
          displayA11y={t('devices.list.a11y.openDisplaySettings')}
          displayActions={homeDisplayPullDownActions}
          menuA11y={t('devices.list.a11y.openMenu')}
          onDisplayAction={(id) => {
            applyDisplayView(homeDisplayMenuPatch(id as HomeDisplayMenuKey, {
              groupByProject,
              groupDialogue,
            }));
          }}
          onOpenDeviceMenu={openDeviceMenu}
          onOpenDisplaySettings={openDisplaySettings}
          onOpenMenu={openChromeMenu}
          onSelectScope={handleHomeScopeAction}
          scopeActions={homeScopePullDownActions}
          showRemoteGuide={showRemoteGuide}
          title={selectedDeviceLabel}
          titleA11y={t('devices.list.a11y.selectScope')}
        />
      ) : null}
      <View
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        style={[styles.homeChrome, headerFrosted && !nativeHomeHeader && styles.homeChromeFrosted]}
      >
        <HomeChromeFrost disabled={nativeHomeHeader} visible={headerFrosted}>
        <View style={{ paddingTop: nativeHomeHeader ? 0 : edgePadding.paddingTop }}>
        {nativeHomeHeader ? null : (
        <View style={styles.homeHeader}>
        <HomeHeaderGlassButton
          accessibilityLabel={t('devices.list.a11y.openMenu')}
          onPress={openChromeMenu}
          testID="home.chromeMenu"
        >
          <Menu color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
        </HomeHeaderGlassButton>
        {showRemoteGuide ? (
          // 引导态没有可筛选的范围:正中只留品牌标题。
          <View style={styles.headerTitleWrap} testID="devices.title">
            <Text style={styles.headerTitle} numberOfLines={1}>Cindy</Text>
          </View>
        ) : (
          <NativePullDownMenu
            actions={homeScopePullDownActions}
            onAction={handleHomeScopeAction}
          >
            <Pressable
              accessibilityLabel={t('devices.list.a11y.selectScope')}
              accessibilityRole="button"
              onPress={nativeHomeMenus ? () => undefined : openDeviceMenu}
              onPressIn={nativeHomeMenus ? undefined : openDeviceMenu}
              style={({ pressed }) => [styles.headerTitleWrap, pressed && styles.pressed]}
              testID="devices.title"
            >
              <View style={styles.headerTitleCluster}>
                <Text style={styles.headerTitle} numberOfLines={1}>{selectedDeviceLabel}</Text>
                <ChevronDown color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.medium} />
              </View>
            </Pressable>
          </NativePullDownMenu>
        )}
        {showRemoteGuide ? (
          <View style={styles.headerIconButton} />
        ) : (
          <NativePullDownMenu
            actions={homeDisplayPullDownActions}
            onAction={(id) => {
              applyDisplayView(homeDisplayMenuPatch(id as HomeDisplayMenuKey, {
                groupByProject,
                groupDialogue,
              }));
            }}
          >
            <HomeHeaderGlassButton
              accessibilityLabel={t('devices.list.a11y.openDisplaySettings')}
              onPress={nativeHomeMenus ? () => undefined : openDisplaySettings}
              testID="home.displaySettingsButton"
            >
              <Ellipsis color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
            </HomeHeaderGlassButton>
          </NativePullDownMenu>
        )}
        </View>
        )}

        {searchOpen || !!searchQuery.trim() ? (
          <HomeSearchBar
            autoFocus={searchOpen && !searchQuery}
            filterA11y={searchFilterA11y}
            filterActions={searchFilterMenu.filterActions}
            filterActive={indexedSearch.activeFilterCount > 0}
            onChangeQuery={indexedSearch.setQuery}
            onFilterAction={searchFilterMenu.onFilterAction}
            onOpenFilter={() => setSearchFilterOpen(true)}
            query={searchQuery}
          />
        ) : null}

        {showConnectionRow ? (
        <View
          style={[styles.connectionRow, (connectionError || activeConnectionIssue) && styles.connectionRowError]}
          testID="connection.banner"
        >
          <StatusDot tone={connectionTone} pulsing={!activeConnectionIssue && status === 'connecting'} />
          <Text ellipsizeMode="tail" numberOfLines={1} style={styles.connectionText} testID="connection.title">
            {connectionCopy ? `${connectionTitle} · ${connectionCopy}` : connectionTitle}
          </Text>
          <Pressable
            accessibilityLabel={refreshing ? t('devices.list.a11y.syncing') : t('devices.list.a11y.sync')}
            accessibilityRole="button"
            accessibilityState={{ busy: refreshing || undefined, disabled: refreshing }}
            disabled={refreshing}
            onPress={() => void loadHome({ visible: true })}
            style={({ pressed }) => [
              styles.connectionIconButton,
              pressed && styles.pressed,
              refreshing && styles.disabled,
            ]}
            testID="connection.syncButton"
          >
            <RefreshCw color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          </Pressable>
        </View>
        ) : null}
        </View>
        </HomeChromeFrost>
      </View>

      <SectionList
        sections={sections}
        style={styles.homeList}
        keyExtractor={(item) => item.key}
        refreshControl={
          <RefreshControl
            progressViewOffset={chromeHeight}
            refreshing={refreshing}
            onRefresh={() => void loadHome({ visible: true })}
          />
        }
        scrollEnabled={projectDrag === null}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingBottom: 83 + insets.bottom,
            paddingTop: chromeHeight,
          },
        ]}
        onScroll={onListScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => {
          // 列表开始滚动即收起已滑开的行(iOS 惯例,避免打开态跟着列表滚)。
          swipeRegistry.closeOpenRow();
          if (!searchQuery.trim()) setSearchOpen(false);
        }}
        testID="devices.list"
        renderSectionHeader={({ section }) => {
          if (section.key !== 'pinned' || !section.title) return null;
          return (
            <Pressable
              accessibilityLabel={t('devices.list.a11y.pinnedConversations', { count: home.pinned.length })}
              accessibilityRole="button"
              accessibilityState={{ expanded: !pinnedCollapsed }}
              onPress={togglePinned}
              style={({ pressed }) => [styles.projectRow, pressed && styles.pressed]}
              testID="home.pinnedHeader"
            >
              {pinnedCollapsed ? (
                <ChevronRight color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
              ) : (
                <ChevronDown color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
              )}
              <Pin color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.thin} />
              <Text style={styles.projectTitle} numberOfLines={1}>{section.title}</Text>
              <Text style={styles.projectCount} numberOfLines={1}>{home.pinned.length}</Text>
            </Pressable>
          );
        }}
        renderSectionFooter={({ section }) => section.key === 'pinned' && sections.length > 1
          // 置顶区底部一根全宽线,把置顶对话与下面的其他对话分开(仅当下方还有其他分区时才画;
          // 下方首行是块时不画 —— 块自己的全宽顶线就是这根分割线)。
          && !isBlockHomeRow(sections[1]?.data[0]) ? (
            <View style={styles.pinnedFooter} testID="home.pinnedFooter" />
          ) : null}
        ListEmptyComponent={
          initialHomeLoading ? (
            <HomeInitialLoadingState
              style={{
                marginTop: spacing.xxl,
                minHeight: windowLayout.emptyMinHeight,
                padding: windowLayout.emptyPadding,
              }}
            />
          ) : home.pinned.length > 0 ? (
            // 仅剩置顶且被收起时 item 数为 0,但用户并非"无对话",不显示空状态插画。
            null
          ) : showRemoteGuide && home.emptyNoDevice ? (
            // 无可控制电脑是「首次使用 / 产品模式说明」级空态:按 reason 渲染远程访问引导
            // (首跑三步 / 离线设备卡 / 精确开关 / 重试访问 + 云端 Cindy 预告),而非一句话空态。
            <RemoteAccessGuide
              context={home.emptyNoDevice}
              copy={emptyStateCopy}
              onRecheck={() => void loadHome({ visible: true })}
              onRetryAccess={retryRevokedGuideDevices}
              rechecking={refreshing}
              retrying={retryingDeviceIds.size > 0}
              style={{
                marginTop: spacing.xxl,
                minHeight: windowLayout.emptyMinHeight,
                padding: windowLayout.emptyPadding,
              }}
              testID="home.remoteAccessGuide"
              title={emptyStateTitle}
            />
          ) : (
            <MainWindowEmptyState
              centered
              copy={emptyStateCopy}
              style={{
                marginTop: spacing.xxl,
                minHeight: windowLayout.emptyMinHeight,
                padding: windowLayout.emptyPadding,
              }}
              testID={initialHomeError ? 'home.syncError' : 'home.empty'}
              title={emptyStateTitle}
            />
          )
        }
        renderItem={renderHomeRow}
      />

      {projectDrag ? (
        <ProjectDragOverlay
          count={projectDrag.count}
          height={projectDrag.height}
          insertY={(() => {
            const line = projectDragInsertY(projectDrag);
            return line === null ? null : line - projectDrag.rootY;
          })()}
          title={projectDrag.title}
          width={projectDrag.width}
          x={projectDrag.x}
          y={projectDragY}
        />
      ) : null}

      {showRemoteGuide ? null : (
        // 引导态(无可控制电脑)下没有可发起对话的设备,置灰 FAB 也是噪音,直接不渲染。
        <Pressable
          accessibilityLabel={t('devices.list.a11y.newRemoteConversation')}
          accessibilityRole="button"
          accessibilityState={{ busy: initialHomeLoading || undefined, disabled: newSessionDisabled }}
          disabled={newSessionDisabled}
          onPress={() => openNewSession()}
          style={({ pressed }) => [
            styles.newChatButton,
            { bottom: CINDY_LIST_FAB_BOTTOM + insets.bottom },
            pressed && styles.pressed,
            newSessionDisabled && styles.disabled,
          ]}
          testID="home.newChatButton"
        >
          <SquarePen color={colors.ctaText} size={iconSize.xxl} strokeWidth={iconStroke.regular} />
        </Pressable>
      )}

      <RevokedAccessTip
        deviceName={revokedTipDeviceName}
        retrying={revokedTipDeviceId !== null && retryingDeviceIds.has(revokedTipDeviceId)}
        onClose={() => setRevokedTipDeviceId(null)}
        onRetry={() => {
          if (revokedTipDeviceId) void retryRevokedDevice(revokedTipDeviceId);
        }}
      />
      <DeviceMenuModal
        connectionStates={deviceConnectionStates}
        filters={home.deviceFilters}
        onClose={() => setDeviceMenuOpen(false)}
        onClosed={handleDeviceMenuClosed}
        onOpenDevice={(item) => {
          if (!item.deviceId) return;
          setDeviceMenuOpen(false);
          guardedPush({
            pathname: '/devices/[deviceId]',
            params: { deviceId: item.deviceId, name: item.label },
          });
        }}
        onRenameDevice={openRenameDevice}
        onSelect={(item) => {
          if (item.deviceId && item.state === 'access_revoked') {
            // 撤销授权提示同样是兄弟 Modal,必须等菜单卸载后再挂(见 pendingMenuActionRef 注释)。
            const deviceId = item.deviceId;
            pendingMenuActionRef.current = () => setRevokedTipDeviceId(deviceId);
            setDeviceMenuOpen(false);
            return;
          }
          viewPrefsTouchedRef.current = true;
          restoredSelectionUnvalidatedRef.current = false;
          setSelectedDeviceId(item.deviceId);
          setRestoredDeviceName(null);
          setDeviceMenuOpen(false);
          void saveHomeViewPreferences({
            selectedDevice: item.deviceId ? { deviceId: item.deviceId, name: item.label } : null,
          });
        }}
        topOffset={chromeHeight}
        visible={deviceMenuOpen}
      />
      <HomeChromeDrawer
        closeInstant={chromeMenuCloseInstant}
        loggingOut={loggingOut}
        onClose={() => {
          setChromeMenuCloseInstant(false);
          setChromeMenuOpen(false);
        }}
        onClosed={() => {
          setChromeMenuCloseInstant(false);
          handleChromeMenuClosed();
        }}
        onOpenSearch={() => {
          setSearchOpen(true);
          setChromeMenuCloseInstant(false);
          setChromeMenuOpen(false);
        }}
        onOpenAccounts={() => {
          pendingMenuActionRef.current = () => setAccountSwitcherOpen(true);
          setChromeMenuCloseInstant(false);
          setChromeMenuOpen(false);
        }}
        onOpenSettings={() => {
          pendingMenuActionRef.current = null;
          guardedPush('/settings');
          setChromeMenuCloseInstant(true);
          setChromeMenuOpen(false);
        }}
        onLogout={() => void logout()}
        open={chromeMenuOpen}
        user={user}
      />
      <AccountSwitcherSheet
        hasRunningTasks={runningSessionIds.size > 0}
        onAddAccount={() => {
          pendingAccountSwitcherActionRef.current = () => {
            void auth.beginAddAccount();
            guardedPush('/add-account');
          };
          setAccountSwitcherOpen(false);
        }}
        onClose={() => setAccountSwitcherOpen(false)}
        onClosed={() => {
          const action = pendingAccountSwitcherActionRef.current;
          pendingAccountSwitcherActionRef.current = null;
          action?.();
        }}
        visible={accountSwitcherOpen}
      />
      <ConversationSearchFilterSheet
        activeCount={indexedSearch.activeFilterCount}
        agentKind={indexedSearch.agentFilter}
        lastActivity={indexedSearch.lastActivityFilter}
        lockedProjects={false}
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
        topOffset={chromeHeight}
        visible={searchFilterOpen}
      />
      <HomeDisplaySettingsModal
        groupByProject={groupByProject}
        groupDialogue={groupDialogue}
        onChangeView={applyDisplayView}
        onClose={() => setDisplaySettingsOpen(false)}
        projectOrder={displayedProjectOrder}
        sortBy={sortBy}
        statusFilter={statusFilter}
        topOffset={chromeHeight}
        visible={displaySettingsOpen}
      />
      <RenameDeviceModal
        draft={renameDraft}
        onCancel={closeRenameDevice}
        onChangeDraft={setRenameDraft}
        onConfirm={confirmRenameDevice}
        saving={renameSaving}
        visible={renameTarget !== null}
      />
      <SessionOptionsPresenter
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
        // 乐观提交:确认即关弹窗,不存在挂起中的保存态。
        saving={false}
        visible={renameSessionTarget !== null}
      />
    </View>
  );
}

function HomeInitialLoadingState({ style }: { style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.initialLoadingState, style]} testID="home.loading">
      <ActivityIndicator color={colors.textSecondary} size="small" />
      <Text style={styles.initialLoadingText}>{t('devices.list.loading')}</Text>
    </View>
  );
}

function DeviceMenuModal({
  connectionStates,
  filters,
  onClose,
  onClosed,
  onOpenDevice,
  onRenameDevice,
  onSelect,
  topOffset,
  visible,
}: {
  connectionStates: Record<string, HomeDeviceConnectionState>;
  filters: readonly MobileHomeDeviceFilterItem[];
  onClose(): void;
  /** 淡出动画完成、Modal 真正卸载后触发;父级用它把「打开第二个 Modal」延后到菜单卸载之后。 */
  onClosed?(): void;
  onOpenDevice(item: MobileHomeDeviceFilterItem): void;
  onRenameDevice(item: MobileHomeDeviceFilterItem): void;
  onSelect(item: MobileHomeDeviceFilterItem): void;
  topOffset: number;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 范围菜单只列设备;设置入口已挪到左上角 / 右上角。
  const scopeScrollMaxHeight = Math.max(160, screenHeight - topOffset - insets.bottom - 24);
  // §14.4:展开用 ≤150ms 纯透明度过渡(不做位移/缩放),关闭淡出后再卸载 Modal。
  // mounted/progress/进场时机(onShow)/onClosed 延迟触发(等 Modal 真正卸载的 commit
  // 完成,避免 iOS present-during-dismiss 吞掉第二个弹窗)统一走 useModalFadeLifecycle。
  const { mounted, progress, onShowStartIn } = useModalFadeLifecycle(visible, {
    inMs: 140,
    outMs: 110,
    onClosed,
  });
  const allFilter = filters.find((item) => item.deviceId === null) ?? null;
  // 范围菜单只列当前能打开的电脑,对齐桌面机器切换器:离线 / 关远控 / 撤权的设备
  // 不占菜单(灰行点不进去只会吵);空态引导另走 RemoteAccessGuide。
  const deviceFilters = filters.filter((item) => item.deviceId !== null && item.available);
  return (
    <HomeMenuScrim
      backdropTestID="home.deviceMenu.backdrop"
      onClose={onClose}
      onShow={onShowStartIn}
      progress={progress}
      topOffset={topOffset}
      visible={mounted}
    >
        <HomeGlassMenuPanel style={styles.deviceMenuPanelCenter} testID="home.deviceMenu">
          <ScrollView
            style={[styles.deviceMenuScroll, { maxHeight: scopeScrollMaxHeight }]}
            showsVerticalScrollIndicator
          >
            {allFilter ? (
              <DeviceMenuItem
                label={t('devices.list.allConversations')}
                onPress={() => onSelect(allFilter)}
                selected={allFilter.selected}
                testID="home.deviceChip.all"
              />
            ) : null}
            {deviceFilters.map((item) => (
              <DeviceMenuItem
                connectionState={item.deviceId ? connectionStates[item.deviceId] ?? 'idle' : 'idle'}
                dimmed={!item.available && item.state !== 'access_revoked'}
                key={item.id}
                label={item.label}
                onLongPress={item.deviceId ? () => onOpenDevice(item) : undefined}
                onPress={() => onSelect(item)}
                onRename={item.deviceId ? () => onRenameDevice(item) : undefined}
                selected={item.selected}
                status={deviceMenuStatus(item)}
                testID={item.deviceId ? `home.deviceChip.${sanitizeDeviceChipTestId(item.deviceId)}` : undefined}
              />
            ))}
          </ScrollView>
        </HomeGlassMenuPanel>
    </HomeMenuScrim>
  );
}

function HomeDisplaySettingsModal({
  groupByProject,
  groupDialogue,
  onChangeView,
  onClose,
  projectOrder,
  showProjectOrder = true,
  sortBy,
  statusFilter,
  topOffset,
  visible,
}: {
  groupByProject: boolean;
  groupDialogue: boolean;
  onChangeView(patch: {
    groupByProject?: boolean;
    groupDialogue?: boolean;
    sortBy?: HomeListSortBy;
    statusFilter?: HomeStatusFilter;
    projectOrder?: HomeProjectOrder;
    manualProjectOrder?: string[];
  }): void;
  onClose(): void;
  projectOrder: HomeProjectOrder;
  showProjectOrder?: boolean;
  sortBy: HomeListSortBy;
  statusFilter: HomeStatusFilter;
  topOffset: number;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scrollMaxHeight = Math.max(200, screenHeight - topOffset - insets.bottom - 24);
  const { mounted, progress, onShowStartIn } = useModalFadeLifecycle(visible, {
    inMs: 140,
    outMs: 110,
  });
  return (
    <HomeMenuScrim
      backdropTestID="home.displaySettings.backdrop"
      onClose={onClose}
      onShow={onShowStartIn}
      progress={progress}
      topOffset={topOffset}
      visible={mounted}
    >
        <HomeGlassMenuPanel style={styles.deviceMenuPanelEnd} testID="home.displaySettings">
          <ScrollView style={[styles.deviceMenuScroll, { maxHeight: scrollMaxHeight }]} showsVerticalScrollIndicator>
            <Text style={styles.deviceMenuSectionLabel}>{t('devices.list.menu.groupHeading')}</Text>
            <DeviceMenuItem
              checked={groupByProject}
              label={t('devices.list.menu.groupByProject')}
              onPress={() => onChangeView({ groupByProject: !groupByProject })}
              selected={false}
              testID="home.deviceMenu.groupByProject"
            />
            <DeviceMenuItem
              checked={groupDialogue}
              label={t('devices.list.menu.groupDialogue')}
              onPress={() => onChangeView({ groupDialogue: !groupDialogue })}
              selected={false}
              testID="home.deviceMenu.groupDialogue"
            />
            <View style={styles.deviceMenuDivider} />
            <Text style={styles.deviceMenuSectionLabel}>{t('devices.list.menu.sortHeading')}</Text>
            <DeviceMenuItem
              label={t('devices.list.menu.sortByTime')}
              onPress={() => onChangeView({ sortBy: 'recency' })}
              selected={sortBy === 'recency'}
              testID="home.deviceMenu.sort.recency"
            />
            <DeviceMenuItem
              label={t('devices.list.menu.sortByPriority')}
              onPress={() => onChangeView({ sortBy: 'priority' })}
              selected={sortBy === 'priority'}
              testID="home.deviceMenu.sort.priority"
            />
            {groupByProject && showProjectOrder ? (
              <>
                <View style={styles.deviceMenuDivider} />
                <Text style={styles.deviceMenuSectionLabel}>{t('devices.list.menu.projectOrderHeading')}</Text>
                <DeviceMenuItem
                  label={t('devices.list.menu.projectOrderActivity')}
                  onPress={() => onChangeView({ projectOrder: 'activity' })}
                  selected={projectOrder === 'activity'}
                  testID="home.deviceMenu.projectOrder.activity"
                />
                <DeviceMenuItem
                  label={t('devices.list.menu.projectOrderManual')}
                  onPress={() => onChangeView({ projectOrder: 'custom' })}
                  selected={projectOrder === 'custom'}
                  testID="home.deviceMenu.projectOrder.custom"
                />
                {projectOrder === 'custom' ? (
                  <Text style={styles.deviceMenuHint}>{t('devices.list.menu.projectOrderManualTip')}</Text>
                ) : null}
              </>
            ) : null}
            <View style={styles.deviceMenuDivider} />
            <Text style={styles.deviceMenuSectionLabel}>{t('devices.list.menu.statusHeading')}</Text>
            <DeviceMenuItem
              label={t('devices.list.menu.statusActive')}
              onPress={() => onChangeView({ statusFilter: 'active' })}
              selected={statusFilter === 'active'}
              testID="home.deviceMenu.status.active"
            />
            <DeviceMenuItem
              label={t('devices.list.menu.statusArchived')}
              onPress={() => onChangeView({ statusFilter: 'archived' })}
              selected={statusFilter === 'archived'}
              testID="home.deviceMenu.status.archived"
            />
            <DeviceMenuItem
              label={t('devices.list.menu.statusAll')}
              onPress={() => onChangeView({ statusFilter: 'all' })}
              selected={statusFilter === 'all'}
              testID="home.deviceMenu.status.all"
            />
          </ScrollView>
        </HomeGlassMenuPanel>
    </HomeMenuScrim>
  );
}

function DeviceMenuItem({
  checked = false,
  connectionState,
  dimmed = false,
  icon,
  label,
  onLongPress,
  onPress,
  onRename,
  selected,
  status,
  testID,
}: {
  checked?: boolean;
  connectionState?: HomeDeviceConnectionState;
  dimmed?: boolean;
  icon?: ReactNode;
  label: string;
  onLongPress?: () => void;
  onPress(): void;
  onRename?: () => void;
  selected: boolean;
  status?: 'online' | 'offline';
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const rowDisabled = dimmed;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ checked: checked || undefined, disabled: rowDisabled, selected: selected || undefined }}
      disabled={rowDisabled && !onRename}
      onLongPress={rowDisabled ? undefined : onLongPress}
      onPress={() => {
        if (rowDisabled) return;
        onPress();
      }}
      style={({ pressed }) => [
        styles.deviceMenuItem,
        pressed && styles.pressed,
        dimmed && styles.disabled,
      ]}
      testID={testID}
    >
      {/* 左侧固定对位列:选中/勾选打 ✓,设置行放图标,未选中留空槽保证文字列对齐。 */}
      <View style={styles.deviceMenuCheckSlot}>
        {icon ?? (selected || checked ? (
          <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.medium} />
        ) : null)}
      </View>
      <Text numberOfLines={1} style={styles.deviceMenuItemText}>{label}</Text>
      {status ? (
        <View style={styles.deviceMenuStatusSlot}>
          <StatusDot tone={status === 'online' ? 'ready' : 'off'} pulsing={connectionState === 'syncing'} />
          {connectionState === 'failed' ? <View style={styles.deviceConnectionFailedRing} /> : null}
        </View>
      ) : null}
      {onRename ? (
        <Pressable
          accessibilityLabel={t('devices.list.a11y.renameDevice', { label })}
          accessibilityRole="button"
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation();
            onRename();
          }}
          style={({ pressed }) => [styles.deviceMenuRenameButton, pressed && styles.pressed]}
          testID={testID ? `${testID}.rename` : undefined}
        >
          <Pencil color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function RenameDeviceModal({
  draft,
  onCancel,
  onChangeDraft,
  onConfirm,
  saving,
  visible,
}: {
  draft: string;
  onCancel(): void;
  onChangeDraft(value: string): void;
  onConfirm(): void;
  saving: boolean;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const canSave = draft.trim().length > 0 && !saving;
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onCancel}>
      <Pressable style={styles.renameDeviceBackdrop} onPress={onCancel} testID="home.renameDevice.backdrop">
        <Pressable style={styles.renameDeviceCard} onPress={() => undefined} testID="home.renameDevice.modal">
          <Text style={styles.renameDeviceTitle}>{t('devices.list.renameDevice.title')}</Text>
          <TextInput
            autoFocus
            editable={!saving}
            maxLength={64}
            onChangeText={onChangeDraft}
            onSubmitEditing={() => {
              if (canSave) onConfirm();
            }}
            placeholder={t('devices.list.renameDevice.placeholder')}
            placeholderTextColor={colors.textTertiary}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.renameDeviceInput}
            testID="home.renameDevice.input"
            value={draft}
          />
          {/* 确认对统一规则:共享满宽纵排组(保存在上/取消居底),置于卡片底部。 */}
          <MainWindowActionGroup
            primaryActions={[{
              accessibilityLabel: saving ? t('devices.list.renameDevice.savingA11y') : t('devices.list.renameDevice.saveA11y'),
              busy: saving,
              disabled: !canSave,
              label: saving ? t('devices.common.saving') : t('devices.common.save'),
              onPress: onConfirm,
              testID: 'home.renameDevice.save',
              tone: 'primary',
            }]}
            cancelAction={{
              accessibilityLabel: t('devices.list.a11y.cancelRename'),
              disabled: saving,
              label: t('devices.common.cancel'),
              onPress: onCancel,
              testID: 'home.renameDevice.cancel',
            }}
            testID="home.renameDevice.actions"
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RevokedAccessTip({
  deviceName,
  onClose,
  onRetry,
  retrying,
}: {
  deviceName: string | null;
  onClose(): void;
  onRetry(): void;
  retrying: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <Modal animationType="fade" transparent visible={deviceName != null} onRequestClose={onClose}>
      <Pressable style={styles.revokedTipBackdrop} onPress={onClose} testID="home.revokedTip.backdrop">
        {/* Inner press swallow keeps taps on the card from dismissing via the backdrop. */}
        <Pressable style={styles.revokedTipCard} onPress={() => undefined}>
          <View style={styles.revokedTipHeader}>
            <View style={styles.revokedTipIcon}>
              <Lock color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
            </View>
            <Pressable
              accessibilityLabel={t('devices.list.a11y.close')}
              accessibilityRole="button"
              hitSlop={8}
              onPress={onClose}
              style={({ pressed }) => [styles.revokedTipClose, pressed && styles.pressed]}
            >
              <X color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
            </Pressable>
          </View>
          <Text style={styles.revokedTipTitle}>{t('devices.list.revoked.title')}</Text>
          <Text style={styles.revokedTipBody}>
            {t('devices.list.revoked.body', { deviceName: deviceName ?? t('devices.list.thisComputer') })}
          </Text>
          <Pressable
            accessibilityLabel={t('devices.list.revoked.retry')}
            accessibilityRole="button"
            accessibilityState={{ busy: retrying, disabled: retrying }}
            disabled={retrying}
            onPress={onRetry}
            style={({ pressed }) => [styles.revokedTipRetry, pressed && styles.pressed, retrying && styles.disabled]}
            testID="home.revokedTip.retry"
          >
            {retrying ? (
              <ActivityIndicator color={colors.ctaText} size="small" />
            ) : (
              <Text style={styles.revokedTipRetryText}>{t('devices.list.revoked.retry')}</Text>
            )}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function sanitizeDeviceChipTestId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function deviceMenuStatus(item: MobileHomeDeviceFilterItem): 'online' | 'offline' {
  return item.available && (item.state === 'ready' || item.state === 'busy') ? 'online' : 'offline';
}

function projectDragInsertY(drag: ProjectDragSession): number | null {
  const sourceIndex = drag.layouts.findIndex((item) => item.key === drag.key);
  if (sourceIndex < 0 || drag.hoverIndex === sourceIndex) return null;
  const target = drag.layouts[drag.hoverIndex];
  if (!target) return null;
  return drag.hoverIndex > sourceIndex ? target.y + target.height : target.y;
}

function ProjectDragOverlay({
  count,
  height,
  insertY,
  title,
  width,
  x,
  y,
}: {
  count: number;
  height: number;
  insertY: number | null;
  title: string;
  width: number;
  x: number;
  y: SharedValue<number>;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const ghostStyle = useAnimatedStyle(() => ({
    height,
    left: x,
    top: y.value,
    width,
  }));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="home.projectDragOverlay">
      {insertY === null ? null : <View style={[styles.projectDragInsertLine, { top: insertY }]} />}
      <Reanimated.View style={[styles.projectDragGhost, ghostStyle]}>
        <Folder color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.thin} />
        <Text numberOfLines={1} style={styles.projectTitle}>{title}</Text>
        <Text numberOfLines={1} style={styles.projectCount}>{count}</Text>
      </Reanimated.View>
    </View>
  );
}

function ProjectRow({
  collapsed,
  dragging = false,
  expandedAutomationGroups,
  headerRefs,
  kind = 'project',
  onDragEnd,
  onDragMove,
  onDragStart,
  onOpenAutomationGroup,
  onOpenProject,
  onOpenSession,
  onToggle,
  onToggleAutomationGroup,
  project,
  showAll = false,
  suppressTopBorder = false,
  swipe,
}: {
  collapsed: boolean;
  dragging?: boolean;
  expandedAutomationGroups: readonly string[];
  headerRefs?: MutableRefObject<Map<string, View>>;
  kind?: 'project' | 'dialogue';
  onDragEnd?: () => void;
  onDragMove?: (absoluteY: number) => void;
  onDragStart?: (input: { absoluteY: number; count: number; key: string; title: string }) => void;
  onOpenAutomationGroup(group: RemoteAutomationSessionGroup): void;
  onOpenProject(): void;
  onOpenSession(item: RemoteSessionListItem): void;
  onToggle(): void;
  onToggleAutomationGroup(key: string): void;
  project: MobileHomeProjectGroup;
  /** 对话组「查看全部」在原地展开,不跳设备详情。 */
  showAll?: boolean;
  /** 前一行也是块(项目组 / 自动化组)时不画顶线:前块底线已是这根分割线。 */
  suppressTopBorder?: boolean;
  /** 提供时项目子行挂与顶层普通会话行同款的左右滑操作(组行仍不挂,子行经透传可滑)。 */
  swipe?: SessionSwipeControls;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 折叠豁免要命令式读会话运行态,而派生链稳定化后本组件不再逐 emit 重渲染(cell 经
  // PureComponent bail)——以 storeVersion 订阅兜底感知运行态变化,与 AutomationGroup-
  // Children 同款(否则折叠线以下转入 running 的会话不会被豁免展开,review P1)。
  useRemoteSessionStoreVersion();
  // 与桌面侧栏项目组同一套折叠策略:前 N 条之外豁免最近 24h 活动 / 需关注 / 运行中的条目
  // (豁免语义见共享层 getRemoteSessionPreviewCollapse 注释)。
  // 自动化折叠后 sessions 是"行"(组行代表多条会话):按钮显隐看隐藏行数(hiddenCount),
  // 文案仍用 sessionCount(总会话数),两者语义不同不能混用。
  const { visibleItems: visibleSessions, hiddenCount: hiddenRowCount } = getRemoteSessionPreviewCollapse(
    project.sessions,
    {
      limit: showAll ? project.sessions.length : PROJECT_PREVIEW_LIMIT,
      isSessionRunning: (sessionId) => remoteSessionStore.isSessionRunning(sessionId),
    },
  );
  const groupTestID = kind === 'dialogue' ? 'home.dialogueGroup' : 'home.projectGroup';
  const rowTestID = kind === 'dialogue' ? 'home.dialogueRow' : 'home.projectRow';
  const childTestID = kind === 'dialogue' ? 'home.chatRow' : 'home.projectSessionRow';
  const reorderable = kind === 'project' && !!onDragStart && !!onDragMove && !!onDragEnd;
  const dragGesture = useMemo(() => {
    if (!onDragStart || !onDragMove || !onDragEnd || kind !== 'project') return null;
    const start = onDragStart;
    const move = onDragMove;
    const finish = onDragEnd;
    return Gesture.Pan()
      .activateAfterLongPress(380)
      .onStart((event) => {
        runOnJS(start)({
          absoluteY: event.absoluteY,
          count: project.sessionCount,
          key: project.key,
          title: project.title,
        });
      })
      .onUpdate((event) => {
        runOnJS(move)(event.absoluteY);
      })
      .onFinalize(() => {
        runOnJS(finish)();
      });
  }, [kind, onDragEnd, onDragMove, onDragStart, project.key, project.sessionCount, project.title]);
  const header = (
    <Pressable
      accessibilityHint={reorderable ? t('devices.list.menu.projectOrderManualTip') : undefined}
      accessibilityLabel={kind === 'dialogue'
        ? t('devices.list.a11y.dialogue')
        : t('devices.list.a11y.project', { title: project.title })}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      onPress={dragging ? undefined : onToggle}
      ref={(node) => {
        if (!headerRefs || kind !== 'project') return;
        if (node) headerRefs.current.set(project.key, node);
        else headerRefs.current.delete(project.key);
      }}
      style={({ pressed }) => [
        styles.projectRow,
        pressed && !dragging && styles.pressed,
        dragging && styles.projectRowDragging,
      ]}
      testID={rowTestID}
    >
      {collapsed ? (
        <ChevronRight color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      ) : (
        <ChevronDown color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      )}
      {kind === 'dialogue' ? (
        <MessagesSquare color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.thin} />
      ) : collapsed ? (
        <Folder color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.thin} />
      ) : (
        <FolderOpen color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.thin} />
      )}
      <Text style={styles.projectTitle} numberOfLines={1}>{project.title}</Text>
      <Text style={styles.projectCount} numberOfLines={1}>{project.sessionCount}</Text>
    </Pressable>
  );
  return (
    <View
      style={[styles.projectGroup, suppressTopBorder && styles.projectGroupNoTop]}
      testID={groupTestID}
    >
      {dragGesture ? <GestureDetector gesture={dragGesture}>{header}</GestureDetector> : header}

      {collapsed ? null : (
        <View style={styles.projectChildren} testID="home.projectChildren">
          {visibleSessions.map((item, index) => {
            const row = (
              <HomeSessionRow
                expandedAutomationGroups={expandedAutomationGroups}
                // 项目块内最后一个元素不画自己的缩进线:项目块底部的全宽线就是分割线。
                hideDivider={hiddenRowCount === 0 && index === visibleSessions.length - 1}
                indented
                item={item}
                onOpenAutomationGroup={onOpenAutomationGroup}
                onOpenSession={onOpenSession}
                onToggleAutomationGroup={onToggleAutomationGroup}
                swipe={swipe}
                testID={childTestID}
              />
            );
            // 与顶层同一条规则:普通会话子行挂滑动,自动化组行不挂(组行语义含混,
            // 其展开子行由 AutomationGroupChildren 内的透传包裹)。
            if (!swipe || item.automationGroup || !conversationSearchAllowsLocalWrites(item)) {
              return <Fragment key={item.automationGroup?.key ?? item.session.id}>{row}</Fragment>;
            }
            return (
              <SwipeableSessionRow
                key={item.session.id}
                onArchive={swipe.onArchive}
                onShowOptions={swipe.onShowOptions}
                onTogglePin={swipe.onTogglePin}
                registry={swipe.registry}
                session={item.session as RemoteSession}
                testID={`${childTestID}.swipe`}
              >
                {row}
              </SwipeableSessionRow>
            );
          })}
          {hiddenRowCount > 0 ? (
            <Pressable
              accessibilityLabel={t('devices.list.viewAllConversations', { count: project.sessionCount })}
              accessibilityRole="button"
              disabled={kind !== 'dialogue' && !project.deviceId}
              onPress={onOpenProject}
              style={({ pressed }) => [
                styles.projectViewAllRow,
                pressed && styles.pressed,
                kind !== 'dialogue' && !project.deviceId && styles.disabled,
              ]}
              testID={kind === 'dialogue' ? 'home.dialogueViewAll' : 'home.projectViewAll'}
            >
              <Text style={styles.projectViewAllText} numberOfLines={1}>
                {t('devices.list.viewAllConversations', { count: project.sessionCount })}
              </Text>
              <ChevronRight color={colors.textTertiary} size={iconSize.action} strokeWidth={iconStroke.regular} />
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

/**
 * 首页 renderItem 输出的 per-item memo 单元(2026-07-18 风暴修复第二刀)。
 * 内核行(HomeSessionRow)memo 后,每次 sections 真实变化(流式期间预览更新等)仍会
 * 整列表重渲染全部 cell 的 Swipeable / 手势包装树(trace:47 次壳层重渲染 × ~105 cell,
 * 每次 ~500ms)。把整个 renderItem 输出按 item 级 memo,包装树只在自己 item 的数据
 * 变化时重建。比较器与 HomeSessionRow 同款 dataPropsEqual:函数 props 跳过——闭包
 * 审计:onArchive / onShowOptions / onTogglePin / onOpen* / onToggle* 均为 useCallback
 * 且只闭合 router / store / 稳定 setState;registry(swipeRegistry)与 swipe 为
 * useMemo 单例。给本组件新增函数 prop 时必须复审闭包稳定性。projectCollapsed /
 * prevIsBlock 等邻接派生位由 renderItem 计算成标量传入,天然参与比较。
 */
const HomeListRow = memo(HomeListRowInner, dataPropsEqual);

function HomeListRowInner({
  expandedAutomationGroups,
  isLastPinnedRow,
  item,
  nextIsBlock,
  onArchive,
  onOpenAutomationGroup,
  onOpenProjectSessions,
  onOpenSession,
  onProjectDragEnd,
  onProjectDragMove,
  onProjectDragStart,
  onShowAllDialogue,
  onShowOptions,
  onToggleAutomationGroup,
  onToggleProject,
  onTogglePin,
  prevIsBlock,
  projectCollapsed,
  projectDragging,
  projectHeaderRefs,
  registry,
  showAllDialogue,
  swipe,
}: {
  expandedAutomationGroups: readonly string[];
  /** 置顶组展开态:行进入置顶卡片内的缩进/描边形态(CINDY list 视觉)。 */
  isLastPinnedRow: boolean;
  item: HomeRow;
  nextIsBlock: boolean;
  onArchive(session: RemoteSession): void;
  onOpenAutomationGroup(group: RemoteAutomationSessionGroup): void;
  onOpenProjectSessions(project: MobileHomeProjectGroup): void;
  onOpenSession(item: RemoteSessionListItem): void;
  onProjectDragEnd?: () => void;
  onProjectDragMove?: (absoluteY: number) => void;
  onProjectDragStart?: (input: { absoluteY: number; count: number; key: string; title: string }) => void;
  onShowAllDialogue(): void;
  onShowOptions(session: RemoteSession): void;
  onToggleAutomationGroup(key: string): void;
  onToggleProject(key: string): void;
  onTogglePin(session: RemoteSession): void;
  prevIsBlock: boolean;
  projectCollapsed: boolean;
  projectDragging: boolean;
  projectHeaderRefs: MutableRefObject<Map<string, View>>;
  registry: ReturnType<typeof createSwipeRowRegistry>;
  showAllDialogue: boolean;
  swipe: SessionSwipeControls;
}) {
  if (item.kind === 'project' || item.kind === 'dialogue') {
    return (
      <ProjectRow
        collapsed={projectCollapsed}
        dragging={projectDragging}
        expandedAutomationGroups={expandedAutomationGroups}
        headerRefs={projectHeaderRefs}
        kind={item.kind}
        onDragEnd={item.kind === 'project' ? onProjectDragEnd : undefined}
        onDragMove={item.kind === 'project' ? onProjectDragMove : undefined}
        onDragStart={item.kind === 'project' ? onProjectDragStart : undefined}
        onOpenAutomationGroup={onOpenAutomationGroup}
        onOpenProject={item.kind === 'dialogue' ? onShowAllDialogue : () => onOpenProjectSessions(item.project)}
        onOpenSession={onOpenSession}
        onToggle={() => onToggleProject(item.project.key)}
        onToggleAutomationGroup={onToggleAutomationGroup}
        project={item.project}
        showAll={item.kind === 'dialogue' && showAllDialogue}
        suppressTopBorder={prevIsBlock}
        swipe={swipe}
      />
    );
  }
  const row = (
    <HomeSessionRow
      asBlock
      expandedAutomationGroups={expandedAutomationGroups}
      hideDivider={nextIsBlock || isLastPinnedRow}
      item={item.item}
      onOpenAutomationGroup={onOpenAutomationGroup}
      onOpenSession={onOpenSession}
      onToggleAutomationGroup={onToggleAutomationGroup}
      sourceLabel={item.sourceLabel}
      suppressBlockTopBorder={prevIsBlock}
      swipe={swipe}
      testID={item.source === 'search' ? 'home.searchSessionRow' : homeSessionRowTestId(item.source)}
    />
  );
  // 普通会话行(含置顶区)在这里挂滑动操作;自动化组行不挂 —— 组行代表多次运行,
  // 「置顶/归档这一组」语义含混,但其展开的子行经 swipe 透传同样可滑。
  // 项目组子行 / 自动化子行的滑动在各自渲染路径内包裹;选择态不传 swipe。
  if (item.item.automationGroup || !conversationSearchAllowsLocalWrites(item.item)) return row;
  return (
    <SwipeableSessionRow
      onArchive={onArchive}
      onShowOptions={onShowOptions}
      onTogglePin={onTogglePin}
      registry={registry}
      session={item.item.session as RemoteSession}
      testID={`${item.source === 'search' ? 'home.searchSessionRow' : homeSessionRowTestId(item.source)}.swipe`}
    >
      {row}
    </SwipeableSessionRow>
  );
}

// 导出给项目作用域的设备详情页(app/devices/[deviceId].tsx)复用,保证两处会话行视觉一致。
// memo 化(2026-07-18 重渲染风暴):行是列表里最重的单元(Svg 状态标 + Swipeable +
// 手势树,dev 实测单行 ~13ms),父层每次重渲染 105 个挂载行全量重画是风暴的主放大器。
// 比较器 dataPropsEqual:数据 props(item / 布尔位 / expandedAutomationGroups)深比较,
// **函数 props 跳过**——闭包审计:onOpenSession / onToggleAutomationGroup /
// onOpenAutomationGroup 只闭合 router / 稳定 setState / 稳定 store 引用,新旧闭包可互换;
// swipe(SessionSwipeControls)为父层 useMemo 单例,内部函数同理。给行新增函数 prop 时
// 必须重新审计闭包稳定性,否则会拿着 stale 闭包运行。行内运行态经 useSessionRunning
// 订阅(不再依赖父层重渲染带入),展开组子行的运行态订阅见 AutomationGroupChildren。
export const HomeSessionRow = memo(HomeSessionRowInner, dataPropsEqual);

function HomeSessionRowInner({
  asBlock = false,
  automationChildTestID,
  automationChildrenTestID,
  deepIndented = false,
  expandedAutomationGroups,
  groupRowTestID,
  hideDivider = false,
  indented = false,
  item,
  onLongPress,
  onOpenAutomationGroup,
  onOpenSession,
  onPressSelection,
  onToggleAutomationGroup,
  selected = false,
  selectionMarkTestID,
  selectionMode = false,
  sourceLabel,
  suppressBlockTopBorder = false,
  swipe,
  testID,
  titleTestIDPrefix = 'home.sessionRowTitle',
}: {
  /**
   * 自动化组行以「块」呈现:上下各一根全宽分割线,与项目组同款,把任务块和普通对话区分开。
   * 仅顶层列表传 true;项目组内部的自动化组行保持缩进行样式(已有项目块包裹,不再嵌套块)。
   */
  asBlock?: boolean;
  automationChildTestID?: string;
  automationChildrenTestID?: string;
  /**
   * 自动化组子行的深缩进档(缩进全部收在行内 padding,滑动包装才能全宽):
   * 在 indented 基础上再深一档,保证子行始终比组行(无论组行在 chats 还是项目组内)更深。
   */
  deepIndented?: boolean;
  /** 已展开的自动化组 key 列表(页面级 state,列表虚拟化回收行组件也不丢展开态)。 */
  expandedAutomationGroups?: readonly string[];
  groupRowTestID?: string;
  /**
   * 隐藏本行自己的缩进分割线。用于紧邻「块」(项目组 / 自动化组)上边界的行,以及块内最后
   * 一个元素 —— 块的全宽 border 已经画了线,行内缩进线再画会两根 hairline 叠成一根粗线。
   */
  hideDivider?: boolean;
  indented?: boolean;
  item: RemoteSessionListItem;
  onLongPress?: () => void;
  /** 组展开后子运行超过限量时,点「查看全部 N 次运行」进入该任务的专属列表页(与项目组一致)。 */
  onOpenAutomationGroup?: (group: RemoteAutomationSessionGroup) => void;
  onOpenSession(item: RemoteSessionListItem): void;
  onPressSelection?: () => void;
  /** 提供时,自动化组行点击 = 展开/收起(与设备详情页完整模式的组行约定一致);子行点开各自会话。 */
  onToggleAutomationGroup?: (key: string) => void;
  selected?: boolean;
  selectionMarkTestID?: string;
  selectionMode?: boolean;
  /** 平铺时标题旁的来源标签(项目名 /「对话」);分组模式下不传。 */
  sourceLabel?: string;
  /** 块模式下,前一行也是块时不画自己的顶线(前块的底线已经是这根线)。 */
  suppressBlockTopBorder?: boolean;
  /** 提供时透传给展开的自动化组子行(子行挂与顶层同款滑动操作);组行自身不消费。 */
  swipe?: SessionSwipeControls;
  testID: string;
  titleTestIDPrefix?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 运行态走订阅而非命令式读取:行已 memo 化,父层不再逐 emit 重渲染,命令式读取会 stale。
  const sessionIsRunning = useSessionRunning(item.session.id);
  const running = sessionIsRunning || !!item.scheduleInfo?.running;
  // attention 合并 main 的 #368:liveActivity.attention 也点亮关注态(组行直开 primary 的判定沿用)。
  const attention = item.pendingInteractionCount > 0
    || (item.scheduleInfo?.unreadCount ?? 0) > 0
    || item.liveActivity?.attention === true;
  // 右侧状态槽(替代时间位):与桌面侧栏同一套五档优先级与色表
  // (error 红 > awaiting TapTap 蓝 > running spinner > 完成未读绿 > 时间)。
  const rightStatus = resolveMobileSessionRightStatus({
    liveAttention: item.liveActivity?.attention === true,
    livePhase: item.liveActivity?.phase,
    pendingInteractionCount: item.pendingInteractionCount,
    running,
    scheduleUnreadCount: item.scheduleInfo?.unreadCount ?? 0,
  });
  const showDraftIndicator = readBooleanField(item.session, 'hasDraft')
    || readBooleanField(item.session, 'hasPausedQueue')
    || readBooleanField(item.session, 'composerDraft');
  const showSchedule = !!item.scheduleInfo || item.session.source === 'scheduler';
  // 对齐桌面多绑定语义:只有同一会话的所有 schedule 都 paused / expired，
  // 才在 Timer 固定槽位叠 Pause 角标；任一 active 绑定仍保留普通 Timer。
  const scheduleStopped = item.scheduleInfo?.allSchedulesStopped === true;
  const showPinned = !!item.session.pinnedAt;
  // 自动化组行:同一任务的多次运行折叠而成(共享层 groupAutomationListItems 产出)。
  // 没接展开回调的调用点退化为普通行为(点击打开 primary 会话)。
  const group = onToggleAutomationGroup ? item.automationGroup : undefined;
  const groupExpanded = !!group && !!expandedAutomationGroups?.includes(group.key);
  // 块模式:组行 + 展开的子行整体包在一个上下全宽线的块里;组行自身不再画缩进分割线
  // (收起时块底线紧贴行底,展开时组头与子行之间保持连续无线,均与项目组语义一致)。
  const blockMode = asBlock && !!group;
  // 预览走共享 buildRemoteSessionCardPreview(已并入 #368 的 liveActivity),运行中会显示实时活动;
  // 组行的预览位改为任务态摘要(需关注数 / 执行中 / 共 N 次运行),对齐桌面版组头 meta。
  const preview = group
    ? automationGroupPreview(item, group.sessionCount, t)
    : buildRemoteSessionCardPreview(item, { running });
  // 零消息会话没有摘要。此时不要保留双行列表的空白第二行；但定时任务与置顶
  // 标记仍占用右下状态槽，因此继续使用双行布局。
  const showPreviewLine = !!preview?.trim() || showSchedule || showPinned;
  // 组行点击语义对齐桌面版侧边栏:收起且有需关注内容(未读运行 / 待处理)时,点行直接打开
  // 该看的那条会话(共享层 primary:运行中 > 有未读 > 最新);想展开点行首箭头(独立热区)。
  // 无需关注内容或已展开时,点行仍是展开 / 收起。
  const openGroupPrimary = () => {
    if (!group) return;
    const primary = group.items.find((child) => child.session.id === group.primarySessionId) ?? group.items[0];
    if (primary) onOpenSession(primary);
  };
  const groupRowOpensPrimary = !!group && attention && !groupExpanded;
  const handlePress = selectionMode && onPressSelection
    ? onPressSelection
    : group
      ? groupRowOpensPrimary ? openGroupPrimary : () => onToggleAutomationGroup?.(group.key)
      : () => onOpenSession(item);
  return (
    <View
      style={blockMode
        ? [
          styles.automationGroupBlock,
          suppressBlockTopBorder && styles.automationGroupBlockNoTop,
        ]
        : undefined}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={group
          ? groupRowOpensPrimary ? t('devices.list.a11y.openAutomationLatest', { title: item.title }) : t('devices.list.a11y.automationTask', { title: item.title })
          : t('devices.list.a11y.openConversation', { title: item.title })}
        accessibilityState={group ? { expanded: groupExpanded, selected } : { selected }}
        onLongPress={onLongPress}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.sessionListRow,
          !showPreviewLine && styles.sessionListRowSingleLine,
          indented && styles.sessionListRowIndented,
          deepIndented && styles.sessionListRowDeepIndented,
          pressed && styles.pressed,
        ]}
        testID={group ? (groupRowTestID ?? `${testID}.automationGroup`) : testID}
      >
        {selectionMode ? (
          <View style={[styles.selectionMark, selected && styles.selectionMarkSelected]} testID={selectionMarkTestID}>
            {selected ? <Text style={styles.selectionMarkText}>✓</Text> : null}
          </View>
        ) : null}
        {group && !selectionMode ? (
          // 展开箭头放行首,与项目组的折叠交互一致(chevron → 图标 → 标题);
          // 独立热区:即使组行点击直开会话(有需关注内容时),点箭头仍然是展开 / 收起。
          <Pressable
            accessibilityLabel={groupExpanded ? t('devices.list.a11y.collapse', { title: item.title }) : t('devices.list.a11y.expand', { title: item.title })}
            accessibilityRole="button"
            hitSlop={{ bottom: 12, left: 12, right: 4, top: 12 }}
            onPress={(event) => {
              // 防御性阻断:避免 chevron 点击同时触发父行 onPress(有需关注内容时父行
              // 是"直开 primary 会话",双触发会边展开边跳页)。与设备菜单重命名按钮同款处理。
              event.stopPropagation();
              onToggleAutomationGroup?.(group.key);
            }}
            style={styles.sessionGroupChevronCell}
            testID={`${testID}.automationGroupChevron`}
          >
            {groupExpanded ? (
              <ChevronDown color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
            ) : (
              <ChevronRight color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
            )}
          </Pressable>
        ) : null}
        <View style={[
          styles.sessionIconCell,
          !showPreviewLine && styles.sessionIconCellSingleLine,
        ]}>
          <SessionStatusMark
            item={item}
            running={running}
            showDraftIndicator={showDraftIndicator}
          />
        </View>
        <View style={[
          styles.sessionListContent,
          (hideDivider || blockMode || (!!group && groupExpanded)) && styles.sessionListContentNoDivider,
        ]}>
          <View style={styles.sessionTitleRow}>
            <Text
              style={styles.sessionTitle}
              ellipsizeMode="tail"
              numberOfLines={1}
              testID={titleTestIDPrefix === 'deviceDetail.sessionRowTitle'
                ? `deviceDetail.sessionRowTitle.${item.session.id}`
                : `home.sessionRowTitle.${item.session.id}`}
            >
              {item.title}
            </Text>
            {sourceLabel ? (
              <Text
                ellipsizeMode="tail"
                numberOfLines={1}
                style={styles.sessionSourceLabel}
                testID={`home.sessionSourceLabel.${item.session.id}`}
              >
                {sourceLabel}
              </Text>
            ) : null}
            {rightStatus === 'time' ? (
              <SessionRelativeTime lastActivityAt={item.lastActivityAt} style={styles.sessionTime} />
            ) : (
              // 统一 18×18 定位槽(对齐桌面 size-4 槽的做法):点(10)与 spinner(15)
              // 尺寸不同,裸放会导致两者横/纵中心不一致,先居中到同一槽再谈对齐。
              <View style={styles.sessionRightStatusCell}>
                {rightStatus === 'running' ? (
                  // 与桌面右槽完全同款:lucide Loader2/LoaderCircle 圆弧 + 1s 匀速旋转
                  // (对齐 Tailwind animate-spin),中性色 —— running 的橙色语义由行首
                  // vendor icon 呼吸表达。
                  <SessionRightSpinner testID={`home.sessionRightStatus.running.${item.session.id}`} />
                ) : (
                  <View
                    accessibilityLabel={rightStatus === 'error' ? t('devices.list.a11y.taskError') : rightStatus === 'awaiting' ? t('devices.list.a11y.awaitingYou') : t('devices.list.a11y.doneUnread')}
                    accessibilityRole="image"
                    style={[styles.sessionRightDot, {
                      backgroundColor: rightStatus === 'error'
                        ? colors.statusError
                        : rightStatus === 'awaiting'
                          ? colors.statusAwaiting
                          : colors.statusDone,
                    }]}
                    testID={`home.sessionRightStatus.${rightStatus}.${item.session.id}`}
                  />
                )}
              </View>
            )}
          </View>
          {showPreviewLine ? (
            <View style={styles.sessionPreviewRow}>
              <Text
                ellipsizeMode="tail"
                numberOfLines={1}
                style={styles.sessionPreview}
                testID={`home.sessionRowPreview.${item.session.id}`}
              >
                {preview}
              </Text>
              {showSchedule || showPinned ? (
                // 组行与单次自动化会话行同款标记:Timer 放右下(时间下方的尾部图标位),
                // 行首保留正常的会话状态图标(primary 运行的 vendor / 运行态)。
                <View style={styles.sessionTrailingIcons}>
                  {showSchedule ? (
                    <AutomationTimerIcon
                      paused={scheduleStopped}
                      size={iconSize.lg}
                      testID={`home.sessionAutomationTimer.${item.session.id}`}
                    />
                  ) : null}
                  {showPinned ? <Pin color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.thin} /> : null}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </Pressable>
      {group && groupExpanded && !selectionMode ? (
        <AutomationGroupChildren
          childTestID={automationChildTestID}
          childrenTestID={automationChildrenTestID}
          group={group}
          inBlock={blockMode}
          suppressTrailingDivider={hideDivider}
          onOpenGroup={onOpenAutomationGroup}
          onOpenSession={onOpenSession}
          swipe={swipe}
          testID={testID}
          titleTestIDPrefix={titleTestIDPrefix}
        />
      ) : null}
    </View>
  );
}

/**
 * 自动化组展开后的子运行列表:与项目组同一交互模式 —— 默认只显示前 N 条
 * (限量与 PROJECT_PREVIEW_LIMIT 一致,24h 活动 / 需关注 / 运行中的条目豁免不折叠),
 * 有隐藏行时显示「查看全部 N 次运行」,点击进入该任务的专属列表页
 * (设备详情页的自动化任务作用域模式)。
 */
function AutomationGroupChildren({
  childTestID,
  childrenTestID,
  group,
  inBlock = false,
  // 宿主行已被上层声明"尾线由外层块提供"(如项目块内最后一个元素)时,
  // 展开子列表的尾缘线(末条运行 / 查看全部行)一并抑制,避免与块收尾线叠双(PR-266 greptile P2)。
  suppressTrailingDivider = false,
  onOpenGroup,
  onOpenSession,
  swipe,
  testID,
  titleTestIDPrefix,
}: {
  childTestID?: string;
  childrenTestID?: string;
  group: RemoteAutomationSessionGroup;
  suppressTrailingDivider?: boolean;
  /** 组行处于块模式(上下全宽线):块内最后一个元素不画自己的缩进线,避免与块底线叠成粗线。 */
  inBlock?: boolean;
  onOpenGroup?: (group: RemoteAutomationSessionGroup) => void;
  onOpenSession(item: RemoteSessionListItem): void;
  /** 提供时每条子运行挂与顶层普通会话行同款的左右滑操作。 */
  swipe?: SessionSwipeControls;
  testID: string;
  titleTestIDPrefix?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 折叠豁免要命令式读子会话运行态,而父行(HomeSessionRow)已 memo 化、不再逐 emit
  // 重渲染——这里以 storeVersion 订阅兜底感知运行态变化。仅组展开时挂载,量小成本可忽略。
  useRemoteSessionStoreVersion();
  // 与项目组同一套折叠豁免(24h 活动 / 需关注 / 运行中),见共享层注释。
  const { visibleItems, hiddenCount } = getRemoteSessionPreviewCollapse(group.items, {
    limit: PROJECT_PREVIEW_LIMIT,
    isSessionRunning: (sessionId) => remoteSessionStore.isSessionRunning(sessionId),
  });
  const hasViewAllRow = hiddenCount > 0 && !!onOpenGroup;
  return (
    <View style={styles.automationGroupChildren} testID={childrenTestID ?? `${testID}.automationGroupChildren`}>
      {visibleItems.map((child, index) => {
        const row = (
          <HomeSessionRow
            deepIndented
            hideDivider={(inBlock || suppressTrailingDivider) && !hasViewAllRow && index === visibleItems.length - 1}
            item={child}
            onOpenSession={onOpenSession}
            testID={childTestID ?? `${testID}.automationChild`}
            titleTestIDPrefix={titleTestIDPrefix}
          />
        );
        if (!swipe) return <Fragment key={child.session.id}>{row}</Fragment>;
        return (
          <SwipeableSessionRow
            key={child.session.id}
            onArchive={swipe.onArchive}
            onShowOptions={swipe.onShowOptions}
            onTogglePin={swipe.onTogglePin}
            registry={swipe.registry}
            session={child.session as RemoteSession}
            testID={`${testID}.automationChild.swipe`}
          >
            {row}
          </SwipeableSessionRow>
        );
      })}
      {hasViewAllRow ? (
        <Pressable
          accessibilityLabel={t('devices.list.viewAllRuns', { count: group.sessionCount })}
          accessibilityRole="button"
          onPress={() => onOpenGroup?.(group)}
          style={({ pressed }) => [
            styles.automationViewAllRow,
            !inBlock && !suppressTrailingDivider && styles.automationViewAllRowDivider,
            pressed && styles.pressed,
          ]}
          testID={`${testID}.automationViewAll`}
        >
          <Text style={styles.projectViewAllText} numberOfLines={1}>
            {t('devices.list.viewAllRuns', { count: group.sessionCount })}
          </Text>
          <ChevronRight color={colors.textTertiary} size={iconSize.action} strokeWidth={iconStroke.regular} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** 自动化组行的预览位文案:需关注数 > 执行中 > 共 N 次运行(对齐桌面版组头 meta 的优先级)。 */
function automationGroupPreview(item: RemoteSessionListItem, sessionCount: number, t: TFunction): string {
  const unread = item.scheduleInfo?.unreadCount ?? 0;
  const waiting = item.pendingInteractionCount;
  if (unread > 0 || waiting > 0) {
    return [
      unread > 0 ? t('devices.list.preview.needAttention', { count: unread }) : null,
      waiting > 0 ? t('devices.list.preview.waiting', { count: waiting }) : null,
    ].filter(Boolean).join(' · ');
  }
  if (item.scheduleInfo?.running) return t('devices.list.preview.automationRunning');
  return t('devices.list.preview.totalRuns', { count: sessionCount });
}

// 状态提醒点已移到行右侧(替代时间位,与桌面一致),行首图标只保留 vendor 标识 +
// running 呼吸 + 草稿铅笔,不再叠角标点。
function SessionStatusMark({
  item,
  running,
  showDraftIndicator,
}: {
  item: RemoteSessionListItem;
  running: boolean;
  showDraftIndicator: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const archived = item.session.status === 'archived';
  const orcaLead = item.session.orcaRole === 'lead';
  const attached = readBooleanField(item.session, 'attached') || readBooleanField(item.session, 'deviceLinkAttached');
  // 用户拍板 2026-07-20(对齐桌面):running 一律 Thinking Orange(statusAccent)。
  const glyphColor = running ? colors.statusAccent : colors.textTertiary;
  return (
    <View style={styles.sessionStatusMark}>
      {archived ? (
        <Archive color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.thin} />
      ) : orcaLead ? (
        // 与桌面 SessionStatusIcon /「+」菜单协同项同款 UsersRound，不再用旧 Puzzle。
        <SessionStatusPulse running={running}>
          <UsersRound color={glyphColor} size={iconSize.action} strokeWidth={iconStroke.thin} />
        </SessionStatusPulse>
      ) : attached ? (
        <SessionStatusPulse running={running}>
          <RadioTower color={glyphColor} size={iconSize.lg} strokeWidth={iconStroke.thin} />
        </SessionStatusPulse>
      ) : (
        <MobileVendorIcon
          color={glyphColor}
          running={running}
          // Claude 星标 logo 视觉重量偏小,+1px 光学补偿对齐 Codex 标(刻意非阶梯值)。
          size={isClaudeCodeAgentKind(item.session.agentKind) ? 19 : iconSize.lg}
          vendor={item.session.agentKind}
        />
      )}
      {!archived && showDraftIndicator ? (
        <View style={styles.sessionDraftIndicator}>
          {/* 9px:Pencil 微徽标,徽标容器几何依赖(designTokenDiscipline ALLOWLIST 登记豁免)。 */}
          <Pencil color={colors.textSecondary} size={9} strokeWidth={iconStroke.medium} />
        </View>
      ) : null}
    </View>
  );
}

/** 行右侧 running spinner —— 与桌面 SessionItem 右槽同款:LoaderCircle(即桌面的
 *  lucide Loader2)圆弧图标,1s linear 无限旋转(Tailwind animate-spin 同参数)。 */
/**
 * 行右侧相对时间标签(「刚刚 / N 分钟前」)的独家保鲜叶子:行主体 memo 化后不再逐
 * emit 重渲染,时间标签失去偶然保鲜会无限期冻结(review P1);而把分钟订阅挂在行
 * 本体又等于每分钟重画全列表重型子树(review 复核 P1)。下沉到只渲染一个 Text 的
 * 叶子组件独家订阅 useMinuteNow:每分钟只重渲染 ~百个纯 Text,行主体纹丝不动。
 */
function SessionRelativeTime({ lastActivityAt, style }: { lastActivityAt: string; style: StyleProp<TextStyle> }) {
  useMinuteNow();
  return (
    <Text style={style} numberOfLines={1}>
      {formatRemoteSessionSidebarTime(lastActivityAt)}
    </Text>
  );
}

function SessionRightSpinner({ testID }: { testID?: string }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        duration: 1000,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      accessibilityLabel={t('devices.list.a11y.running')}
      style={{ transform: [{ rotate }] }}
      testID={testID}
    >
      <LoaderCircle color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
    </Animated.View>
  );
}

function SessionStatusPulse({ children, running }: { children: ReactNode; running: boolean }) {
  const opacity = useRef(new Animated.Value(running ? 0.3 : 1)).current;
  useEffect(() => {
    opacity.stopAnimation();
    if (!running) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.3);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.3,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, running]);

  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/** 该首页行是否以「块」呈现(上下全宽线):项目组,或自动化组行(顶层 asBlock)。 */
function isBlockHomeRow(row: HomeRow | undefined): boolean {
  if (!row) return false;
  return isFolderHomeRow(row) || (row.kind === 'session' && !!row.item.automationGroup);
}

function homeSessionRowTestId(source: 'chat' | 'pinned' | 'project'): string {
  if (source === 'pinned') return 'home.pinnedRow';
  if (source === 'project') return 'home.projectSessionRow';
  return 'home.chatRow';
}

function remoteListStatusFilter(filter: RemoteSessionStatusFilter): RemoteListStatusFilter {
  if (filter === 'archived') return 'archived';
  if (filter === 'all' || filter === 'waiting' || filter === 'automation') return 'all';
  return 'active';
}

function isDeviceOfflineError(error: unknown): boolean {
  if (error instanceof DeviceLinkError) return error.code === 'DEVICE_OFFLINE';
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code === 'DEVICE_OFFLINE';
  }
  return error instanceof Error && error.message.includes('[DEVICE_OFFLINE]');
}

function isOptionalActiveSessionSnapshotError(error: unknown): boolean {
  if (isAccessRevokedError(error) || isDeviceOfflineError(error)) return false;
  const text = formatRemoteError(error);
  if (text.includes('REMOTE_DISABLED')) return false;
  return true;
}

function markDeviceViewsOffline(
  devices: readonly DeviceView[],
  offlineDeviceIds: ReadonlySet<string>,
): DeviceView[] {
  if (offlineDeviceIds.size === 0) return [...devices];
  return devices.map((device) => {
    if (!offlineDeviceIds.has(device.deviceId)) return device;
    return {
      ...device,
      busy: false,
      online: false,
      remoteControlEnabled: false,
    };
  });
}

function readBooleanField(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)[key] === true;
}

function isClaudeCodeAgentKind(agentKind: string): boolean {
  return agentKind === 'cc' || agentKind === 'claude-code';
}

function homeConnectionTitle(status: 'online' | 'connecting' | 'stopped', t: TFunction): string {
  if (status === 'connecting') return t('devices.list.connection.connecting');
  if (status === 'stopped') return t('devices.list.connection.disconnected');
  return '';
}

function updateHomeDeviceConnectionState(
  current: Record<string, HomeDeviceConnectionState>,
  deviceId: string,
  state: HomeDeviceConnectionState,
): Record<string, HomeDeviceConnectionState> {
  if (state === 'idle') {
    if (!(deviceId in current)) return current;
    const { [deviceId]: _removed, ...next } = current;
    return next;
  }
  if (current[deviceId] === state) return current;
  return { ...current, [deviceId]: state };
}

function pruneHomeDeviceConnectionStates(
  current: Record<string, HomeDeviceConnectionState>,
  availableDeviceIds: ReadonlySet<string>,
): Record<string, HomeDeviceConnectionState> {
  let changed = false;
  const next: Record<string, HomeDeviceConnectionState> = {};
  for (const [deviceId, state] of Object.entries(current)) {
    if (!availableDeviceIds.has(deviceId)) {
      changed = true;
      continue;
    }
    next[deviceId] = state;
  }
  return changed ? next : current;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  homeChrome: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
  },
  homeChromeFrosted: {
    borderBottomColor: colors.chatHeaderDivider,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  homeHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: HOME_HEADER_MIN_HEIGHT,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  headerIconButton: {
    alignItems: 'center',
    flexShrink: 0,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  headerTitleWrap: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 0,
    paddingHorizontal: spacing.sm,
  },
  headerTitleCluster: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 6,
    maxWidth: '100%',
    minWidth: 0,
  },
  headerTitle: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.listTitle,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listTitleCompact,
  },
  deviceMenuPanelCenter: {
    alignSelf: 'center',
  },
  deviceMenuPanelEnd: {
    alignSelf: 'flex-end',
  },
  connectionRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 42,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  connectionRowError: {
    backgroundColor: colors.surface,
  },
  connectionText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  connectionIconButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  deviceConnectionFailedRing: {
    borderColor: colors.errorBorder,
    // 16×16 圆环:语义是正圆,用 pill(RN 钳制到半高)而非碰巧同值的 control 档。
    borderRadius: radius.pill,
    borderWidth: 1.5,
    height: 16,
    position: 'absolute',
    width: 16,
  },
  deviceMenuBackdrop: {
    backgroundColor: colors.overlay,
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  deviceMenuPanel: {
    // 左锚定窄卡(对齐设计稿「选择器菜单」):贴着头部选择器下方展开,不再横向铺满。
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 360,
    minWidth: 264,
    padding: spacing.sm,
  },
  deviceMenuScroll: {
    // 仅作为 scope 列表的可滚动容器,flexGrow:0 让短列表时收缩到内容高度(maxHeight 在行内设)。
    flexGrow: 0,
  },
  deviceMenuCheckSlot: {
    alignItems: 'center',
    width: iconSize.md,
  },
  deviceMenuItem: {
    alignItems: 'center',
    borderRadius: radius.container,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  deviceMenuItemText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  deviceMenuSectionLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  deviceMenuHint: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  deviceMenuStatusSlot: {
    alignItems: 'center',
    height: 20,
    justifyContent: 'center',
    position: 'relative',
    width: 20,
  },
  deviceMenuRenameButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  deviceMenuDivider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.sm,
  },
  renameDeviceBackdrop: {
    alignItems: 'center',
    backgroundColor: colors.overlay,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  renameDeviceCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    maxWidth: 360,
    padding: spacing.lg,
    width: '100%',
  },
  renameDeviceTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.subtitle,
  },
  renameDeviceInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  revokedTipBackdrop: {
    alignItems: 'center',
    backgroundColor: colors.overlay,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  revokedTipCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    maxWidth: 360,
    padding: spacing.lg,
    width: '100%',
  },
  revokedTipHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  revokedTipIcon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  revokedTipClose: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  revokedTipTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.subtitle,
  },
  revokedTipBody: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
  },
  revokedTipRetry: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  revokedTipRetryText: {
    color: colors.ctaText,
    fontSize: typeScale.body,
    fontWeight: fontWeight.semibold,
  },
  homeList: {
    backgroundColor: colors.surface,
    flex: 1,
  },
  listContent: {
    backgroundColor: colors.surface,
    flexGrow: 1,
    paddingBottom: 83,
    paddingTop: 0,
  },
  // 置顶区收尾线:回 XD-Maker 原版 hairline(换肤卡片化曾置 0,通栏回退一并恢复)。
  pinnedFooter: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  initialLoadingState: {
    alignItems: 'center',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  initialLoadingText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.code,
  },
  projectGroup: {
    backgroundColor: colors.surface,
    // 全宽分割线挂在项目组的顶部与底部:把整个项目块与上方/下方的普通对话分开,
    // 而非分隔项目头与其下属会话(项目头 → 内容之间保持连续无线)。
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: 0, // 显式方角覆盖,非漂移
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderWidth: 0,
  },
  projectGroupNoTop: {
    // 前一行也是块时不画顶线,避免两根 hairline 叠成一根粗线。
    borderTopWidth: 0,
  },
  projectRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: 8,
    minHeight: 56,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
  },
  projectTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.listTitle,
    minWidth: 0,
  },
  projectCount: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.subtitle,
  },
  projectRowDragging: {
    opacity: 0.28,
  },
  projectDragGhost: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    position: 'absolute',
  },
  projectDragInsertLine: {
    backgroundColor: colors.textPrimary,
    height: StyleSheet.hairlineWidth * 2,
    left: spacing.lg,
    position: 'absolute',
    right: spacing.lg,
  },
  projectChildren: {
    backgroundColor: colors.surface,
  },
  projectViewAllRow: {
    // 永远是项目块的最后一个元素:不画自己的下线,块底部的全宽线就是分割线
    // (再画会两根 hairline 叠成一根粗线)。
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 54,
    paddingLeft: 48,
    paddingRight: spacing.lg,
  },
  projectViewAllText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  sessionListRow: {
    alignItems: 'stretch',
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: spacing.md,
    height: HOME_SESSION_ROW_HEIGHT,
    paddingLeft: spacing.md,
  },
  sessionListRowSingleLine: {
    height: HOME_SESSION_SINGLE_LINE_ROW_HEIGHT,
  },
  sessionListRowIndented: {
    // 项目下属会话向右多缩进一档,让"隶属于该项目"在视觉上更明显
    // (连同行内分割线一起右移,形成嵌套层级感)。
    paddingLeft: spacing.md + spacing.lg,
  },
  sessionListRowDeepIndented: {
    // 自动化组子行:比 indented 再深一档(缩进全部收在行内,滑动包装全宽才能贴屏边),
    // 保证子行始终比组行(无论组行在 chats 还是项目组内)更深一层。
    paddingLeft: spacing.md + spacing.lg * 2,
  },
  automationGroupBlock: {
    // 自动化组(组行 + 展开的子行)整体成块:上下各一根全宽分割线,与项目组(projectGroup)
    // 同款,把任务块和普通对话在视觉上区分开。
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  automationGroupBlockNoTop: {
    // 前一行也是块时不画顶线:前块的底线就是这根分割线,再画会叠成一根粗线。
    borderTopWidth: 0,
  },
  automationGroupChildren: {
    // 自动化组展开的子运行容器:不再用容器 padding 做缩进(会把子行的滑动包装挤离屏边),
    // 深一档的缩进由子行自身的 sessionListRowDeepIndented 承担,视觉层级不变。
    backgroundColor: colors.surface,
  },
  automationViewAllRow: {
    // 「查看全部 N 次运行」:与项目组「查看全部 N 条对话」同款行样式,
    // 左缩进对齐组内子行文字(deepIndented 行的缩进 + 行首图标位)。
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 54,
    paddingLeft: spacing.md + spacing.lg * 2 + 24 + spacing.md,
    paddingRight: spacing.lg,
  },
  automationViewAllRowDivider: {
    // 仅非块模式(项目组内部的自动化组)画自己的下线;块模式下块底线负责,不再叠一根。
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sessionIconCell: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 22,
    width: 24,
  },
  sessionIconCellSingleLine: {
    justifyContent: 'center',
    paddingTop: 0,
  },
  sessionGroupChevronCell: {
    // 自动化组行行首的展开箭头列:与项目组行首 chevron 对齐(尺寸 22、次级色),
    // 垂直对齐标题行(与 sessionIconCell 同一基线)。
    alignItems: 'center',
    justifyContent: 'flex-start',
    marginRight: -spacing.xs,
    paddingTop: 23,
    width: 22,
  },
  sessionListContent: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
    paddingBottom: spacing.sm,
    paddingRight: spacing.lg,
    paddingTop: spacing.sm,
  },
  sessionListContentNoDivider: {
    // 紧邻块(项目组 / 自动化组)边界的行不画自己的缩进线:块的全宽 border 已经是这根线,
    // 两根 hairline 相邻会叠成一根明显更粗的线(即「项目组上边线偏粗」的根因)。
    borderBottomWidth: 0,
  },
  sessionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    height: 30,
  },
  sessionStatusMark: {
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
    overflow: 'visible',
    position: 'relative',
    width: 24,
  },
  // 右侧状态槽(替代时间位):18×18 定位槽把点与 spinner 居中到同一锚点;
  // 点 10px(桌面 size-2=8px,手机屏幕密度高、观看距离远,放大一档保证可辨识,
  // 2026-07 产品模拟器实测拍板)。
  sessionRightStatusCell: {
    alignItems: 'center',
    flexShrink: 0,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  sessionRightDot: {
    borderRadius: radius.pill, // 10x10 圆点:pill 钳制为半径 5,与原字面量视觉一致
    flexShrink: 0,
    height: 10,
    width: 10,
  },
  sessionDraftIndicator: {
    alignItems: 'center',
    bottom: -3,
    height: 12,
    justifyContent: 'center',
    position: 'absolute',
    right: -3,
    width: 12,
  },
  sessionTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.subtitle,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listTitle,
    minWidth: 0,
  },
  sessionSourceLabel: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.body,
    maxWidth: '42%',
    minWidth: 0,
  },
  sessionPreviewRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    height: lineHeight.subtitle,
  },
  sessionPreview: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.code,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.subtitle,
    minWidth: 0,
  },
  sessionTrailingIcons: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    minHeight: lineHeight.subtitle,
    paddingTop: 3,
  },
  sessionTime: {
    color: colors.textTertiary,
    flexShrink: 0,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.body,
  },
  selectionMark: {
    alignItems: 'center',
    alignSelf: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  selectionMarkSelected: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.textPrimary,
  },
  selectionMarkText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  newChatButton: {
    alignItems: 'center',
    backgroundColor: colors.homeListFab,
    borderColor: colors.homeListFabBorder,
    borderRadius: radius.pill,
    borderWidth: colors.homeListFabBorder === 'transparent' ? 0 : StyleSheet.hairlineWidth,
    bottom: CINDY_LIST_FAB_BOTTOM,
    height: CINDY_LIST_FAB_SIZE,
    justifyContent: 'center',
    position: 'absolute',
    right: CINDY_LIST_GUTTER,
    width: CINDY_LIST_FAB_SIZE,
  },
});
