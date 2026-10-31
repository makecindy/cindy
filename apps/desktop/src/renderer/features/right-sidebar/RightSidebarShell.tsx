/**
 * RightSidebarShell —— 右侧栏内容容器(TabBar + TabBody),挂在外壳 aside 之内。
 *
 * Phase 3 切换:渲染从 placeholder 改为 **plugin registry 驱动** ——
 *   - 每个 tab 通过 `getTabKind(kind).TabBody` 渲染对应 plugin 内容;
 *   - 多 tab 同时挂载,仅靠 CSS `hidden` 切换可见性(对齐 TabKindPlugin 接口注释
 *     "display:none 切换可见性,不卸载"),避免切顶层 tab 时 webview/编辑器 state
 *     丢失或重新挂载抖动;
 *   - plugin TabBody 收 `{ state, ctx }`,ctx 内 `patchState` 走 store.patchTabState
 *     乐观更新 + IPC 持久化;`workdir` 由 host(MainLayout)推上来。
 *
 * Phase 3 同步:Shell 顶层 import `./plugins`,触发各 plugin 的 import-side-effect
 * 注册(`registerTabKind`)。后续新 plugin 只需在 plugins/index.ts 加一行 import。
 *
 * Phase 2 简化保留:错误打日志、所有 IPC 失败本地回滚 + log;Phase 7 已收尾:添加失败按错误码 toast 统一暴露(见 handleAdd)。
 *
 * sessionId / workdir 由 host 透:
 *   - sessionId 为 null = 不在 cc-agent 路由,Shell 渲染空状态,store 不工作;
 *   - workdir 为空串 = remote session 或还没解析,plugin 自行降级渲染占位。
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { CINDY_MAKE_ENABLED } from '@cindy/maker-shared/cindy-make-feature';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { RightSidebarDetach } from '@/components/layout/RightSidebarDetach';
import { RightSidebarMaximize } from '@/components/layout/RightSidebarMaximize';
import { RightSidebarToggle } from '@/components/layout/RightSidebarToggle';
import { CHROME_ACTIONS_GEOMETRY } from '@/components/layout/chromeActionsGeometry';
import { TabBar, TabStrip, TabTitleLabel, type PopoutWindowOption } from './TabBar';
import { EmptyState } from './EmptyState';
import { getTabKind, hydrateTabState } from './registry';
import {
  addOrFocusSingletonTab,
  addTab,
  closeTab,
  ensureHydrated,
  getBucket,
  patchTabState,
  reorderTabs,
  setActiveTab,
  setTabCloseInterceptor,
  subscribe,
} from './store';
import type { TabKindHostContext, TabKindId, TabState } from './types';
// Side-effect import:触发各 plugin 模块顶层 registerTabKind(...)。Phase 3 注册
// file-browser;Phase 5 注册 web-browser。Shell 不直接消费 plugin 实例,只通过
// getTabKind 查 registry。
import './plugins';
import { initRsbBrowserBridge } from './lib/rsbBrowserBridge';
import { initPopupRouter, setPopupFallbackSession } from './lib/popupRouter';
import { TabBodyErrorBoundary } from './TabBodyErrorBoundary';
import { useRetainedBrowserTabHosts } from './hooks/useRetainedBrowserTabHosts';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { useTabCreationMenu } from './lib/useTabCreationMenu';
import {
  isTabPoppedOut,
  summarizeSidebarTabWindows,
  useSidebarTabWindowsState,
} from '@/lib/sidebarTabWindowState';
import {
  isGlobalTabId,
  removeGlobalTab,
  setActiveGlobalTabId,
  subscribeRevealSessionTab,
  useActiveGlobalTabId,
  useGlobalTabs,
} from './globalTabs';
import {
  buildTabAvailabilities,
  mergeAvailableTabOrder,
  projectAvailableTabs,
} from './tabAvailability';
import { moveTabToGroup } from './moveTab';
import {
  DEFAULT_TAB_GROUP,
  getGroupActiveTabId,
  setGroupActiveTabId,
  tabGroupOf,
  subscribeTabGroups,
  useTabGroupAssignments,
  type TabGroupId,
} from './tabGroups';

const log = createLogger('rightSidebar.shell');
/** 组内激活记忆的订阅(与组归属同一个通知源)。 */
const subscribeGroupActive = (cb: () => void) => subscribeTabGroups(cb);
const EMPTY_TAB_ID_SET = new Set<string>();

// helpers
/** 已挂载页签里属于全局页签的那部分:全局页签跨任务存活,任务页签跟任务走。 */
function selectPinnedTabIds(
  tabIds: ReadonlySet<string>,
  pinnedTabIds: ReadonlySet<string>,
): Set<string> {
  return new Set([...tabIds].filter((tabId) => pinnedTabIds.has(tabId)));
}
/**
 * Mac 合并顶栏右端 spacer 宽度，对应 MainLayout 固定唤起按钮：28px 按钮 + 8px 右距。
 * detach / maximize / 收起均属于面板自身，直接渲染在本顶栏中。
 */
const MAC_HEADER_ACTION_SPACER_PX = 36;
type RightTabDirection = 'prev' | 'next';

