/**
 * SidebarTopNav —— 侧栏顶部常驻动作/导航列表(取代原 HorizontalTabbar)。
 * ---------------------------------------------------------------------------
 * 一条同级、等权的列表行:新建固定;自动任务 / Plugins / 伙伴 / 搜索与带主视图的插件
 * 按用户偏好排序与显示(插件的显隐沿用其「在侧边栏显示」开关);未勾选的进「更多」。
 * 最小化插件面板恢复入口仍按需出现。
 *   - 新建 / 自动任务:项目(cc-agent)视图的动作 —— 在任意视图点击都跳回项目视图并执行。
 *   - Plugins:主视图切换(navigateToView),命中当前视图时高亮。
 *   - 伙伴:原位切换为「返回任务」动作,随目标更换文案和图标,不显示选中高亮。
 *   - 搜索(SidebarInlineSearch):静息态与其余行同款「🔍 搜索」;hover / 聚焦
 *     就地展开成搜索框,结果由下方功能槽(CCAgentSidebarUpper)替换列表绘制。搜索状态经
 *     ConversationSearchProvider 的 context 共享(行在此、结果在功能槽,两者是兄弟子树)。
 *   - 远程机器切换 2026-08-13 起不再占行:并入主列表段头标题(「全部任务」即
 *     范围下拉,见 MachineSwitcherMenu 头注),省一行且标题不再与范围脱节。
 * 去掉了原来的「项目(Bot)」标签 —— 项目即默认主视图,无单独入口。
 * rail 态由 SidebarRailNavigation 渲染同一套偏好(顺序 / 显示 / 「更多」);搜索仍是
 * CollapsedView 提供的 ConversationSearchBox 图标弹窗(不走本行 / context)。
 *
 * 与 Shell"不感知路由"的原则:本组件是原 HorizontalTabbar 的同位替代,封装了
 * 自身的路由 / cc-agent 数据,Shell 仍只负责把它渲染在顶行(见 Sidebar.tsx)。
 *
 * rail(收窄)态:任务视图用 SidebarRailNavigation;其它 Feature 的 rail 只由
 * section="rail" 补一个伙伴入口。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CirclePlus,
  Ellipsis,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate, useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useNavigationAttention } from '@/lib/navigationAttentionStore';
import { NavigationCountBadge } from '@/components/sidebar/NavigationCountBadge';
import { useAuth } from '@/contexts/AuthContext';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useAnyGhostUnread } from '@/cindy-brain/ghostUnreadStore';
import { useGhostMainViews, type GhostMainViewItem } from '@/cindy-brain/ghostMainViews';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { GhostPanelRestoreEntry } from '@/cindy-brain/GhostPanelRestoreEntry';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { SidebarInlineSearch } from '@/features/cc-agent/sidebar/SidebarInlineSearch';
import { SidebarIconButton, SIDEBAR_RAIL_ICON_BUTTON_CLASS } from './SidebarIconButton';
import { Tip } from '@/components/ui/tooltip';
import { useConversationSearchContext } from '@/features/cc-agent/sidebar/conversationSearchContext';
import { GhostMainViewNavEntry, MAIN_VIEW_ICONS } from './GhostMainViewNavEntries';
import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarNavigationCustomize } from './SidebarNavigationCustomize';
import {
  SIDEBAR_NAVIGATION_ITEM_ICONS,
  ghostIdOfEntry,
  isBuiltInEntry,
  markSidebarAppArrivalsSeen,
  reconcileSidebarAppArrivals,
  resolveSidebarNavigationOrder,
  useSidebarNavigationPrefs,
  useSidebarUnseenApps,
  type SidebarNavigationAppEntryId,
  type SidebarNavigationEntryId,
  type SidebarNavigationItemId,
} from './sidebarNavigationPrefs';

/** 列表行通用样式 —— 各行同款 pill 行。 */
const ROW_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)] transition-colors hover:bg-sidebar-item-hover';
/** 命中当前视图（自动任务 / Plugin 与 Skill 管理）时的高亮 —— 与下方会话列表
 *  选中行同款反相胶囊(sidebar-item-active 族;2026-07-21 用户裁决,替代原 chat-input-chip
 *  灰 chip,顶部导航选中态与对话选中样式统一)。hover:bg-sidebar-item-active 抵消
 *  ROW_CLASS 的半透明 hover(cn/twMerge last-wins),避免选中胶囊 hover 时闪回半透明。 */
