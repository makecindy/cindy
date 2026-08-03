/**
 * TabBar — RSB 内容级 chrome(36px 单条),只装 tab pills + 「+」(+ Win 端右端 maximize / 折叠)。
 *
 * 平台行为分歧:
 * - Mac 端(showWindowControls=false):RSB 顶上还有一条 50px chrome 由 RightSidebar 自己画,
 *   maximize / 折叠按钮走 MainLayout 浮层钉在窗口右上角。TabBar 内右端**完全空**。
 * - Win 端(showWindowControls=true):RSB 没有顶 50px chrome,本 TabBar 就是第一行;
 *   maximize / 折叠按钮**渲染在 TabBar 内右端**,与 tab pills + 「+」共占同一条 chrome。
 *
 * 布局:
 *   左侧 tab pills (30px 高,顶部 8px 圆角,底部贴 TabBar 底边)+「+」按钮(24×24)
 *   右侧 [Win only] maximize-2(28×28) + panel-right-close(28×28)
 *   tab pill 底齐(items-end),控件垂直居中(各自 items-center wrapper)。
 *
 * 拖窗:整条横条 drag region;tabs / 「+」 / 控件个个 no-drag(允许点击)。
 *
 * Phase 1 状态:Maximize 按钮 onClick 仅占位,Phase 6 真接行为。Tab kind → 图标 / 标题
 * i18n key 用 record 映射;Phase 2+ 改为从 plugin registry 取。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderTree,
  Globe,
  Terminal,
  GitPullRequestArrow,
  UsersRound,
  ListTodo,
  Plus,
  Puzzle,
  X,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PictureInPicture2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { SortableList } from '@/components/sidebar/SortableList';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddTabDropdown } from './AddTabDropdown';
import { getTabKind, hydrateTabState } from './registry';
import type { BuiltinTabKindId, TabKindId, TabState } from './types';

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  sessionId?: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAdd: (kind: TabKindId) => void;
  /**
   * 是否在 TabBar 右端渲染 maximize + 折叠按钮。
   * - Mac false:控件走 MainLayout 浮层
   * - Win true:控件在本 TabBar 内
   */
  showWindowControls: boolean;
  /** Maximize 按钮 onClick(仅 showWindowControls=true 时使用)。Phase 6 真接行为。 */
  onMaximize?: () => void;
  /** 关闭整个 RSB 的 toggle(仅 showWindowControls=true 时使用)。 */
  onCloseSidebar?: () => void;
  /** maximize 当前态(Phase 6)— 用来切换按钮图标 Maximize2 ↔ Minimize2,
   *  让用户视觉上知道按一下是"退出最大化"。 */
  isMaximized?: boolean;
  /** Tab pill 右键菜单 "关闭其他":保留传入 tabId,关掉其它所有。 */
  onCloseOthers?: (keepTabId: string) => void;
  /** Tab pill 右键菜单 "关闭所有"。 */
  onCloseAll?: () => void;
  /** 「在新窗口中打开侧边栏」(开偏好 + 弹出子窗口);仅 showWindowControls=true
   *  (Win 端)时渲染在 maximize 左侧。Mac 端按钮走 MainLayout 浮层。
   *  Windows 主窗口展开态同时传入 onCloseSidebar,折叠按钮归属本 TabBar;
   *  折叠后再由聊天区角上的 chip 提供展开入口。 */
  onDetach?: () => void;
  /** 本条横带是否作为**窗口**拖拽区(B3):主窗口内嵌形态传 false —— 空白处是
   *  "拖面板"手势面(窗口拖拽区收不到鼠标事件,二者物理互斥;拖窗走左栏顶行);
   *  detached 子窗口等其它宿主不传,默认 true 维持经典拖窗行为。 */
  chromeWindowDrag?: boolean;
}

interface TabStripProps {
  tabs: TabState[];
  activeTabId: string | null;
  sessionId?: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAdd: (kind: TabKindId) => void;
  onCloseOthers?: (keepTabId: string) => void;
  onCloseAll?: () => void;
  className?: string;
  /**
   * pill 视觉变体:
   * - 'flush'(默认,Win 36px TabBar):浏览器式贴底 tab —— rounded-t + 三边
   *   border,底边与宿主栏 border-b 相接,依赖 items-end 底对齐。
   * - 'chip'(Mac 合并顶栏):垂直居中的浮动 chip —— 完整圆角 + 四边 border,
   *   pills /「+」/ 右侧浮层按钮全部落在宿主栏同一水平中线(对齐 Codex;
   *   贴底样式在 50px 高栏里与居中控件错位 10px,是拆成两个变体的原因)。
   */
  pillVariant?: 'flush' | 'chip';
  /**
   * 「+」按钮 wrapper 的高度类,调用方必须传**定高**(TabBar 传 `h-[36px]`、
   * Mac 合并顶栏传 `h-[30px]` = pill 高)。不要传 `h-full`:TabStrip 根节点
   * 高度由内容驱动,百分比高度会退化成 auto,items-center 的垂直对齐随之失效。
   */
  addButtonWrapperClassName?: string;
  addButtonClassName?: string;
}

