/**
 * Sidebar Shell（纯外壳层）
 * ---------------------------------------------------------------------------
 * 职责：
 *   - 宽度 / 背景 / 右侧分割线 / 折叠-展开过渡动画（跨所有主功能共享）
 *   - 顶行（Codex 风格布局重构后通顶到窗口顶部）：mac 红绿灯所在的空白
 *     拖拽行；其下是 HorizontalTabbar 行。折叠/菜单按钮在 MainLayout 的
 *     ChromeActions 浮层（钉死左上角红绿灯旁,不随侧栏状态移动）
 *   - 上半"功能内容槽"——内容由当前激活的 Feature Layout 注入，Shell 不知道
 *     里面是什么（这里通过 useFeatureSidebarUpper 读取槽位内容）
 *   - 底部用户信息区 F3（UserInfoSection）
 *
 * Shell 层刻意不 import react-router-dom 的 useLocation / useNavigate——
 * 主界面外壳不应该知道具体路由。"哪个 nav item 被选中"这种功能内语义归属于
 * Feature Layout（比如 ChatFeature 里的 ChatSidebarUpper）。
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import type { SidebarPeekDrawerProps, SidebarPeekState } from '@/hooks/useSidebarPeek';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { useFeatureSidebarUpper } from '@/features/feature-context';
import { ConversationSearchProvider } from '@/features/cc-agent/sidebar/conversationSearchContext';
import { CHROME_ACTIONS_GEOMETRY } from '@/components/layout/chromeActionsGeometry';
import { SidebarTopNav } from './SidebarTopNav';
import { UpdateBanner } from './UpdateBanner';
import { UserInfoSection } from './UserInfoSection';

/** 折叠态 rail 宽度（px）——78px 与 ContentHeader 的红绿灯让位(pl-[78px])对齐:
 *  macOS 三个窗口控制点(traffic lights)整簇约 70px,rail 必须 ≥ 它才能完整容纳,
 *  否则红绿灯会越过 rail 右缘溢出到主区(64px 时的问题)。78px 也容得下 36px 瓷砖
 *  / 头像居中 + 两侧呼吸。 */
const RAIL_WIDTH = 78;

interface SidebarProps {
  /** 完全隐藏（左上角 toggle / ⌘B）——w-0，与旧版语义一致。 */
  isCollapsed: boolean;
  /** rail 模式（拖动边框拉到最窄触发）——64px 竖排文字列，与 isCollapsed 独立。 */
  isRail?: boolean;
  /** Expanded-state width in px (driven by useSidebarResize). */
  width?: number;
  /** Whether the user is currently dragging the resize handle. */
  isDragging?: boolean;
  /** Pointer-down handler for the resize handle. */
  onDragStart?: (e: React.PointerEvent) => void;
  /** Double-click handler to reset width to default. */
  onResetWidth?: () => void;
  /** Open the update notice dialog to review release notes. */
  onOpenUpdateNotice?: () => void;
  /**
   * Open the update notice dialog pinned to one version — used by UpdateBanner
   * to preview the notes of the downloaded-but-not-yet-installed update, which
   * `onOpenUpdateNotice`'s history range (`<= appVersion`) cannot reach.
   */
  onOpenVersionNotice?: (version: string) => void;
  /**
   * 完全隐藏态 hover 临时浮出(peek)——非 null 时以 fixed overlay 抽屉渲染
   * (useSidebarPeek 驱动,MainLayout 只在 peek 可见期传入):
   *   peeking     滑入并停留;peekClosing 滑出动画中;
   *   pinning     固定展开的冻结过渡(无动画,流内 spacer 负责推开主区)。
   */
  peekState?: SidebarPeekState | null;
  /** peek 期挂在 aside 上的 mouse enter/leave + data 标记(useSidebarPeek)。 */
  peekDrawerProps?: SidebarPeekDrawerProps;
}