const ROW_ACTIVE_CLASS =
  'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)] hover:bg-sidebar-item-active';

// Native window dragging ignores a portal's z-index. Keep both menu surfaces
// below the 46px titlebar / 50px invisible drag strip, including collision shifts.
const NAV_MENU_COLLISION_PADDING = { top: 58, right: 8, bottom: 8, left: 8 };
const NAV_MENU_CLASS =
  'min-w-[172px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto';

/**
 * 渲染范围。任务列表页把「新建」以外的行搬进列表滚动区(向上滚时一起滚走,
 * 对齐 Codex;2026-08-12 用户裁决),因此本组件要能分两段渲染:
 *   - 'all'(默认):常驻行全渲染。非 cc-agent 视图(插件页 / Skill 页等)沿用,
 *     那些页的侧栏没有长列表,不存在滚动需求。
 *   - 'pinned':只渲染「新建」——Shell 顶部固定段。
 *   - 'scrollable':渲染其余行(自动任务 / 插件 / 按需恢复入口 / 搜索),由 cc-agent
 *     的侧栏滚动容器在列表最上方绘制。
 */
export type SidebarTopNavSection = 'all' | 'pinned' | 'scrollable' | 'rail';

export interface SidebarNavigationAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  active: boolean;
  showDot: boolean;
  /** Attention count shown at the entry's end (99+ overflow), with its spoken label. */
  count?: { value: number; label: string };
}

function EntryCountBadge({ count, className }: { count?: SidebarNavigationAction['count']; className?: string }) {
  return count ? <NavigationCountBadge count={count.value} label={count.label} className={className} /> : null;
}

/** One definition per built-in entry, shared by the rows, the rail and More. */
function useSidebarNavigationActions(
  openSearch: () => void,
): Record<SidebarNavigationItemId, SidebarNavigationAction> {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeKey, navigateToView } = useActiveMainView();
  const onScheduleMatch = useMatch('/cc-agent/scheduled');
  // 任一插件有未读 → 入口行尾一颗**静态**绿点(聚合入口按 AttentionDot 规范不呼吸,
  // 呼吸留给单条卡片;见 AttentionDot 头部的形态规范)。
  const hasGhostUnread = useAnyGhostUnread();
  // `activeKey` is intentionally sticky for the other navigation rows, but this
  // action must describe the actual destination. Settings and other auxiliary
  // routes should continue to offer entry to Teammates, not a stale return.
  const isBotsView = isBotsPath(location.pathname);
  // The teammate entry counts what waits at its destination: unread teammate
  // messages, or tasks needing attention once it has become "back to tasks".
  const navigationCounts = useNavigationAttention();
  const botsCount = isBotsView ? navigationCounts.tasks : navigationCounts.teammates;
  return {
    automations: {
      label: t('ccAgent.layout.automations'),
      icon: SIDEBAR_NAVIGATION_ITEM_ICONS.automations,
      onSelect: () => navigate('/cc-agent/scheduled'),
      active: Boolean(onScheduleMatch),
      showDot: false,
    },
    plugins: {
      label: t('sidebar.tabs.plugins'),
      icon: SIDEBAR_NAVIGATION_ITEM_ICONS.plugins,
      onSelect: () => navigateToView('plugins'),
      active: activeKey === 'plugins',
      showDot: hasGhostUnread,
    },
    bots: {
      label: t(isBotsView ? 'sidebar.backToSessions' : 'sidebar.tabs.bots'),
      icon: isBotsView ? ArrowLeft : SIDEBAR_NAVIGATION_ITEM_ICONS.bots,
      onSelect: () => navigateToView(isBotsView ? 'cc-agent' : 'bots'),
      active: false,
      showDot: false,
      count: {
        value: botsCount,
        label: t(isBotsView ? 'sidebar.taskAttentionCount' : 'sidebar.teammateUnreadCount', { count: botsCount }),
      },
    },
    search: {
      label: t('sidebar.navigation.items.search'),
      icon: SIDEBAR_NAVIGATION_ITEM_ICONS.search,
      onSelect: openSearch,
      active: false,
      showDot: false,
    },
  };
}