const KIND_ICON: Record<BuiltinTabKindId, LucideIcon> = {
  'file-browser': FolderTree,
  'web-browser': Globe,
  terminal: Terminal,
  review: GitPullRequestArrow,
  'orca-workers': UsersRound,
  'background-tasks': ListTodo,
};

const KIND_LABEL_KEY: Record<BuiltinTabKindId, string> = {
  'file-browser': 'rightSidebar.tabs.kinds.fileBrowser',
  'web-browser': 'rightSidebar.tabs.kinds.browser',
  terminal: 'rightSidebar.tabs.kinds.terminal',
  review: 'rightSidebar.tabs.kinds.review',
  'orca-workers': 'rightSidebar.tabs.kinds.collaboration',
  'background-tasks': 'rightSidebar.tabs.kinds.backgroundTasks',
};

/**
 * DB(right_sidebar_tabs.kind)是自由文本:更新的版本 / 并行的 dev 分支可能写入
 * 本版本不认识的 kind,编译期的 TabKindId 联合约束不了库里的历史数据。
 * 这两个 helper 是渲染前的运行时兜底 —— 未知 kind 显示通用图标 + 「未知标签页」,
 * pill 照常可关闭,body 侧由 RightSidebarShell 的 placeholder 兜底。
 * (2026-07-09 事故:dev 分支写入 kind='orca-workers',release 端
 *  KIND_ICON[kind] 取到 undefined 渲染 <undefined/> → React #130 全屏崩溃。)
 */
function iconForTabKind(kind: TabKindId): LucideIcon {
  return (KIND_ICON as Partial<Record<string, LucideIcon>>)[kind] ?? Puzzle;
}

function labelKeyForTabKind(kind: TabKindId): string {
  // 插件页签的意识被停用/卸下(plugin 已注销)时,pill 兜底显示「插件面板」
  // 而非「未知标签页」——kind 前缀本身就能识别它是谁的地盘。
  if (kind.startsWith('ghost:')) return 'rightSidebar.tabs.kinds.ghostPanel';
  return (
    (KIND_LABEL_KEY as Partial<Record<string, string>>)[kind] ??
    'rightSidebar.tabs.kinds.unknown'
  );
}

function scrollTabIntoContainerView(container: HTMLElement | null, tab: HTMLElement | null): void {
  if (!container || !tab) return;
  const containerRect = container.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const padding = 16;

  if (tabRect.left < containerRect.left + padding) {
    container.scrollTo({
      left: container.scrollLeft + tabRect.left - containerRect.left - padding,
      behavior: 'smooth',
    });
    return;
  }
  if (tabRect.right > containerRect.right - padding) {
    container.scrollTo({
      left: container.scrollLeft + tabRect.right - containerRect.right + padding,
      behavior: 'smooth',
    });
  }
}

