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
 * Phase 2 简化保留:错误打日志、所有 IPC 失败本地回滚 + log(无 toast),Phase 7 收尾接 toast。
 *
 * sessionId / workdir 由 host 透:
 *   - sessionId 为 null = 不在 cc-agent 路由,Shell 渲染空状态,store 不工作;
 *   - workdir 为空串 = remote session 或还没解析,plugin 自行降级渲染占位。
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { RightSidebarDetach } from '@/components/layout/RightSidebarDetach';
import { RightSidebarMaximize } from '@/components/layout/RightSidebarMaximize';
import { CHROME_ACTIONS_GEOMETRY } from '@/components/layout/chromeActionsGeometry';
import { TabBar, TabStrip } from './TabBar';
import { EmptyState } from './EmptyState';
import {
  getTabKind,
  hydrateTabState,
  listGhostTabMenuMetas,
  useTabKindRegistryVersion,
} from './registry';
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

const log = createLogger('rightSidebar.shell');
/**
 * Mac 合并顶栏右端 spacer 宽度,对应 MainLayout 浮层按钮簇(MainLayout.tsx
 * `isMac && rightSidebarAvailable` 那块 `absolute right-0 top-0 z-50` 浮层)
 * 展开态的占宽:3 个 h-7 w-7 按钮(detach / maximize / 折叠,28×3=84;
 * #650 起与左簇统一 28px 规格族)+ gap-1 × 2(4×2=8)+ pr-2(8)= 100。
 * 两处没有共享常量(浮层用 tailwind 类布局,绑不到同一个数字上),MainLayout
 * 侧增删按钮 / 改间距时必须同步核对本值,否则 tab strip 会被浮层遮挡或留白。
 */
const MAC_HEADER_ACTION_SPACER_PX = 100;
type RightTabDirection = 'prev' | 'next';

