/**
 * RightSidebar Shell —— 右侧边栏外壳(与左侧 Sidebar 对称)。
 *
 * 职责:
 *   - 宽度 / 背景 / 折叠-展开 250ms 过渡动画
 *   - 朝聊天区一侧的 resize handle(拖动改宽,双击复位;边缘由 resizeEdge 决定,
 *     经典布局在左边缘,面板被布局树换到聊天区左侧时在右边缘)
 *
 * 内容容器是 `<RightSidebarShell>`(`features/right-sidebar/`),负责 TabBar + 各
 * plugin TabBody。aside 这一层只关心壳子动画与拖宽,内部布局由 Shell 自管。
 *
 * 视觉走主题 token(规则 16)。
 */

import {
  type CSSProperties,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { RightSidebarShell } from '@/features/right-sidebar/RightSidebarShell';
import { usePanelWidth } from '@/layout/paneWidths';
import { CHAT_AREA_MIN_WIDTH } from '@/hooks/useRightSidebarResize';
import { CHROME_ACTIONS_GEOMETRY } from './chromeActionsGeometry';

/**
 * RightSidebar 暴露给父层(MainLayout)的命令式句柄。
 *
 * 设计原则:**动画只在用户主动 toggle 按钮**时跑;sessionId 切换 / 草稿切换 / init / 任何其它
 * isCollapsed prop 变化都**直接同步**不动画。toggle 按钮 onClick 时父层调用
 * `requestAnimateNextChange()` 主动 prime 一次,RightSidebar 看到这个标记后才让下一次 prop
 * 变化走 250ms 动画;不主动 prime → 默认无动画。
 *
 * 避免了之前用 ref / effect 推断"prop 变化是 toggle 还是 cascade"的脆弱逻辑(N+1/N+2 race、
 * sessionChanged 误判等)—— toggle 是事件源,理应由事件源显式声明动画意图。
 */
export interface RightSidebarHandle {
  /** Toggle 按钮 onClick 调用:标记"下次 isCollapsed prop 变化走动画"。 */
  requestAnimateNextChange: () => void;
}

interface RightSidebarProps {
  isCollapsed: boolean;
  /** Expanded-state width in px —— 兜底值。宽度主权在引擎:本组件优先消费
   *  PaneWidthContext 的实时值(拖引擎缝把手时逐帧跟手),引擎未接管时才回落
   *  本 prop。私有拖宽把手已拆除(同一条缝不双把手,把手 = 引擎分割线)。 */
  width: number;
  /** 平台是否为 macOS;决定顶栏合并路径 + 哪侧渲染 maximize / 折叠按钮。 */
  isMac: boolean;
  /** 关闭整个 RightSidebar(走外层 toggle handler);仅 Win 端 TabBar 内会渲染对应按钮(Mac 走 MainLayout 浮层)。 */
  onCloseSidebar?: () => void;
  /** 固定唤起入口；只负责显示已展开的侧栏，不承担关闭语义。 */
  onShowSidebar?: () => void;
  /** 最大化 RightSidebar;Phase 6 接真行为,Phase 1 渲染按钮即可。Mac 走 MainLayout 浮层、Win 走 TabBar 右端。 */
  onMaximize?: () => void;
  /** 当前 cc-agent session id;由 MainLayout 持有,CCAgentSessionView ownsRoute 时通过 outlet context 推上来。
   *  null = 不在聊天会话内(或路由副本),Shell 不接 store,渲染空状态。 */
  sessionId: string | null;
  /** 当前 session 的 workingDir;Shell 注入 plugin ctx。空串 = 尚未解析,plugin 渲染占位。 */
  workdir: string;
  /** 非空 = SSH remote 会话(workdir 为远端路径),透传给 Shell → plugin ctx。 */
  remoteHostId: string | null;
  /** device-link 会话归属：null = 已确认本机，undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  /** Maximize 态(Phase 6):RSB 撑满整个非左栏区,主区 hidden。本组件用来隐藏
   *  resize handle(maximize 不允许拖宽)+ 把 TabBar maximize 按钮图标切到"还原"。 */
  isMaximized?: boolean;
  /** 左侧栏完全收起且 RSB maximize 时，为顶栏左上角浮动 ChromeActions 让位。 */
  reserveLeftChromeActions?: boolean;
  /** 工具面板位于最左且左侧栏为 rail 时，顶栏承接 ChromeActions 的 no-drag 命中区。 */
  railChromeActionsHitHole?: boolean;
  /** 「在新窗口中打开侧边栏」:开偏好 + 弹出子窗口。Win 端 TabBar 内渲染按钮
   *  (Mac 走 MainLayout 浮层,不经此 prop)。 */
  onDetach?: () => void;
  /** M2(mac 交换态):面板当前贴哪条边。透传给 Shell —— 'left' 时 Shell 顶栏
   *  右端渲染 detach / maximize 真按钮(折叠 toggle 恒在 MainLayout 窗口右上浮层)。 */
  panelSide?: 'left' | 'right';
  /** 本 session 关掉最后一个 tab 时回调,由 MainLayout 用来自动收起侧栏。透传给 Shell。 */
  onAllTabsClosed?: () => void;
}

export const RightSidebar = forwardRef<RightSidebarHandle, RightSidebarProps>(function RightSidebar(
  {
    isCollapsed,
    width,
    isMac,
    onCloseSidebar,
    onShowSidebar,
    onMaximize,
    isMaximized,
    reserveLeftChromeActions = false,
    railChromeActionsHitHole = false,
    sessionId,
    workdir,
    remoteHostId,
    deviceLinkDeviceId,
    onDetach,
    panelSide,
    onAllTabsClosed,
  },
  ref,
) {
  const { t } = useTranslation();

  // 折叠 / 展开过渡动画 —— **只在 toggle 按钮主动 prime 时跑**;其它任何 isCollapsed prop
  // 变化(sessionId 切换 / 草稿切换 / init 等)默认都直接同步 displayCollapsed = isCollapsed,
  // 不动画(用户体验需求:切 session 应"瞬间生效"而不是"看着一栏慢慢展开/收起")。
  //
  // 动画机制(保留原 250ms transition + rAF 滞后一帧切 displayCollapsed 的方案):
  //   1) MainLayout toggle 按钮 onClick → 调 requestAnimateNextChange() 设 animateNextRef=true
  //   2) MainLayout setIsRightSidebarCollapsed → prop 变化触发本 component useEffect
  //   3) animateNextRef=true → 开 transition、下一帧切 displayCollapsed(width 滑过 250ms),reset ref
  //   4) animateNextRef=false(默认) → 直接同步 displayCollapsed = isCollapsed,无动画
  //
  // 比例模式下窗口缩放只改 width、不翻 isCollapsed,故 transition 默认 off,避免 250ms ease
  // 造成"追不上窗口边缘"的橡皮筋滞后。
  const [displayCollapsed, setDisplayCollapsed] = useState(isCollapsed);
  const [animating, setAnimating] = useState(false);
  const [animationWidthSnapshot, setAnimationWidthSnapshot] = useState<number | null>(null);
  const animateNextRef = useRef(false);
  const asideRef = useRef<HTMLElement | null>(null);
  // 宽度优先取引擎实时值(拖引擎缝把手逐帧跟手),未接管回落 prop。
  const engineWidth = usePanelWidth('right-tabs');
  const effectiveWidth = engineWidth ?? width;
  const widthRef = useRef(effectiveWidth);
  widthRef.current = effectiveWidth;

  useImperativeHandle(
    ref,
    () => ({
      requestAnimateNextChange: () => {
        animateNextRef.current = true;
      },
    }),
    [],
  );

  useEffect(() => {
    if (!animateNextRef.current) {
      // 默认路径:直接同步,不动画(sessionId 切换 / init / 任何非 toggle 引起的变化)
      setAnimating(false);
      setAnimationWidthSnapshot(null);
      setDisplayCollapsed(isCollapsed);
      return;
    }
    // 显式 toggle 路径:走 250ms 动画。
    animateNextRef.current = false;
    const measuredWidth = asideRef.current?.getBoundingClientRect().width ?? 0;
    setAnimationWidthSnapshot(measuredWidth > 0 ? measuredWidth : widthRef.current);
    setAnimating(true);
    const raf = window.requestAnimationFrame(() => setDisplayCollapsed(isCollapsed));
    const timer = window.setTimeout(() => {
      setAnimating(false);
      setAnimationWidthSnapshot(null);
    }, 280);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [isCollapsed]);

  const expandedSidebarStyle: CSSProperties | undefined =
    !displayCollapsed && !isMaximized
      ? {
          width: effectiveWidth,
          flexShrink: 1,
          maxWidth: `max(0px, calc(100% - ${CHAT_AREA_MIN_WIDTH}px))`,
        }
      : undefined;
  const contentStyle: CSSProperties | undefined =
    !isMaximized && animating && animationWidthSnapshot !== null
      ? { width: animationWidthSnapshot }
      : undefined;

  return (
    <aside
      ref={asideRef}
      aria-label={t('rightSidebar.ariaLabel')}
      // PanelDragController(拖面板换位,B3 转正)的手势识别根:值标明面板身份。
      data-panel-drag-root="right-tabs"
      // 折叠态标记:引擎分割线的 CSS 据此隐藏邻接缝(globals.css .layout-divider-*),
      // 收起到 0 宽时不在窗口边缘留孤线。
      data-pane-collapsed={displayCollapsed ? '' : undefined}
      className={cn(
        // 侧边分割线由布局引擎统一绘制,aside 与内容层都不自画竖线。
        'relative flex flex-col bg-content-area',
        animating &&
          'transition-[width] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0',
        // maximize 态:用 flex-1 撑满 row 内 sidebar 之后的剩余空间,不传 fixed
        // width —— 否则 MainLayout 的 rightAvailableWidth(基于 main rect)在 main
        // hidden 后算成"窗口宽"漏算 sidebar,RSB 被算多一个 sidebar 宽度,推 tree
        // pane 出视口(2026-07-01 用户实测 bug:maximize 后文件树消失)。
        // 非 maximize:width prop 只作为 preferred width。允许 flex shrink,配合 main
        // 的 min-w-[400px] 让极窄窗口下 RSB 温和变窄,避免 280px 目标宽硬顶出窗口。
        isMaximized ? 'flex-1' : 'shrink',
        'min-w-0 max-w-full',
        'overflow-hidden',
        displayCollapsed && 'w-0',
      )}
      style={expandedSidebarStyle}
      aria-hidden={isCollapsed || undefined}
    >
      {/* 内容容器。稳态跟随 aside 实际宽(w-full),只有折叠 / 展开动画期间钉住开始
          快照宽防 reflow —— aside 宽度 250ms 收到 0 时,本块保持展开宽度被
          overflow-hidden 裁切,TabBar / 内容区不会因瞬时变窄而抖动(规则 7)。

          Mac 端布局(46px 顶 chrome,行高随 #650 全局 50→46):
            ├ Shell 内 46px unified topbar ── tab pills(chip 变体)+「+」垂直
            │   居中,右侧预留 MainLayout 浮层按钮宽度;maximize / 折叠按钮仍走
            │   z-50 浮层覆盖到本 chrome 右端,与 macOS 系统标题栏规范一致。
            └ Body ── 不再额外渲染旧 36px TabBar 行
          Win 端布局(82px 顶 chrome):
            ├ 46px drag region ── 与 ContentHeader 等高,给 WindowControls 浮层让位
            └ Shell(TabBar 36 + Body) ── TabBar 内右端含 maximize + 折叠按钮 */}
      {/* border-l 画在本层,跨 46px chrome + TabBar + Body 整个 RSB 内部,从顶到底连贯一条;
          aside 外壳折叠到 w-0 时本层被 overflow-hidden 一并裁掉,不留残留。 */}
      <div
        // 侧边分割线已移交布局引擎统一绘制(LayoutRoot 的 layout-divider)——
        // 本层不再自画 border,避免与引擎缝双线/漏缝;把手 hover 高亮线仍在下方。
        className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
        style={contentStyle}
      >
        {!isMac && (
          /* Win 端:46px 拖拽区与左侧 ContentHeader 等高,让 TabBar 完全落在
             WindowControls(absolute top-0 right-0 h-[46px] z-50)下方,不遮挡
             最小化 / 最大化 / 关闭三按钮。Windows 本期维持两排结构不改。 */
          <div
            aria-hidden
            data-testid="right-sidebar-titlebar-spacer"
            // 46px 顶带整条归窗口拖动(B3 口径修订,与 ContentHeader 同轮拍板);
            // 工具面板的拖动手柄 = 下方 36px Tab 条空白 + 长按窗体。
            className="h-[46px] shrink-0 flex-none border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            {/* 仅当工具面板位于布局树首位时，本顶带才会落在 ChromeActions
                浮层下方。no-drag 必须是 drag 元素的后代，才能为两个左上按钮
                可靠挖洞；常规右侧布局不渲染，保留整条顶栏的窗口拖拽能力。 */}
            {panelSide === 'left' && (
              <div
                aria-hidden
                data-testid="right-sidebar-chrome-actions-hit-hole"
                className="h-full shrink-0"
                style={
                  {
                    width: CHROME_ACTIONS_GEOMETRY.clusterWidth,
                    marginLeft: CHROME_ACTIONS_GEOMETRY.defaultLeft,
                    WebkitAppRegion: 'no-drag',
                  } as React.CSSProperties
                }
              />
            )}
          </div>
        )}
        <RightSidebarShell
          sessionId={sessionId}
          workdir={workdir}
          remoteHostId={remoteHostId}
          deviceLinkDeviceId={deviceLinkDeviceId}
          shellVisible={!displayCollapsed}
          isMac={isMac}
          unifiedTopbar={isMac}
          onCloseSidebar={onCloseSidebar}
          onShowSidebar={onShowSidebar}
          onMaximize={onMaximize}
          isMaximized={isMaximized}
          reserveLeftChromeActions={reserveLeftChromeActions}
          railChromeActionsHitHole={railChromeActionsHitHole}
          onDetach={onDetach}
          // B3:主窗口内嵌形态 Tab 条空白处 = 拖面板手势面(窗口拖动走左栏顶行)。
          chromeWindowDrag={false}
          panelSide={panelSide}
          onAllTabsClosed={onAllTabsClosed}
        />
      </div>

      {/* 私有拖宽把手已拆除:同一条缝不双把手 —— 拖宽/双击复位统一走
          引擎分割线(LayoutRoot 的 RootDivider),对任意排列与 N 面板通用。 */}
    </aside>
  );
});
