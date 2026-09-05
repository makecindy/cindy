/**
 * SessionListDrawer —— 宽屏(iPad / 折叠屏展开 / 横屏手机)会话页的任务列表抽屉。
 *
 * 会话页左上角三条杠拉出:原地切任务 / 新建任务 / 回主页,不来回压导航栈。
 * 断点判定在 `wideSessionNav.ts`(纯函数),本组件只管呈现与手势。
 *
 * 结构取舍:
 * - **树内 overlay 而非 RN Modal**:会话页已有多个 sheet Modal,iOS 同级双 Modal
 *   有 present/dismiss 竞态(见 SheetSurface 头注释);树内层叠没有这些约束。新建 / 回主页
 *   仍必须等 overlay 退场并真正卸载后执行；任务切换则在当前原生 Screen 内只替换 route
 *   params，完全绕开 Android NativeStack replace。代价是盖不住原生弹层,但抽屉打开前
 *   页面会先收键盘,且其它 sheet 与抽屉互斥(都由页面状态驱动)。
 * - **数据直读全局 remoteSessionStore**:与首页同一份 store(进会话页前已水合,
 *   设备订阅继续推增量),经共享层 buildMobileHomePresentation 复用首页的排序 /
 *   置顶 / 自动化折叠口径,不在抽屉里重建首页的设备同步机械。
 * - 动画走 reanimated(withTiming + Pan 手势拖拽关闭),遵循 reduce-motion 约定
 *   (useReduceMotionEnabled === false 才播)。
 */
import { House, LoaderCircle, SquarePen } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { ConversationSearchFilterSheet } from '@/session/ConversationSearchFilterSheet';
import { HomeSearchBar } from '@/session/HomeSearchBar';
import {
  conversationSearchOriginsFromDeviceModels,
  listConversationSearchProjects,
  shouldReplaceListWithSearchResults,
  type ConversationSearchDeviceModel,
  type ConversationSearchDeviceOrigin,
} from '@/session/conversationSearch';
import { useConversationSearch } from '@/session/useConversationSearch';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { buildHomeSections, type HomeRow, type HomeSection } from '@/session/homeSections';
import { buildMobileHomePresentation, excludeOrcaWorkerSessions } from '@/session/mobileHome';
import {
  remoteSessionStore,
  useRemoteConversationSearchDeviceModels,
  useRemoteDeviceIdentity,
  useRemoteHomeStatusVersion,
  useRemoteMessageVersion,
  useRemoteSessionMessagePreview,
  useRemoteSessions,
  useSessionRunning,
} from '@/session/remoteSessionStore';
import type { RemoteSessionLiveActivity } from '@/session/sessionList';
import { resolveMobileSessionRightStatus } from '@/session/sessionRightStatus';
import {
  buildRemoteSessionCardPreview,
  buildSessionMessagePreviewIndex,
  formatRemoteSessionSidebarTime,
  type RemoteSessionListItem,
} from '@/session/sessionList';
import { useMinuteNow } from '@/utils/useMinuteNow';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  motionDuration,
  motionEasing,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

/** 拖过面板宽度的 1/3 或甩速超阈即判定关闭(常见抽屉手感)。 */
const DRAWER_CLOSE_DISTANCE_RATIO = 1 / 3;
const DRAWER_CLOSE_VELOCITY = -800;