export function TabBar({
  tabs,
  activeTabId,
  sessionId,
  onActivate,
  onClose,
  onReorder,
  onAdd,
  showWindowControls,
  onMaximize,
  onCloseSidebar,
  isMaximized,
  onCloseOthers,
  onCloseAll,
  onDetach,
  chromeWindowDrag = true,
}: TabBarProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="right-sidebar-tab-bar"
      // 拖面板换位(B3):主窗口内嵌形态(chromeWindowDrag=false)下,Tab 条空白处
      // 是"拖面板"手势面;detached 子窗口等宿主维持窗口拖拽区。
      data-panel-drag-handle=""
      className="relative flex h-[36px] shrink-0 flex-none items-end justify-between border-b border-[var(--border-default)] bg-[var(--panel-bg)] px-2"
      style={{ WebkitAppRegion: chromeWindowDrag ? 'drag' : 'no-drag' } as React.CSSProperties}
    >
      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        sessionId={sessionId}
        onActivate={onActivate}
        onClose={onClose}
        onReorder={onReorder}
        onAdd={onAdd}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
        addButtonWrapperClassName="h-[36px]"
        addButtonClassName="mt-[3px]"
      />

      {/* Right: window controls. 仅 showWindowControls=true(Win 端)时渲染;
          Mac 端 maximize / 折叠走 MainLayout 浮层,本块不在场,TabBar 右端完全空。
          垂直居中(items-center)而非 end —— 避开 tab pill 底齐对齐. */}
      {showWindowControls && (
        <div
          className="flex h-full shrink-0 items-center gap-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {onDetach && (
            <ChromeIconButton
              aria-label={t('rightSidebar.tabs.controls.detachAria')}
              title={t('rightSidebar.tabs.controls.detachAria')}
              onClick={onDetach}
            >
              <PictureInPicture2 size={14} />
            </ChromeIconButton>
          )}
          {onMaximize && (
            <ChromeIconButton
              aria-label={t(
                isMaximized
                  ? 'rightSidebar.tabs.controls.restoreAria'
                  : 'rightSidebar.tabs.controls.maximizeAria',
              )}
              onClick={onMaximize}
            >
              {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </ChromeIconButton>
          )}
          {onCloseSidebar && (
            <ChromeIconButton
              aria-label={t('rightSidebar.tabs.controls.closeAria')}
              onClick={onCloseSidebar}
            >
              <PanelRightClose size={15} />
            </ChromeIconButton>
          )}
        </div>
      )}
    </div>
  );
}