export function Sidebar({
  isCollapsed,
  isRail = false,
  width,
  isDragging,
  onDragStart,
  onResetWidth,
  onOpenUpdateNotice,
  onOpenVersionNotice,
  peekState = null,
  peekDrawerProps,
}: SidebarProps) {
  const upperContent = useFeatureSidebarUpper();
  const { t } = useTranslation();
  // 顶部 chrome 行的 no-drag 洞要对齐 ChromeActions 浮层按钮簇的落点：
  // 按钮簇钉死左上角(mac 非全屏 78 让位红绿灯,其余 8),不随侧栏状态移动,
  // 洞跟随同一坐标(见 ChromeActions 的 x 计算)。
  const { isMac, isFullscreen } = useMacFullscreen();
  const chromeClusterX =
    isMac && !isFullscreen
      ? CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft
      : CHROME_ACTIONS_GEOMETRY.defaultLeft;

  // peek 抽屉态(fixed overlay,不占流内布局)。矩形与正常展开态逐像素一致,
  // 因此 pin 时(pinning → idle)fixed↔static 的交换帧不产生视觉跳变。
  const isPeek = peekState != null;

  // 离开 peek 的交换帧必须禁用宽度过渡:peekClosing → idle(收起)时,aside 带着
  // 上一帧的 width=展开宽 回流为流内 width=0,若 transition-[width] 还挂着,这次
  // 260→0 会被当成常规折叠动画播放 —— 主区先被推开再滑回来(一次多余的左滑)。
  // 正确行为是快照式归零(抽屉本已滑出屏幕,主区从头到尾不该动)。
  const prevIsPeekRef = useRef(isPeek);
  const justLeftPeek = prevIsPeekRef.current && !isPeek;
  useEffect(() => {
    prevIsPeekRef.current = isPeek;
  });

  // 宽度三态：完全隐藏 0（toggle/⌘B，旧版语义）→ rail 64（拖到最窄）→ 展开 width。
  // 拖拽中宽度直接跟手（useHorizontalResize 已把下限放宽到 railWidth）。
  // peek 抽屉恒用展开宽 —— peek 的语义就是「预览完整展开列表」。
  const visualWidth = isPeek
    ? width ?? 260
    : isCollapsed
      ? 0
      : isDragging
        ? width ?? 260
        : isRail
          ? RAIL_WIDTH
          : width ?? 260;

  // 内容层宽度:与 visualWidth 唯一的区别是**收起态不归零** —— 收起/展开动画期间
  // 内容保持展开宽度被 aside 的 overflow-hidden 从右侧裁切,而不是跟随 aside 宽度
  // 连续 reflow(否则文字换行/挤压,视觉很难受)。同时内容层做透明度渐隐/渐显,
  // 对齐 Codex 的「文字淡出的同时侧栏收起」手感(2026-07 用户定稿;与右栏
  // RightSidebar 的定宽内容层同一套路,规则 7)。
  const contentWidth = isPeek
    ? width ?? 260
    : isDragging
      ? width ?? 260
      : isRail
        ? RAIL_WIDTH
        : width ?? 260;

  return (
    <aside
      {...(isPeek ? peekDrawerProps : undefined)}
      aria-label={t('sidebar.ariaLabel')}
      aria-hidden={isCollapsed && !isPeek}
      className={cn(
        'flex flex-col bg-sidebar overflow-hidden',
        isPeek
          ? cn(
              // 抽屉:fixed overlay 通顶,不挤压主区;z 低于 ChromeActions(z-20),
              // 触发钮保持可点(点击 = pin)。阴影复用 --shadow-menu(中型悬浮卡,
              // 同色 Surface 上的辅助分离),1px hairline 仍是主分隔手段(docs/design-rules/cindy-design-system.md)。
              'fixed inset-y-0 left-0 z-[15]',
              'border-r border-sidebar-border shadow-[var(--shadow-menu)]',
              peekState === 'peeking' &&
                'animate-[sidebar-peek-in_200ms_cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none',
              peekState === 'peekClosing' &&
                '-translate-x-full opacity-0 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0',
              // pinning:不加任何动画类 = 冻结在原位,等流内 spacer 跑完宽度动画。
            )
          : cn(
              'relative shrink-0',
              // 折叠态 width=0,border-r 1px 仍会渲染贴在窗口左缘,看着像残留阴影/线 — 仅非折叠态画分隔线。
              !isCollapsed && 'border-r border-sidebar-border',
              !isDragging &&
                !justLeftPeek &&
                'transition-[width] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0',
            ),
      )}
      style={{ width: visualWidth }}
    >
      {/* 定宽内容层(见 contentWidth 注释):收起/展开动画期间内容不随 aside 宽度
          reflow,只被右侧裁切 + 整层渐隐/渐显。 */}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          // visibility 参与过渡:渐隐播完后才真正隐藏(阻止 Tab 焦点进入收起的
          // 侧栏),展开瞬间恢复 —— 与 SectionCollapse 同口径。
          'transition-[opacity,visibility] duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0',
          isCollapsed && !isPeek ? 'invisible opacity-0' : 'visible opacity-100',
        )}
        style={{ width: contentWidth }}
      >
      {/* Top chrome 行: Sidebar 通顶后窗口左上角的空白 chrome 行（Codex 风格）。
          - mac 非全屏：红绿灯悬浮在本行左侧。
          - 折叠 + 菜单按钮**不在本行** —— 它们是 MainLayout 的 ChromeActions
            浮层（浮在本行之上），钉死左上角红绿灯旁,不随侧栏状态移动。
          - 整行 drag region（拖拽移动窗口）；放一个 no-drag 占位后代为浮层
            按钮挖出可点击的洞（Electron 拖拽区域挖洞只在 drag 元素自己的后代
            上可靠生效，浮层自身的 no-drag 不算数）。洞与按钮簇同坐标:
            mac 非全屏 78（红绿灯右侧）,mac 全屏 / Windows 8。
          - 不画下边框 —— 顶行与列表区是一块连续表面（对齐 Codex）。 */}
      <div
        // 46px 与 ContentHeader / ChromeActions 行高一致(红绿灯心 y=23 同轴)。
        className="flex h-[46px] w-full shrink-0 items-center"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          aria-hidden
          // 60px = 折叠按钮 28 + gap 4 + 菜单 28(ChromeActions 簇宽)。
          className="h-full shrink-0"
          style={
            {
              width: CHROME_ACTIONS_GEOMETRY.clusterWidth,
              marginLeft: chromeClusterX,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        />
      </div>

      {/* ConversationSearchProvider:在顶部导航行(SidebarTopNav 的「搜索」行)与功能槽
          (CCAgentSidebarUpper 的结果 overlay)这两个兄弟子树的共同祖先处,只实例化一次
          会话搜索状态,经 context 共享。外壳本身仍不感知搜索细节,只负责放置 Provider。 */}
      <ConversationSearchProvider>
        {/* 顶部常驻动作/导航列表(新建 / 自动任务 / Skill / 搜索)。
            取代原 HorizontalTabbar:同级等权列表行,无单独项目 Tab。
            rail（收窄）态放不下,隐藏——rail 自身承担入口;展开后回归。
            完全隐藏态 w-0 自然裁掉。 */}
        {!isRail && <SidebarTopNav />}

        {/* Upper: feature-injected content slot.
            The current Feature Layout injects either an expanded or collapsed
            sidebar tree through the FeatureSidebarSlotContext. Shell renders
            whatever it's given. If no feature is active (e.g. /settings with
            the intentionally empty SettingsSidebarUpper), this simply leaves
            the upper area blank. */}
        <div className="flex flex-1 flex-col overflow-hidden">{upperContent}</div>
      </ConversationSearchProvider>

      {/* Update banner: shown only when a verified update is ready
          peek 抽屉视同展开(否则横幅在抽屉里消失,与「预览完整列表」语义相悖)。 */}
      <UpdateBanner
        isCollapsed={(isCollapsed && !isPeek) || isRail}
        onOpenVersionNotice={onOpenVersionNotice}
      />

      {/* Bottom: User info (Shell-level, shared across all features)
          isCollapsed 在这里表达"窄布局"（rail 居中头像）；完全隐藏态 w-0 整体裁掉。 */}
      <UserInfoSection isCollapsed={isRail} onOpenUpdateNotice={onOpenUpdateNotice} />
      </div>

      {/* Resize handle — expanded 和 rail 态都保留（rail 靠拖拽进出，F1 / F6）。
          完全隐藏态没有可拖的边;peek 抽屉(含 pinning 冻结期)是临时 overlay,
          不提供 resize。 */}
      {!isCollapsed && !isPeek && (
        <div
          className="absolute right-0 top-0 z-10 h-full w-[4px] cursor-col-resize group/handle"
          onPointerDown={onDragStart}
          onDoubleClick={onResetWidth}
        >
          {/* Visual highlight line — default transparent so the aside's existing
              border-r provides the 1px divider (docs/design-rules/cindy-design-system.md: Board hairline).
              Only becomes visible on hover to indicate the draggable handle. */}
          <div className="absolute right-0 top-0 h-full w-px bg-transparent transition-colors group-hover/handle:bg-sidebar-action-icon" />
        </div>
      )}
    </aside>
  );
}
