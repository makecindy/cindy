/**
 * ContentHeader（右侧内容区顶栏 Shell）
 * ---------------------------------------------------------------------------
 * Codex 风格布局重构后，原 TitleBar 拆为三部分：
 *   - Sidebar 顶行（红绿灯让位 + 空白拖拽区，见 Sidebar.tsx）
 *   - ChromeActions 浮动按钮簇（菜单 + 折叠按钮，见 MainLayout —— 浮在
 *     Sidebar / Header 之上，折叠/展开时整体平移，而不是两份实例消失重现）
 *   - 本组件：右侧内容区自己的顶栏
 *
 * Shell 职责（跨所有路由保证存在，feature 不可遗漏）：
 *   - 窗口拖拽区域（整条 header 默认 drag，交互元素各自 no-drag）
 *   - Windows 窗口控制按钮（最小化/最大化/关闭，恒在右上角）
 *   - 折叠态给 ChromeActions 按钮簇预留的占位 spacer（与侧栏宽度动画同步
 *     伸缩，保证标题平滑让位，不与浮动按钮重叠）
 *   - Sidebar 不可见（折叠 / 设置页）且非全屏时，mac 红绿灯让位 padding
 *
 * 中部内容由当前路由视图通过 useRegisterContentHeader 注入（会话标题等），
 * Shell 不知道里面是什么。无注入时：mac + 侧栏展开 → 整条隐藏（自带顶部
 * 内容的页面不浪费 46px）；其余场景保留空白拖拽条（约束见函数内注释）。
 *
 * 视觉：无背景（bg 继承 main 的 bg-content-area），下边框 hairline 只画在
 * 右栏（Sidebar 侧保持无横线的连续表面）；设置页隐形 chrome 连边框也不画。
 */

import type { ReactNode } from 'react';

import { useFeatureContentHeader } from '@/features/feature-context';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { cn } from '@/lib/utils';
import { CHROME_ACTIONS_GEOMETRY } from './chromeActionsGeometry';

/**
 * Windows 窗口控制按钮宽度（3 × 46px）。固定侧栏入口位于下一行的内容区，
 * 不占用本标题栏。
 */
const WIN_CONTROLS_WIDTH = 138;

/**
 * mac 右栏固定唤起按钮宽度占位（按钮 28 + 右距 8）。按钮已 hoist 到 MainLayout
 * 顶层浮层（钉窗口右上角，见
 * MainLayout 的 mac 浮层），这里同 Windows 一样在右端留等宽占位，防止注入的
 * header 内容滑到浮动开关下面。
 */
const MAC_RIGHT_TOGGLE_WIDTH = 36;

/**
 * "空 header 隐藏"判定(用户决策 2026-06-11)的单一决策源:MainLayout 与 ContentHeader
 * 共用,MainLayout 据此在 <main> 上广播 --content-header-h(46px/0px)供路由做占位
 * 补偿(新建页内容组恒定在"有栏时"位置,用户改稿 2026-07-21),ContentHeader 据此隐藏。
 * 判定语义见组件内原注释:mac + Sidebar 展开 + 无注入内容 + 无右栏开关。
 */
export function useContentHeaderHidden(args: {
  sidebarVisible: boolean;
  rightSidebarAvailable: boolean;
}): boolean {
  const { isMac } = useMacFullscreen();
  const headerContent = useFeatureContentHeader();
  return isMac && args.sidebarVisible && headerContent == null && !args.rightSidebarAvailable;
}

interface ContentHeaderProps {
  /** Sidebar 当前是否在布局中可见（展开态）。false = 折叠或设置页隐藏。 */
  sidebarVisible: boolean;
  /** 折叠态是否需要为 ChromeActions 浮动按钮簇预留占位。设置页为 false。 */
  showCollapsedActions: boolean;
  /** 左侧栏是否处于 rail 态（拖到最窄但仍保留图标列）。 */
  isSidebarRail: boolean;
  /** mac 右上固定唤起按钮是否在场。mac 据此在右端留按钮占位并决定是否留住空
   *  header；Windows 仅影响空 header 判定，
   *  占位恒为窗口控制按钮宽。 */
  rightSidebarAvailable: boolean;
  /** MainLayout 经 useContentHeaderHidden 预判的结果(与 --content-header-h 同源)。 */
  hidden: boolean;
}