function isBotsPath(pathname: string): boolean {
  return pathname === '/bots' || pathname.startsWith('/bots/');
}

/**
 * Built-in entries and plugin main views in one saved order. A plugin takes part
 * only while its own "show in sidebar" switch is on; Customize then decides whether
 * it sits at the top level or in More, like the built-ins.
 */
function useSidebarNavigationEntries(): {
  order: SidebarNavigationEntryId[];
  hidden: SidebarNavigationEntryId[];
  isVisible: (id: SidebarNavigationEntryId) => boolean;
  appFor: (id: SidebarNavigationEntryId) => GhostMainViewItem | undefined;
  /** Plugin entries that just arrived in More and have not been looked at. */
  unseen: ReadonlySet<SidebarNavigationEntryId>;
  markSeen: () => void;
} {
  const { dataOwnerId } = useAuth();
  const prefs = useSidebarNavigationPrefs(dataOwnerId);
  const { sidebarVisible } = useGhostMainViews();
  const rosterReady = useInstalledGhosts().length > 0;
  const sidebarGhostIds = sidebarVisible.map((item) => item.ghostId).join('\n');
  // Plugins entering the sidebar for the first time start in More, flagged as new.
  // Wait for the account and its installed roster: both are per data owner.
  useEffect(() => {
    if (dataOwnerId) {
      reconcileSidebarAppArrivals(
        dataOwnerId,
        sidebarGhostIds ? sidebarGhostIds.split('\n') : [],
        rosterReady,
      );
    }
  }, [dataOwnerId, sidebarGhostIds, rosterReady]);
  const unseenGhostIds = useSidebarUnseenApps(dataOwnerId);
  const apps = new Map(sidebarVisible.map((item) => [item.ghostId, item]));
  const order = resolveSidebarNavigationOrder(prefs.order, sidebarVisible.map((item) => item.ghostId));
  const isVisible = (id: SidebarNavigationEntryId) => ghostIdOfEntry(id) === null
    ? prefs.visible.includes(id as SidebarNavigationItemId)
    : prefs.appsAtTop.includes(id as SidebarNavigationAppEntryId);
  const appFor = (id: SidebarNavigationEntryId) => {
    const ghostId = ghostIdOfEntry(id);
    return ghostId === null ? undefined : apps.get(ghostId);
  };
  const hidden = order.filter((id) => !isVisible(id));
  const unseen = new Set(hidden.filter((id) => {
    const ghostId = ghostIdOfEntry(id);
    return ghostId !== null && unseenGhostIds.includes(ghostId);
  }));
  const markSeen = () => {
    if (dataOwnerId) markSidebarAppArrivalsSeen(dataOwnerId);
  };
  return { order, hidden, isVisible, appFor, unseen, markSeen };
}

/** Quiet grayscale tag for entries that just joined More. */
function NewTag({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-10 font-medium leading-4 text-[var(--text-primary)]',
        className,
      )}
    >
      {t('sidebar.navigation.new')}
    </span>
  );
}