interface RightSidebarShellProps {
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
  /** 「在新窗口中打开侧边栏」;仅 Win 端 TabBar 内渲染按钮(Mac 走 MainLayout 浮层)。 */
  onDetach?: () => void;
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
  sessionId,
  workdir,
  remoteHostId,
  shellVisible = true,
  isMac,
  unifiedTopbar = false,
  onCloseSidebar,
  onMaximize,
  isMaximized,
  onDetach,
  chromeWindowDrag = true,
  panelSide = 'right',
  onAllTabsClosed,
  reserveLeftChromeActions = false,
  railChromeActionsHitHole = false,
}: RightSidebarShellProps) {
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

  useEffect(() => {
    // Phase 5: 推送当前焦点 RSB sessionId 给 main,让 RsbWebviewBackend 拿到。
    // null 也推(切到非 RSB 路由时),让 main 端清掉 active session — 否则
    // 之前的 sessionId 会成 stale 引用。setActiveSession 失败容错(preload 未就绪)。
    void window.electronAPI?.rsbBrowserBridge
      ?.setActiveSession({ sessionId })
      .catch(() => undefined);
    if (!sessionId) return;
    // 首次访问该 sessionId 时触发 IPC list 拉取;命中 cache 直接 noop。
    // 完成后 setBucket → notify → subscribeBucket 唤醒 useSyncExternalStore 重渲染。
    void ensureHydrated(sessionId).catch((err) => {
      log.error('ensureHydrated failed', { sessionId, err });
    });
  }, [sessionId]);

  const tabs = bucket.tabs;
  const activeTabId = bucket.activeTabId;

  // 插件页签(panel.position:'tab')随装/卸/停用动态注册,版本号驱动重渲——
  // EmptyState 的插件行与「+」菜单动态分组都吃这份数据。
  const tabRegistryVersion = useTabKindRegistryVersion();
  // 注册表是模块级 Map,不在 React 数据流里 —— 版本号是唯一变化信号,拿它当 dep。
  const ghostTabMetas = useMemo(() => listGhostTabMenuMetas(), [tabRegistryVersion]);

  // 关掉最后一个 tab → 通知 host 自动收起侧栏。只在 tab 数「从 >0 变 0」的转变时
  // 触发,不是"等于 0"就触发:
  //   - hydrated 后首帧 prev===null 不触发(区分"刚加载出来就是空"与"关到空");
  //   - 展开一个本就 0-tab 的 session 也不会被立刻折叠,用户仍能在 EmptyState 加 tab。
  // sessionId 变化时重置计数,避免"切到一个空 session"被误判成"关空"。
  const prevTabCountRef = useRef<number | null>(null);
  useEffect(() => {
    prevTabCountRef.current = null;
  }, [sessionId]);
  useEffect(() => {
    if (!bucket.hydrated) return; // 未 hydrate 的空数组不算"关空"
    const prev = prevTabCountRef.current;
    prevTabCountRef.current = tabs.length;
    if (prev !== null && prev > 0 && tabs.length === 0) {
      onAllTabsClosed?.();
    }
  }, [bucket.hydrated, tabs.length, onAllTabsClosed]);

  const handleAdd = useCallback(
    (kind: TabKindId) => {
      if (!sessionId) {
        log.warn('handleAdd ignored: sessionId is null', { kind });
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
      const action = isSingleton
        ? addOrFocusSingletonTab(sessionId, kind, initialState)
        : addTab(sessionId, kind, initialState);
      void action.catch((err) => {
        // TODO(Phase 7): toast 暴露 RIGHT_SIDEBAR_TOO_MANY_TABS / STATE_TOO_LARGE 等错误码。
        log.error('handleAdd failed', { sessionId, kind, err });
      });
    },
    [sessionId],
  );

  const handleClose = useCallback(
    (tabId: string) => {
      if (!sessionId) return;
      void closeTab(sessionId, tabId).catch((err) => {
        log.error('handleClose failed', { sessionId, tabId, err });
      });
    },
    [sessionId],
  );

  const handleActivate = useCallback(
    (tabId: string) => {
      if (!sessionId) return;
      void setActiveTab(sessionId, tabId).catch((err) => {
        log.error('handleActivate failed', { sessionId, tabId, err });
      });
    },
    [sessionId],
  );

  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      if (!sessionId) return;
      void reorderTabs(sessionId, orderedIds).catch((err) => {
        log.error('handleReorder failed', { sessionId, orderedIds, err });
      });
    },
    [sessionId],
  );

  const handleCycleTab = useCallback(
    (direction: RightTabDirection): boolean => {
      if (!sessionId) return false;
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
      void setActiveTab(sessionId, nextTabId).catch((err) => {
        log.error('cycle right sidebar tab failed', { sessionId, direction, nextTabId, err });
      });
      return true;
    },
    [activeTabId, sessionId, shellVisible, tabs],
  );

  useAppShortcut('right-tab-prev', () => handleCycleTab('prev'), {
    enabled: Boolean(sessionId),
    stopImmediate: true,
  });
  useAppShortcut('right-tab-next', () => handleCycleTab('next'), {
    enabled: Boolean(sessionId),
    stopImmediate: true,
  });

  // 右键菜单"关闭其他":关掉除 keep 外的所有 tab。
  // 用现有 closeTab 串行 await(避免一次 close 多个时位置 reorder 竞态);
  // store 单 IPC 调用很轻,N=5 也只是几十 ms,Phase 7 如果要优化再加 batch close API。
  const handleCloseOthers = useCallback(
    async (keepTabId: string) => {
      if (!sessionId) return;
      const targets = bucket.tabs.filter((t) => t.id !== keepTabId).map((t) => t.id);
      for (const tabId of targets) {
        try {
          await closeTab(sessionId, tabId);
        } catch (err) {
          log.error('handleCloseOthers: closeTab failed', { sessionId, tabId, err });
          break; // 串行下一个失败时停止,避免连环错误
        }
      }
    },
    [sessionId, bucket.tabs],
  );

  // 右键菜单"关闭所有":关掉本 session 的全部 tab。
  const handleCloseAll = useCallback(async () => {
    if (!sessionId) return;
    const targets = bucket.tabs.map((t) => t.id);
    for (const tabId of targets) {
      try {
        await closeTab(sessionId, tabId);
      } catch (err) {
        log.error('handleCloseAll: closeTab failed', { sessionId, tabId, err });
        break;
      }
    }
  }, [sessionId, bucket.tabs]);

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
    if (!sessionId) return;
    const off = window.electronAPI.onRsbBrowserCommand(({ command }) => {
      if (command === 'right-tab-prev') {
        handleCycleTab('prev');
      } else if (command === 'right-tab-next') {
        handleCycleTab('next');
      }
    });
    return off;
  }, [handleCycleTab, sessionId]);

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
            tabs={tabs}
            activeTabId={activeTabId}
            sessionId={sessionId}
            onActivate={handleActivate}
            onClose={handleClose}
            onReorder={handleReorder}
            onAdd={handleAdd}
            onCloseOthers={handleCloseOthers}
            onCloseAll={handleCloseAll}
            pillVariant="chip"
            addButtonWrapperClassName="h-[30px]"
          />
          {/* 右端两态(M2,2026-07-09 Lizi 口径修订):
              - 贴右(默认)/ maximize 撑满:MainLayout 的 mac 浮层按钮钉在窗口
                右上角(此时正压在本顶栏右端),这里用固定 spacer 给 detach /
                maximize / 折叠三按钮让位,避免 tab strip 展开时压到浮层下方。
              - 贴左(非 maximize):窗口右上浮层只剩折叠 toggle(钉在最右 pane
                = 聊天区的顶栏角上,不跟面板跑),面板自属控件跟面板走 —— 在本
                顶栏右端渲染真按钮(detach + maximize)。 */}
          {panelSide === 'left' && !isMaximized ? (
            <div
              data-testid="right-sidebar-topbar-actions"
              className="flex h-full shrink-0 items-center gap-1"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              {onDetach && <RightSidebarDetach size="toolbar" onDetach={onDetach} />}
              {onMaximize && (
                <RightSidebarMaximize
                  size="toolbar"
                  onMaximize={onMaximize}
                  isMaximized={isMaximized}
                />
              )}
            </div>
          ) : (
            <div
              aria-hidden
              className="pointer-events-none h-full shrink-0"
              style={{ width: MAC_HEADER_ACTION_SPACER_PX }}
            />
          )}
        </div>
      ) : (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          sessionId={sessionId}
          onActivate={handleActivate}
          onClose={handleClose}
          onReorder={handleReorder}
          onAdd={handleAdd}
          showWindowControls={!isMac}
          onMaximize={onMaximize}
          onCloseSidebar={onCloseSidebar}
          isMaximized={isMaximized}
          onDetach={onDetach}
          onCloseOthers={handleCloseOthers}
          onCloseAll={handleCloseAll}
          chromeWindowDrag={chromeWindowDrag}
        />
      )}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
        {/* 首次切到某 session 时 cache 尚未 hydrate(等 IPC list 回包),保留 panel
            背景而非闪 EmptyState —— EmptyState 是"真的没 tab"的 Welcome 内容。
            sessionId 为 null 也走这条:Shell 不显示任何内容(无激活会话)。 */}
        {!bucket.hydrated ? null : tabs.length === 0 ? (
          // tab 列表为空时永远渲染 EmptyState。审查页签只通过「+」dropdown 或
          // EmptyState 的"打开审查"入口由用户主动创建。
          <EmptyState
            onAddFileTab={() => handleAdd('file-browser')}
            onAddReviewTab={() => handleAdd('review')}
            onAddBackgroundTasksTab={() => handleAdd('background-tasks')}
            onAddBrowserTab={() => handleAdd('web-browser')}
            onAddTerminalTab={() => handleAdd('terminal')}
            ghostTabMetas={ghostTabMetas}
            onAddGhostTab={handleAdd}
          />
        ) : (
          // 所有 tab 都挂载,只切换可见性(规则 7:杜绝切顶层 tab 时 plugin 内部 state /
          // webview / 编辑器 / 文件树 expansion 全部丢失重建)。pointer-events 用
          // `hidden` 自然 disable,visibility 状态由 onVisibilityChange 给 plugin。
          tabs.map((tab) => (
            <PluginBodyHost
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              sessionId={sessionId}
              workdir={workdir}
              remoteHostId={remoteHostId}
              shellVisible={shellVisible}
              t={t}
            />
          ))
        )}
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
      setCloseInterceptor: (interceptor) =>
        setTabCloseInterceptor(tab.id, interceptor),
    }),
    [sessionId, workdir, remoteHostId, tab.id],
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
        <plugin.TabBody
          state={hydratedState}
          ctx={ctx}
          active={active}
          shellVisible={shellVisible}
        />
      ) : (
        <PlaceholderBody tab={tab} t={t} />
      )}
    </div>
  );
}

/** Plugin 未注册的兜底。 */
function PlaceholderBody({ tab, t }: { tab: TabState; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-tertiary)]">
      <span>{t('rightSidebar.tabs.placeholderHint', { kind: tab.kind })}</span>
    </div>
  );
}