export function TabStrip({
  tabs,
  activeTabId,
  sessionId = null,
  onActivate,
  onClose,
  onReorder,
  onAdd,
  onCloseOthers,
  onCloseAll,
  className,
  pillVariant = 'flush',
  addButtonWrapperClassName,
  addButtonClassName,
}: TabStripProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const addButtonWrapperRef = useRef<HTMLDivElement | null>(null);
  const existingKinds = useMemo(() => new Set<TabKindId>(tabs.map((t) => t.kind)), [tabs]);
  // 右键菜单状态:虚拟 trigger 在 rect 位置弹 DropdownMenu(跟 FileTreeView 同款做法,
  // 同时间只可能一个右键菜单打开,统一在 TabStrip 顶层管理避免每 pill 一份实例)。
  const [contextMenu, setContextMenu] = useState<{
    pos: { x: number; y: number };
    tabId: string;
  } | null>(null);
  const closeContextMenu = () => setContextMenu(null);

  // 溢出渐变遮罩:只在对应侧**真的有溢出**时才启用那一侧的 fade。
  // 历史坑(2026-07-01):全量常开的 fade-mask 会把首尾 active pill 的 1px border
  // 裁掉,所以被移除过 —— 现在按侧按需开,无溢出侧不加 mask,border 完好;
  // 有溢出侧 pill 本来就被裁在滚动口外,fade 只是把生硬的切边变柔和。
  // 用 mask-image(基于 alpha)而非叠色块:透出的是宿主栏自己的背景,
  // light / dark / 任意扩展主题天然正确,不需要针对主题取色。
  const [edgeFade, setEdgeFade] = useState({ left: false, right: false });
  const updateEdgeFade = useCallback(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdgeFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    updateEdgeFade();
    el.addEventListener('scroll', updateEdgeFade, { passive: true });
    // jsdom 无 ResizeObserver(仓库同款 guard,见 RolePillDropdown / ReviewTabBody)。
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateEdgeFade) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', updateEdgeFade);
      ro?.disconnect();
    };
  }, [updateEdgeFade]);
  // tabs 增删改变 scrollWidth,但不触发容器自身 resize —— 单独驱动一次重算。
  useEffect(() => {
    updateEdgeFade();
  }, [tabs, updateEdgeFade]);
  const fadeMaskImage =
    edgeFade.left || edgeFade.right
      ? `linear-gradient(to right, ${
          edgeFade.left ? 'transparent 0, black 24px' : 'black 0'
        }, ${edgeFade.right ? 'black calc(100% - 24px), transparent 100%' : 'black 100%'})`
      : undefined;

  return (
    <div
      data-testid="right-sidebar-tab-strip"
      className={cn(
        'relative flex min-w-0 flex-1 gap-1',
        pillVariant === 'chip' ? 'items-center' : 'items-end',
        className,
      )}
    >
      {/* drag/no-drag 口径:no-drag 只挖在真正可交互的元素上(tabs scroll 容器、
          「+」wrapper),TabStrip 根节点不整体 no-drag —— 根是 flex-1,tabs 少时
          「+」右侧的大片空白仍归宿主栏的 drag region,保证 Mac 合并顶栏 / Win
          TabBar 的空白区都能拖动窗口(Codex 同款:整条 drag、按钮挖洞)。 */}
      {/* tabs scroll 容器 +「+」按钮并排,共同占据左半。
          关键布局口径(2026-07-01 修):
            - tabs scroll 容器和「+」按钮是**兄弟节点**,scroll 容器 flex shrink + min-w-0
              (能被压缩到 0),「+」shrink-0(永远可见)。tabs 多到溢出时 scroll 容器
              内部横滑,「+」始终在 scroll 容器右侧贴着 —— 不会被推出视口。
            - 「+」放在 scroll 容器外:scroll 容器的 `overflow-x-auto + mask-image`
              会 clip 子元素并产生 stacking context,如果把「+」(及其 absolute dropdown)
              放在里面,dropdown popup 会被 overflow / mask 直接砍掉(用户实测 bug:
              点 + 没下拉)。
            - 垂直对齐随 pillVariant:flush 用 items-end(pill 底边贴宿主栏底边,
              chrome 风格),chip 用 items-center(与宿主栏其它控件同一中线)。 */}
      <div
        ref={tabsScrollRef}
        className="min-w-0 overflow-x-auto scrollbar-hide"
        style={
          {
            WebkitAppRegion: 'no-drag',
            // 保留 scroll padding 作为键盘/触控滚动的浏览器提示;active pill 的
            // 程序滚动只调整本容器 scrollLeft,避免滚动外层 RSB chrome。
            scrollPaddingInline: 16,
            // side-aware 溢出渐变(见上方 edgeFade 注释);无溢出时不设 mask。
            WebkitMaskImage: fadeMaskImage,
            maskImage: fadeMaskImage,
          } as React.CSSProperties
        }
      >
        <SortableList
          items={tabs}
          getId={(tab) => tab.id}
          onReorder={onReorder}
          reducedMotion={reducedMotion}
          // 整个 tab 标题区都可拖,靠 fallbackTolerance 区分普通 click 与拖动;
          // 只有关闭按钮显式 data-no-drag,避免用户想关 tab 时误起拖拽。
          filter="input, textarea, select, a, [data-no-drag]"
          className={cn('flex w-max gap-1', pillVariant === 'chip' ? 'items-center' : 'items-end')}
          rowClassName="right-sidebar-tab-sortable-row shrink-0"
          renderItem={(tab) => (
            <TabPill
              tab={tab}
              active={tab.id === activeTabId}
              pillVariant={pillVariant}
              sessionId={sessionId}
              fallbackLabel={t(labelKeyForTabKind(tab.kind))}
              t={t}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ pos: { x: e.clientX, y: e.clientY }, tabId: tab.id });
              }}
              scrollContainerRef={tabsScrollRef}
              closeAriaLabel={t('rightSidebar.tabs.tabCloseAria')}
            />
          )}
        />
      </div>
      {/* 「+」按钮 wrapper:scroll 容器外、shrink-0 永远可见。dropdown portal 到
          body(fixed 定位,以本 wrapper 为 anchor),不被面板 overflow-hidden 切。 */}
      <div
        ref={addButtonWrapperRef}
        className={cn('relative flex shrink-0 items-center', addButtonWrapperClassName)}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          aria-label={t('rightSidebar.tabs.addAria')}
          aria-haspopup="menu"
          aria-expanded={dropdownOpen}
          onClick={() => setDropdownOpen((v) => !v)}
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors',
            addButtonClassName,
            dropdownOpen
              ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
              : 'text-[var(--titlebar-icon)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <Plus size={13} />
        </button>
        {dropdownOpen && (
          <AddTabDropdown
            anchorRef={addButtonWrapperRef}
            onClose={() => setDropdownOpen(false)}
            onSelect={(kind) => {
              onAdd(kind);
              setDropdownOpen(false);
            }}
            existingKinds={existingKinds}
          />
        )}
      </div>

      {/* Tab pill 右键菜单 —— 虚拟 trigger 在右键位置弹 DropdownMenu(跟
          FileTreeView 同款)。"关闭其他" / "关闭所有" 由 Shell 提供 handler。
          只有 tabs > 1 时 "关闭其他" 才有意义,disabled 1 个 tab 场景。 */}
      <DropdownMenu
        open={contextMenu !== null}
        onOpenChange={(open) => {
          if (!open) closeContextMenu();
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: 'fixed',
              left: contextMenu?.pos.x ?? 0,
              top: contextMenu?.pos.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          className={cn(
            'rounded-xl p-0.5 overflow-hidden',
            'bg-[var(--cmd-palette-bg)]',
            'border border-[var(--cmd-palette-border)]',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          {contextMenu && (
            <>
              <DropdownMenuItem
                onClick={() => {
                  const id = contextMenu.tabId;
                  closeContextMenu();
                  onClose(id);
                }}
                className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
              >
                {t('rightSidebar.tabs.contextMenu.close')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={tabs.length <= 1}
                onClick={() => {
                  if (tabs.length <= 1) return;
                  const id = contextMenu.tabId;
                  closeContextMenu();
                  onCloseOthers?.(id);
                }}
                className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)] data-[disabled]:opacity-50"
              >
                {t('rightSidebar.tabs.contextMenu.closeOthers')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  closeContextMenu();
                  onCloseAll?.();
                }}
                className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
              >
                {t('rightSidebar.tabs.contextMenu.closeAll')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function TabPill({
  tab,
  active,
  pillVariant,
  sessionId,
  fallbackLabel,
  t,
  onActivate,
  onClose,
  onContextMenu,
  scrollContainerRef,
  closeAriaLabel,
}: {
  tab: TabState;
  active: boolean;
  /** 见 TabStripProps.pillVariant:flush = 贴底三边框 tab,chip = 居中四边框 chip。 */
  pillVariant: 'flush' | 'chip';
  sessionId: string | null;
  fallbackLabel: string;
  t: TFunction;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  closeAriaLabel: string;
}) {
  const plugin = getTabKind(tab.kind);
  const FallbackIcon = iconForTabKind(tab.kind);
  const TitleNode = plugin?.TabPillTitle;
  const IconNode = plugin?.TabPillIcon;
  // raw tab.state 可能是 null(Phase 2 旧 tab 没 hydrate)或旧 schema —— 必须先
  // 规范化再喂给 plugin 的 Title/Icon,否则 plugin 内 `state.xxx` 直接 NPE。
  // 走 store 持久化时是 raw,展示前由 hydrateTabState 兜底 / 校正。
  const hydratedState = hydrateTabState(plugin, tab.state);
  // active 变成 true 时(用户点了该 tab 或加新 tab 自动 active 它)滚到本容器视口里。
  // 只调整 tabs 横向滚动容器,避免浏览器把右栏外层 chrome 一起滚动。
  const pillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    scrollTabIntoContainerView(scrollContainerRef.current, pillRef.current);
  }, [active, scrollContainerRef]);
  return (
    <div
      ref={pillRef}
      onContextMenu={onContextMenu}
      // 中键(滚轮键)关闭当前 tab —— 对齐浏览器等多 tab 应用的通用习惯。
      // auxclick 对所有非主键(中/右键)都会触发,这里只认中键(button === 1);
      // 右键仍走上面的 onContextMenu 弹菜单,两者互不干扰。
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      // 抑制 Chromium 在 overflow-x 滚动容器内中键按下触发的 autoscroll(平移光标):
      // 必须在 mousedown 阶段 preventDefault,不影响随后 auxclick 的派发。
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      className={cn(
        'group flex h-[30px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] transition-colors',
        pillVariant === 'chip' ? 'rounded-lg' : 'rounded-t-lg',
        active
          ? cn(
              'border-[var(--border-default)] bg-[var(--surface)] font-medium text-[var(--text-primary)]',
              // flush 只画三边(底边由宿主栏 border-b 补齐,视觉上与内容区相连);
              // chip 悬浮居中,画完整四边框。
              pillVariant === 'chip' ? 'border' : 'border-l border-r border-t',
            )
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex items-center gap-1.5 max-w-[160px]"
      >
        <span
          className={cn(
            'shrink-0',
            active ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
          )}
        >
          {IconNode ? (
            <IconNode state={hydratedState} sessionId={sessionId} active={active} />
          ) : (
            <FallbackIcon size={13} />
          )}
        </span>
        <span className="truncate">
          {TitleNode ? (
            <TitleNode state={hydratedState} sessionId={sessionId} active={active} t={t} />
          ) : (
            fallbackLabel
          )}
        </span>
      </button>
      <button
        type="button"
        data-no-drag
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={closeAriaLabel}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-opacity hover:text-[var(--text-primary)]',
          // chip:close 常驻显形(Chrome 式)——若 hover 才显形,常态下右侧会留出
          // 一块看不见的占位空白,文字视觉上不居中;flush(Win)维持 hover 显形不变。
          pillVariant === 'flush' && 'opacity-0 group-hover:opacity-100',
        )}
      >
        <X size={10} />
      </button>
    </div>
  );
}

function ChromeIconButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--titlebar-icon)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  );
}
