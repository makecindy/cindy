import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BrowserWebviewPool } from '@/components/layout/BrowserWebviewPool';
import { ChromeActions } from '@/components/layout/ChromeActions';
import { shouldReserveLeftChromeActions } from '@/components/layout/chromeActionsLayout';
import { ContentHeaderSlot } from '@/components/layout/ContentHeader';
import { rightSidebarOwnsRailChromeActions as resolveRightSidebarRailChromeActionsOwner } from '@/components/layout/railChromeActions';
import { FadeSwitcher } from '@/components/layout/FadeSwitcher';
import { RightSidebar, type RightSidebarHandle } from '@/components/layout/RightSidebar';
import { RightSidebarToggle } from '@/components/layout/RightSidebarToggle';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { getSplitSessionIds, useSplitGroup } from '@/features/cc-agent/splitGroupStore';
import { LayoutRoot } from '@/layout/LayoutRoot';
import { PanelDragController } from '@/layout/PanelDragController';
import { GhostMediaLightboxHost } from '@/cindy-brain/GhostMediaLightboxHost';
import { GhostPanelBubbleLayer } from '@/cindy-brain/GhostPanelBubbleLayer';
import {
  migrateLegacySidebarCollapsed,
  readPanelCollapsed,
  writePanelCollapsed,
} from '@/layout/collapsePrefs';
import { BuiltinPanelBridgeProvider } from '@/panels/BuiltinPanelBridge';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { UpdateNoticeDialog } from '@/components/UpdateNoticeDialog';
import { FeishuConflictDialogHost } from '@/components/feishuBot/FeishuConflictDialogHost';
import { GlobalDropImportListener } from '@/components/layout/GlobalDropImportListener';
import { SessionShareImportWizard } from '@/components/settings/SessionShareImportWizard';
import { ControlledBanner } from '@/features/remote-device/ControlledBanner';
import { CredentialStoreBanner } from '@/components/layout/CredentialStoreBanner';
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';
import { pluginScheduleNavigationState } from '@/features/scheduler/lib/pluginScheduleCreateIntent';
import { FeatureSidebarSlotProvider } from '@/features/feature-context';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import {
  addOrFocusSingletonTab,
  closeTab,
  ensureHydrated,
  getBucket,
  getTabSnapshot,
  importTabSnapshot,
  resetCachesForHostTransition,
} from '@/features/right-sidebar/store';
import { browserWebviewPool } from '@/features/right-sidebar/lib/browserWebviewPool';
import { markAllPtyDetached } from '@/features/right-sidebar/plugins/terminal/lib/xtermPool';
import {
  bootstrapRsbWindowState,
  getRsbWindowUiState,
  useRightSidebarWindowState,
} from '@/lib/rightSidebarWindowState';
import {
  detachedHostAfterOpen,
  didUserCloseDetachedSidebarWindow,
  nextDetachedHostAfterFocus,
  sessionIdForDetachedSidebarClose,
} from '@/lib/rsbWindowTransitions';
import { routeSidebarCommand } from '@/features/right-sidebar/lib/detachedSidebarRouting';
import { openTerminalFromShortcut } from '@/features/right-sidebar/lib/openTerminalShortcut';
import { executeSidebarCommand } from '@/features/right-sidebar/lib/executeSidebarCommand';
import { openUrlInSidebarBrowser } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { useSidebarResize } from '@/hooks/useSidebarResize';
import { useSidebarCardMode } from '@/hooks/useSidebarCardMode';
import { useSidebarPeek } from '@/hooks/useSidebarPeek';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { useRightSidebarResize } from '@/hooks/useRightSidebarResize';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { useUpdateNotice } from '@/hooks/useUpdateNotice';
import { syncNotificationsEnabledToMain } from '@/hooks/useNotificationSettings';
import {
  isAgentIslandSupported,
  toggleAgentIslandSoundEnabled,
} from '@/hooks/useAgentIslandSettings';
import { requestNewWorkerFromShortcut } from '@/features/cc-agent/lib/newWorkerShortcut';
// chat-data-localization F1 V0.4 / M-FE6
import { useCorruptionRestoredToast } from '@/hooks/useCorruptionRestoredToast';
// #37 schema-drift release-side toast
import { useSchemaDriftWarningToast } from '@/hooks/useSchemaDriftWarningToast';
import { useVoiceInputShortcutRecoveryToast } from '@/hooks/useVoiceInputShortcutRecoveryToast';
import { usePluginRemovalNoticeToast } from '@/hooks/usePluginRemovalNoticeToast';
import { usePluginUpgradeNoticeToast } from '@/hooks/usePluginUpgradeNoticeToast';
import { requestProjectFocus } from '@/state/pendingProjectFocus';
import { patchDraft } from '@/state/newMakerDraft';
import { cn } from '@/lib/utils';
import { checkForUpdateWithToast } from '@/lib/checkForUpdateWithToast';
import { createLogger } from '@/lib/logger';
import { subscribeWorkLouderCodexAction } from '@/lib/workLouderCodexActions';
import { cleanupLegacyGlobalKeys } from '@/lib/sessionLayoutPrefs';
import {
  onRequestRightSidebarVisibility,
  requestRightSidebarVisibility,
  shouldAnimateSidebarVisibilityRequest,
} from '@/features/right-sidebar/lib/sidebarCommands';
import { requestSessionSwitch } from '@/features/cc-agent/lib/sessionSwitchCommands';
import { makeFolderPickerNewMakerRouteState } from '@/features/cc-agent/lib/newMakerRouteState';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute,
  resolveAgentIslandVisibleSessionFromRouteTarget,
  resolveAgentIslandVisibleSessionIdFromPath,
} from '@/lib/agentIslandVisibleSessionRoute';

const SIDEBAR_RAIL_KEY = 'sidebar-rail';

/**
 * RSB 交互领地:aside 本体(data-panel-drag-root="right-tabs")+ portal 到 body 的
 * RSB 浮层(data-rsb-territory,如 TabStrip「+」菜单)。浮层 DOM 挂在 body 尾,
 * 但交互语义仍属右栏 —— ⌘W 归属的两层判定(activeElement / 最近 pointer 交互)
 * 都用本 selector。浮层不能复用 data-panel-drag-root:PanelDragController 会把
 * 该标记内的长按识别成拖面板手势。
 */
const RSB_TERRITORY_SELECTOR = '[data-panel-drag-root="right-tabs"], [data-rsb-territory]';

/**
 * 右栏折叠态:per-session 记忆(切 A → B 不串扰,新 session 默认 collapsed=true
 * 不主动占地)。B2a 起读写统一走 collapsePrefs(按注册表 collapseMemory 声明分发),
 * 存储位置与键不变,这两个包装只固化 right-tabs 的默认值与空 sessionId 短路。
 */
function readCollapsedFor(sessionId: string | null): boolean {
  if (!sessionId) return true;
  return readPanelCollapsed('right-tabs', { sessionId }, true);
}

function writeCollapsedFor(sessionId: string | null, collapsed: boolean): void {
  if (!sessionId) return;
  writePanelCollapsed('right-tabs', { sessionId }, collapsed);
}

interface RightSidebarSessionDeclarationOptions {
  initialCollapsed?: boolean;
  writeInitialCollapsedRecord?: boolean;
  subagentsAvailable?: boolean;
}

const applicationMenuLog = createLogger('ApplicationMenu');
const log = createLogger('MainLayout');
// Keep in sync with single-segment static routes under /cc-agent in router.tsx.
const CC_AGENT_STATIC_SEGMENTS = ['boot', 'files', 'new', 'new-dialogue', 'orca', 'scheduled'];

function getInitialCollapsed(): boolean {
  // 「在新窗口打开」的副窗口默认折叠侧栏 —— 多开盯多个会话时,每个窗口都铺一条
  // 会话列表很占地方。只在初始化时判断、不写回存档,故不影响主窗偏好。
  if (isSecondaryWindow()) return true;
  // B2a:左栏折叠(global 作用域)持久化真身在布局树;旧 localStorage 键首启一次性
  // 迁入(迁移值同步用于首帧,无跳变)。
  const migrated = migrateLegacySidebarCollapsed();
  return migrated ?? readPanelCollapsed('session-list', {}, false);
}

function getInitialRailMode(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_RAIL_KEY) === 'true';
  } catch {
    return false;
  }
}

function getInitialRightCollapsed(): boolean {
  // 初始时 rightSidebarSessionId 还是 null(尚未进入聊天会话),默认 collapsed=true。
  // 真正的"按 session 读"在 useEffect 监听 rightSidebarSessionId 变化时执行。
  return true;
}

function getShortcutTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isZoomShortcutBlockedTarget(target: EventTarget | null): boolean {
  const element = getShortcutTargetElement(target);
  if (!element) return false;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }
  return Boolean(
    element.closest(
      '[contenteditable="true"], .ProseMirror, .cm-editor, .cm-content, .cm-scroller, [role="textbox"]',
    ),
  );
}

function hasInlineControlledBannerPath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'cc-agent') return false;
  if (parts.length === 2) return !CC_AGENT_STATIC_SEGMENTS.includes(parts[1]);
  return parts.length === 3 && parts[1] === 'orca' && parts[2] !== 'new';
}

/**
 * SidebarPinSpacer —— peek 抽屉固定展开(pinning)期的流内占位。
 * 抽屉在 pinning 期保持 fixed 冻结不动,本组件在流内跑 0→width 的宽度动画
 * (与 ChromeActions 的 left 平移同时长同缓动)把主区平滑推开;pinning 结束
 * 后卸载,aside 同帧摘掉 fixed 落回流内。双 rAF 确保 0 宽先提交一帧再翻到
 * 目标宽,transition 可靠触发。
 */
function SidebarPinSpacer({ width }: { width: number }) {
  const [animatedWidth, setAnimatedWidth] = useState(0);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAnimatedWidth(width));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [width]);
  return (
    <div
      aria-hidden
      className="h-full shrink-0 transition-[width] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0"
      style={{ width: animatedWidth }}
    />
  );
}