interface RightSidebarShellProps {
  /**
   * 本 Shell 承载哪个页签组(见 tabGroups.ts):只投影归属该组的页签。缺省右侧组
   * (历史右侧栏);左 / 上 / 下边组由 TabGroupPanel 传入。弹出窗口(hostedTabIds)不分组。
   */
  groupId?: TabGroupId;
  /**
   * 当前 cc-agent session id;由 MainLayout 透传(CCAgentSessionView ownsRoute 时声明)。
   * null = 尚无激活会话(或不在 cc-agent 路由),store 不工作,Shell 渲染空状态。
   */
  sessionId: string | null;
  /**
   * 当前 cc-agent session 的 workingDir;空串 = remote session 或尚未解析,plugin 自行渲染占位。
   * file-browser plugin 据此驱动文件树 / 内容预览。
   */
  workdir: string;
  /** 非空 = SSH remote 会话(workdir 为远端路径);见 TabKindHostContext.remoteHostId。 */
  remoteHostId: string | null;
  /** device-link 会话归属：null = 已确认本机，undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  /** Pi-only product gate for Subagents navigation and detail rendering. */
  subagentsAvailable?: boolean;
  /** RightSidebar aside 当前是否真实展开。折叠时 keep-alive body 仍挂载但不可见。 */
  shellVisible?: boolean;
  isMac: boolean;
  /**
   * 主窗口 Mac 内嵌形态专用:true 时 Shell 顶部渲染 46px 合并顶栏(#650 起随全局 chrome 行高 50→46)(TabStrip +
   * 右端浮层按钮让位 spacer),不再渲染 36px TabBar 行。detached 子窗口
   * (SidebarWindowLayout)**不传**此项 —— 子窗口有自己的 46px chrome,Shell
   * 维持旧 TabBar 行为(本期子窗口零改动)。
   */
  unifiedTopbar?: boolean;
  onCloseSidebar?: () => void;
  /** Windows 内嵌展开态的固定唤起入口；Mac 由 MainLayout 窗口级浮层承载。 */
  onShowSidebar?: () => void;
  onMaximize?: () => void;
  /** maximize 态 — 用来让 TabBar 把 maximize 按钮换图标(Maximize2 ↔ Minimize2)。 */
  isMaximized?: boolean;
  /**
   * 主窗口左栏完全收起且当前面板 maximize 时，右栏 unified topbar 需要为
   * MainLayout 的浮动 ChromeActions 预留左侧 no-drag 占位；普通右栏/rail/独立
   * 子窗口不应消费这段空间。
   */
  reserveLeftChromeActions?: boolean;
  /** 工具面板处于最左 rail 邻位时，顶栏为浮动 ChromeActions 挖 no-drag 命中区并预留布局空间。 */
  railChromeActionsHitHole?: boolean;
  /**
   * 「在独立窗口中打开」页签:主窗侧栏继续存在,只把该页签弹出到自己的窗口;带
   * targetWindowId 时搬进已有的弹出窗口。顶栏按钮作用于当前激活页签(没有激活页签时
   * 不渲染);页签右键菜单作用于被点的页签。弹出窗口(hostedTabIds 形态)与会话副窗不传。
   */
  onDetachTab?: (tabId: string, targetWindowId?: string) => void;
  /**
   * 页签独立窗口形态:Shell 只投影并挂载 main 指派给本窗口的这些页签(不分组),
   * 激活位只在本窗口内存里,不写任务桶,也不向 main 上报「活跃侧栏会话」(主窗仍是
   * 侧栏宿主权威)。页签全部从桶里消失后 Shell 渲染为空,由 SidebarTabWindowLayout 关窗。
   */
  hostedTabIds?: ReadonlySet<string>;
  /** 独立窗口形态:右键菜单「合并回侧边栏」作用于被点的页签。 */
  onMergeBackTab?: (tabId: string) => void;
  /** 独立窗口形态:本窗口里经「+」新建的页签(乐观插入那一刻回调),宿主拿去收编。 */
  onTabCreated?: (tabId: string) => void;
  /** 当前激活页签变化(独立窗口的 ⌘W / 合并按钮要知道作用于谁)。 */
  onActiveTabChange?: (tabId: string | null) => void;
  /** 合并顶栏首 / 尾插槽(独立窗口的红绿灯让位、合并按钮与窗口控件)。 */
  topbarLeading?: ReactNode;
  topbarTrailing?: ReactNode;
  /** TabBar 横带是否作为窗口拖拽区(见 TabBar 同名 prop):主窗口内嵌形态传
   *  false(空白处 = 拖面板手势面);detached 子窗口不传,默认 true。 */
  chromeWindowDrag?: boolean;
  /** M2(mac 交换态):面板当前贴哪条边。'left' 且非 maximize 时合并顶栏右端
   *  渲染真按钮(detach + maximize,面板自属控件跟面板走;折叠 toggle 恒在
   *  MainLayout 窗口右上浮层,不下沉进面板);'right'(默认)与 maximize 撑满态
   *  维持浮层 + 让位 spacer。仅 mac unifiedTopbar 形态消费。 */
  panelSide?: 'left' | 'right';
  /**
   * 本 session 的 tab 数从 >0 变为 0(用户关掉最后一个 tab)时回调一次。
   * host(MainLayout)据此自动收起右侧栏。只在「关闭动作」触发 —— 展开一个本就
   * 无 tab 的 session 不会触发(见下方 effect 的 prev>0 判据)。detached 子窗口不传。
   */
  onAllTabsClosed?: () => void;
}