export function SessionListDrawer({
  currentSessionId,
  onClose,
  onClosed,
  onGoHome,
  onNewSession,
  onSelectSession,
  open,
  width,
}: {
  currentSessionId: string;
  onClose(): void;
  /** 关闭动画完成、overlay 真正卸载后触发。 */
  onClosed?(): void;
  onGoHome(): void;
  onNewSession(): void;
  onSelectSession(item: RemoteSessionListItem): void;
  open: boolean;
  width: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionEnabled();
  // 抽屉贴左缘,横屏刘海侧的 left inset 并进面板总宽,内容用 padding 让出。
  // 下限 1 是除零保险:当前调用点 enabled=false 时本组件整个不渲染(width 恒 >=300),
  // 但 progress/scrim 多处除以 panelWidth,不把不变量寄托在调用方身上。
  const panelWidth = Math.max(1, width + insets.left);

  const [mounted, setMounted] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const openRef = useRef(open);
  openRef.current = open;
  // progress 0→1 = 收起→展开;dragX(≤0)是手势拖拽的临时位移,松手后归零或并入 progress。
  const progress = useSharedValue(open ? 1 : 0);
  const dragX = useSharedValue(0);
  // 关闭收尾统一走这里(动画完成回调 / reduce-motion 直跳两条路径):先只卸载 overlay。
  // onClosed 必须等 mounted=false 的 commit 完成,否则导航会和 GestureDetector/
  // Reanimated 子树卸载挤进同一帧(Android 原生 Screen 存在崩溃竞态)。背景焦点归还
  // 则由父级在 accessibility 隔离解除后的 commit effect 中完成。
  const finishClose = useCallback(() => {
    if (openRef.current) return;
    setMounted(false);
  }, []);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (!wasMounted || mounted) return;
    onClosedRef.current?.();
  }, [mounted]);
  // 打开后把读屏焦点移进面板首控件(新建任务):背后内容已按模态摘出读屏树,不移焦
  // VoiceOver/TalkBack 会停在已隐藏的节点上。延到入场动画结束再移,避免读出滑动中的几何。
  const newSessionButtonRef = useRef<View>(null);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const node = findNodeHandle(newSessionButtonRef.current);
      if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
    }, motionDuration.enter);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    // reduce-motion 约定:只有 === false 才播动画,null(首帧未知)按不播降级。
    const animate = reduceMotion === false;
    if (open) {
      setMounted(true);
      // 手势位移并回 progress,从当前视觉位置继续,不跳帧。
      const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
      progress.value = effective;
      dragX.value = 0;
      // 重浮层入场档(motionDuration.enter + out 曲线),与 DESIGN.md §14.4 双端同构。
      progress.value = animate
        ? withTiming(1, { duration: motionDuration.enter, easing: Easing.bezier(...motionEasing.out) })
        : 1;
      return;
    }
    if (!mountedRef.current) return;
    const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
    progress.value = effective;
    dragX.value = 0;
    if (!animate) {
      progress.value = 0;
      finishClose();
      return;
    }
    progress.value = withTiming(
      0,
      // 重浮层退场档(motionDuration.exit + in 曲线)。
      { duration: motionDuration.exit, easing: Easing.bezier(...motionEasing.in) },
      (finished) => {
        'worklet';
        if (finished) runOnJS(finishClose)();
      },
    );
  }, [dragX, finishClose, open, panelWidth, progress, reduceMotion]);

  // Android 系统返回键:抽屉开着时先关抽屉,不冒泡成页面返回。
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, open]);

  const closeFromGesture = useCallback(() => onClose(), [onClose]);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        // 与内部 SectionList 纵向滚动的协调全靠激活窗口收窄:
        // - 只认「向左」(关闭方向)为激活条件,向右 16pt 直接判失败——右拖不该抢任何手势;
        // - 纵向 16pt 先到即失败,滚动优先;斜向手势必须横向分量先赢才归抽屉。
        .activeOffsetX(-16)
        .failOffsetX(16)
        .failOffsetY([-16, 16])
        .onUpdate((event) => {
          'worklet';
          dragX.value = Math.min(0, event.translationX);
        })
        .onEnd((event) => {
          'worklet';
          const shouldClose =
            event.translationX < -panelWidth * DRAWER_CLOSE_DISTANCE_RATIO ||
            event.velocityX < DRAWER_CLOSE_VELOCITY;
          if (shouldClose) {
            runOnJS(closeFromGesture)();
          } else {
            // 未过阈回弹:位置插值档(fast + move 曲线)。
            dragX.value = withTiming(0, {
              duration: motionDuration.fast,
              easing: Easing.bezier(...motionEasing.move),
            });
          }
        }),
    [closeFromGesture, dragX, panelWidth],
  );

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth)),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: Math.max(
          -panelWidth,
          Math.min(0, (progress.value - 1) * panelWidth + dragX.value),
        ),
      },
    ],
  }));

  // 与首页同一套展示模型(排序 / 置顶区 / 自动化折叠);未挂载时跳过重建,
  // 常驻宽屏页面时不为收起的抽屉付 presentation 成本。
  const sessions = useRemoteSessions();
  // pending/live/running 才重建分组；普通消息预览由可见行按 session 订阅。
  const homeStatusVersion = useRemoteHomeStatusVersion();
  // 设备身份和搜索可达性可单独变化，不能依赖 sessions 数组顺便触发刷新。
  const devices = useRemoteDeviceIdentity();
  const searchDeviceModels = useRemoteConversationSearchDeviceModels() as readonly ConversationSearchDeviceModel[];
  const unresponsiveDevices = useUnresponsiveDevices();
  const searchOrigins = useMemo(() => {
    if (searchDeviceModels.length > 0) {
      return conversationSearchOriginsFromDeviceModels(searchDeviceModels, {
        unresponsiveDeviceIds: unresponsiveDevices,
      });
    }
    if (devices.length > 0) {
      return devices.map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.name,
        reachable: false,
      }));
    }
    const byId = new Map<string, ConversationSearchDeviceOrigin>();
    for (const session of sessions) {
      const id = session.canonicalDeviceId ?? session.deviceLinkDeviceId;
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        deviceId: id,
        deviceName: session.deviceLinkDeviceName ?? id,
        reachable: false,
      });
    }
    return [...byId.values()];
  }, [devices, searchDeviceModels, sessions, unresponsiveDevices]);
  const searchProjects = useMemo(
    () => listConversationSearchProjects(excludeOrcaWorkerSessions(sessions)),
    [sessions],
  );
  const indexedSearch = useConversationSearch({
    enabled: mounted,
    origins: searchOrigins,
    projects: searchProjects,
  });
  const searchQuery = indexedSearch.query;
  // 索引搜索就绪前的本地搜索仍须匹配已加载消息；普通列表不订阅全局消息版本。
  const messageSearchVersion = useRemoteMessageVersion(mounted && searchQuery.trim().length > 0);
  const [searchFilterOpen, setSearchFilterOpen] = useState(false);
  const searchFilterA11y = t('devices.list.search.filterAria', {
    agent: t(`devices.list.search.filter.agent.${indexedSearch.agentFilter}`),
    lastActivity: t(`devices.list.search.filter.lastActivity.${indexedSearch.lastActivityFilter}`),
    projects: indexedSearch.projectSelection === 'all'
      ? t('devices.list.search.filter.allProjects')
      : t('devices.list.search.filter.selectedProjects', { count: indexedSearch.projectSelection.length }),
    sort: t(`devices.list.search.filter.sort.${indexedSearch.sortBy}`),
    status: t(`devices.list.search.filter.status.${indexedSearch.statusFilter}`),
  });
  const sections = useMemo<HomeSection[]>(() => {
    if (!mounted) return [];
    if (shouldReplaceListWithSearchResults(searchQuery, indexedSearch.status)) {
      return [{
        data: indexedSearch.results.map((item) => ({
          item,
          key: `search:${(item.session as { deviceLinkDeviceId?: string | null }).deviceLinkDeviceId ?? 'local'}:${item.session.id}`,
          kind: 'session' as const,
          source: 'search' as const,
        })),
        key: 'search',
        title: null,
      }];
    }
    void homeStatusVersion;
    void messageSearchVersion;
    const messagePreviewIndex = searchQuery.trim()
      ? buildSessionMessagePreviewIndex(
          sessions.map((session) => session.id),
          (sessionId) => remoteSessionStore.getMessages(sessionId),
        )
      : undefined;
    // 与首页同口径的行内状态输入:等待授权/回复(awaiting)与 live error/done 都来自
    // 这两个 index,缺了会全部退化成普通时间行。
    const pendingInteractionIndex = new Map(
      sessions
        .map((session) => [session.id, remoteSessionStore.getPendingInteractions(session.id).length] as const)
        .filter(([, count]) => count > 0),
    );
    const liveActivityEntries: Array<[string, RemoteSessionLiveActivity]> = [];
    for (const session of sessions) {
      const liveActivity = remoteSessionStore.getSessionLiveActivity(session.id);
      if (liveActivity) liveActivityEntries.push([session.id, liveActivity]);
    }
    const home = buildMobileHomePresentation({
      searchQuery,
      // 权威设备身份必须随会话一起进 presentation:canonicalizeSessionDevice 会按传入
      // devices 重算并覆盖 canonicalDeviceId,空列表会把 store 已认领好的规范 id 打回
      // 弱推断(re-link 后点行路由到旧物理设备)。
      devices,
      liveActivityIndex: new Map(liveActivityEntries),
      messagePreviewIndex,
      pendingInteractionIndex,
      // scheduleIndex **刻意不接**:它靠 1+N×listRuns RPC 水合,仓内把这条链路限制在
      // 首页/设备详情页并配 defer+30s 节流(见 scheduleIndex.ts / scheduleIndexDefer.ts,
      // issue 324:单 WS 管道被背景 listRuns 拥塞会拖慢会话打开的关键读)。抽屉是瞬态
      // 切换器:分组与名称由共享层 fallbackScheduleInfo 兜底,主选与运行态由
      // pendingInteractionIndex / liveActivity / useSessionRunning 覆盖,仅缺 schedule
      // 未读绿点这档次要徽标——不值得从会话页新开一个取数点。
      sessions: excludeOrcaWorkerSessions(sessions),
      statusFilter: 'active',
      // 已解析的 i18n 文案传给共享层(共享层不出中文串;en/ja/ko 不再回退「未命名任务」)。
      unnamedLabel: t('session.menu.unnamedTitle'),
    });
    return buildHomeSections(home, false, false);
  }, [devices, homeStatusVersion, indexedSearch.results, indexedSearch.status, messageSearchVersion, mounted, searchQuery, sessions, t]);
  const hasRows = useMemo(
    () => sections.some((section) => section.data.length > 0),
    [sections],
  );

  const renderRow = useCallback(
    ({ item }: { item: HomeRow }) => {
      if (item.kind !== 'session') return null;
      const active =
        item.item.session.id === currentSessionId ||
        (item.item.automationGroup?.sessionIds.includes(currentSessionId) ?? false);
      return (
        <DrawerSessionRow
          active={active}
          item={item.item}
          onSelect={onSelectSession}
          searchResult={item.source === 'search'}
        />
      );
    },
    [currentSessionId, onSelectSession],
  );

  if (!mounted) return null;

  return (
    <View
      // iOS VoiceOver:抽屉开着时按模态处理,不让焦点跑到被遮住的会话内容上。
      accessibilityViewIsModal={mounted}
      // mounted 期间恒拦截(含 200ms 关闭动画):此时 scrim 仍半透明盖着内容,放行
      // 点击会穿透误触;落在 scrim 上的点击只是幂等地再触发一次 onClose。
      pointerEvents="auto"
      style={styles.overlay}
      testID="sessionDrawer.overlay"
    >
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable
          accessibilityLabel={t('home.drawer.closeA11y')}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scrimPressable}
          testID="sessionDrawer.scrim"
        />
      </Animated.View>
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.panel,
            { paddingLeft: insets.left, paddingTop: insets.top + spacing.sm, width: panelWidth },
            panelStyle,
          ]}
          testID="sessionDrawer.panel"
        >
          <View style={styles.panelHeader}>
            <Text numberOfLines={1} style={styles.panelTitle} testID="sessionDrawer.title">
              {t('devices.list.allConversations')}
            </Text>
            <Pressable
              accessibilityLabel={t('devices.list.a11y.newRemoteConversation')}
              accessibilityRole="button"
              hitSlop={6}
              onPress={onNewSession}
              ref={newSessionButtonRef}
              style={({ pressed }) => [styles.panelIconButton, pressed && styles.pressed]}
              testID="sessionDrawer.newSession"
            >
              <SquarePen
                color={colors.textPrimary}
                size={iconSize.xl}
                strokeWidth={iconStroke.regular}
              />
            </Pressable>
          </View>
          <View style={styles.drawerSearchRow}>
            <HomeSearchBar
              autoFocus={false}
              filterA11y={searchFilterA11y}
              filterActive={indexedSearch.activeFilterCount > 0}
              onChangeQuery={indexedSearch.setQuery}
              onOpenFilter={() => setSearchFilterOpen(true)}
              padded={false}
              query={searchQuery}
              testIDs={{
                filter: 'sessionDrawer.searchFilterButton',
                input: 'sessionDrawer.searchInput',
                row: 'sessionDrawer.searchRow',
              }}
            />
          </View>
          {hasRows ? (
            <SectionList
              contentContainerStyle={styles.listContent}
              keyExtractor={(row) => row.key}
              keyboardShouldPersistTaps="handled"
              renderItem={renderRow}
              renderSectionHeader={({ section }) =>
                section.title ? (
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                ) : null
              }
              sections={sections}
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled={false}
              style={styles.list}
              testID="sessionDrawer.list"
            />
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>{t('home.drawer.empty')}</Text>
            </View>
          )}
          <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
            <Pressable
              accessibilityLabel={t('home.drawer.home')}
              accessibilityRole="button"
              onPress={onGoHome}
              style={({ pressed }) => [styles.footerRow, pressed && styles.pressed]}
              testID="sessionDrawer.home"
            >
              <House
                color={colors.textSecondary}
                size={iconSize.lg}
                strokeWidth={iconStroke.regular}
              />
              <Text style={styles.footerLabel}>{t('home.drawer.home')}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </GestureDetector>
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
        topOffset={insets.top + spacing.sm}
        visible={searchFilterOpen}
      />
    </View>
  );
}