export function MainLayout() {
  const splitGroup = useSplitGroup();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(getInitialCollapsed);
  const [shareImportRequest, setShareImportRequest] = useState<{
    id: number;
    filePath: string;
  } | null>(null);
  const shareImportRequestSeqRef = useRef(0);
  const openShareImport = useCallback((filePath: string) => {
    shareImportRequestSeqRef.current += 1;
    setShareImportRequest({ id: shareImportRequestSeqRef.current, filePath });
  }, []);
  const handleShareImportOpenChange = useCallback((open: boolean) => {
    if (!open) setShareImportRequest(null);
  }, []);
  // rail 模式（64px 竖排文字列）——只能通过**拖动边框拉到最窄**进入/退出
  //（redesign 决策：左上角 toggle / ⌘B 维持原版"完全隐藏"语义，两者独立）。
  const [isRailMode, setIsRailMode] = useState(getInitialRailMode);
  const handleRailModeChange = useCallback((on: boolean) => {
    setIsRailMode(on);
    try {
      localStorage.setItem(SIDEBAR_RAIL_KEY, String(on));
    } catch {
      // storage not available — silently ignore
    }
  }, []);
  // 仅卡片版(瀑布流多列)给侧栏拖拽挂「2 列最佳最小宽」磁吸停靠点;list(单列满宽)
  // 与 text 不分栏,无需吸附。
  const { mode } = useSidebarCardMode();
  const {
    width: sidebarWidth,
    isDragging,
    handleDragStart,
    resetWidth,
  } = useSidebarResize(
    {
      railMode: isRailMode,
      onRailModeChange: handleRailModeChange,
    },
    mode === 'card',
  );
  // 右侧边栏(第三块布局,与左栏对称)：折叠态 + 宽度各自持久化。
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = useState(getInitialRightCollapsed);
  // 「侧边栏在新窗口中显示」偏好 + 子窗口开闭(main 权威,广播镜像)。
  // 副窗(会话多开窗)不参与 detach:内嵌行为保持不变,只有主窗联动子窗口
  // (main 侧 SET_CONTEXT 也只信主窗 sender,双保险)。
  const rsbWindow = useRightSidebarWindowState();
  const rsbDetached = !isSecondaryWindow() && rsbWindow.loaded && rsbWindow.detached;
  // 右栏是否「在场」：由当前路由视图自己声明（白名单/声明式，取代旧的「所有非设置页
  // 默认有、逐界面特判关闭」黑名单）。只有全屏聊天视图（CCAgentSessionView 的路由主
  // 实例）会经 Outlet context 的 setRightSidebarAvailable 置 true，卸载时置 false。
  // 据此决定是否渲染右栏面板：离开聊天视图 → 面板卸载，不会卡在展开态且无入口关闭。
  const [rightSidebarAvailable, setRightSidebarAvailable] = useState(false);
  // 当前 cc-agent session id —— 由 CCAgentSessionView 的路由主实例(ownsRoute=true)经 outlet context
  // 推上来,Shell 据此从 module-level store 拉对应桶的 tab 列表持久化数据。null = 不在聊天会话内。
  const [rightSidebarSessionId, setRightSidebarSessionId] = useState<string | null>(null);
  const [rightSidebarSubagentsAvailable, setRightSidebarSubagentsAvailable] = useState<
    boolean | undefined
  >(undefined);
  const rightSidebarSessionIdRef = useRef(rightSidebarSessionId);
  rightSidebarSessionIdRef.current = rightSidebarSessionId;
  const detachedHostSessionIdRef = useRef<string | null>(null);
  const isRightSidebarCollapsedRef = useRef(isRightSidebarCollapsed);
  isRightSidebarCollapsedRef.current = isRightSidebarCollapsed;
  const rsbDetachedRef = useRef(rsbDetached);
  rsbDetachedRef.current = rsbDetached;
  const navigateToSessionRef = useRef<(sessionId: string) => void>(() => undefined);
  const declareRightSidebarSessionId = useCallback(
    (sessionId: string | null, opts: RightSidebarSessionDeclarationOptions = {}) => {
      rightSidebarSessionIdRef.current = sessionId;
      detachedHostSessionIdRef.current = nextDetachedHostAfterFocus(
        detachedHostSessionIdRef.current,
        sessionId,
      );
      setRightSidebarSessionId(sessionId);
      setRightSidebarSubagentsAvailable(sessionId ? opts.subagentsAvailable : undefined);
      if (!sessionId || !rsbWindow.loaded || rsbDetached) return;
      const hasInitialCollapsed = typeof opts.initialCollapsed === 'boolean';
      const nextCollapsed = hasInitialCollapsed
        ? opts.initialCollapsed === true
        : readCollapsedFor(sessionId);
      setIsRightSidebarCollapsed(nextCollapsed);
      if (hasInitialCollapsed && opts.writeInitialCollapsedRecord === true) {
        writeCollapsedFor(sessionId, nextCollapsed);
      }
    },
    [rsbDetached, rsbWindow.loaded],
  );
  // 当前 cc-agent session 的 workingDir + remote 归属 —— 同 sessionId 由 CCAgentSessionView
  // 主实例推上来,给 RightSidebar plugin(file-browser)做 useFileTree / useFileContent 入参。
  // workdir 空串 = 尚未解析(刚切入会话),plugin 据此渲染"未关联 workdir"占位而不是炸。
  // remoteHostId 非空 = SSH remote 会话:workdir 是远端绝对路径,文件操作由 main 路由到
  // 远端 file-service(plugin 关闭 watch / 系统打开等本地-only 能力)。
  const [rightSidebarWorkdirInfo, setRightSidebarWorkdirInfo] = useState<{
    workdir: string;
    remoteHostId: string | null;
    deviceLinkDeviceId?: string | null;
  }>({ workdir: '', remoteHostId: null, deviceLinkDeviceId: undefined });
  const setRightSidebarWorkdir = useCallback(
    (workdir: string, remoteHostId: string | null = null, deviceLinkDeviceId?: string | null) =>
      // 同值 bailout(返回 prev 引用):恢复"字符串 state 同值不重渲染"的旧语义。
      // Outlet context 对象每次渲染都是新身份,OrcaWorkflowRoute 等消费方的
      // effect 以 outletContext 为 dep——如果同值 declare 也换新对象,会形成
      // declare → 重渲染 → 新 context → effect 重跑 → declare 的死循环
      // (真机实测 Maximum update depth exceeded)。
      setRightSidebarWorkdirInfo((prev) =>
        prev.workdir === workdir &&
        prev.remoteHostId === remoteHostId &&
        prev.deviceLinkDeviceId === deviceLinkDeviceId
          ? prev
          : { workdir, remoteHostId, deviceLinkDeviceId },
      ),
    [],
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // B1a(去方位化):左侧占位块(pinning spacer + Sidebar)的 wrapper。
  // row/sidebar refs 仅供面板拖放命中区测量，不再驱动 live-resize React state。
  const sidebarBlockRef = useRef<HTMLDivElement>(null);
  // B1b-1:宽度全局一份、持久化在布局树里(不再 per-session),hook 不再收 sessionId。
  // 拖宽把手已统一为引擎分割线(LayoutRoot RootDivider),hook 只剩宽度兜底 +
  // 所在侧推导(rightSidebarSide 供折叠 toggle 落角)。
  // 像素宽主权在 LayoutRoot → PaneWidthContext；这里仅保留引擎缺席时的稳定
  // fallback + 面板所在侧推导，不再让 MainLayout 订阅连续窗口宽度。
  const { width: rightSidebarWidth, resizeEdge: rightResizeEdge } = useRightSidebarResize();
  // B2b:工具面板当前贴哪条边(把手在面板朝聊天区那侧,取反即面板所在侧)。
  // 经 Outlet context 下发给聊天视图 —— 折叠态的展开入口要留守面板消失的那一侧。
  const rightSidebarSide: 'left' | 'right' = rightResizeEdge === 'left' ? 'right' : 'left';

  // host 端 resize 期间(左栏 / RSB resize handle 被拖)给 document.body 挂
  // `resizing-pane` class,globals.css 据此让所有 RSB 内置 webview wrapper
  // (`#browser-webview-pool` + `[data-pool-tab-id]`)pointer-events: none。
  //
  // 必要原因:Electron `<webview>` 是独立 webContents,host 端的 pointer 移到
  // webview 区域后,guest 接管 mousemove,host 全局 document pointermove 监听
  // 收不到事件 → resize handler 卡住(2026-07-01 用户实测:RSB 浏览器 tab
  // 拖不动 resize handle)。pointer-events: none 让 host 端事件穿过 webview
  // 不命中,guest 也不收,host pointermove 能正常拿到。
  //
  // 用 useEffect 同步 body class —— 不直接 inline 写,因为 MainLayout 不直接
  // 渲染 webview wrapper(pool 是 vanilla DOM,React 跟它没引用);CSS 规则在
  // globals.css 里基于 body class 选 wrapper 是最简单的路径。
  useEffect(() => {
    // 左栏拖宽期间 webview 指针穿透;内容区缝把手/拖面板期间的同款 class 由
    // 引擎(LayoutRoot RootDivider / PanelDragController)自己挂,不经这里。
    if (isDragging) {
      document.body.classList.add('resizing-pane');
      return () => document.body.classList.remove('resizing-pane');
    }
    return undefined;
  }, [isDragging]);
  const isMac = window.electronAPI?.platform === 'darwin';
  const { isFullscreen } = useMacFullscreen();
  const {
    open: noticeOpen,
    mode: noticeMode,
    releaseNotes,
    allVersions: noticeAllVersions,
    loadVersion: noticeLoadVersion,
    dismiss: dismissNotice,
    onOpen: openNotice,
    onOpenVersion: openVersionNotice,
  } = useUpdateNotice();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    syncNotificationsEnabledToMain();
  }, []);

  const isSettingsRoute = location.pathname === '/settings';
  const hasInlineControlledBanner = hasInlineControlledBannerPath(location.pathname);

  // 完全隐藏态 hover 临时浮出(peek)状态机 —— hover 折叠按钮抽屉滑出预览,
  // 点击/⌘B 固定展开(pin)。rail 态(isCollapsed=false)不触发。见 useSidebarPeek。
  const sidebarPeek = useSidebarPeek({
    isCollapsed: isSidebarCollapsed,
    enabled: !isSettingsRoute,
  });
  // ChromeActions 固定在窗口左上。rail 态下它跨到内容区，必须由当前最左且可见
  // 的面板顶栏挖 no-drag 命中区：默认是 chat-main；工具面板换到左侧时则交给
  // RightSidebar 的 unified topbar。peek 抽屉会强制退出 rail，不能沿用 rail 命中区。
  const hasRailChromeActions =
    !isSettingsRoute &&
    isMac &&
    !isFullscreen &&
    isRailMode &&
    !isSidebarCollapsed &&
    !sidebarPeek.isPeekVisible;
  // peek 中固定展开(pinning)时若持久化的 rail 模式还开着:退出 rail —— 用户
  // 刚在全宽抽屉里预览并选择固定,落到 78px 窄轨会与所见不符且造成宽度跳变。
  useEffect(() => {
    if (sidebarPeek.peekState === 'pinning' && isRailMode) {
      handleRailModeChange(false);
    }
  }, [sidebarPeek.peekState, isRailMode, handleRailModeChange]);

  const routeSessionId = resolveAgentIslandVisibleSessionIdFromPath(location.pathname);
  const splitVisibleSessionIds = useMemo(() => {
    const splitSessionIds = getSplitSessionIds(splitGroup.root);
    return routeSessionId && splitSessionIds.length >= 2
      ? [...new Set([routeSessionId, ...splitSessionIds])]
      : [];
  }, [routeSessionId, splitGroup.root]);

  const syncAgentIslandVisibleSession = useCallback(() => {
    if (!isAgentIslandSupported()) return;
    if (!document.hasFocus()) return;
    if (isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute(location.pathname)) return;
    void window.electronAPI.agentIsland?.setVisibleSession?.(
      splitVisibleSessionIds.length >= 2 ? splitVisibleSessionIds : routeSessionId,
    );
  }, [location.pathname, routeSessionId, splitVisibleSessionIds]);

  useEffect(() => {
    syncAgentIslandVisibleSession();
  }, [syncAgentIslandVisibleSession]);

  // 会话切换上报(订阅槽① did-session-switched 数据源):路由变化即报当前
  // 台前会话,平台无关、无 agent-island 门控(它是 mac-only + 焦点门,借用会
  // 让 Windows / 后台窗口漏报)。去重与投递资格全在 main,这里只做纯上报。
  useEffect(() => {
    window.electronAPI?.ghosts?.noteSessionFocused?.(
      resolveAgentIslandVisibleSessionIdFromPath(location.pathname),
    );
  }, [location.pathname]);

  // 一次性清理旧版无 suffix 的全局 RSB 布局 key(`right-sidebar-fraction` /
  // `rightSidebar.fileBrowser.treeWidth`)。Per-session 改造后这两个 key 已废弃,清掉
  // 避免 DevTools 看 localStorage 时迷惑。removeItem 幂等,无需 once 标记。
  useEffect(() => {
    cleanupLegacyGlobalKeys();
  }, []);

  useEffect(() => {
    window.addEventListener('focus', syncAgentIslandVisibleSession);
    return () => window.removeEventListener('focus', syncAgentIslandVisibleSession);
  }, [syncAgentIslandVisibleSession]);

  useEffect(
    () => () => {
      if (!isAgentIslandSupported()) return;
      void window.electronAPI.agentIsland?.setVisibleSession?.(null);
    },
    [],
  );

  // chat-data-localization V0.4 / M-FE6：corruption 恢复后一次性 toast
  useCorruptionRestoredToast();
  // #37：release 端未知 schema drift 一次性 toast(提示用户升级或联系支持)
  useSchemaDriftWarningToast();
  // 语音快捷键在设置页之外自动恢复失败 —— 那时设置页的 toast 不在,只能由常挂载的这里提示。
  useVoiceInputShortcutRecoveryToast();
  // 冷启动市场对账可能早于 Renderer 挂载；Main pending + 常驻 consume 保证清理不静默。
  usePluginRemovalNoticeToast();
  usePluginUpgradeNoticeToast();
  // device-link 跨设备远程控制:同账号在线 + 开了被控的设备,其项目自动并入侧边栏
  useDeviceLinkRemoteProjects();

  // 系统通知点击回调：主进程把窗口拉到前台后广播 sessionId，这里跳路由。
  // 挂在 MainLayout 而不是 App 顶层——这里在 ProtectedRoute + LocalDbGate 之内，
  // 用户必然已登录、可以安全 navigate 到 /cc-agent。
  //
  // 用 ref 转当前 route 给闭包读，避免每次路由变化都重订阅 IPC；同时做 dedupe
  // 防止 HMR listener 累积或 Electron click 异常多次触发时反复 navigate。
  const currentPathRef = useRef(`${location.pathname}${location.search}`);
  currentPathRef.current = `${location.pathname}${location.search}`;
  const navigateToSession = useCallback(
    (sessionId: string, messageClientId?: string) => {
      // device-link 远程会话本地无 row:resolveSessionRoute 内部的 sessionService.get
      // 会 miss → 远程 Orca lead/worker 被当普通会话路由,CCAgentSessionView 再
      // redirect 到 orca 路由时会丢 searchJump 锚点。传入远程镜像的 session 对象,
      // 让 Orca 路由一步到位(Codex review P2,与 SessionLinkChip 同款处理)。
      const remoteSession =
        remoteProjectsStore.getMergedRemoteSessions().find((s) => s.id === sessionId) ?? null;
      void resolveSessionRoute(sessionId, remoteSession).then((target) => {
        const visibleSession = resolveAgentIslandVisibleSessionFromRouteTarget(target);
        if (messageClientId) {
          // 带消息锚点:即使已在目标路由也要 navigate——新的 location.state 才能
          // 触发 CCAgentSessionView 的 searchJump 消费 effect(定位 + 高亮)。
          navigate(target, {
            state: {
              searchJump: {
                kind: 'conversation-search',
                sessionId,
                messageId: messageClientId,
                messageIdKind: 'clientId',
                messageClientId,
              },
            },
          });
        } else if (currentPathRef.current !== target) {
          navigate(target);
        }
        // 通知点击跳转专用的 visible-session 上报:故意只 gate isAgentIslandSupported(),
        // 不像上面的 syncAgentIslandVisibleSession / OrcaSplitView 那样加 document.hasFocus()
        // 或 orca-split / workdir-browse 归属守卫。原因:通知触发跳转时主窗口 focus 往往还
        // 没稳定(见 main 端 isAgentIslandPendingFocusAck 放宽),本路径是唯一能在这段 focus
        // 竞态里把灵动岛收起的上报来源。若把 orca / files 路由交还各自 owner 组件,它们都带
        // document.hasFocus() 守卫、竞态期不会上报,首个权限卡片会退回"必须先点窗口才收起"
        // 的旧 bug。worker deep link 直接按 route query 上报 [Lead, Worker]，普通会话
        // 上报单个 session；窗口 focus 稳定后 owner 组件继续维护同一份可见集合。
        if (isAgentIslandSupported()) {
          void window.electronAPI.agentIsland?.setVisibleSession?.(visibleSession);
        }
      });
    },
    [navigate],
  );
  navigateToSessionRef.current = navigateToSession;
  useEffect(() => {
    const unsubscribe = window.electronAPI.onNotificationFocusSession((sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return;
      navigateToSession(sessionId);
    });
    return unsubscribe;
  }, [navigateToSession]);

  // 插件请求新建自动化(agent 槽的 schedule 加档):main 的 scheduleSlot 已做资格审 /
  // 净化截断 / 频率钳制 / 限速,这里只负责把用户带到自动化页并把预填内容交过去。
  // 挂在 MainLayout 的理由同上面那条:它在 ProtectedRoute + LocalDbGate 之内,用户
  // 必然已登录、可以安全 navigate;而插件请求可能在任何路由下到达(用户当时正在
  // 插件面板里),SchedulerPage 那时还没挂载,接不到这条推送。
  //
  // main 侧**只投一个主壳窗**(见 cindy-brain 的 isMainShellWindowUrl):独立的插件
  // 面板窗 / 右侧栏窗与 MainLayout 平级、没有本订阅,所以别在那两个轻壳里再加一份
  // 处理——它们收不到,加了也是死代码。同一窗口内仍需去重(下游 SchedulerPage 的
  // handledScheduleCreateRequestRef):navigate 带的 state 可能被 effect 重复消费。
  //
  // ⚠️ 这里**只导航**。任务落库只发生在用户于面板上点保存之后 —— 插件全程没有
  // 直接建任务的通道(scheduleSlot 的 deps 里压根没有 schedule storage)。
  useEffect(() => {
    const unsubscribe = window.electronAPI.ghosts?.onScheduleDraft?.((payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { requestId, ghostId, ghostName, name, prompt, intervalMs } = payload;
      if (
        typeof requestId !== 'string' ||
        !requestId ||
        typeof ghostId !== 'string' ||
        !ghostId ||
        typeof ghostName !== 'string' ||
        !ghostName ||
        typeof name !== 'string' ||
        !name ||
        typeof prompt !== 'string' ||
        !prompt
      ) {
        return;
      }
      navigate('/cc-agent/scheduled', {
        state: pluginScheduleNavigationState({
          kind: 'plugin-schedule-draft',
          requestId,
          ghostId,
          ghostName,
          name,
          prompt,
          ...(typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
            ? { intervalMs }
            : {}),
        }),
      });
    });
    return unsubscribe;
  }, [navigate]);

  // cindy://(+ 历史 xdt-maker://)深度链接 + --open-folder 右键菜单订阅 —— main 端解析后推 payload,
  // 这里按 type 分发。
  // session:     canonicalize 后 navigate 到对应路由(与 onNotificationFocusSession 同语义)
  // project:     fire pendingProjectFocus 信号给 sidebar (CCAgentSidebarUpper) 去做
  //              "展开 + 滚动" 和 "找不到时 toast"。需要保证消费 effect 所在的
  //              ExpandedView 已挂载 —— 在 /cc-agent/files/<id> (CCAgentSidebarUpper
  //              切到 WorkdirBrowseSidebar) 或 /settings 等路由下,ExpandedView 是
  //              unmounted 的,信号会沉淀直到下次 mount。所以这两种情况强制 navigate
  //              回 /cc-agent index, 触发 CCAgentIndexRedirect → ExpandedView mount
  //              → effect 跑 → expand + scroll。
  // new-session: 右键 "通过 Cindy 打开" 入口。把 workingDir 写进 newMakerDraft
  //              (并清空 extraDirs,旧目录的附加只读引用对新目录无意义),然后
  //              navigate('/cc-agent/new')。NewMakerDraftRoute 订阅 store 自动反映。
  const handleDeepLinkPayload = useCallback(
    (
      payload:
        | { type: 'session'; id: string; messageClientId?: string }
        | { type: 'project'; workingDir: string }
        | { type: 'new-session'; workingDir: string }
        | { type: 'share-import'; filePath: string }
        | { type: 'settings'; tab: 'voice-input' | 'providers'; connect?: string },
    ) => {
      if (payload.type === 'session') {
        navigateToSession(payload.id, payload.messageClientId);
        return;
      }
      if (payload.type === 'project') {
        requestProjectFocus(payload.workingDir);
        const path = currentPathRef.current;
        const inExpandedView = path.startsWith('/cc-agent') && !path.startsWith('/cc-agent/files/');
        if (!inExpandedView) {
          navigate('/cc-agent');
        }
        return;
      }
      if (payload.type === 'new-session') {
        patchDraft({ workingDir: payload.workingDir, extraDirs: [] });
        navigate('/cc-agent/new');
        return;
      }
      if (payload.type === 'share-import') {
        openShareImport(payload.filePath);
        return;
      }
      if (payload.type === 'settings') {
        // connect 透传给 ProvidersSection 已有的 ?connect=<providerId> 消费逻辑
        // (可指向内置 provider 或 preset;providers 就绪后一次性消费、消费即从
        // URL 摘除),与「连接供应商」引导卡的 navigate 形态保持一致。
        const connect =
          payload.tab === 'providers' && payload.connect
            ? `&connect=${encodeURIComponent(payload.connect)}`
            : '';
        navigate(`/settings?tab=${payload.tab}${connect}`);
      }
    },
    [navigate, navigateToSession, openShareImport],
  );
  useEffect(() => {
    const unsubscribe = window.electronAPI.onDeepLinkNavigate(handleDeepLinkPayload);
    return unsubscribe;
  }, [handleDeepLinkPayload]);

  // pull-on-mount:冷启动期间 (mainWindow 未 ready / renderer 未挂 listener)
  // 缓存在 main 端的 deep link / --open-folder payload, MainLayout 第一次 mount
  // 时拉一次消费。已运行场景始终返回 null,no-op。
  //
  // 关键场景:未登录用户右键 "通过 Cindy 打开" → 冷启动 → LoginPage 接管 →
  // 用户走完 Feishu OAuth → MainLayout (在 ProtectedRoute 之内) 第一次 mount →
  // 此 effect 跑一次 take + dispatch → 用户回到 /cc-agent/new 且 workingDir
  // 已预填,不会因为登录流程跳过而丢失意图。
  //
  // 用 ref 锁住"只拉一次":React 严格模式 (dev) 下 effect 会跑两次,如果用
  // cancelled 标志阻断第二次,会同时阻断第一次还没 resolve 的 dispatch (cleanup
  // 时第一次 cancelled=true,再也回不到 false),payload 被取走但 dispatch 没跑。
  // ref 模式让第二次 effect 直接 skip,第一次 take 的 promise 正常 resolve + dispatch。
  const pendingDeepLinkPulledRef = useRef(false);
  useEffect(() => {
    if (pendingDeepLinkPulledRef.current) return;
    pendingDeepLinkPulledRef.current = true;
    void window.electronAPI.takePendingDeepLink().then((payload) => {
      if (!payload) return;
      handleDeepLinkPayload(payload);
    });
  }, [handleDeepLinkPayload]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      // global 作用域 → 写布局树(沿用旧行为:副窗口 toggle 同样写全局存档)。
      writePanelCollapsed('session-list', {}, next);
      return next;
    });
  }, []);

  // RightSidebar 的命令式句柄。toggle 按钮 onClick 时主动调 requestAnimateNextChange()
  // 告诉 RightSidebar "这次 prop 变化走 250ms 动画"。其它任何 isCollapsed 变化路径
  // (sessionId 切换 / 草稿切换 / init)都不调,RightSidebar 默认走"直接同步"无动画。
  const rightSidebarRef = useRef<RightSidebarHandle>(null);

  const handleOpenRightSidebar = useCallback(() => {
    if (!rsbWindow.loaded) return;
    // 主窗口固定入口只负责显示 / 聚焦，不承担关闭语义。
    if (rsbDetached) {
      writeCollapsedFor(rightSidebarSessionId, false);
      void window.electronAPI.rightSidebarWindow
        .open()
        .catch((err) => log.warn('show detached right sidebar failed', err));
      return;
    }
    if (!isRightSidebarCollapsed) return;
    // 打开时沿用上次记住的比例（useRightSidebarResize 持久化的 fraction）：展开后
    // 右栏 = fraction × 可用宽、中间 flex-1 吸收剩余，窗口缩放时两栏按比例同步变化。
    // 持久化按 rightSidebarSessionId 分桶 —— 各 session 独立记忆开关状态(切 session 不串扰)。
    // 显式 prime RightSidebar 走动画。
    rightSidebarRef.current?.requestAnimateNextChange();
    writeCollapsedFor(rightSidebarSessionId, false);
    setIsRightSidebarCollapsed(false);
  }, [isRightSidebarCollapsed, rightSidebarSessionId, rsbDetached, rsbWindow.loaded]);

  // 面板自身的关闭按钮继续只负责收起内嵌面板。
  const handleCloseRightSidebar = useCallback(() => {
    if (rsbDetached || isRightSidebarCollapsed) return;
    rightSidebarRef.current?.requestAnimateNextChange();
    writeCollapsedFor(rightSidebarSessionId, true);
    setIsRightSidebarCollapsed(true);
  }, [isRightSidebarCollapsed, rightSidebarSessionId, rsbDetached]);

  const handleToggleRightSidebar = useCallback(() => {
    if (!rsbWindow.loaded) return;
    if (rsbDetached) {
      if (rsbWindow.open) {
        void window.electronAPI.rightSidebarWindow
          .close()
          .catch((err) => log.warn('hide detached right sidebar failed', err));
        return;
      }
      handleOpenRightSidebar();
      return;
    }
    if (isRightSidebarCollapsed) {
      handleOpenRightSidebar();
      return;
    }
    handleCloseRightSidebar();
  }, [
    handleCloseRightSidebar,
    handleOpenRightSidebar,
    isRightSidebarCollapsed,
    rsbDetached,
    rsbWindow.loaded,
    rsbWindow.open,
  ]);

  // 关掉右侧栏最后一个 tab 时自动收起(由 RightSidebarShell 在 tab 数 >0→0 时回调)。
  // detached 子窗口形态不在此处理(那时主窗根本不渲染内嵌 Shell,也收不到此回调)。
  // 走 requestAnimateNextChange 让收起有 250ms 动画,与用户手动折叠观感一致(规则 7)。
  // sessionId 用 ref 取最新值,避免回调闭包捕获旧 session。
  const handleRightSidebarEmptied = useCallback(() => {
    if (rsbDetached) return;
    const sessionId = rightSidebarSessionIdRef.current;
    if (sessionId == null) return;
    rightSidebarRef.current?.requestAnimateNextChange();
    setIsRightSidebarCollapsed(true);
    writeCollapsedFor(sessionId, true);
  }, [rsbDetached]);

  // 分离侧栏合并回主窗时，main 先转发不可持久化 session 的 tab 快照，
  // 再广播 detached=false 让这里重挂内嵌 Shell。快照必须在 cache invalidation
  // 之前接收；store 会把它保留到本次 hydrate，避免远程/草稿会话回到空栏。
  useEffect(() => {
    if (isSecondaryWindow()) return;
    return window.electronAPI.rightSidebarWindow.onTabHandoff((handoff) => {
      for (const snapshot of handoff.snapshots) importTabSnapshot(snapshot);
    });
  }, []);

  // sessionId 切换时按新 session 的存档刷新折叠态。无需 prime 动画 —— RightSidebar 默认
  // 直接同步,切 session "瞬间生效"(用户体感:不应看着一栏慢慢展开/收起)。
  useLayoutEffect(() => {
    if (!rsbWindow.loaded || !rightSidebarSessionId || rsbDetached) return;
    setIsRightSidebarCollapsed(readCollapsedFor(rightSidebarSessionId));
  }, [rightSidebarSessionId, rsbDetached, rsbWindow.loaded]);

  // 监听"右侧栏可见性"信号 —— Phase 5 RsbWebviewBackend 触发(rsbBrowserBridge
  // .handleTabOpRequest):open/focus → 'open',close 最后一个 tab → 'close'。
  // 全部走纯代码确定性,不让模型推理。
  //
  // Cross-session 呼起必须跟发起方 session,不能只认当前焦点:
  //   1) agent 在 session A 调 open → 触发 visibility 'open' + sessionId=A
  //   2) 用户此时看着 session B(远程连接、副窗、切走等)
  //   旧实现只给 B 弹栏 / 或把异会话请求丢掉,A 的浏览器永远看不见。
  //   现在: detached 把子窗口钉到 A;内嵌则写入 A 的存档并 navigate 到 A。
  //   信号未带 sessionId(直接 UI button)仍走当前 session。
  useEffect(() => {
    return onRequestRightSidebarVisibility((visibility, opts) => {
      const currentSessionId = rightSidebarSessionIdRef.current;
      const targetSessionId = opts.sessionId ?? currentSessionId;
      if (!targetSessionId) return;
      const targetCollapsed = visibility === 'close';
      const windowState = getRsbWindowUiState();
      if (!windowState.loaded) return;
      const detachedNow = !isSecondaryWindow() && windowState.detached;
      // detached 模式:可见性 = 子窗口开闭。呼起必须跟发起方 session,不能只认
      // 主窗当前焦点 —— 远程连接 / 后台 session 的 agent 开页否则会丢在焦点桶里。
      // (agent tab-op 在 detached 时 dispatch 到子窗口 renderer,其内的
      // SidebarWindowLayout 也订阅了本通道;这里主要覆盖主窗内直接调用方。)
      if (detachedNow) {
        writeCollapsedFor(targetSessionId, targetCollapsed);
        if (visibility === 'open') {
          detachedHostSessionIdRef.current = detachedHostAfterOpen({
            currentSessionId,
            targetSessionId,
            previousHostSessionId: detachedHostSessionIdRef.current,
          });
          // userInitiated 透传:插件 preview / agent 自动化(false)只把内容送进
          // 子窗口,不 show+focus 抢用户前台;用户手势(缺省 true)行为不变。
          // sessionId 让 controller 把子窗口钉在发起方 session 上。
          void window.electronAPI.rightSidebarWindow
            .open({
              userInitiated: opts.userInitiated !== false,
              sessionId: targetSessionId,
            })
            .catch(() => undefined);
        } else if (targetSessionId === currentSessionId) {
          void window.electronAPI.rightSidebarWindow.close().catch(() => undefined);
        }
        return;
      }
      if (targetSessionId === currentSessionId) {
        // 前台路径:走 UI + 持久化
        setIsRightSidebarCollapsed((prev) => {
          if (prev === targetCollapsed) return prev;
          if (shouldAnimateSidebarVisibilityRequest(opts)) {
            rightSidebarRef.current?.requestAnimateNextChange();
          }
          writeCollapsedFor(targetSessionId, targetCollapsed);
          return targetCollapsed;
        });
      } else {
        // 后台路径:写入目标 session 存档。用户手势跨任务 open 才切主窗;
        // agent / 插件自动化(userInitiated:false)只落档,不抢当前输入焦点。
        writeCollapsedFor(targetSessionId, targetCollapsed);
        if (visibility === 'open' && opts.userInitiated !== false) {
          navigateToSessionRef.current?.(targetSessionId);
        }
      }
    });
  }, []);

  // detached 子窗口的所有真实关窗入口最终都会广播 open:true→false。只要偏好仍是
  // detached，就把**实际宿主 session**记为用户显式收起；合并回主窗会先变
  // detached=false，不命中本分支，继续由 attach 路径写“开”。
  const prevRsbWindowStateRef = useRef(rsbWindow);
  useEffect(() => {
    const prev = prevRsbWindowStateRef.current;
    prevRsbWindowStateRef.current = rsbWindow;
    if (!didUserCloseDetachedSidebarWindow(prev, rsbWindow, !isSecondaryWindow())) return;
    const sessionId = sessionIdForDetachedSidebarClose(
      rsbWindow.hostSessionId ?? detachedHostSessionIdRef.current,
      rightSidebarSessionIdRef.current,
    );
    if (sessionId) writeCollapsedFor(sessionId, true);
  }, [rsbWindow]);

  // RSB Maximize(Phase 6):侧栏接管整个内容区。
  // - true:`<main>` 加 hidden(display:none),RSB 走 flex-1 占满整个非左栏区
  // - 全局 Esc 拦截退出 maximize(只在 maximize 态绑监听,避免抢占其它 Esc 行为)
  // - 折叠 RSB 时自动退出(否则 maximize 状态下点折叠会导致主区 hidden + RSB 也 0 宽 → 全黑)
  // - 不持久化:刷新 / 切 session 默认非 maximize,跟"临时聚焦视图"语义一致
  const [isRightSidebarMaximized, setIsRightSidebarMaximized] = useState(false);
  const rightSidebarOwnsRailChromeActions = resolveRightSidebarRailChromeActionsOwner({
    hasRailChromeActions,
    rightSidebarSide,
    rightSidebarAvailable,
    rightSidebarLoaded: rsbWindow.loaded,
    isRightSidebarCollapsed,
    isRightSidebarMaximized,
    rsbDetached,
  });
  const handleMaximizeRightSidebar = useCallback(() => {
    setIsRightSidebarMaximized((v) => !v);
  }, []);
  useEffect(() => {
    if (!isRightSidebarMaximized) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 输入态让路 —— 用户在 input / contenteditable 里按 Esc 通常是取消编辑。
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.closest?.('[contenteditable="true"]')
      ) {
        return;
      }
      setIsRightSidebarMaximized(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRightSidebarMaximized]);
  // 折叠 RSB / session 切换 / 主路由切走聊天视图 → 自动退出 maximize。
  useEffect(() => {
    if (isRightSidebarCollapsed && isRightSidebarMaximized) {
      setIsRightSidebarMaximized(false);
    }
  }, [isRightSidebarCollapsed, isRightSidebarMaximized]);
  useEffect(() => {
    if (!rightSidebarAvailable && isRightSidebarMaximized) {
      setIsRightSidebarMaximized(false);
    }
  }, [rightSidebarAvailable, isRightSidebarMaximized]);

  // ── 侧边栏子窗口(detached)联动 ─────────────────────────────────────────
  // 1) 上下文上推:sessionId / workdir / available 变化时无条件推给 main
  //    (main 缓存 + 只在子窗口开着时转发;无条件推让"开偏好瞬间"就有 context)。
  //    副窗的推送会被 main 按 sender 丢弃,这里不用特判。
  useEffect(() => {
    if (isSecondaryWindow()) return;
    window.electronAPI.rightSidebarWindow?.setContext({
      sessionId: rightSidebarSessionId,
      workdir: rightSidebarWorkdirInfo.workdir || null,
      remoteHostId: rightSidebarWorkdirInfo.remoteHostId,
      deviceLinkDeviceId: rightSidebarWorkdirInfo.deviceLinkDeviceId,
      subagentsAvailable: rightSidebarSubagentsAvailable,
      available: rightSidebarAvailable,
    });
  }, [
    rightSidebarSessionId,
    rightSidebarWorkdirInfo,
    rightSidebarSubagentsAvailable,
    rightSidebarAvailable,
  ]);

  // detached-closed 的 allowOpen=false intent 由 main 暂存；偏好切回 attached 时，
  // main 通过同一 command channel 把 ownership 交回当前主 renderer。
  useEffect(() => {
    if (isSecondaryWindow()) return;
    return window.electronAPI.rightSidebarWindow.onCommand((command) => {
      if (command.sessionId !== rightSidebarSessionIdRef.current) return;
      void executeSidebarCommand(command).catch((err) => {
        applicationMenuLog.warn('execute attached sidebar command failed', err);
      });
    });
  }, []);

  // 2) detach / attach 转换清理:
  //    - 内嵌 → 弹出:主窗内嵌 Shell 即将卸载 —— 退出 maximize、清本 renderer 的
  //      webview 池(否则僵尸 webview 留在停车区,且 main TabRegistry 指向旧窗口)、
  //      失效 store 缓存(子窗口接管后本窗缓存必然过期)。
  //    - 弹出 → 收回:重挂内嵌 Shell 前失效缓存(子窗口里新增/改过的 tab 重新拉),
  //      并展开当前会话(用户点了"合并回主窗口",预期立即看到内嵌侧栏)。
  const prevRsbDetachedRef = useRef(rsbDetached);
  useEffect(() => {
    const prev = prevRsbDetachedRef.current;
    prevRsbDetachedRef.current = rsbDetached;
    if (prev === rsbDetached) return;
    if (rsbDetached) {
      setIsRightSidebarMaximized(false);
      browserWebviewPool.releaseAll();
      // 终端 entry 的 ptyAttached 是 per-renderer 标记:宿主迁移后本窗的标记必然
      // 过期(PTY sink 会被对方窗口 re-attach 抢走),两个方向都要复位,否则
      // "弹出 → 合并回主窗"往返后 guard 跳过 re-attach,终端失活。
      markAllPtyDetached();
      resetCachesForHostTransition();
    } else {
      markAllPtyDetached();
      resetCachesForHostTransition();
      const sessionId = rightSidebarSessionIdRef.current;
      if (sessionId) {
        // The attached shell can mount before this parent transition effect.
        // Its initial hydrate then belongs to the cache generation that the
        // reset above invalidates. Start a fresh hydrate after the reset so a
        // persisted Windows session cannot remain on EMPTY_BUCKET forever.
        void ensureHydrated(sessionId).catch((err) => {
          applicationMenuLog.warn('rehydrate right sidebar after host transition failed', {
            sessionId,
            err,
          });
        });
        writeCollapsedFor(sessionId, false);
        setIsRightSidebarCollapsed(false);
      }
    }
  }, [rsbDetached]);

  // 3) 启动期只从 main 拉取当前进程状态。分离状态不跨客户端重启恢复；main 在
  //    controller 创建前已重置 detached / lastOpen，并清理旧版本遗留的偏好文件。
  const rsbWindowBootstrappedRef = useRef(false);
  useEffect(() => {
    if (rsbWindowBootstrappedRef.current) return;
    rsbWindowBootstrappedRef.current = true;
    if (isSecondaryWindow()) return;
    void bootstrapRsbWindowState();
  }, []);

  // 4) 「在新窗口打开」入口(mac 浮层 / win TabBar 按钮共用):开偏好 + 弹出。
  const handleDetachRightSidebar = useCallback(() => {
    if (isSecondaryWindow()) return;
    writeCollapsedFor(rightSidebarSessionId, false);
    const snapshot = getTabSnapshot(rightSidebarSessionId);
    const handoff = snapshot ? { snapshots: [snapshot] } : undefined;
    void window.electronAPI.rightSidebarWindow.setDetached(true, handoff).catch(() => undefined);
  }, [rightSidebarSessionId]);

  const handlePageZoomIn = useCallback(() => {
    void window.electronAPI.pageZoomIn();
  }, []);

  const handlePageZoomOut = useCallback(() => {
    void window.electronAPI.pageZoomOut();
  }, []);

  const handlePageZoomReset = useCallback(() => {
    void window.electronAPI.pageZoomReset();
  }, []);

  const newMakerShortcutInFlightRef = useRef(false);
  const handleNewMakerShortcut = useCallback(() => {
    if (newMakerShortcutInFlightRef.current) return;
    newMakerShortcutInFlightRef.current = true;
    void requestNewWorkerFromShortcut()
      .then((handled) => {
        if (handled) {
          applicationMenuLog.info('new-maker shortcut handled by visible collaboration panel');
          return;
        }
        applicationMenuLog.info('new-maker shortcut invoked, navigating to /cc-agent/new');
        navigate('/cc-agent/new');
      })
      .catch((err: unknown) => {
        applicationMenuLog.warn('new-maker shortcut routing failed', err);
      })
      .finally(() => {
        newMakerShortcutInFlightRef.current = false;
      });
  }, [navigate]);

  useEffect(() => {
    return window.electronAPI.onApplicationMenuCommand((command) => {
      switch (command) {
        case 'open-about':
          navigate('/settings?tab=about');
          break;
        case 'open-settings':
          if (currentPathRef.current !== '/settings') {
            navigate('/settings');
          }
          break;
        case 'open-agent-island-settings':
          if (isMac) {
            navigate('/settings?tab=agent-island');
          }
          break;
        case 'check-for-updates':
          void checkForUpdateWithToast(t);
          break;
        case 'open-release-notes':
          openNotice();
          break;
        case 'open-help':
          applicationMenuLog.info('Help clicked');
          navigate('/settings?tab=help&openPanel=help');
          break;
        case 'open-issues':
          navigate('/issues');
          break;
        case 'new-maker':
          // 等价于 CCAgentSidebarUpper.handleNewCCS (sidebar 顶部 "+ New Maker" 按钮):
          // 单步 navigate 到 /cc-agent/new, draft 状态由 NewMakerDraftRoute 自己读取。
          // 不重置 workingDir —— sidebar 按钮也不重置, 保留用户上次的目录上下文。
          applicationMenuLog.info('new-maker invoked, navigating to /cc-agent/new');
          navigate('/cc-agent/new');
          break;
        case 'new-maker-shortcut':
          handleNewMakerShortcut();
          break;
        case 'toggle-agent-island-sound':
          toggleAgentIslandSoundEnabled();
          break;
        case 'toggle-sidebar':
          // 菜单点击走这里。⌘B 按键由 MainLayout 内的 keydown 监听独立处理
          // (跳过非 Tiptap 的 contenteditable 以保留富文本编辑器的 Bold 能力),
          // 不依赖菜单 accelerator。
          handleToggleSidebar();
          break;
      }
    });
  }, [isMac, navigate, openNotice, t, handleNewMakerShortcut, handleToggleSidebar]);

  // ⌘B / Ctrl+B 切换侧边栏折叠 (组合键定义在 shared/appShortcuts registry,
  // 用户可改绑)。capture 阶段处理, 但需要为真正用到 Bold 的 contenteditable
  // 编辑器让路 —— 非 Tiptap 的 contenteditable 可能注册了 Bold mark,
  // 偷掉 ⌘B 会让 Mac / Windows 都失去加粗能力。
  //
  // ChatInput 的 Tiptap composer (.ProseMirror) 没注册 Bold mark, 让路给它只会
  // 让用户感知"启动后 ⌘B 不生效"(启动时 composer 立即自动 focus), 所以这里
  // 显式只跳过非 Tiptap 的 contenteditable: ProseMirror 节点仍 preventDefault,
  // 其它 contenteditable 编辑器走自己的 Bold 处理。
  useAppShortcut('toggle-sidebar', (e) => {
    const target = e.target as HTMLElement | null;
    const editable = target?.closest?.('[contenteditable="true"]') as HTMLElement | null;
    // 仅放行非 Tiptap 的 contenteditable, Tiptap 的 ProseMirror
    // 没 Bold 能力, 继续拦截以保证 sidebar 切换可用。
    if (editable && !editable.classList.contains('ProseMirror')) return false;
    handleToggleSidebar();
    return true;
  });

  // 打开命令行 (默认 ⌃`): 会话页有右侧栏时, 已有终端 tab 则聚焦、否则新建;
  // 右侧栏折叠态先展开。非会话路由 (右侧栏不存在) 不消费, 按键保持原生行为。
  //
  // 必须先 ensureHydrated 再 add/focus: rightSidebarAvailable 只代表
  // RightSidebar 已条件渲染, bucket 的 hydrate 是 RightSidebarShell effect 里
  // 异步触发的; 进会话后立刻按快捷键时若跳过 hydration, addTab 会以空 bucket
  // 乐观写入并标记 hydrated, 吞掉已持久化的 tabs 甚至重复新建终端。
  // await 之后校验会话未切换 (ref 取最新值), 避免把 tab 建到旧 session。
  const openTerminalShortcutAbortRef = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      openTerminalShortcutAbortRef.current?.abort();
      openTerminalShortcutAbortRef.current = null;
    },
    [rightSidebarSessionId],
  );

  const openTerminalForCurrentTask = useCallback((): boolean => {
    const sessionId = rightSidebarSessionId;
    if (!rightSidebarAvailable || !sessionId) return false;
    openTerminalShortcutAbortRef.current?.abort();
    const abortController = new AbortController();
    openTerminalShortcutAbortRef.current = abortController;
    void openTerminalFromShortcut({
      signal: abortController.signal,
      isCurrentSession: () => rightSidebarSessionIdRef.current === sessionId,
      routeCommand: () => routeSidebarCommand({ type: 'open-terminal', sessionId }),
      openAttachedTerminal: async () => {
        await ensureHydrated(sessionId);
        if (rightSidebarSessionIdRef.current !== sessionId) return;
        requestRightSidebarVisibility('open', { sessionId });
        await addOrFocusSingletonTab(sessionId, 'terminal');
      },
    })
      .then((result) => {
        if (result === 'exhausted') {
          applicationMenuLog.warn('open terminal via shortcut exhausted detached routing retries');
        }
      })
      .catch((err) => {
        applicationMenuLog.warn('open terminal via shortcut failed', err);
      })
      .finally(() => {
        if (openTerminalShortcutAbortRef.current === abortController) {
          openTerminalShortcutAbortRef.current = null;
        }
      });
    return true;
  }, [rightSidebarAvailable, rightSidebarSessionId]);

  useAppShortcut('open-terminal', openTerminalForCurrentTask);

  useEffect(() => {
    return subscribeWorkLouderCodexAction((action) => {
      if (action.type === 'keyboard') {
        const target =
          document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: action.key,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      }
      if (action.type !== 'command') return false;
      switch (action.commandId) {
        case 'newTask':
          navigate('/cc-agent/new');
          return true;
        case 'settings':
          navigate('/settings?tab=shortcuts&workLouderCodex=1');
          return true;
        case 'manageTasks':
          navigate('/cc-agent/scheduled');
          return true;
        case 'openSkills':
          navigate('/skillhub/local');
          return true;
        case 'feedback':
          navigate('/issues');
          return true;
        case 'openFolder':
          navigate('/cc-agent/new', { state: makeFolderPickerNewMakerRouteState() });
          return true;
        case 'navigateBack':
          navigate(-1);
          return true;
        case 'navigateForward':
          navigate(1);
          return true;
        case 'toggleSidebar':
          handleToggleSidebar();
          return true;
        case 'toggleRightSidebar':
          // Goes through the same handler as the UI button so the detached
          // (separate window) preference keeps its open/close semantics.
          handleToggleRightSidebar();
          return true;
        case 'session.selectPrevious':
          requestSessionSwitch('previous');
          return true;
        case 'session.selectNext':
          requestSessionSwitch('next');
          return true;
        case 'toggleTerminal':
          return openTerminalForCurrentTask();
        case 'openBrowserTab': {
          const sessionId = rightSidebarSessionIdRef.current;
          if (!sessionId) return false;
          void openUrlInSidebarBrowser(sessionId, 'about:blank').catch((error) =>
            applicationMenuLog.warn('Codex Micro browser action failed', error),
          );
          return true;
        }
        case 'toggleReviewTab': {
          const sessionId = rightSidebarSessionIdRef.current;
          if (!sessionId) return false;
          void (async () => {
            const routed = await routeSidebarCommand({ type: 'toggle-review-tab', sessionId });
            if (routed !== 'attached') return;
            if (rightSidebarSessionIdRef.current !== sessionId) return;
            await ensureHydrated(sessionId);
            if (rightSidebarSessionIdRef.current !== sessionId) return;
            const bucket = getBucket(sessionId);
            const reviewTab = bucket.tabs.find((tab) => tab.kind === 'review');
            const reviewIsActive =
              !isRightSidebarCollapsedRef.current &&
              reviewTab != null &&
              bucket.activeTabId === reviewTab.id;
            if (reviewIsActive && reviewTab) {
              await closeTab(sessionId, reviewTab.id);
              return;
            }
            requestRightSidebarVisibility('open', { sessionId });
            await addOrFocusSingletonTab(sessionId, 'review', null);
          })().catch((error) => applicationMenuLog.warn('Codex Micro review action failed', error));
          return true;
        }
        default:
          return false;
      }
    });
  }, [handleToggleRightSidebar, handleToggleSidebar, navigate, openTerminalForCurrentTask]);

  // ⌘W / Ctrl+W ('close-tab-or-window', 不可改绑): 用户"在右侧栏内"且有激活
  // tab → 只关那个 tab (与点 tab 上的 × 同路径, terminal 走 onBeforeClose
  // dispose PTY); 否则 mac 走 windowCloseSelf 关(隐藏)本窗口, 与原生菜单 role
  // close 行为一致; win/linux 不消费 (Ctrl+W 此前无任何绑定, 且主窗关闭 =
  // 退出 app, 不能挂在 Ctrl+W 上)。
  //
  // "在右侧栏内"的判定分两层: activeElement 有效 (非 body) 时以键盘焦点为准
  // (有意为之: 焦点在 composer 等输入框里时 ⌘W 关窗符合 mac 惯例, 不被面板的
  // 历史交互抢走); 右侧栏里大量区域不可聚焦 (review diff 正文 / 面板空白处),
  // 点击后焦点被 blur 回 body, 此时回落到最近一次 pointerdown / wheel 交互是否
  // 落在 RSB 领地 (RSB_TERRITORY_SELECTOR: aside 本体或 RSB 的 body portal 浮层)
  // 内 —— 否则用户明明在面板里
  // 操作, ⌘W 却把整个窗口收起来 (Codex review P2, wheel 补充同轮 P2)。副作用上
  // 这也让"连续 ⌘W 逐个关 tab"可用: 关 tab 后焦点落回 body, 交互标记仍在面板内。
  // detached / 折叠态下两层判定都不可能命中内嵌 aside, 直接走窗口分支;
  // webview guest 内的 ⌘W 由 main 端 webview-security 拦截转发 'close-tab',
  // 不经过本监听。
  const lastInteractionInRsbRef = useRef(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      lastInteractionInRsbRef.current = Boolean(target?.closest(RSB_TERRITORY_SELECTOR));
    };
    window.addEventListener('pointerdown', handler, true);
    // wheel 必须 passive —— 只记录区域, 不 preventDefault, 不能拖累滚动性能。
    window.addEventListener('wheel', handler, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
    };
  }, []);
  // 声明壳层所有权 —— App 根的 useCloseWindowFallbackShortcut 在本布局挂载期间
  // 让路, ⌘W 由下面的焦点分派消费点接管。
  useCloseShortcutShellOwner();
  useAppShortcut('close-tab-or-window', () => {
    const sessionId = rightSidebarSessionId;
    const activeEl = document.activeElement;
    const userInRsb =
      activeEl && activeEl !== document.body
        ? Boolean(activeEl.closest(RSB_TERRITORY_SELECTOR))
        : lastInteractionInRsbRef.current;
    if (sessionId && !rsbDetached && !isRightSidebarCollapsed && userInRsb) {
      const bucket = getBucket(sessionId);
      if (bucket.activeTabId) {
        void closeTab(sessionId, bucket.activeTabId).catch((err) => {
          applicationMenuLog.warn('close sidebar tab via shortcut failed', err);
        });
        return true;
      }
    }
    if (!isMac) return false;
    window.electronAPI.windowCloseSelf();
    return true;
  });

  // 页面缩放 (Windows / Linux only —— registry 的 platforms 限定, macOS 由系统
  // 菜单 role 承担, 这里的监听在 mac 上拿不到组合永不命中)。
  const zoomGuard = (e: KeyboardEvent): boolean => !isZoomShortcutBlockedTarget(e.target);
  useAppShortcut(
    'zoom-in',
    (e) => {
      if (!zoomGuard(e)) return false;
      handlePageZoomIn();
      return true;
    },
    { stopImmediate: true },
  );
  useAppShortcut(
    'zoom-out',
    (e) => {
      if (!zoomGuard(e)) return false;
      handlePageZoomOut();
      return true;
    },
    { stopImmediate: true },
  );
  useAppShortcut(
    'zoom-reset',
    (e) => {
      if (!zoomGuard(e)) return false;
      handlePageZoomReset();
      return true;
    },
    { stopImmediate: true },
  );

  return (
    // Shell wraps its entire subtree (Sidebar + <Outlet /> inside <main>) in
    // the feature-sidebar slot provider. Any Feature Layout rendered through
    // <Outlet /> can inject its own sidebar upper content via
    // useRegisterSidebarUpper, and the Sidebar Shell reads it via
    // useFeatureSidebarUpper. See apps/desktop/src/renderer/features/feature-context.tsx.
    //
    // Codex 风格布局（原"顶栏 + 下方左右分栏"翻转为"左右分栏 + 右栏自带顶栏"）：
    //   - Sidebar 通顶到窗口顶部，顶行承载 mac 红绿灯让位 / Tabbar / MenuButton /
    //     折叠按钮（见 Sidebar.tsx）。
    //   - 右侧 <main> 第一行是 ContentHeader Shell：窗口拖拽区 + Windows 窗口
    //     控制按钮 + 折叠态快捷按钮回流；中部由路由视图注入（会话标题等）。
    //   - 设置页：Sidebar 隐藏不变，ContentHeader 退化为"隐形 chrome"（无折叠
    //     按钮，仅拖拽区 + Windows 窗口控制 + mac 红绿灯让位）。
    // sidebar-card-mode: rail 态(拖到最窄 64px)在 slot provider 上与 collapsed 同义
    // (都表达"窄布局"),Sidebar 另收 isRail 区分"完全隐藏 vs 窄轨"。
    // peek 可见期强制展开语义:抽屉里要呈现完整展开列表(ExpandedView)。
    <FeatureSidebarSlotProvider
      isCollapsed={sidebarPeek.isPeekVisible ? false : isSidebarCollapsed || isRailMode}
    >
      <div
        ref={rowRef}
        className={cn(
          'relative flex h-screen bg-content-area text-foreground',
          isDragging && 'select-none cursor-col-resize',
        )}
      >
        {/* 左侧占位块 wrapper(B1a):透传容器,包住 pinning spacer + Sidebar,
            作为可用宽度测量的唯一观测目标(见 paneWidths 的测量 Provider)。
            flex + shrink-0 与 aside 原有的 flex child 行为一致,不改变布局;
            peek 期 aside 变 fixed 出流,wrapper 宽度自然等于流内 spacer 宽。 */}
        {!isSettingsRoute && (
          <div ref={sidebarBlockRef} className="flex shrink-0">
            {/* pinning 冻结期的流内占位:抽屉保持 fixed 不动,由本 spacer 跑 0→W 的
                250ms 宽度动画把主区推开;动画结束(peekState 回 idle)后同一帧内
                spacer 卸载、aside 摘掉 fixed 落回流内 —— 两者矩形一致,交换无跳变。 */}
            {sidebarPeek.peekState === 'pinning' && <SidebarPinSpacer width={sidebarWidth} />}
            <Sidebar
              isCollapsed={isSidebarCollapsed}
              // peek 抽屉恒以展开态呈现(预览完整列表),rail 视觉在 peek 期强制关闭。
              isRail={sidebarPeek.isPeekVisible ? false : isRailMode}
              width={sidebarWidth}
              isDragging={isDragging}
              forceMountFeatureContent={location.pathname === '/cc-agent/new'}
              onDragStart={handleDragStart}
              onResetWidth={resetWidth}
              onOpenUpdateNotice={openNotice}
              onOpenVersionNotice={openVersionNotice}
              peekState={sidebarPeek.isPeekVisible ? sidebarPeek.peekState : null}
              peekDrawerProps={sidebarPeek.drawerProps}
            />
          </div>
        )}
        {/* 浮动 chrome 按钮簇（折叠 + 菜单）：absolute 浮在 Sidebar / Header
            之上，钉死窗口左上角红绿灯旁,不随侧栏折叠/展开/peek 移动
            （见 ChromeActions.tsx）。设置页隐藏（侧栏本身不显示，无折叠语义）。 */}
        {!isSettingsRoute && (
          <ChromeActions
            isSidebarCollapsed={isSidebarCollapsed}
            onToggleSidebar={handleToggleSidebar}
            peekTriggerProps={sidebarPeek.triggerProps}
          />
        )}
        {/* 布局树引擎:聊天主区与工具面板的**顺序与在场**改由
            布局树(userData/layout.v1.json)驱动,渲染链 LayoutRoot → 面板注册表
            (renderer/panels)。两大块 JSX 原样保留在 bridge 里 —— 构造与状态
            所有权仍在 MainLayout(绞杀式重构 Step A:只换骨架不动组件;尺寸/
            折叠仍由既有 props 驱动,树上 fraction 暂不参与渲染)。LayoutRoot 的
            root split 在专属内容区 flex 容器内扁平化；稳态窗口 resize 的 pane 宽度
            由 CSS 百分比相对剩余内容宽直接响应，不再把连续窗口宽度发布进 React)。 */}
        <BuiltinPanelBridgeProvider
          value={{
            // 会话列表是树外全高固定柱,由上方 <Sidebar/> 直接渲染,此槽 Step A 不消费。
            sessionList: null,
            chatMain: (
              <main
                ref={mainRef}
                // PanelDragController(拖面板换位,B3 转正)手势根:聊天区的标题条
                // 手势面是 ContentHeader(Windows),窗体长按亦可。
                data-panel-drag-root="chat-main"
                className={cn(
                  'relative flex flex-1 flex-col overflow-hidden bg-content-area',
                  isSettingsRoute ? 'min-w-0' : 'min-w-[400px]',
                  // RSB Maximize(Phase 6):主区彻底 display:none,把整个非左栏空间让给 RSB。
                  isRightSidebarMaximized && 'hidden',
                )}
              >
                {/* showCollapsedActions: 完全隐藏(isSidebarCollapsed)**和** rail 态(isRailMode)
                    都要为浮动 ChromeActions 簇预留 68px 占位 —— rail 下侧栏仅 64px,chrome 簇
                    贴在 rail 右缘(见上方 sidebarWidth),不留占位会压住会话标题左侧。 */}
                {/* rail 态在 sidebarVisible 口径里视同"不可见"(codex review): 否则 mac 无
                    headerContent 路由下 ContentHeader 会因 sidebarVisible=true 提前 return null,
                    我们为 rail 浮动 chrome 预留的 spacer 不渲染、按钮悬空。 */}
                <ContentHeaderSlot
                  sidebarVisible={!isSettingsRoute && !isSidebarCollapsed && !isRailMode}
                  showCollapsedActions={!isSettingsRoute && (isSidebarCollapsed || isRailMode)}
                  isSidebarRail={hasRailChromeActions && !rightSidebarOwnsRailChromeActions}
                  // M2(2026-07-09 口径修订):mac 右上浮层随面板在场常驻(折叠
                  // toggle 永远钉窗口右上角),ContentHeader 右端占位不再分侧别。
                  rightSidebarAvailable={rightSidebarAvailable}
                >
                  {/* key 取 feature 段（pathname 第一段）而非完整 pathname：
                    跨 Feature 切换（/issues → /cc-agent）触发 FadeSwitcher 重挂跑淡入动画；
                    同一 Feature 内的 detail 切换（/issues/aaa → /issues/bbb）保持同 key，
                    不重挂主区域子树，避免详情页 unmount + 220ms opacity
                    重跑导致的"刷新一帧"闪烁。
                    ContentHeader 在 FadeSwitcher 之外 —— header chrome 不参与路由切换
                    动画，只有注入的中部内容随路由变化。 */}
                  {/* 持久凭证库故障全局警示条(#1687):ContentHeader 之下、路由内容之上,
                      shrink-0 在 main 的 flex 列里独占一行把内容推下(不遮盖)。放在
                      FadeSwitcher 之外 —— 它是全局状态提示,不参与路由切换动画。 */}
                  <CredentialStoreBanner />
                  {!isMac &&
                    rightSidebarAvailable &&
                    rsbWindow.loaded &&
                    (rsbDetached || isRightSidebarCollapsed) && (
                      <div
                        data-testid="right-sidebar-fixed-trigger"
                        className={cn(
                          'pointer-events-none absolute z-50',
                          rightSidebarSide === 'left' ? 'left-2' : 'right-2',
                        )}
                        style={
                          {
                            top: 'calc(var(--content-header-h) + 0.25rem)',
                            WebkitAppRegion: 'no-drag',
                          } as React.CSSProperties
                        }
                      >
                        <RightSidebarToggle
                          action="show"
                          collapsed
                          onToggle={handleOpenRightSidebar}
                          side={rightSidebarSide}
                        />
                      </div>
                    )}
                  <FadeSwitcher key={location.pathname.split('/')[1] || 'root'}>
                    <Outlet
                      context={{
                        sidebarWidth,
                        // detached 时主窗口没有内嵌侧栏，始终按折叠态布局；子窗口开闭
                        // 不改变主窗口浮动控件的占位语义。
                        rightSidebarCollapsed: rsbDetached || isRightSidebarCollapsed,
                        onToggleRightSidebar: handleOpenRightSidebar,
                        // B2b:面板所在侧,聊天视图据此决定展开入口落左上还是右上。
                        rightSidebarSide,
                        setRightSidebarAvailable,
                        setRightSidebarSessionId: declareRightSidebarSessionId,
                        setRightSidebarWorkdir,
                      }}
                    />
                  </FadeSwitcher>
                </ContentHeaderSlot>
              </main>
            ),
            // 右侧边栏 —— 工具面板。在场性沿用原语义:路由声明 rightSidebarAvailable
            // (仅全屏聊天视图在场)+ detached(在新窗口显示)时内嵌不渲染
            // (webview 池 / 终端等资源不能双实例,内容由子窗口 renderer 独占)。
            rightTabs:
              rightSidebarAvailable && rsbWindow.loaded && !rsbDetached ? (
                <RightSidebar
                  ref={rightSidebarRef}
                  isCollapsed={isRightSidebarCollapsed}
                  // width 只在非 maximize 受控,且只是兜底 —— RSB 优先消费
                  // 引擎 PaneWidthContext 的实时值;maximize 时 RightSidebar 内部走
                  // flex-1 自己撑满(2026-07-01 bug 修)。拖宽把手 = 引擎分割线。
                  width={rightSidebarWidth}
                  isMac={isMac}
                  // Windows 展开态的折叠入口归属工具面板自身,放回 TabBar 右端;
                  // 收起后聊天区角上才显示展开入口。mac 仍走窗口右上浮层。
                  onCloseSidebar={handleCloseRightSidebar}
                  onMaximize={handleMaximizeRightSidebar}
                  isMaximized={isRightSidebarMaximized}
                  reserveLeftChromeActions={shouldReserveLeftChromeActions({
                    isSidebarCollapsed,
                    rightSidebarSide,
                    isRightSidebarMaximized,
                  })}
                  railChromeActionsHitHole={rightSidebarOwnsRailChromeActions}
                  sessionId={rightSidebarSessionId}
                  workdir={rightSidebarWorkdirInfo.workdir}
                  remoteHostId={rightSidebarWorkdirInfo.remoteHostId}
                  deviceLinkDeviceId={rightSidebarWorkdirInfo.deviceLinkDeviceId}
                  subagentsAvailable={rightSidebarSubagentsAvailable}
                  onDetach={isSecondaryWindow() ? undefined : handleDetachRightSidebar}
                  // M2:面板贴左时 detach / maximize 由 Shell 顶栏右端自渲染
                  // (面板自属控件跟面板走);折叠 toggle 恒在窗口右上浮层,不下沉。
                  panelSide={rightSidebarSide}
                  onAllTabsClosed={handleRightSidebarEmptied}
                />
              ) : null,
          }}
        >
          {/* 面板稳态宽度由 LayoutRoot 输出 CSS 百分比/clamp，BrowserWindow live resize
              不再逐像素回灌 React；设置页接管时非 chat 面板统一歇业。 */}
          <LayoutRoot suppressNonChatPanels={isSettingsRoute} />
        </BuiltinPanelBridgeProvider>
        {/* 拖面板换位(B3 转正;M3 起 mac 同步开闸——mac 顶栏全部保留窗口拖拽,
            手势天然只剩长按窗体)。总开关只管全局语境(内容区路由在场、非
            maximize 撑满态);"哪些面板当下可换位"不在这里猜 —— N 面板
            通用,控制器起拖时按布局树现场收集落点,折叠/隐藏(无身体)的面板
            被 isDroppableRect 过滤,一个落点都没有就不浮起。曾经的
            !isRightSidebarCollapsed 写死条件是 B3 双面板时代遗产:右栏一折叠
            连意识面板的换位也被整体关掉(2026-07-08 Lizi 实测发现)。 */}
        <PanelDragController
          rowRef={rowRef}
          sidebarBlockRef={sidebarBlockRef}
          enabled={rightSidebarAvailable && !isRightSidebarMaximized}
        />
        {/* 意识面板「点图看大图」承接端:main 拦下面板 /preview/ 导航过闸后
            推送到本窗口,这里弹标准 ImageLightbox(整窗一份,纯监听无 UI)。
            sessionId = 当前聊天会话 → lightbox 里「发送到对话」可用。 */}
        <GhostMediaLightboxHost sessionId={rightSidebarSessionId ?? undefined} />
        {/* 最小化插件面板的浮动气泡层(portal 到 body,z-[9900];点击气泡
            恢复停靠,拖动换位并持久化)。设置页等接管态也保持在场——气泡是
            被最小化面板的唯一恢复入口。 */}
        <GhostPanelBubbleLayer />
        {/* Windows 顶层浮层 chrome：窗口控制按钮(min/max/close)，所有路由常驻
            （含设置页），永远钉在窗口角，开/关右栏都不动 —— 解决「右栏作为 <main>
            sibling 会把窗口按钮挤左」的问题。no-drag（按钮可点），周围窗口拖拽区由
            ContentHeader / 左栏顶行提供。
            mac 不渲染本块（用系统红绿灯）。Windows 固定侧栏入口保留在内容区
            右上角（系统按钮下一行），与截图中的原位置一致。 */}
        {!isMac && (
          <div
            className="absolute right-0 top-0 z-50 flex h-[46px] items-center pr-2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls />
          </div>
        )}
        {/* mac 右栏折叠按钮 —— 同样 hoist 到顶层浮层，钉窗口右上角（right-0 top-0）、
            浮在右栏之上，与左栏折叠按钮（ChromeActions，钉左上角）左右对称。
            右栏打开时落在右栏顶部 toolbar 横贯条的右端、关闭时落在 main 的
            ContentHeader 右端 —— 无论开/关都「始终在窗口最右」（用户 2026-06-15
            诉求）。仅全屏聊天视图在场时渲染（rightSidebarAvailable）；mac 那侧本就
            没有窗口控制按钮，这个位置空着正好。no-drag 保证可点，ContentHeader /
            右栏 toolbar 条已为它留出等宽占位。 */}
        {/* M2(mac 交换态适配,2026-07-09 Lizi 口径修订):浮层只要面板在场就渲染,
            折叠 toggle **永远钉窗口右上角**(即当前最右侧 pane 顶栏的右上角),与
            左上角的左栏折叠按钮(ChromeActions)对称、不跟面板跑;detach/maximize
            是面板自属控件,贴右(或 maximize 撑满)时在浮层里(视觉落在面板顶栏
            右端),贴左时跟面板走进 Shell 顶栏右端(见 RightSidebarShell)。 */}
        {isMac &&
          rightSidebarAvailable &&
          rsbWindow.loaded &&
          (rsbDetached || isRightSidebarCollapsed) && (
            <div
              className="absolute right-0 top-0 z-50 flex h-[46px] items-center gap-1 pr-2"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              {/* 固定唤起入口只负责显示 / 聚焦。detach / maximize / 收起属于面板自身，
                在 RightSidebarShell 的顶栏内渲染，不再与本入口混用。 */}
              <RightSidebarToggle
                size="toolbar"
                action="show"
                collapsed={rsbDetached ? !rsbWindow.open : isRightSidebarCollapsed}
                onToggle={handleOpenRightSidebar}
                side={rightSidebarSide}
              />
            </div>
          )}
      </div>
      {/* Update notice dialog -- mounted inside FeatureSidebarSlotProvider (ThemeProvider scope) */}
      {releaseNotes && (
        <UpdateNoticeDialog
          open={noticeOpen}
          mode={noticeMode}
          releaseNotes={releaseNotes}
          allVersions={noticeAllVersions}
          loadVersion={noticeLoadVersion}
          onDismiss={dismissNotice}
        />
      )}
      {/* FeiShu Bot conflict dialog -- subscribes to main process push and surfaces a global modal */}
      <FeishuConflictDialogHost />
      {/* 窗口级拖拽兜底:拖 .cshare 进窗口空白处 → 会话导入向导 */}
      <GlobalDropImportListener onOpenShareImport={openShareImport} />
      {shareImportRequest && (
        <SessionShareImportWizard
          key={shareImportRequest.id}
          open
          initialFilePath={shareImportRequest.filePath}
          onOpenChange={handleShareImportOpenChange}
        />
      )}
      {/* RSB Phase 4:web-browser plugin 的 webview 池占位组件。pool 本身是模块
          单例 + vanilla DOM,这里只挂一个空 React 节点,Phase 6 maximize 时
          会在这里加 layout 控制。 */}
      <BrowserWebviewPool />
      {/* 被控端可见性:主聊天页在输入区内联渲染;其它页面保留全局兜底。 */}
      {!hasInlineControlledBanner && <ControlledBanner />}
    </FeatureSidebarSlotProvider>
  );
}