export function ContentHeader({
  sidebarVisible,
  showCollapsedActions,
  isSidebarRail,
  rightSidebarAvailable,
  hidden,
}: ContentHeaderProps) {
  const { isMac, isFullscreen } = useMacFullscreen();
  const headerContent = useFeatureContentHeader();

  // Sidebar 不可见时红绿灯落在 header 上方 → 非全屏让位。78px = 70px 红绿灯
  // 占位 + 8px 呼吸间隙（与原 TitleBar 的 pl-[70px] + px-2 等效）。
  const needsTrafficLightInset = isMac && !isFullscreen && !sidebarVisible;
  // rail 态时，Sidebar 仍占 78px；mac 非全屏的 ChromeActions 却紧贴其右缘
  // (x=78)。Sidebar 顶栏里的 no-drag 洞会被自身 overflow-hidden 裁掉，必须在
  // main 的 drag header 左缘再挖一个洞，否则点击浮动的收放/菜单按钮会被 Electron
  // 当成窗口拖拽吞掉。完全收起态 main 从 x=0 开始，既有 spacer 已覆盖该位置；
  // 全屏态按钮回到 rail 内，也由 Sidebar 的既有洞覆盖。
  const needsRailChromeActionsHitHole = isMac && !isFullscreen && isSidebarRail;

  // 设置页：Sidebar 隐藏且无折叠按钮占位 → 不画下边框（用户决策 2026-06-11）。
  // 返回 + 标题仍由 SettingsView 注入本 header，与聊天共用 46px 行高。
  const isInvisibleChrome = !sidebarVisible && !showCollapsedActions;

  // 空 header 隐藏（用户决策 2026-06-11）：技能中心 / 自动化 / 文件浏览 /
  // 新建对话等自带顶部内容的页面，不再渲染空白的 46px 顶栏。
  // 仅当以下条件全部成立才隐藏：
  //   - 无注入内容（headerContent == null）
  //   - Sidebar 展开可见 —— 折叠态下这 46px 是 ChromeActions 浮层按钮和
  //     mac 红绿灯的所在行，藏了按钮会压在页面内容上
  //   - mac —— Windows 上这条空 header 仍保留为拖拽细条（窗口控制按钮已
  //     hoist 到 MainLayout 顶层浮层，但顶栏仍是 Windows 拖动窗口的抓手）
  //   - 右栏唤起入口在场（rightSidebarAvailable，mac 把入口放在本 header 右端）——
  //     即使无注入内容也留住空 header 当开关落点，否则全屏聊天视图在 mac 上会
  //     失去关闭右栏的入口
  // 设置页天然不满足 sidebarVisible，维持隐形 chrome 现状。
  // 判定已上提到 useContentHeaderHidden(MainLayout 同源消费,广播 --content-header-h)。
  if (hidden) {
    return null;
  }

  return (
    <header
      className={cn(
        // 46px 行高:红绿灯钉 y=16(实测灯心 ≈23 = 46/2,macOS 渲染比理论低约 1pt),标题/图标与
        // 红绿灯同轴(对齐 Codex 的紧凑 titlebar)。与 ChromeActions / Sidebar
        // 顶行 / MainLayout 右上浮层同一常量,改动必须连同 main 侧
        // trafficLightPosition 一起同步。
        'relative flex h-[46px] w-full shrink-0 items-center select-none',
        // 下边框只画在右栏（header 在 main 内部，不会延伸到 Sidebar 上方），
        // Sidebar 侧保持无横线的连续表面；设置页隐形 chrome 不画
        // （用户决策 2026-06-11）。
        !isInvisibleChrome && 'border-b border-titlebar-border',
        'transition-[padding] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
        needsTrafficLightInset ? 'pl-[78px]' : 'pl-2',
      )}
      // 窗口拖拽区(B3 口径修订,Lizi 实测拍板):46px 顶带整条归窗口拖动 ——
      // 曾把本条划给"拖面板"手势,实测窗口没了顺手抓握区,难受;聊天面板的
      // 拖动入口回归长按窗体(面积大,够顺手),面板级"标题条手柄"只保留
      // 36px Tab 条那层(在面板身上,语义准)。
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {needsRailChromeActionsHitHole && (
        <div
          aria-hidden
          data-testid="content-header-rail-chrome-actions-hit-hole"
          className="absolute left-0 top-0 h-full"
          style={
            {
              width: CHROME_ACTIONS_GEOMETRY.clusterWidth,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        />
      )}
      {/* 折叠态占位 spacer：真实按钮在 MainLayout 的 ChromeActions 浮层里
          （钉死左上角、不随折叠重建的常驻实例）。本 spacer 以与侧栏宽度动画
          相同的时长/缓动伸缩，把标题平滑推到浮动按钮右侧（项目规则 8）。
          68px = 折叠按钮 28 + gap 4 + 菜单 28 + 与标题间隙 8。
          ⚠️ spacer 自身必须 no-drag：Electron 的拖拽区域挖洞只在"drag 元素
          自己的后代"上可靠生效，浮层（非后代）的 no-drag 不被计入 ——
          否则浮层按钮点击会被窗口拖拽吞掉。 */}
      <div
        aria-hidden
        className={cn(
          'h-full shrink-0 overflow-hidden',
          'transition-[max-width] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
          showCollapsedActions ? 'max-w-[68px] w-[68px]' : 'max-w-0 w-[68px]',
        )}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />

      {/* 中部：feature 注入的 slot 内容。容器保持 drag，注入内容里的交互
          元素自行 no-drag。 */}
      <div className="flex h-full min-w-0 flex-1 items-center">{headerContent}</div>

      {/* 右端占位 —— 平台分流（两端都只留占位，不再放交互按钮）：
          - mac：全屏聊天视图在场时（rightSidebarAvailable）留出固定唤起按钮等宽占位。
            按钮本身已 hoist 到 MainLayout 顶层浮层（钉窗口右上角）；这里仅占位防注入
            内容被压到浮层按钮下。不在场则右端留空。
          - Windows：留出 WIN_CONTROLS_WIDTH 等宽占位（窗口控制按钮已 hoist 到
            MainLayout 顶层浮层）；固定侧栏入口位于下一行内容区。 */}
      {isMac ? (
        rightSidebarAvailable && (
          <div aria-hidden className="h-full shrink-0" style={{ width: MAC_RIGHT_TOGGLE_WIDTH }} />
        )
      ) : (
        <div aria-hidden className="h-full shrink-0" style={{ width: WIN_CONTROLS_WIDTH }} />
      )}
    </header>
  );
}

/**
 * ContentHeaderSlot —— 必须渲染在 FeatureSidebarSlotProvider 内(useContentHeaderHidden
 * 消费 feature context)。一式两用:① 按判定渲染/隐藏 ContentHeader;② 用 display:contents
 * 包裹层向后代广播 --content-header-h(46px/0px,与 header 的 h-[46px] 同源)——供新建页等
 * 视口比例定位的路由做占位补偿,顶栏显隐内容区零跳动(用户改稿 2026-07-21)。
 * display:contents 不参与布局,children 仍直接躺在 <main> 的 flex 上下文里,DOM 语义不变。
 */
export function ContentHeaderSlot({
  sidebarVisible,
  showCollapsedActions,
  isSidebarRail,
  rightSidebarAvailable,
  children,
}: Omit<ContentHeaderProps, 'hidden'> & { children: ReactNode }) {
  const hidden = useContentHeaderHidden({ sidebarVisible, rightSidebarAvailable });
  return (
    <>
      <ContentHeader
        sidebarVisible={sidebarVisible}
        showCollapsedActions={showCollapsedActions}
        isSidebarRail={isSidebarRail}
        rightSidebarAvailable={rightSidebarAvailable}
        hidden={hidden}
      />
      <div
        style={{ display: 'contents', ['--content-header-h' as string]: hidden ? '0px' : '46px' }}
      >
        {children}
      </div>
    </>
  );
}