const DrawerSessionRow = memo(function DrawerSessionRow({
  active,
  item,
  onSelect,
  searchResult,
}: {
  active: boolean;
  item: RemoteSessionListItem;
  onSelect(item: RemoteSessionListItem): void;
  searchResult: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 运行态走订阅(行 memo 化后命令式读取会 stale,与首页行同一取舍)。
  const sessionIsRunning = useSessionRunning(item.session.id);
  const loadedMessagePreview = useRemoteSessionMessagePreview(item.session.id);
  const running = sessionIsRunning || !!item.scheduleInfo?.running;
  const rightStatus = resolveMobileSessionRightStatus({
    liveAttention: item.liveActivity?.attention === true,
    livePhase: item.liveActivity?.phase,
    pendingInteractionCount: item.pendingInteractionCount,
    running,
    scheduleUnreadCount: item.scheduleInfo?.unreadCount ?? 0,
  });
  // 索引搜索展示命中摘要；普通行（含自动化代表行）才使用自己的最新消息预览。
  const preview = buildRemoteSessionCardPreview(
    searchResult || loadedMessagePreview === undefined || loadedMessagePreview === item.messagePreview
      ? item
      : { ...item, messagePreview: loadedMessagePreview },
    { running },
  );
  return (
    <Pressable
      accessibilityLabel={t('devices.list.a11y.openConversation', { title: item.title })}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => onSelect(item)}
      style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.pressed]}
      testID={`sessionDrawer.row.${item.session.id}`}
    >
      <View style={styles.rowTitleLine}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {item.title}
        </Text>
        {rightStatus === 'time' ? (
          <DrawerRelativeTime lastActivityAt={item.lastActivityAt} />
        ) : (
          <View style={styles.rowStatusCell}>
            {rightStatus === 'running' ? (
              <DrawerRowSpinner sessionId={item.session.id} />
            ) : (
              <View
                accessibilityLabel={
                  rightStatus === 'error'
                    ? t('devices.list.a11y.taskError')
                    : rightStatus === 'awaiting'
                      ? t('devices.list.a11y.awaitingYou')
                      : t('devices.list.a11y.doneUnread')
                }
                accessibilityRole="image"
                style={[
                  styles.rowStatusDot,
                  {
                    backgroundColor:
                      rightStatus === 'error'
                        ? colors.statusError
                        : rightStatus === 'awaiting'
                          ? colors.statusAwaiting
                          : colors.statusDone,
                  },
                ]}
                testID={`sessionDrawer.rowStatus.${rightStatus}.${item.session.id}`}
              />
            )}
          </View>
        )}
      </View>
      {preview?.trim() ? (
        <Text numberOfLines={1} style={styles.rowPreview}>
          {preview}
        </Text>
      ) : null}
    </Pressable>
  );
});