export function RightSidebarShell({
  groupId = DEFAULT_TAB_GROUP,
  sessionId,
  workdir,
  remoteHostId,
  deviceLinkDeviceId,
  subagentsAvailable,
  shellVisible = true,
  isMac,
  unifiedTopbar = false,
  onCloseSidebar,
  onShowSidebar,
  onMaximize,
  isMaximized,
  onDetachTab,
  hostedTabIds,
  onMergeBackTab,
  onTabCreated,
  onActiveTabChange,
  topbarLeading,
  topbarTrailing,
  chromeWindowDrag = true,
  panelSide = 'right',
  onAllTabsClosed,
  reserveLeftChromeActions = false,
  railChromeActionsHitHole = false,
}: RightSidebarShellProps) {
  const soloMode = hostedTabIds !== undefined;
  /** 右侧组是页签系统的"主组":任务级的激活位对账、快捷键、浏览器桥的活跃会话上报只由它做。 */
  const isPrimaryGroup = groupId === DEFAULT_TAB_GROUP && !soloMode;
  const { isFullscreen } = useMacFullscreen();
  const chromeActionsLeft =
    isMac && !isFullscreen
      ? CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft
      : CHROME_ACTIONS_GEOMETRY.defaultLeft;
  // unifiedTopbar 本身有 px-2(8px) 左内边距。加上 chromeActionsLeft 后，
  // spacer 的布局起点正好落在 ChromeActions 簇之前，并在簇后保留 8px 呼吸间距。
  const leftChromeActionsSpacerWidth =
    unifiedTopbar && reserveLeftChromeActions
      ? chromeActionsLeft + CHROME_ACTIONS_GEOMETRY.clusterWidth
      : 0;
  // rail 邻位时浮动 ChromeActions 从工具面板左缘开始。命中洞保持 absolute
  // 对齐窗口坐标；另加正常流中的 spacer，把 TabStrip 推到按钮簇之后。
  const railChromeActionsSpacerWidth =
    unifiedTopbar && !isFullscreen && railChromeActionsHitHole
      ? CHROME_ACTIONS_GEOMETRY.clusterWidth
      : 0;
  const { t } = useTranslation();
  const installedGhosts = useInstalledGhosts();
  // 已弹出到独立窗口的页签:数据留在桶里,但本 Shell 不投影、不挂 body。
  // 弹出窗口自身(soloMode)反过来只投影 main 指派给它承载的那几个。
  const poppedOutTabs = useSidebarTabWindowsState();

  // RSB browser bridge (Phase 2):在 Shell 整个生命周期内只 init 一次。bridge 内部
  // 自带 idempotent guard,strict-mode 双 effect / 重复挂载都安全。bridge 绑定
  // pool.onRelease → main(LRU 淘汰 / 显式关 tab 同步清理 main 端 TabRegistry),
  // 以及 main → pool 的 automation pin 同步。teardown 不在这里调 —— bridge 是
  // 单例,Shell unmount(切 RSB / 切 session)不应解绑,否则 LRU 淘汰那条同步链
  // 就断了。Shell 真的退出场景在 app quit,进程整体下线无所谓。
  useEffect(() => {
    initRsbBrowserBridge();
  }, []);

  // 订阅当前 sessionId 桶变化 —— useSyncExternalStore 在 sessionId 变化时,
  // 当次 render 就同步拿到新桶(cache miss 返回 EMPTY_BUCKET 单例,下面 hydrated
  // 判断渲染占位);避免老 useState+effect 模式下"切到新 session 第一帧仍看到
  // 旧 session tabs"的视觉跳变(规则 7)。
  //
  // getBucket cache miss 必须返回稳定 reference(EMPTY_BUCKET 单例),否则 React
  // 用 Object.is 比对 snapshot 时报警告 / 无限重渲染 —— 见 store.ts。
  const subscribeBucket = useCallback(
    (onChange: () => void) =>
      subscribe((changedSessionId) => {
        if (changedSessionId === sessionId) onChange();
      }),
    [sessionId],
  );
  const getBucketSnapshot = useCallback(() => getBucket(sessionId), [sessionId]);
  const bucket = useSyncExternalStore(subscribeBucket, getBucketSnapshot);
  // 全局页签(不跟对话):在所有任务里都在场,切任务留在原位;与任务页签一起投影。
  const globalTabs = useGlobalTabs();
  const activeGlobalTabId = useActiveGlobalTabId();
  const groupAssignments = useTabGroupAssignments();
  const groupActiveVersion = useSyncExternalStore(
    subscribeGroupActive,
    () => getGroupActiveTabId(groupId, sessionId),
  );
  // 没有任务(sessionId=null)时任务桶不存在,但全局页签照常可展示——弹出窗口里
  // 承载全局页签就是这种形态。
  const contentReady = bucket.hydrated || sessionId === null;
  const hiddenTabIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (hostedTabIds) {
      return new Set(
        [...globalTabs, ...bucket.tabs].map((tab) => tab.id).filter((id) => !hostedTabIds.has(id)),
      );
    }
    const ids = Object.keys(poppedOutTabs);
    return ids.length > 0 ? new Set(ids) : undefined;
  }, [bucket.tabs, globalTabs, hostedTabIds, poppedOutTabs]);
  const previousShellVisibleRef = useRef(shellVisible);
  const subagentsEligibilityKnown = typeof subagentsAvailable === 'boolean';
  const subagentsEnabled = subagentsAvailable === true;

  useEffect(() => {
    // Phase 5: 推送当前焦点 RSB sessionId 给 main,让 RsbWebviewBackend 拿到。
    // null 也推(切到非 RSB 路由时),让 main 端清掉 active session — 否则
    // 之前的 sessionId 会成 stale 引用。隐藏的分离窗口只是预热/待命实例，不能
    // 覆盖主窗口当前的浏览器 session。setActiveSession 失败容错(preload 未就绪)。
    // 单页签独立窗口不是侧栏宿主,不上报(主窗仍是「活跃侧栏会话」权威);边组同理。
    if (soloMode || !isPrimaryGroup) {
      // no-op
    } else if (shellVisible) {
      void window.electronAPI?.rsbBrowserBridge
        ?.setActiveSession({ sessionId })
        .catch(() => undefined);
    } else if (previousShellVisibleRef.current) {
      void window.electronAPI?.rsbBrowserBridge
        ?.setActiveSession({ sessionId: null })
        .catch(() => undefined);
    }
    previousShellVisibleRef.current = shellVisible;
    if (!sessionId) return;
    // 首次访问该 sessionId 时触发 IPC list 拉取;命中 cache 直接 noop。
    // 完成后 setBucket → notify → subscribeBucket 唤醒 useSyncExternalStore 重渲染。
    void ensureHydrated(sessionId).catch((err) => {
      log.error('ensureHydrated failed', { sessionId, err });
    });
  }, [isPrimaryGroup, sessionId, shellVisible, soloMode]);

  // Subagents eligibility is tri-state: `undefined` while the session row is
  // still loading, then true/false once the harness is known. Folding unknown
  // into "unavailable" would filter a *persisted* active Subagents tab out of
  // the projection, and the active-tab reconciliation below would immediately
  // persist a different tab (or null) as active — the user's selection is gone
  // by the time eligibility resolves to true. Keep the tab projected while
  // unknown and only converge once we actually know.
  // 可用性口径与页签组在场判定(tabGroupPanes)同源:两边必须对"哪些页签可见"
  // 给出同一答案,否则会出现有组无页签的空壳。
  const availabilities = useMemo(
    () =>
      buildTabAvailabilities({
        installedGhosts,
        remoteHostId,
        deviceLinkDeviceId,
        subagentsAvailable,
        hiddenTabIds,
      }),
    [deviceLinkDeviceId, hiddenTabIds, installedGhosts, remoteHostId, subagentsAvailable],
  );
  const tabAvailability = availabilities.session;
  // 整个任务的可见页签投影(所有组):任务级激活位对账用它,不受本组过滤影响。
  const projectedTabs = useMemo(
    () => projectAvailableTabs(bucket.tabs, bucket.activeTabId, tabAvailability),
    [bucket.activeTabId, bucket.tabs, tabAvailability],
  );
  const allPinnedTabs = useMemo(
    () => projectAvailableTabs(globalTabs, null, availabilities.global).tabs,
    [availabilities.global, globalTabs],
  );
  /** 页签是否归本 Shell 的组:弹出窗口不分组(它只投影被指派的那一个)。 */
  const inGroup = useCallback(
    (tabId: string) => soloMode || tabGroupOf(groupAssignments, tabId) === groupId,
    [groupAssignments, groupId, soloMode],
  );
  const pinnedTabs = useMemo(
    () => allPinnedTabs.filter((tab) => inGroup(tab.id)),
    [allPinnedTabs, inGroup],
  );
  const sessionTabs = useMemo(
    () => projectedTabs.tabs.filter((tab) => inGroup(tab.id)),
    [inGroup, projectedTabs.tabs],
  );
  const sessionActiveTabId = projectedTabs.activeTabId;
  /** 本组可见页签 = 归本组的全局页签(钉在前) + 归本组的当前任务页签。 */
  const tabs = useMemo(() => [...pinnedTabs, ...sessionTabs], [pinnedTabs, sessionTabs]);
  // 激活位:用户选中的全局页签优先并跨任务保持;否则是任务自己的激活页签(在本组时);
  // 本组不含任务级激活页签时用组内上次选中的;再没有就落到第一个页签。
  const groupRememberedActiveId = groupActiveVersion;
  // 独立窗口:激活位只在本窗口内存里(不写任务桶、不碰主窗的全局激活位)。
  const [hostedActiveTabId, setHostedActiveTabId] = useState<string | null>(null);
  const activeTabId = soloMode
    ? hostedActiveTabId && tabs.some((tab) => tab.id === hostedActiveTabId)
      ? hostedActiveTabId
      : (tabs.at(-1)?.id ?? null)
    : activeGlobalTabId && pinnedTabs.some((tab) => tab.id === activeGlobalTabId)
      ? activeGlobalTabId
      : sessionActiveTabId && sessionTabs.some((tab) => tab.id === sessionActiveTabId)
        ? sessionActiveTabId
        : groupRememberedActiveId && tabs.some((tab) => tab.id === groupRememberedActiveId)
          ? groupRememberedActiveId
          : (sessionTabs[0]?.id ?? pinnedTabs[0]?.id ?? null);

  useEffect(() => {
    onActiveTabChange?.(activeTabId);
  }, [activeTabId, onActiveTabChange]);

  // 首帧只挂当前激活 tab。其余 tab 在浏览器空闲期逐个补挂载，随后继续按原有
  // keep-alive 语义保留组件 / webview / 编辑器状态。这样恢复一个多 tab 会话时，
  // 非当前面板不会与窗口首帧、presentation-ready 握手争抢主线程。
  const [deferredMountState, setDeferredMountState] = useState<{
    sessionId: string | null;
    tabIds: Set<string>;
  }>(() => ({ sessionId: null, tabIds: new Set() }));
  const pinnedTabIds = useMemo(() => new Set(pinnedTabs.map((tab) => tab.id)), [pinnedTabs]);
  // 全局页签(webview 持有插件的页面状态)一旦挂载就不因任务变化卸载,所以换任务的这一帧
  // 也要保住它们——effect 来不及:它在 commit 之后才把状态换成新任务,而这一帧的 render
  // 已经决定了谁被卸载。任务页签仍按新任务重新计。
  const deferredMountedTabIds = useMemo(() => {
    if (deferredMountState.sessionId === sessionId) return deferredMountState.tabIds;
    const kept = selectPinnedTabIds(deferredMountState.tabIds, pinnedTabIds);
    return kept.size > 0 ? kept : EMPTY_TAB_ID_SET;
  }, [deferredMountState, pinnedTabIds, sessionId]);

  useEffect(() => {
    setDeferredMountState((previous) => {
      if (previous.sessionId !== sessionId) {
        const tabIds = selectPinnedTabIds(previous.tabIds, pinnedTabIds);
        if (activeTabId) tabIds.add(activeTabId);
        return { sessionId, tabIds };
      }
      if (!activeTabId || previous.tabIds.has(activeTabId)) return previous;
      const next = new Set(previous.tabIds);
      next.add(activeTabId);
      return { sessionId, tabIds: next };
    });
  }, [activeTabId, pinnedTabIds, sessionId]);

  useEffect(() => {
    if (!bucket.hydrated || !sessionId) return;
    const pendingTabIds = tabs
      .map((tab) => tab.id)
      .filter((tabId) => tabId !== activeTabId && !deferredMountedTabIds.has(tabId));
    if (pendingTabIds.length === 0) return;

    let cancelled = false;
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let nextIndex = 0;
    const scheduleNext = () => {
      if (cancelled || nextIndex >= pendingTabIds.length) return;
      const mountNext = () => {
        if (cancelled) return;
        const tabId = pendingTabIds[nextIndex++];
        setDeferredMountState((previous) => {
          if (previous.sessionId !== sessionId || previous.tabIds.has(tabId)) return previous;
          const next = new Set(previous.tabIds);
          next.add(tabId);
          return { sessionId, tabIds: next };
        });
        scheduleNext();
      };
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(mountNext, { timeout: 1000 });
      } else {
        timeoutId = setTimeout(mountNext, 32);
      }
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [activeTabId, bucket.hydrated, deferredMountedTabIds, sessionId, tabs]);

  // If an unavailable tab owned the active marker, move the persisted marker
  // to a visible tab (or null), while preserving the hidden tab state.
  //
  // Never write while Subagents eligibility is still unknown: the projection is
  // provisional during that window, so converging it would persist a decision
  // taken from incomplete information and destroy the restored selection.
  useEffect(() => {
    // 单页签独立窗口不写激活位:它只投影自己承载的页签,激活位归主窗侧栏管。
    // 边组也不写:任务级激活位是整个任务(所有组)的对账,只由右侧组做一次。
    if (soloMode || !isPrimaryGroup || !subagentsEligibilityKnown) return;
    if (!bucket.hydrated || !sessionId || bucket.activeTabId === sessionActiveTabId) return;
    void setActiveTab(sessionId, sessionActiveTabId).catch((err) => {
      log.error('unavailable active-tab reconciliation failed', {
        sessionId,
        activeTabId: sessionActiveTabId,
        err,
      });
    });
  }, [
    sessionActiveTabId,
    bucket.activeTabId,
    bucket.hydrated,
    isPrimaryGroup,
    sessionId,
    soloMode,
    subagentsEligibilityKnown,
  ]);

  const prevTabCountRef = useRef<number | null>(null);
  useEffect(() => {
    prevTabCountRef.current = null;
  }, [sessionId]);

  // A bucket containing only unavailable product surfaces must not leave an
  // empty public sidebar open. Preserve hidden state for later eligibility.
  const hiddenOnlyCollapseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shellVisible) {
      hiddenOnlyCollapseRef.current = null;
      return;
    }
    const shouldCollapse =
      bucket.hydrated &&
      bucket.tabs.length > 0 &&
      tabs.length === 0 &&
      prevTabCountRef.current === null;
    if (!shouldCollapse || !sessionId) {
      hiddenOnlyCollapseRef.current = null;
      return;
    }
    if (hiddenOnlyCollapseRef.current === sessionId) return;
    hiddenOnlyCollapseRef.current = sessionId;
    onAllTabsClosed?.();
  }, [
    bucket.hydrated,
    bucket.tabs,
    onAllTabsClosed,
    sessionId,
    shellVisible,
    tabs.length,
  ]);

  // 面板收束后不再注册的历史页签在 hydration 后静默关闭，避免显示死页签。
  // `ghost:*`、`bot-delegations`、`bot-artifacts` 和 `bot-workbench`(伙伴工作台已并入聊天头部
  // 的近况浮层)只作为数据库历史值保留。
  // 这些 kind 已无渲染方,
  // 留着只会落到 PlaceholderBody 变成"敬请期待"的死页签。
  useEffect(() => {
    if (soloMode || !isPrimaryGroup || !bucket.hydrated || !sessionId) return;
    const legacyGhostTabs = bucket.tabs.filter((tab) =>
      tab.kind.startsWith('ghost:') ||
      tab.kind === ('bot-delegations' as TabKindId) ||
      tab.kind === ('bot-artifacts' as TabKindId) ||
      tab.kind === ('bot-workbench' as TabKindId),
    );
    if (legacyGhostTabs.length === 0) return;
    void (async () => {
      for (const tab of legacyGhostTabs) {
        try {
          await closeTab(sessionId, tab.id);
        } catch (err) {
          log.error('legacy ghost tab prune failed', { sessionId, tabId: tab.id, err });
        }
      }
    })();
  }, [bucket.hydrated, bucket.tabs, isPrimaryGroup, sessionId, soloMode]);

  // 关掉最后一个 tab → 通知 host 自动收起侧栏。只在 tab 数「从 >0 变 0」的转变时
  // 触发,不是"等于 0"就触发:
  //   - hydrated 后首帧 prev===null 不触发(区分"刚加载出来就是空"与"关到空");
  //   - 展开一个本就 0-tab 的 session 也不会被立刻折叠,用户仍能在 EmptyState 加 tab。
  // sessionId 变化时重置计数,避免"切到一个空 session"被误判成"关空"。
  // 全局页签计入可见页签数:有全局页签在场时侧栏不会因任务页签关空而自动收起。
  useEffect(() => {
    if (!contentReady) return; // 未 hydrate 的空数组不算"关空"
    const prev = prevTabCountRef.current;
    prevTabCountRef.current = tabs.length;
    if (prev !== null && prev > 0 && tabs.length === 0) {
      onAllTabsClosed?.();
    }
  }, [contentReady, tabs.length, onAllTabsClosed]);

  const handleAdd = useCallback(
    (kind: TabKindId) => {
      if (kind === 'cindy-make' && !CINDY_MAKE_ENABLED) {
        log.warn('handleAdd ignored: Cindy Make is disabled');
        return;
      }
      if (!sessionId) {
        log.warn('handleAdd ignored: sessionId is null', { kind });
        return;
      }

      if (kind === 'subagents' && !subagentsEnabled) {
        log.warn('handleAdd ignored: Subagents surface is unavailable for this harness');
        return;
      }
      const plugin = getTabKind(kind);
      // Plugin 未注册的 kind(早期 Phase 还没接的 web-browser / terminal):
      // 仍允许建 tab,但 TabBody 会落到 PlaceholderBody。用户体感上点了「+」总有
      // 反馈,只是看到"敬请期待"而不是"无变化"。
      const initialState = plugin ? plugin.defaultState() : null;
      // 单例 kind(当前仅 review)走 addOrFocusSingletonTab:已存在则切到现有,
      // 否则正常 addTab。menu meta 的 singleton 字段是数据来源,目前只有 review。
      const isSingleton = plugin?.menu?.singleton === true;
      // 独立窗口:本窗口已承载该单例页签时直接切过去(窗口的激活位只在本地,走任务桶的
      // 聚焦路径不会更新它,菜单里的「已打开」就成了无响应)。
      if (soloMode && isSingleton) {
        const existing = tabs.find((tab) => tab.kind === kind);
        if (existing) {
          setHostedActiveTabId(existing.id);
          return;
        }
      }
      // 边组里点「+」:新页签直接落在本组(乐观插入那一帧就带着组归属,不闪过右侧栏)。
      // 独立窗口里点「+」:乐观插入那一刻交给宿主收编(登记为本窗口承载)。
      const addOpts = soloMode
        ? {
            onOptimisticAdd: (tabId: string) => {
              setHostedActiveTabId(tabId);
              onTabCreated?.(tabId);
            },
          }
        : isPrimaryGroup
          ? undefined
          : { groupId };
      const action = isSingleton
        ? addOrFocusSingletonTab(sessionId, kind, initialState, addOpts)
        : addTab(sessionId, kind, initialState, addOpts);
      void action.catch((err) => {
        // 按错误码 toast:专属文案挂在全局 ipcError 命名空间(RIGHT_SIDEBAR_*),其余错误落通用 addFailed 兜底。
        toast.error(
          t(
            mapIpcErrorToI18nKey(err, {
              fallback: 'rightSidebar.tabs.addFailed',
            }),
          ),
        );
        log.error('handleAdd failed', { sessionId, kind, err });
      });
    },
    [groupId, isPrimaryGroup, onTabCreated, sessionId, soloMode, subagentsEnabled, t, tabs],
  );

  // 独立窗口里「+」菜单选了插件页签:新加的交给宿主收编;已打开的——本窗口承载就切过去,
  // 在别的弹出窗口里就聚焦那扇窗口,在主窗侧栏里就收编进本窗口(主窗据弹出镜像把它隐藏)。
  const handleGlobalTabSelected = useCallback(
    (tabId: string, existed: boolean) => {
      if (existed && tabs.some((tab) => tab.id === tabId)) {
        setHostedActiveTabId(tabId);
        return;
      }
      if (existed && isTabPoppedOut(tabId)) {
        void window.electronAPI?.sidebarTabWindow
          ?.focus(tabId)
          .catch((err) => log.warn('focus plugin tab window failed', { tabId, err }));
        return;
      }
      setHostedActiveTabId(tabId);
      onTabCreated?.(tabId);
    },
    [onTabCreated, tabs],
  );

  const creationMenu = useTabCreationMenu({
    sessionId, subagentsAvailable: subagentsEnabled, onSelect: handleAdd,
    sideChatPlacement: soloMode
      ? { onOptimisticAdd: (tabId) => { setHostedActiveTabId(tabId); onTabCreated?.(tabId); } }
      : isPrimaryGroup ? undefined : { groupId },
  });

  const handleClose = useCallback(
    (tabId: string) => {
      // 全局页签的关闭是全局动作(所有任务里一起消失),不进任务桶。
      if (isGlobalTabId(tabId)) {
        removeGlobalTab(tabId);
        return;
      }
      if (!sessionId) return;
      void closeTab(sessionId, tabId).catch((err) => {
        log.error('handleClose failed', { sessionId, tabId, err });
      });
    },
    [sessionId],
  );

  const handleActivate = useCallback(
    (tabId: string) => {
      if (soloMode) {
        setHostedActiveTabId(tabId);
        return;
      }
      setGroupActiveTabId(groupId, sessionId, tabId);
      if (isGlobalTabId(tabId)) {
        setActiveGlobalTabId(tabId);
        return;
      }
      // 选中本组的任务页签 = 离开本组里的全局页签(别的组里的全局页签不受影响);
      // 任务自己的激活位照常落库。
      const activeGlobal = activeGlobalTabId;
      if (activeGlobal && pinnedTabs.some((tab) => tab.id === activeGlobal)) {
        setActiveGlobalTabId(null);
      }
      if (!sessionId) return;
      void setActiveTab(sessionId, tabId).catch((err) => {
        log.error('handleActivate failed', { sessionId, tabId, err });
      });
    },
    [activeGlobalTabId, groupId, pinnedTabs, sessionId, soloMode],
  );

  // 程序打开的任务页签(插件任务页)要露出来:与用户点选同口径离开本组的全局页签。
  const revealContextRef = useRef({ activeGlobalTabId, inGroup, pinnedTabs, hostedTabIds });
  revealContextRef.current = { activeGlobalTabId, inGroup, pinnedTabs, hostedTabIds };
  useEffect(() => {
    if (!sessionId) return undefined;
    return subscribeRevealSessionTab((targetSessionId, tabId) => {
      if (targetSessionId !== sessionId) return;
      const context = revealContextRef.current;
      if (soloMode) {
        if (context.hostedTabIds?.has(tabId)) setHostedActiveTabId(tabId);
        return;
      }
      // 与页签投影共用弹出归属镜像;不要依赖尚未重渲染的新页签列表。
      if (!context.inGroup(tabId) || isTabPoppedOut(tabId)) return;
      setGroupActiveTabId(groupId, sessionId, tabId);
      const activeGlobal = context.activeGlobalTabId;
      if (activeGlobal && context.pinnedTabs.some((tab) => tab.id === activeGlobal)) {
        setActiveGlobalTabId(null);
      }
    });
  }, [groupId, sessionId, soloMode]);

  // 主窗:已弹出的页签窗口(同任务或只有全局页签的),右键菜单「移到窗口 …」的目标。
  // 标签用窗口里第一个页签的标题(插件的 TabPillTitle 组件,不是字符串)。
  const popoutWindows = useMemo<PopoutWindowOption[] | undefined>(() => {
    if (soloMode || !onDetachTab) return undefined;
    const options: PopoutWindowOption[] = [];
    for (const summary of summarizeSidebarTabWindows(poppedOutTabs)) {
      if (summary.sessionId !== null && summary.sessionId !== sessionId) continue;
      const firstTab =
        bucket.tabs.find((tab) => summary.tabIds.includes(tab.id)) ??
        globalTabs.find((tab) => summary.tabIds.includes(tab.id));
      if (!firstTab) continue;
      options.push({
        windowId: summary.windowId,
        label: <TabTitleLabel tab={firstTab} sessionId={sessionId} />,
      });
    }
    return options.length > 0 ? options : undefined;
  }, [bucket.tabs, globalTabs, onDetachTab, poppedOutTabs, sessionId, soloMode]);

  // 右键菜单「移到 …」:改组归属,目标组里立刻选中它;组 pane 的出现 / 隐藏由
  // tabGroupPanes 按在场判定处理。
  const handleMoveTab = useCallback(
    (tabId: string, target: TabGroupId) => {
      if (target !== groupId) moveTabToGroup(tabId, target, sessionId);
    },
    [groupId, sessionId],
  );

  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      if (!sessionId) return;
      // 只重排本组可见的页签:别的组的页签当作"不可见槽位"原位保留。
      const hidden = new Set(tabAvailability.hiddenTabIds ?? []);
      for (const tab of bucket.tabs) if (!inGroup(tab.id)) hidden.add(tab.id);
      const fullOrder = mergeAvailableTabOrder(bucket.tabs, orderedIds, {
        ...tabAvailability,
        hiddenTabIds: hidden,
      });
      void reorderTabs(sessionId, fullOrder).catch((err) => {
        log.error('handleReorder failed', { sessionId, orderedIds, err });
      });
    },
    [bucket.tabs, inGroup, sessionId, tabAvailability],
  );

  const handleCycleTab = useCallback(
    (direction: RightTabDirection): boolean => {
      // 独立页签窗口的激活位只在窗口本地,只有全局页签的窗口没有任务也要能切。
      if (!sessionId && !soloMode) return false;
      // 右侧栏存在但折叠 / 单 tab 时按键语义是 no-op,仍需消费以免漏给系统菜单。
      if (!shellVisible || tabs.length < 2) return true;
      const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      const nextIndex =
        activeIndex < 0
          ? direction === 'next'
            ? 0
            : tabs.length - 1
          : (activeIndex + (direction === 'next' ? 1 : -1) + tabs.length) % tabs.length;
      const nextTabId = tabs[nextIndex]?.id;
      if (!nextTabId || nextTabId === activeTabId) return false;
      handleActivate(nextTabId);
      return true;
    },
    [activeTabId, handleActivate, sessionId, shellVisible, soloMode, tabs],
  );

  useAppShortcut('right-tab-prev', () => handleCycleTab('prev'), {
    enabled: soloMode || (Boolean(sessionId) && isPrimaryGroup),
    stopImmediate: true,
  });
  useAppShortcut('right-tab-next', () => handleCycleTab('next'), {
    enabled: soloMode || (Boolean(sessionId) && isPrimaryGroup),
    stopImmediate: true,
  });

  // 右键菜单"关闭其他":关掉除 keep 外的所有 tab。
  // 用现有 closeTab 串行 await(避免一次 close 多个时位置 reorder 竞态);
  // store 单 IPC 调用很轻,N=5 也只是几十 ms,Phase 7 如果要优化再加 batch close API。
  const handleCloseOthers = useCallback(
    async (keepTabId: string) => {
      if (!sessionId) return;
      // 「关闭其他 / 关闭所有」只作用于任务页签;全局页签要用户逐个显式关闭。
      const targets = sessionTabs.filter((t) => t.id !== keepTabId).map((t) => t.id);
      for (const tabId of targets) {
        try {
          await closeTab(sessionId, tabId);
        } catch (err) {
          log.error('handleCloseOthers: closeTab failed', { sessionId, tabId, err });
          break; // 串行下一个失败时停止,避免连环错误
        }
      }
    },
    [sessionId, sessionTabs],
  );

  // 右键菜单"关闭所有":关掉本 session 的全部 tab。
  const handleCloseAll = useCallback(async () => {
    if (!sessionId) return;
    const targets = sessionTabs.map((t) => t.id);
    for (const tabId of targets) {
      try {
        await closeTab(sessionId, tabId);
      } catch (err) {
        log.error('handleCloseAll: closeTab failed', { sessionId, tabId, err });
        break;
      }
    }
  }, [sessionId, sessionTabs]);

  // popup 路由已挪到窗口级常驻模块(lib/popupRouter.ts):订阅不随 Shell 生命
  // 周期,用户离开聊天视图 / main 端归属等待期间 route 切换都不再丢 popup。
  // Shell 只负责两件事:确保 router 已 init(幂等,与 bridge 同款),以及把
  // "用户正在看的 session"喂给 router 作无归属 popup 的回落目标(保留最后
  // 已知值,Shell 卸载期间到达的 popup 仍有处可去)。
  useEffect(() => {
    initPopupRouter();
  }, []);
  useEffect(() => {
    setPopupFallbackSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    // 只排除主窗的边组;独立页签窗口自己就是页签的承载方,浏览器 webview 转发的快捷键要收。
    if (!soloMode && (!sessionId || !isPrimaryGroup)) return;
    const off = window.electronAPI.onRsbBrowserCommand(({ command }) => {
      if (command === 'right-tab-prev') {
        handleCycleTab('prev');
      } else if (command === 'right-tab-next') {
        handleCycleTab('next');
      }
    });
    return off;
  }, [handleCycleTab, isPrimaryGroup, sessionId, soloMode]);

  // 顶栏「在独立窗口中打开」作用于当前激活页签;没有激活页签时不渲染按钮。
  const handleDetachActiveTab = useMemo(
    () => (onDetachTab && activeTabId ? () => onDetachTab(activeTabId) : undefined),
    [activeTabId, onDetachTab],
  );

  // 桶还没水合(contentReady=false)时只挡任务页签:全局页签不依赖任务桶,卸载它等于丢掉插件页面状态。
  const retainedHosts = useRetainedBrowserTabHosts(
    tabs
      .filter((tab) => contentReady || pinnedTabIds.has(tab.id))
      .filter((tab) => tab.id === activeTabId || deferredMountedTabIds.has(tab.id))
      .map((tab) => ({ tab, sessionId, workdir, remoteHostId, deviceLinkDeviceId })),
  );
  // 全局页签的 wrapper 在 keyed 列表里排最前、彼此顺序稳定:useRetainedBrowserTabHosts 会把
  // 浏览器页签排到前面,不重排的话 React 为了让位会移动全局页签的 wrapper,断开里面的 webview guest。
  const bodyHosts = [
    ...retainedHosts.filter((host) => pinnedTabIds.has(host.tab.id)),
    ...retainedHosts.filter((host) => !pinnedTabIds.has(host.tab.id)),
  ];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {unifiedTopbar ? (
        <div
          data-testid="right-sidebar-unified-topbar"
          // bg 走 --panel-bg 与下方 TabBar / Body 同源(2026-07-21 用户裁决:CINDY 下
          // globals.css 会把 .bg-[var(--panel-bg)] 统一映射到玻璃底,原 bg-content-area
          // 是不透明灰,导致顶栏与面板体两种底色打架;其他 family 两 token 同为 surface,零变化)。
          className="relative flex h-[46px] shrink-0 flex-none items-center border-b border-[var(--border-default)] bg-[var(--panel-bg)] px-2"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {topbarLeading}
          {!isFullscreen && railChromeActionsHitHole && (
            <div
              aria-hidden
              data-testid="right-sidebar-rail-chrome-actions-hit-hole"
              className="absolute left-0 top-0 h-full"
              style={
                {
                  width: CHROME_ACTIONS_GEOMETRY.clusterWidth,
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties
              }
            />
          )}
          {railChromeActionsSpacerWidth > 0 && (
            <div
              aria-hidden
              data-testid="right-sidebar-rail-chrome-actions-spacer"
              className="h-full shrink-0"
              style={
                {
                  width: railChromeActionsSpacerWidth,
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties
              }
            />
          )}
          {leftChromeActionsSpacerWidth > 0 && (
            <div
              aria-hidden
              data-testid="right-sidebar-left-chrome-actions-spacer"
              className="h-full shrink-0"
              style={
                {
                  width: leftChromeActionsSpacerWidth,
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties
              }
            />
          )}
          {/* pillVariant="chip":pills 垂直居中的浮动 chip(完整圆角 + 四边框),
              与「+」、右侧浮层按钮共享宿主栏水平中线(对齐 Codex)——贴底 flush
              样式在 46px 高栏里会与居中控件错位。
              「+」wrapper 传 h-[30px](pill 高)而非 h-full:TabStrip 根高度由
              内容驱动,百分比高度会退化。 */}
          <TabStrip
            tabs={sessionTabs}
            pinnedTabs={pinnedTabs}
            activeTabId={activeTabId}
            sessionId={sessionId}
            onActivate={handleActivate}
            onClose={handleClose}
            onReorder={handleReorder}
            creationMenu={creationMenu}
            onCloseOthers={handleCloseOthers}
            onCloseAll={handleCloseAll}
            onDetachTab={soloMode ? undefined : onDetachTab}
            onMergeBackTab={onMergeBackTab}
            popoutWindows={popoutWindows}
            groupId={groupId}
            onMoveTab={soloMode ? undefined : handleMoveTab}
            onGlobalTabSelected={soloMode ? handleGlobalTabSelected : undefined}
            pillVariant="chip"
            addButtonWrapperClassName="h-[30px]"
          />
          {/* 面板自属控件始终跟随面板：detach → maximize → 收起。固定唤起入口只在
              面板收起或分离时存在；展开态不渲染无效的 show 按钮，也不预留空位。 */}
          <div
            data-testid="right-sidebar-topbar-actions"
            className="flex h-full shrink-0 items-center gap-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {handleDetachActiveTab && (
              <RightSidebarDetach size="toolbar" onDetach={handleDetachActiveTab} />
            )}
            {onMaximize && (
              <RightSidebarMaximize
                size="toolbar"
                onMaximize={onMaximize}
                isMaximized={isMaximized}
              />
            )}
            {onCloseSidebar && (
              <RightSidebarToggle
                size="toolbar"
                collapsed={false}
                onToggle={onCloseSidebar}
                side={panelSide}
              />
            )}
          </div>
          {onShowSidebar && (panelSide === 'right' || isMaximized) && (
            <div
              aria-hidden
              data-testid="right-sidebar-fixed-trigger-spacer"
              className="pointer-events-none h-full shrink-0"
              style={{ width: MAC_HEADER_ACTION_SPACER_PX }}
            />
          )}
          {topbarTrailing}
        </div>
      ) : (
        <TabBar
          tabs={sessionTabs}
          pinnedTabs={pinnedTabs}
          activeTabId={activeTabId}
          sessionId={sessionId}
          onActivate={handleActivate}
          onClose={handleClose}
          onReorder={handleReorder}
          creationMenu={creationMenu}
          showWindowControls={!isMac}
          onMaximize={onMaximize}
          onCloseSidebar={onCloseSidebar}
          onShowSidebar={onShowSidebar}
          panelSide={panelSide}
          isMaximized={isMaximized}
          onDetach={soloMode ? undefined : handleDetachActiveTab}
          onDetachTab={soloMode ? undefined : onDetachTab}
          onMergeBackTab={onMergeBackTab}
          popoutWindows={popoutWindows}
          groupId={groupId}
          onMoveTab={soloMode ? undefined : handleMoveTab}
          onGlobalTabSelected={soloMode ? handleGlobalTabSelected : undefined}
          onCloseOthers={handleCloseOthers}
          onCloseAll={handleCloseAll}
          chromeWindowDrag={chromeWindowDrag}
        />
      )}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
        {/* 首次切到某 session 时 cache 尚未 hydrate(等 IPC list 回包),保留 panel
            背景而非闪 EmptyState —— EmptyState 是"真的没 tab"的 Welcome 内容。
            sessionId 为 null 也走这条:Shell 不显示任何内容(无激活会话)。 */}
        {!contentReady || soloMode || !sessionId || !isPrimaryGroup ? null : tabs.length === 0 ? (
          // tab 列表为空时永远渲染 EmptyState。审查页签只通过「+」dropdown 或
          // EmptyState 的"审查"入口由用户主动创建。
          <EmptyState menu={creationMenu} selectionOptions={{
            groupId, onGlobalTabSelected: soloMode ? handleGlobalTabSelected : undefined,
          }} />
        ) : null}
        {/* Keep one keyed list even when the foreground task is empty or still
            hydrating. Pool-backed background browsers keep their original slot
            and task context; the pool still decides when to release them. */}
        {bodyHosts.map((host) => (
          <PluginBodyHost
            key={host.tab.id}
            {...host}
            active={host.sessionId === sessionId && host.tab.id === activeTabId}
            shellVisible={shellVisible}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

interface PluginBodyHostProps {
  tab: TabState;
  active: boolean;
  sessionId: string | null;
  workdir: string;
  remoteHostId: string | null;
  deviceLinkDeviceId?: string | null;
  shellVisible: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}

/**
 * 单个 tab 的 body 挂载点 —— 解析 plugin、构造 ctx、按 active 切换可见性。
 *
 * 一个 PluginBodyHost 实例的生命周期 = 一个 tab 的生命周期(Shell 不卸载内部 plugin
 * 子树),内部 state(如 file tree expansion / webview content)切顶层 tab 不丢。
 *
 * sessionId 为 null 时 host 也已经在上层 short-circuit 到 EmptyState,不会跑到这里;
 * 但类型上 ctx.sessionId 是 string,需断言。
 */
function PluginBodyHost({
  tab,
  active,
  sessionId,
  workdir,
  remoteHostId,
  deviceLinkDeviceId,
  shellVisible,
  t,
}: PluginBodyHostProps) {
  const plugin = getTabKind(tab.kind);

  // 构造 plugin host ctx。patchState 通过 store.patchTabState 走 store + IPC,
  // 失败回滚。useCallback dep 锁 sessionId + tab.id,plugin 内部 useEffect 监听 ctx
  // identity 才不会无意义重跑。
  //
  // onVisibilityChange v1 仅作占位钩子(plugin 自检 active 与否的辅助通道,Phase 4
  // webview 加 mute 时再消费)。
  const ctx = useMemo<TabKindHostContext>(
    () => ({
      tabId: tab.id,
      sessionId: sessionId ?? '',
      workdir,
      remoteHostId,
      deviceLinkDeviceId,
      patchState: (patch: unknown) => {
        if (!sessionId) return;
        void patchTabState(sessionId, tab.id, (current) => {
          // 默认对象浅合并语义。plugin 想完全替换可传 fn-style;但这里 ctx 接口固定
          // 是 patch object,plugin 调用方负责传可序列化的部分 state diff。
          if (
            current &&
            typeof current === 'object' &&
            patch &&
            typeof patch === 'object' &&
            !Array.isArray(current) &&
            !Array.isArray(patch)
          ) {
            return { ...current, ...patch };
          }
          return patch;
        }).catch((err) => {
          log.error('patchState failed', { sessionId, tabId: tab.id, err });
        });
      },
      onVisibilityChange: () => {
        // Phase 4/5 真消费(webview mute / 暂停媒体);v1 noop。
      },
      setCloseInterceptor: (interceptor) => setTabCloseInterceptor(tab.id, interceptor),
    }),
    [sessionId, workdir, remoteHostId, deviceLinkDeviceId, tab.id],
  );

  // active 切换:走 effect 通知 plugin(plugin 自己内部用 ctx.onVisibilityChange
  // 时机控制媒体 / 焦点)。
  useEffect(() => {
    ctx.onVisibilityChange(active && shellVisible);
  }, [active, ctx, shellVisible]);

  // 规范化 raw state → plugin state:Phase 2 创的旧 tab 持久化是 null,plugin
  // 直接 `state.xxx` 会 NPE。走 hydrateTabState helper(优先 plugin.hydrateState,
  // 否则 null → defaultState 兜底)。TabBar 渲染 TabPill 时也走同一 helper,保证
  // body / pill 两边看到的 state 形状一致。
  const hydratedState = useMemo(() => hydrateTabState(plugin, tab.state), [plugin, tab.state]);

  return (
    <div
      className={active ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}
      aria-hidden={!active || undefined}
    >
      {plugin ? (
        <TabBodyErrorBoundary tabId={tab.id} tabKind={tab.kind} t={t}>
          <Suspense fallback={null}>
            <plugin.TabBody
              state={hydratedState}
              ctx={ctx}
              active={active}
              shellVisible={shellVisible}
            />
          </Suspense>
        </TabBodyErrorBoundary>
      ) : (
        <PlaceholderBody tab={tab} t={t} />
      )}
    </div>
  );
}

/** Plugin 未注册的兜底。 */
function PlaceholderBody({ tab, t }: { tab: TabState; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="flex flex-1 items-center justify-center text-12 text-[var(--text-tertiary)]">
      <span>{t('rightSidebar.tabs.placeholderHint', { kind: tab.kind })}</span>
    </div>
  );
}