/** Unchecked entries and (when there is room) the customize panel; empty menus render nothing. */
function SidebarNavigationMoreMenu({
  trigger,
  hiddenIds,
  actions,
  appFor,
  unseen,
  onSeen,
  onCustomize,
  onCloseAutoFocus,
}: {
  trigger: React.ReactNode;
  hiddenIds: readonly SidebarNavigationEntryId[];
  actions: Record<SidebarNavigationItemId, SidebarNavigationAction>;
  appFor: (id: SidebarNavigationEntryId) => GhostMainViewItem | undefined;
  unseen: ReadonlySet<SidebarNavigationEntryId>;
  /** Called when the menu closes after showing new entries. */
  onSeen: () => void;
  onCustomize?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // A press on a plugin item's manage button reaches the item's own select next;
  // this flag routes that one selection to the plugin details instead of its page.
  const openDetailsRef = useRef(false);
  if (hiddenIds.length === 0 && !onCustomize) return null;
  return (
    // New entries keep their tag while the menu is open, then count as seen.
    <DropdownMenu onOpenChange={(open) => { if (!open && unseen.size > 0) onSeen(); }}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={NAV_MENU_COLLISION_PADDING}
        className={NAV_MENU_CLASS}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {hiddenIds.map((id) => {
          const app = appFor(id);
          if (app) {
            const AppIcon = MAIN_VIEW_ICONS[app.icon];
            const manageLabel = t('settings.ghosts.page.manageAria', { name: app.manifest.name });
            const ghostId = encodeURIComponent(app.ghostId);
            return (
              <DropdownMenuItem
                key={id}
                onSelect={() => {
                  const openDetails = openDetailsRef.current;
                  openDetailsRef.current = false;
                  navigate(openDetails ? `/settings?tab=ghosts&ghost=${ghostId}` : `/apps/${ghostId}`);
                }}
                className="group/more-app gap-2.5"
              >
                <AppIcon size={16} strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate">{app.title}</span>
                {unseen.has(id) && <NewTag />}
                {/* Same manage action as the plugin's sidebar row, revealed with the item. */}
                <Tip text={manageLabel} side="right">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={manageLabel}
                    onClick={() => {
                      openDetailsRef.current = true;
                    }}
                    className="-mr-1 grid size-6 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] group-data-[highlighted]/more-app:opacity-100"
                  >
                    <SlidersHorizontal size={14} aria-hidden="true" />
                  </button>
                </Tip>
              </DropdownMenuItem>
            );
          }
          const action = isBuiltInEntry(id) ? actions[id] : null;
          if (!action) return null;
          const Icon = action.icon;
          return (
            <DropdownMenuItem key={id} onSelect={action.onSelect} className="gap-2.5">
              <Icon size={16} strokeWidth={1.8} />
              {action.label}
              {action.showDot && <AttentionDot size={6} className="ml-auto" />}
              <EntryCountBadge count={action.count} className="ml-auto" />
            </DropdownMenuItem>
          );
        })}
        {onCustomize && (
          <>
            {hiddenIds.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={onCustomize} className="gap-2.5">
              <SlidersHorizontal size={16} strokeWidth={1.8} />
              {t('sidebar.navigation.customize.title')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface SidebarRailSearchOptions {
  /** Open on mount: a hidden Search was chosen from More. */
  defaultOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 任务视图 rail 的导航段:与展开态同一份偏好 —— 勾选项(含插件主视图)按保存顺序
 * 成图标,其后是面板恢复入口,最后「更多」收纳未勾选项。
 * 搜索图标由调用方提供(依赖任务列表的数据),这里只决定它的位置与显隐。
 */
export function SidebarRailNavigation({
  renderSearch,
  forceSearch = false,
}: {
  renderSearch: (options: SidebarRailSearchOptions) => React.ReactNode;
  /** A project-scoped search request needs the tile even while Search is unchecked. */
  forceSearch?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const entries = useSidebarNavigationEntries();
  const [searchOpen, setSearchOpen] = useState(false);
  const [openSearchOnMount, setOpenSearchOnMount] = useState(false);
  const pendingSearchRef = useRef(false);
  // Open after More has closed: its focus return would otherwise dismiss the popover.
  const actions = useSidebarNavigationActions(() => {
    pendingSearchRef.current = true;
  });
  const handleMoreCloseAutoFocus = (event: Event) => {
    if (!pendingSearchRef.current) return;
    pendingSearchRef.current = false;
    event.preventDefault();
    setOpenSearchOnMount(true);
    setSearchOpen(true);
  };
  const handleSearchOpenChange = (open: boolean) => {
    setSearchOpen(open);
    if (!open) setOpenSearchOnMount(false);
  };
  const showSearch = entries.isVisible('search') || forceSearch || searchOpen;
  const tiles = entries.order.filter((id) => entries.isVisible(id) || (id === 'search' && showSearch));

  return (
    <>
      {tiles.map((id) => {
        const app = entries.appFor(id);
        if (app) return <GhostMainViewNavEntry key={id} item={app} variant="rail" />;
        if (id === 'search') {
          return (
            <Fragment key={id}>
              {renderSearch({ defaultOpen: openSearchOnMount, onOpenChange: handleSearchOpenChange })}
            </Fragment>
          );
        }
        if (!isBuiltInEntry(id)) return null;
        const action = actions[id];
        return (
          <SidebarIconButton
            key={id}
            icon={action.icon}
            label={action.label}
            active={action.active}
            aria-current={action.active ? 'page' : undefined}
            aria-description={action.count?.value ? action.count.label : undefined}
            showDot={action.showDot}
            badge={<EntryCountBadge count={action.count} />}
            onClick={action.onSelect}
          />
        );
      })}
      <GhostPanelRestoreEntry variant="rail" className={SIDEBAR_RAIL_ICON_BUTTON_CLASS} />
      <SidebarNavigationMoreMenu
        hiddenIds={entries.hidden}
        actions={actions}
        appFor={entries.appFor}
        unseen={entries.unseen}
        onSeen={entries.markSeen}
        onCloseAutoFocus={handleMoreCloseAutoFocus}
        trigger={
          <Tip text={t('sidebar.navigation.more')} side="right">
            <button
              type="button"
              className={cn(SIDEBAR_RAIL_ICON_BUTTON_CLASS, 'relative')}
              aria-label={entries.unseen.size > 0
                ? `${t('sidebar.navigation.more')} · ${t('sidebar.navigation.new')}`
                : t('sidebar.navigation.more')}
            >
              <Ellipsis size={18} />
              {/* The rail has no room for the tag; a static dot marks new entries. */}
              {entries.unseen.size > 0 && (
                <AttentionDot size={6} className="absolute right-1.5 top-1.5" />
              )}
            </button>
          </Tip>
        }
      />
    </>
  );
}

export function SidebarTopNav({
  section = 'all',
}: {
  section?: SidebarTopNavSection;
} = {}): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { navigateToView } = useActiveMainView();
  const { search, allKnownProjects, openSignal } = useConversationSearchContext();
  const { dataOwnerId } = useAuth();
  const navigationPrefs = useSidebarNavigationPrefs(dataOwnerId);
  const entries = useSidebarNavigationEntries();
  const [customizing, setCustomizing] = useState(false);
  const [showHiddenSearch, setShowHiddenSearch] = useState(false);
  const [searchOpenSignal, setSearchOpenSignal] = useState(0);
  const actions = useSidebarNavigationActions(() => {
    setShowHiddenSearch(true);
    setSearchOpenSignal((signal) => signal + 1);
  });

  // 通用新建继承当前任务的电脑，由草稿页集中迁移；同机保留已选项目。
  const handleNew = () => {
    navigate('/cc-agent/new', { state: makeGenericNewMakerRouteState(location.pathname) });
  };

  // 搜索结果 overlay 只在 cc-agent 视图(CCAgentSidebarUpper)绘制;本行却在所有非 rail 视图都渲染。
  // 用户在 plugins / 设置等视图输入搜索时,先切回 cc-agent 视图,结果才有处显示(同视图为 no-op)。
  const ensureConversationView = useCallback(() => navigateToView('cc-agent'), [navigateToView]);

  const showPinned = section !== 'scrollable' && section !== 'rail';
  const showScrollable = section !== 'pinned' && section !== 'rail';
  const pinSearch = section === 'scrollable' && search.query.trim().length > 0;
  if (section === 'rail') {
    // Other features' rails only borrow the teammate tile; the task rail renders
    // the full navigation itself. The bots feature owns the tile on its route.
    const bots = actions.bots;
    if (isBotsPath(location.pathname) || !navigationPrefs.visible.includes('bots')) return <></>;
    return (
      <div className="flex shrink-0 justify-center px-2 pt-2 pb-1">
        <SidebarIconButton
          icon={bots.icon}
          label={bots.label}
          aria-description={bots.count?.value ? bots.count.label : undefined}
          badge={<EntryCountBadge count={bots.count} />}
          onClick={bots.onSelect}
        />
      </div>
    );
  }
  const renderActionRow = (id: Exclude<SidebarNavigationItemId, 'search'>) => {
    const action = actions[id];
    const Icon = action.icon;
    return (
      <button
        onClick={action.onSelect}
        className={cn(ROW_CLASS, action.active && ROW_ACTIVE_CLASS)}
        aria-label={action.label}
        aria-current={action.active ? 'page' : undefined}
        aria-description={action.count?.value ? action.count.label : undefined}
      >
        <Icon
          size={15}
          strokeWidth={1.8}
          className={cn(
            'shrink-0',
            // 选中反相胶囊上图标跟随 active 前景(图标自带显式色,行级 text 覆盖不到它)。
            action.active
              ? 'text-sidebar-item-active-foreground'
              : 'text-[var(--sidebar-nav-text)]',
          )}
        />
        <span className="leading-none">{action.label}</span>
        {action.showDot && <AttentionDot size={6} className="ml-auto mr-0.5" />}
        <EntryCountBadge count={action.count} className="ml-auto" />
      </button>
    );
  };
  const restoreRow = showScrollable ? (
    <GhostPanelRestoreEntry variant="row" className={ROW_CLASS} />
  ) : null;
  const searchRow = showScrollable ? (
    <SidebarInlineSearch
      search={search}
      allKnownProjects={allKnownProjects}
      openSignal={openSignal + searchOpenSignal}
      onSearchActive={ensureConversationView}
      onFocusLeave={() => setShowHiddenSearch(false)}
    />
  ) : null;
  const rowFor = (id: SidebarNavigationEntryId): React.ReactNode => {
    if (!showScrollable) return null;
    const app = entries.appFor(id);
    if (app) return <GhostMainViewNavEntry item={app} variant="row" />;
    if (id === 'search') return searchRow;
    return isBuiltInEntry(id) ? renderActionRow(id) : null;
  };
  // A running query or a locked project search keeps its input reachable even
  // when the navigation entry is hidden in preferences.
  const showSearch = entries.isVisible('search') || showHiddenSearch ||
    search.query.length > 0 || Boolean(search.lockedProjectKey);
  const orderedIds = entries.order.filter((id) =>
    entries.isVisible(id) || (id === 'search' && showSearch),
  );
  const renderRows = (ids: readonly SidebarNavigationEntryId[]) => ids
    .map((id) => <Fragment key={id}>{rowFor(id)}</Fragment>);
  const orderedNavigationRows = renderRows(orderedIds);
  const customizeRow = showScrollable ? (
    <SidebarNavigationMoreMenu
      hiddenIds={entries.hidden}
      actions={actions}
      appFor={entries.appFor}
      unseen={entries.unseen}
      onSeen={entries.markSeen}
      onCustomize={() => setCustomizing(true)}
      trigger={
        <button
          type="button"
          className={ROW_CLASS}
          aria-label={entries.unseen.size > 0
            ? `${t('sidebar.navigation.more')} · ${t('sidebar.navigation.new')}`
            : t('sidebar.navigation.more')}
        >
          <Ellipsis
            size={15}
            strokeWidth={1.8}
            className="shrink-0 text-[var(--sidebar-nav-text)]"
          />
          <span className="leading-none">{t('sidebar.navigation.more')}</span>
          {entries.unseen.size > 0 && <NewTag className="ml-auto" />}
        </button>
      }
    />
  ) : null;

  // 滚动段把搜索行拆成滚动容器的直接子项:sticky 才能钉在结果列表上,
  // 不被短导航父盒的底边提前带走。输入框仍是同一份实例。
  if (section === 'scrollable') {
    // Search stays a direct child of the scrolling container so a live query
    // can stick to its top. The rows before and after it keep their saved order.
    const searchIndex = orderedIds.indexOf('search');
    const rowsBeforeSearch = renderRows(orderedIds.slice(0, searchIndex));
    const rowsAfterSearch = renderRows(orderedIds.slice(searchIndex + 1));
    return (
      <>
        {customizing ? (
          <SidebarNavigationCustomize
            // A draft belongs to one account; switching accounts starts a fresh one.
            key={dataOwnerId ?? ''}
            onDone={() => setCustomizing(false)}
          />
        ) : !showSearch ? (
          <div className="flex flex-col gap-0.5 pr-3 pl-3">
            {orderedNavigationRows}
            {restoreRow}
            {customizeRow}
          </div>
        ) : (
          <>
            {searchIndex > 0 && (
              <div className="flex flex-col gap-0.5 pr-3 pl-3">{rowsBeforeSearch}</div>
            )}
            <div
              className={cn(
                'px-3',
                searchIndex > 0 && '-mt-1.5',
                pinSearch && 'sticky top-0 z-30 bg-[var(--cmd-palette-bg)] pb-2.5',
              )}
            >
              {searchRow}
            </div>
            {/* Entries after Search stay reachable while a query is pinned; the
                results follow them instead of replacing them. */}
            <div className="-mt-1.5 flex flex-col gap-0.5 pr-3 pl-3">
              {rowsAfterSearch}
              {restoreRow}
              {customizeRow}
            </div>
          </>
        )}
      </>
    );
  }

  // Persistent-view contract: saved navigation order -> {restoreRow} -> More.
  return (
    // pt-1(原 2.5):顶行 chrome 收窄到 46px 后,列表整体上提贴近顶行(对齐 Codex)。
    // 分段渲染时(section≠'all')两段各自成块,由调用方分别放进固定区 / 滚动区;
    // padding 保持同一套,两段拼起来的视觉与整块渲染一致。pinned 段不带 pb,
    // 让滚动段紧随其后(行距仍由滚动段容器的 gap 承担)。
    <div
      className={cn(
        'flex flex-col gap-0.5 pt-1 pr-3 pl-3',
        section === 'pinned' ? 'pb-0.5' : 'pb-2.5',
      )}
    >
      {showPinned && (
        /* 1. 新建 —— 图标 15/1.8 + meta 灰:与项目行的文件夹图标同规格同色
          (2026-07 用户定稿,对齐 Codex;文字仍用 foreground)。 */
        <button onClick={handleNew} className={ROW_CLASS} aria-label={t('ccAgent.layout.new')}>
          <CirclePlus
            size={15}
            strokeWidth={1.8}
            className="shrink-0 text-[var(--sidebar-nav-text)]"
          />
          <span className="leading-none">{t('ccAgent.layout.new')}</span>
        </button>
      )}
      {showScrollable &&
        (customizing ? (
          <SidebarNavigationCustomize
            // A draft belongs to one account; switching accounts starts a fresh one.
            key={dataOwnerId ?? ''}
            onDone={() => setCustomizing(false)}
          />
        ) : (
          orderedNavigationRows
        ))}
      {showScrollable && !customizing && restoreRow}
      {showScrollable && !customizing && customizeRow}
    </div>
  );
}