function DrawerRelativeTime({ lastActivityAt }: { lastActivityAt: string }) {
  const styles = useThemedStyles(makeStyles);
  useMinuteNow();
  return (
    <Text numberOfLines={1} style={styles.rowTime}>
      {formatRemoteSessionSidebarTime(lastActivityAt)}
    </Text>
  );
}

/** 与首页右槽同款:LoaderCircle 圆弧 1s 匀速旋转,中性色。 */
function DrawerRowSpinner({ sessionId }: { sessionId: string }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const reduceMotion = useReduceMotionEnabled();
  const turn = useSharedValue(0);
  const animate = reduceMotion === false;
  useEffect(() => {
    if (!animate) return;
    turn.value = 0;
    turn.value = withRepeat(
      // spinnerCycle 是功能性 loading 的语义循环档(§14.4 窄例外),匀速不走缓动曲线。
      withTiming(1, { duration: motionDuration.spinnerCycle, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(turn);
      turn.value = 0;
    };
  }, [animate, turn]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.value * 360}deg` }],
  }));
  return (
    <Animated.View
      accessibilityLabel={t('devices.list.a11y.running')}
      style={spinStyle}
      testID={`sessionDrawer.rowStatus.running.${sessionId}`}
    >
      <LoaderCircle
        color={colors.textTertiary}
        size={iconSize.md}
        strokeWidth={iconStroke.regular}
      />
    </Animated.View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFill,
      zIndex: 40,
    },
    scrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: colors.overlay,
    },
    scrimPressable: {
      flex: 1,
    },
    panel: {
      backgroundColor: colors.surface,
      borderRightColor: colors.border,
      borderRightWidth: StyleSheet.hairlineWidth,
      bottom: 0,
      left: 0,
      position: 'absolute',
      top: 0,
    },
    panelHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    drawerSearchRow: {
      alignItems: 'center',
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
    },
    drawerSearchInput: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      minWidth: 0,
      paddingVertical: spacing.xs,
    },
    panelTitle: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.title,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.subtitle,
    },
    // 38×38 与会话头图标钮同规格,热区经 hitSlop 补到 44。
    panelIconButton: {
      alignItems: 'center',
      borderRadius: radius.pill,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingBottom: spacing.lg,
      paddingHorizontal: spacing.sm,
    },
    sectionTitle: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.xs,
      paddingTop: spacing.md,
    },
    row: {
      borderRadius: radius.container,
      // 标题与预览行距 2pt 微调:xs(4) 会把双行行高撑过 56,列表密度掉档。
      gap: 2,
      // 无预览的单行任务行只有 42(22+20),minHeight 补足 44 触控底线;居中让单行不顶格。
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: spacing.sm,
      // sm+2 微调:凑出双行行高 ≈56 的触控行,md(12) 会松成 60+。
      paddingVertical: spacing.sm + 2,
    },
    rowActive: {
      backgroundColor: colors.surfaceChip,
    },
    rowTitleLine: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      minWidth: 0,
    },
    rowTitle: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
      minWidth: 0,
    },
    rowTime: {
      color: colors.textTertiary,
      flexShrink: 0,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    // 18×18 定位槽 + 10pt 状态点:与首页会话行右槽同规格(点/spinner 先居中同一槽再对齐)。
    rowStatusCell: {
      alignItems: 'center',
      flexShrink: 0,
      height: 18,
      justifyContent: 'center',
      width: 18,
    },
    rowStatusDot: {
      borderRadius: radius.pill,
      height: 10,
      width: 10,
    },
    rowPreview: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    emptyState: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
      padding: spacing.xl,
    },
    emptyStateText: {
      color: colors.textTertiary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      textAlign: 'center',
    },
    footer: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.sm,
    },
    footerRow: {
      alignItems: 'center',
      borderRadius: radius.container,
      flexDirection: 'row',
      gap: spacing.sm,
      // 主操作行触控目标 >=44(iOS HIG):内容 22 + padV 16 只有 38,minHeight 补足。
      minHeight: 44,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    footerLabel: {
      color: colors.textSecondary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    pressed: {
      opacity: 0.72,
    },
  });
