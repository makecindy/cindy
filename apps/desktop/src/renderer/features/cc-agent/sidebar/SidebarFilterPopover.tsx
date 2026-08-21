/**
 * SidebarFilterPopover — 侧边栏显示设置菜单
 * ---------------------------------------------------------------------------
 * 菜单分四段语义（侧边栏重设计,docs/product-rules/sidebar-redesign-plan.md §3）：
 *   - 分组：独立复选——按项目分组 / 按设备分组(仅远程连接时出现)/ 对话归为一组
 *   - 排序：任务排序（recency / priority）+ 按项目分组时的项目顺序
 *     （activity / custom）
 *   - 筛选：一级只占一行，右侧显示摘要（「无」/「N 项生效」），展开二级子菜单
 *     承载 Status / Project / Agent / Last activity 四维度 + 重置筛选
 *   - 显示：主列表形态(文字/列表)+ 任务信息复选(time / pr / worktree / tokens / cost)
 *
 * 入口仍复用 sliders-horizontal 图标；内容为行式菜单 + 子菜单。
 *
 * 开合方式:**点击展开**(2026-08-12 用户裁决,推翻早前的 hover 自动展开)——
 * 与「对话」段头的同款设置按钮(DialogueSection)完全一致:普通 Radix
 * DropdownMenu,不再走 useHoverOpenMenu 的受控 hover 开合。非模态保留
 * (modal={false}):侧栏是常驻面板,不需要为一个整理菜单锁滚动 / 屏蔽全局指针。
 * 触发按钮配色也与段头其余按钮统一到侧栏 token 对
 * (--sidebar-list-muted → hover --sidebar-nav-text),此前用通用
 * --text-tertiary/--text-secondary,hover 时比邻居暗一档、视觉不齐。
 */

import type { ReactNode } from 'react';
import {
  AlignJustify,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  CircleDot,
  Clock,
  Coins,
  Filter,
  Folder,
  Folders,
  GitPullRequest,
  Globe,
  Info,
  LayoutList,
  SlidersHorizontal,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useSidebarMainViewMode, type SidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { projectOrderWriteLedger, resolveDisplayedProjectOrder } from '@cindy/maker-shared/project-order-sync';
import { useEffectiveSelectedMachineId } from '@/features/device-link/useMachineSwitcher';
import {
  controllerManualOrderForDevice,
  projectOrderWriteScopeForSelection,
  useLocalHostProjectOrder,
  useRemoteHostProjectOrders,
} from '../hooks/useRemoteHostProjectOrders';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import { getRemoteProjectMachineIdentity } from '../lib/remoteProjectIdentity';
import type {
  FilterGroupBy,
  FilterLastActivity,
  FilterProjectOrder,
  FilterSortBy,
  FilterStatus,
  FilterVendor,
  UseSidebarFilterReturn,
} from '../hooks/useSidebarFilter';
import {
  DIALOGUE_FILTER_KEY,
  projectFilterIncludes,
} from '../hooks/helpers/sidebarFilterCore';
import { useTaskInfoFields, type TaskInfoField } from '../hooks/useTaskInfoFields';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from './menuStyles';

type Option<T extends string> = {
  value: T;
  labelKey: string;
  /**
   * 行首小图标(2026-08-12 用户裁决:让选项一眼可辨)。只给「形态 / 数据类型」
   * 这类图标能真正帮上忙的段——分组与排序是抽象策略,硬配图标反而增噪,留空。
   */
  Icon?: LucideIcon;
  /**
   * hover 说明(2026-08-13 用户裁决)。只给「光看标签猜不出排序依据」的选项——
   * 「优先级」不说清按什么排,用户无从判断它和「按时间排序」的差别;
   * 「按时间排序」名字自解释,不加提示避免菜单变成说明书。
   */
  tipKey?: string;
};

const STATUS_OPTIONS: ReadonlyArray<Option<FilterStatus>> = [
  { value: 'active', labelKey: 'ccAgent.sidebar.filterStatus.active' },
  { value: 'archived', labelKey: 'ccAgent.sidebar.filterStatus.archived' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterStatus.all' },
];

const VENDOR_OPTIONS: ReadonlyArray<Option<FilterVendor>> = [
  { value: 'all', labelKey: 'ccAgent.sidebar.filterVendor.all' },
  { value: 'cc', labelKey: 'ccAgent.sidebar.filterVendor.cc' },
  { value: 'codex', labelKey: 'ccAgent.sidebar.filterVendor.codex' },
];

const LAST_ACTIVITY_OPTIONS: ReadonlyArray<Option<FilterLastActivity>> = [
  { value: '1d', labelKey: 'ccAgent.sidebar.filterLastActivity.1d' },
  { value: '3d', labelKey: 'ccAgent.sidebar.filterLastActivity.3d' },
  { value: '7d', labelKey: 'ccAgent.sidebar.filterLastActivity.7d' },
  { value: '30d', labelKey: 'ccAgent.sidebar.filterLastActivity.30d' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterLastActivity.all' },
];

/** 「最早优先」(旧 time)与旧「手动排序」都已从任务排序里拿掉。 */
const SORT_BY_OPTIONS: ReadonlyArray<Option<FilterSortBy>> = [
  { value: 'recency', labelKey: 'ccAgent.sidebar.filterSortBy.recency' },
  {
    value: 'priority',
    labelKey: 'ccAgent.sidebar.filterSortBy.priority',
    tipKey: 'ccAgent.sidebar.filterSortByTip.priority',
  },
];

const PROJECT_ORDER_OPTIONS: ReadonlyArray<Option<FilterProjectOrder>> = [
  { value: 'activity', labelKey: 'ccAgent.sidebar.filterProjectOrder.activity' },
  {
    value: 'custom',
    labelKey: 'ccAgent.sidebar.filterProjectOrder.custom',
    tipKey: 'ccAgent.sidebar.filterProjectOrderTip.custom',
  },
];

/**
 * 本表的顺序 = 菜单里复选项的排列顺序(固定)。列表行的**渲染顺序**另算:
 * 按用户勾选先后(2026-08-12 用户裁决),见 SessionInfoMeta。
 * 图标对应各自的数据类型:时间=Clock(Timer 已被自动任务独占,不复用避免撞义)、
 * PR=GitPullRequest、worktree=Folders(独立工作副本,不跟 PR 的 git 分叉抢形)、
 * token=Coins、费用=Wallet。
 */
const TASK_INFO_OPTIONS: ReadonlyArray<Option<TaskInfoField>> = [
  { value: 'time', labelKey: 'ccAgent.sidebar.taskInfo.time', Icon: Clock },
  { value: 'pr', labelKey: 'ccAgent.sidebar.taskInfo.pr', Icon: GitPullRequest },
  { value: 'worktree', labelKey: 'ccAgent.sidebar.taskInfo.worktree', Icon: Folders },
  { value: 'tokens', labelKey: 'ccAgent.sidebar.taskInfo.tokens', Icon: Coins },
  { value: 'cost', labelKey: 'ccAgent.sidebar.taskInfo.cost', Icon: Wallet },
];

/**
 * 主列表显示形态(B 期):文字版 / 列表版。卡片版仅置顶段支持(入口在置顶段头)。
 * 图标沿用置顶段显示模式菜单的既有定案(PinnedSection):文字=密排文本行,
 * 列表=带内容块的行 —— 同一概念在两处菜单里字形一致。
 */
const MAIN_VIEW_OPTIONS: ReadonlyArray<Option<SidebarMainViewMode>> = [
  { value: 'text', labelKey: 'ccAgent.sidebar.viewStyleList', Icon: AlignJustify },
  { value: 'list', labelKey: 'ccAgent.sidebar.viewStyleListWide', Icon: LayoutList },
];

export interface SidebarFilterPopoverProps {
  filter: UseSidebarFilterReturn;
  /** 用于 Project 多选列表的完整候选集（不受 Last activity 收窄影响）。 */
  allKnownProjects: ProjectNodeData[];
  /** 当前范围内无项目任务数,用来在项目筛选里画「对话」选项。 */
  dialogueCount?: number;
  /**
   * 是否有远程设备连接(E 期)。「按设备分组」与顶部设备切换栏同一出现条件:
   * 仅远程连接时显示;仅本机时该选项整行隐藏。
   */
  hasRemoteDevices?: boolean;
  /**
   * 受控光标定位模式(2026-08-12 用户裁决:侧栏空白处右键也能开这个菜单)。
   * 传入时不渲染段头那个 sliders 按钮,改用「隐形定位 trigger」把菜单开在光标处
   * (与 ProjectNode / ChatImageView 的右键菜单同款做法)。null = 关闭。
   */
  contextMenuPos?: { x: number; y: number } | null;
  /** 受控模式下的关闭回调(点外部 / Esc / 选中项)。 */
  onContextMenuOpenChange?: (open: boolean) => void;
  /**
   * 段头按钮模式的受控开合。范围菜单里的「侧边栏显示设置」入口用它把同一份
   * 菜单打开;与 contextMenuPos 互斥——受控光标模式仍走上面那对 prop。
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function optionLabel<T extends string>(
  options: ReadonlyArray<Option<T>>,
  value: T,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(options.find((option) => option.value === value)?.labelKey ?? '');
}

function MenuSubRow({
  label,
  value,
  valueNode,
  valueEmphasized = false,
  Icon,
  children,
}: {
  label: string;
  /** 文字摘要;给了 valueNode 时忽略(仍需传,用于 aria-label 之类的可读兜底)。 */
  value: string;
  /** 行首图标,与 MenuItemIcon 同规格。 */
  Icon?: LucideIcon;
  /**
   * 自定义摘要节点。任务信息行用它渲染「已选项的图标串」——图标比逗号分隔的
   * 短词更快扫读,且不会在 4 项全选时把行挤爆(2026-08-12 用户裁决)。
   */
  valueNode?: ReactNode;
  /** 偏离默认值时右侧摘要转正文色，提示筛选生效。 */
  valueEmphasized?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <MenuItemIcon Icon={Icon} />
        <span className="truncate">{label}</span>
        <span
          className={cn(
            'ml-auto max-w-[96px] truncate text-right',
            valueEmphasized ? 'text-foreground' : 'text-[var(--cmd-palette-item-meta)]',
          )}
          // 图标摘要下把文字版留给读屏(图标本身 aria-hidden)。
          aria-label={valueNode ? value : undefined}
        >
          {valueNode ?? value}
        </span>
        <ChevronRight size={14} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={8} className={cn(MENU_SUB_CONTENT_CLASS, 'w-[220px]')}>
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * 行首图标(可选):meta 灰、14px/1.8 —— 与菜单文字同一层级,不与右侧的 ✓ 抢注意力。
 * 同段内要么都给要么都不给,避免半数有图标造成文字起点参差。
 */
function MenuItemIcon({ Icon }: { Icon?: LucideIcon }) {
  if (!Icon) return null;
  return (
    <Icon size={14} strokeWidth={1.8} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
  );
}

function SelectMenuItem({
  label,
  selected,
  onSelect,
  Icon,
  tip,
  keepOpen = false,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  Icon?: LucideIcon;
  /** 可选 hover 说明(见 Option.tipKey);为空时 Tip 透明透传,不挂 tooltip。 */
  tip?: string;
  /**
   * 选中后保持菜单打开(2026-08-12 用户裁决)。给筛选的各维度用:筛选常要连着
   * 调好几项(状态 + Agent + 最近活跃),每选一次就整棵菜单收掉、得从段头重新点开
   * 再逐级展开,很难用。项目多选那段本就是这个行为,这里把三个单选维度对齐。
   * 排序与显示模式仍是选完即关——它们是「一次一个决定」,选完就该看列表效果。
   */
  keepOpen?: boolean;
}) {
  return (
    // side="right":菜单本身贴着侧栏右缘,提示往上/下会压住相邻选项,往右才有空间
    // (与项目多选行的远程 Tip 同侧)。Tip 在 text 为空时直接透传 children,
    // 无提示的选项零额外开销、也不会多包一层影响 Radix 的键盘导航。
    <Tip text={tip} side="right">
      <DropdownMenuItem
        onSelect={(event) => {
          if (keepOpen) event.preventDefault();
          onSelect();
        }}
        className={MENU_ITEM_CLASS}
      >
        <MenuItemIcon Icon={Icon} />
        <span className="truncate">{label}</span>
        {selected && (
          <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />
        )}
      </DropdownMenuItem>
    </Tip>
  );
}

/** 复选行：点击不关菜单，右侧打勾表示已选中。 */
function CheckMenuItem({
  label,
  checked,
  onToggle,
  Icon,
  disabled = false,
  tip,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  Icon?: LucideIcon;
  disabled?: boolean;
  tip?: string;
}) {
  return (
    <Tip text={tip} side="right">
      <DropdownMenuItem
        disabled={disabled}
        onSelect={(event) => {
          event.preventDefault();
          if (disabled) return;
          onToggle();
        }}
        className={MENU_ITEM_CLASS}
      >
        <MenuItemIcon Icon={Icon} />
        <span className="truncate">{label}</span>
        {checked && <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />}
      </DropdownMenuItem>
    </Tip>
  );
}

export function SidebarFilterPopover({
  filter,
  allKnownProjects,
  dialogueCount = 0,
  hasRemoteDevices = false,
  contextMenuPos,
  onContextMenuOpenChange,
  open,
  onOpenChange,
}: SidebarFilterPopoverProps) {
  const { t } = useTranslation();
  const localPlatform = window.electronAPI.platform;
  const selectedMachineForOrder = useEffectiveSelectedMachineId();
  const localHostProjectOrder = useLocalHostProjectOrder();
  const remoteHostProjectOrders = useRemoteHostProjectOrders(selectedMachineForOrder);
  const projectOrderScope = projectOrderWriteScopeForSelection(selectedMachineForOrder);
  // 受控光标模式 = 调用方传了 contextMenuPos 这个 prop(值为 null 表示"当前关闭",
  // 仍算受控);段头按钮模式则完全不传。用 !== undefined 而非真值判断。
  const isContextMode = contextMenuPos !== undefined;
  const {
    status,
    projects,
    projectsAsSet,
    isFilterActive,
    isSessionContentFiltered,
    vendor,
    lastActivity,
    groupBy,
    groupDialogue,
    groupDevice,
    sortBy,
    projectOrder,
    manualProjectOrder,
    setStatus,
    toggleProject,
    setProjectsAll,
    setVendor,
    setLastActivity,
    setGroupBy,
    setGroupDialogue,
    setGroupDevice,
    setSortBy,
    setProjectOrder: setViewerProjectOrder,
    resetContentFilters,
  } = filter;

  // 任务信息复选(独立共享状态:列表行与本菜单同源,见 useTaskInfoFields)。
  const { fields: taskInfoFields, toggleField: toggleTaskInfoField } = useTaskInfoFields();

  // 主列表显示形态(独立于置顶段的三态设置,B 期拆分)。
  const { mode: mainViewMode, setMode: setMainViewMode } = useSidebarMainViewMode();

  const statusValue = optionLabel(STATUS_OPTIONS, status, t);
  const vendorValue = optionLabel(VENDOR_OPTIONS, vendor, t);
  const lastActivityValue = optionLabel(LAST_ACTIVITY_OPTIONS, lastActivity, t);
  const groupByValue = t(
    groupBy === 'project'
      ? 'ccAgent.sidebar.filterGroupBy.project'
      : 'ccAgent.sidebar.filterGroupBy.flat',
  );
  const sortByValue = optionLabel(SORT_BY_OPTIONS, sortBy, t);
  const hostSnapshotForWrite = projectOrderScope.kind === 'host' && projectOrderScope.deviceId === null
    ? localHostProjectOrder.snapshot
    : projectOrderScope.kind === 'host' && projectOrderScope.deviceId
      ? remoteHostProjectOrders.orders.get(projectOrderScope.deviceId)
      : undefined;
  const scopedProjectOrder: FilterProjectOrder = resolveDisplayedProjectOrder(
    projectOrderScope,
    hostSnapshotForWrite,
    { manualProjectOrder, projectOrder },
    projectOrderScope.kind === 'host' && projectOrderScope.deviceId === null
      ? localHostProjectOrder.snapshot.manualProjectOrder
      : projectOrderScope.kind === 'host' && projectOrderScope.deviceId
        ? controllerManualOrderForDevice(
          projectOrderScope.deviceId,
          hostSnapshotForWrite,
        ) ?? []
        : [],
  ).projectOrder;
  const setProjectOrder = (next: FilterProjectOrder) => {
    if (
      projectOrderScope.kind === 'viewer'
      || groupBy !== 'project'
      || projectOrderWriteLedger(projectOrderScope, hostSnapshotForWrite) === 'viewer'
    ) {
      setViewerProjectOrder(next);
      return;
    }
    const hostKeys = projectOrderScope.deviceId === null
      ? allKnownProjects.map((project) => project.projectKey).filter((key) => key.startsWith('local:'))
      : allKnownProjects.map((project) => project.projectKey).filter((key) =>
        key.startsWith(`device:${encodeURIComponent(projectOrderScope.deviceId!)}:`));
    if (next === 'custom') {
      if (projectOrderScope.deviceId === null) {
        void localHostProjectOrder.apply({
          manualProjectOrder: localHostProjectOrder.snapshot.manualProjectOrder.length > 0
            ? localHostProjectOrder.snapshot.manualProjectOrder
            : hostKeys,
          projectOrder: 'custom',
        }).then((result) => {
          if (result.kind === 'unavailable') setViewerProjectOrder('custom');
        });
        return;
      }
      const current = controllerManualOrderForDevice(
        projectOrderScope.deviceId,
        remoteHostProjectOrders.orders.get(projectOrderScope.deviceId),
      ) ?? hostKeys;
      void remoteHostProjectOrders.apply(projectOrderScope.deviceId, {
        manualProjectOrder: current,
        projectOrder: 'custom',
      }).then((result) => {
        if (result.kind === 'unavailable') setViewerProjectOrder('custom');
      });
      return;
    }
    if (projectOrderScope.deviceId === null) {
      void localHostProjectOrder.apply({
        manualProjectOrder: localHostProjectOrder.snapshot.manualProjectOrder,
        projectOrder: 'activity',
      });
      return;
    }
    void remoteHostProjectOrders.apply(projectOrderScope.deviceId, {
      manualProjectOrder: controllerManualOrderForDevice(
        projectOrderScope.deviceId,
        remoteHostProjectOrders.orders.get(projectOrderScope.deviceId),
      ) ?? [],
      projectOrder: 'activity',
    });
  };
  const projectValue =
    projects === 'all'
      ? t('ccAgent.sidebar.filterAllText')
      : t('ccAgent.sidebar.filterSelectedProjects', { count: projects.length });

  // 一级「筛选」行摘要：偏离默认的维度数。
  const activeFilterCount =
    (status !== 'active' ? 1 : 0) +
    (projects !== 'all' ? 1 : 0) +
    (vendor !== 'all' ? 1 : 0) +
    (lastActivity !== 'all' ? 1 : 0);
  const filterSummary =
    activeFilterCount > 0
      ? t('ccAgent.sidebar.filterSummaryActive', { count: activeFilterCount })
      : t('ccAgent.sidebar.filterSummaryNone');

  // 「任务信息」行摘要：已选项的短标签串;全不选显示「无」。
  const taskInfoSummary =
    taskInfoFields.length > 0
      ? taskInfoFields
          .map((field) =>
            t(TASK_INFO_OPTIONS.find((option) => option.value === field)?.labelKey ?? ''),
          )
          .join(t('ccAgent.sidebar.taskInfoSummarySeparator'))
      : t('ccAgent.sidebar.taskInfoSummaryNone');
  const taskInfoIsDefault = taskInfoFields.length === 1 && taskInfoFields[0] === 'time';

  const ariaLabel = t('ccAgent.sidebar.filterAria', {
    status: statusValue,
    vendor: vendorValue,
    lastActivity: lastActivityValue,
    groupBy: groupByValue,
    sortBy: sortByValue,
    projects: projectValue,
  });

  return (
    // modal={false}:侧栏是常驻面板,整理菜单不该锁住列表滚动、也不该给 body
    // 加 pointer-events:none 屏蔽其余界面(点外部 / Esc 仍正常关闭)。
    <DropdownMenu
      modal={false}
      {...(isContextMode
        ? {
            open: contextMenuPos !== null,
            onOpenChange: (next: boolean) => onContextMenuOpenChange?.(next),
          }
        : open !== undefined
          ? { open, onOpenChange }
          : null)}
    >
      <DropdownMenuTrigger asChild>
        {isContextMode ? (
          // 隐形定位 trigger:菜单开在光标处(与 ProjectNode / ChatImageView 右键菜单同款)。
          <span
            aria-hidden
            style={{
              position: 'fixed',
              left: contextMenuPos?.x ?? 0,
              top: contextMenuPos?.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        ) : (
          /* hover 不再展开菜单,补一个与邻居同规的 tooltip(复用菜单标题文案,
              与「对话」段头同款按钮一致);aria-label 仍带完整设置摘要。 */
          <Tip text={t('ccAgent.sidebar.organizeSidebar')} side="bottom">
            <button
              type="button"
              aria-label={ariaLabel}
              aria-pressed={isFilterActive}
              className={cn(
                // 配色与段头其余按钮统一(侧栏 token 对),不用通用 text-tertiary。
                'flex h-7 w-7 items-center justify-center rounded-md',
                'text-[var(--sidebar-list-muted)]',
                'transition-colors hover:text-[var(--sidebar-nav-text)]',
              )}
            >
              <SlidersHorizontal size={14} strokeWidth={2} />
            </button>
          </Tip>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={isContextMode ? 2 : 8}
        // 与窗口边缘留白:菜单向上翻转时不顶死在标题栏上(仓库既有 8~16 的先例)。
        collisionPadding={8}
        className={cn(MENU_CONTENT_CLASS, 'w-[248px]')}
      >
        {/* 菜单自身的标题行已去掉(2026-08-12 用户裁决,节约高度;与远程机器菜单
            2026-07 的「无标题行」同规)——触发按钮的 tooltip 已经说明这是什么。

            高度兜底:菜单四段展开约 470px,窗口矮 / 触发按钮居中时上下都放不下,
            而 DropdownMenuContent 基础样式带 overflow-hidden 且无 max-height,
            超出部分会被**静默切掉**(实机:最上面的「分组」整段不见)。渲染进程
            画不到 BrowserWindow 外面,所以这里按 Radix 给出的可用高度收口并允许
            纵向滚动——滚动容器放内层(与下方项目列表同款做法),不与 content 的
            overflow-hidden 抢同一属性。减 0.75rem 让出 content 的 p-1 与边框。 */}
        <div className="max-h-[calc(var(--radix-dropdown-menu-content-available-height)-0.75rem)] overflow-y-auto">
          {/* ── 分组:独立复选(D 期)。「按项目分组」关 = flat 平铺;
            「对话归为一组」控制无项目任务是否收进对话组。 */}
          <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.sidebar.filterGroupByHeading')}
          </div>
          <CheckMenuItem
            label={t('ccAgent.sidebar.filterGroupBy.project')}
            checked={groupBy === 'project'}
            onToggle={() => setGroupBy(groupBy === 'project' ? 'flat' : 'project')}
          />
          {/* 「按设备分组」与顶部设备切换栏同一出现条件:仅远程连接时显示(E 期)。 */}
          {hasRemoteDevices && (
            <CheckMenuItem
              label={t('ccAgent.sidebar.filterGroupBy.device')}
              checked={groupDevice}
              onToggle={() => setGroupDevice(!groupDevice)}
            />
          )}
          <CheckMenuItem
            label={t('ccAgent.sidebar.filterGroupBy.dialogue')}
            checked={groupDialogue}
            onToggle={() => setGroupDialogue(!groupDialogue)}
          />

          <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

          {/* ── 排序 ── */}
          <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.sidebar.filterTaskSortHeading')}
          </div>
          {SORT_BY_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={sortBy === option.value}
              onSelect={() => setSortBy(option.value)}
              tip={option.tipKey ? t(option.tipKey) : undefined}
            />
          ))}

          {groupBy === 'project' ? (
            <>
              <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
              <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
                {t('ccAgent.sidebar.filterProjectOrderHeading')}
              </div>
              {PROJECT_ORDER_OPTIONS.map((option) => (
                <SelectMenuItem
                  key={option.value}
                  label={t(option.labelKey)}
                  selected={scopedProjectOrder === option.value}
                  onSelect={() => setProjectOrder(option.value)}
                  tip={option.tipKey ? t(option.tipKey) : undefined}
                />
              ))}
            </>
          ) : null}

          <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

          {/* ── 筛选（一行入口 → 二级四维度 + 重置） ── */}
          <MenuSubRow
            label={t('ccAgent.sidebar.filterHeading')}
            value={filterSummary}
            valueEmphasized={activeFilterCount > 0}
            Icon={Filter}
          >
            <MenuSubRow
              label={t('ccAgent.sidebar.filterStatusHeading')}
              value={statusValue}
              Icon={CircleDot}
            >
              {STATUS_OPTIONS.map((option) => (
                <SelectMenuItem
                  key={option.value}
                  label={t(option.labelKey)}
                  selected={status === option.value}
                  onSelect={() => setStatus(option.value)}
                  keepOpen
                />
              ))}
            </MenuSubRow>

            <MenuSubRow
              label={t('ccAgent.sidebar.filterProjectsHeading')}
              value={projectValue}
              Icon={Folder}
            >
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setProjectsAll();
                }}
                className={MENU_ITEM_CLASS}
              >
                <span className="truncate">{t('ccAgent.sidebar.filterAllProjects')}</span>
                {projects === 'all' && (
                  <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
              <div className="max-h-[256px] overflow-y-auto">
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    toggleProject(DIALOGUE_FILTER_KEY);
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t('ccAgent.sidebar.dialogues')}</span>
                  </span>
                  <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                    {dialogueCount}
                  </span>
                  {(projects === 'all' || (projectsAsSet?.has(DIALOGUE_FILTER_KEY) ?? false)) && (
                    <Check size={15} className="shrink-0 text-[var(--msg-assistant-text)]" />
                  )}
                </DropdownMenuItem>
                {allKnownProjects.map((project) => {
                  const selected =
                    projects === 'all' ||
                    (projectsAsSet != null &&
                      projectFilterIncludes(projectsAsSet, project.projectKey, localPlatform));
                  const remoteIdentity = getRemoteProjectMachineIdentity(project);
                  return (
                    <DropdownMenuItem
                      key={project.projectKey}
                      onSelect={(event) => {
                        event.preventDefault();
                        toggleProject(project.projectKey);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      {project.scope === 'remote' ? (
                        <Tip text={remoteIdentity?.displayLabel ?? project.remoteHostId ?? ''}>
                          <Globe
                            size={14}
                            strokeWidth={2}
                            className="shrink-0 text-[var(--folder-item-icon)]"
                          />
                        </Tip>
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{project.displayName}</span>
                        {remoteIdentity ? (
                          <span className="block truncate text-xs text-[var(--cmd-palette-item-meta)]">
                            {remoteIdentity.displayLabel}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                        {project.sessions.length}
                      </span>
                      {selected && (
                        <Check size={15} className="shrink-0 text-[var(--msg-assistant-text)]" />
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </MenuSubRow>

            <MenuSubRow
              label={t('ccAgent.sidebar.filterAgentHeading')}
              value={vendorValue}
              Icon={Bot}
            >
              {VENDOR_OPTIONS.map((option) => (
                <SelectMenuItem
                  key={option.value}
                  label={t(option.labelKey)}
                  selected={vendor === option.value}
                  onSelect={() => setVendor(option.value)}
                  keepOpen
                />
              ))}
            </MenuSubRow>

            <MenuSubRow
              label={t('ccAgent.sidebar.filterLastActivityHeading')}
              value={lastActivityValue}
              Icon={CalendarClock}
            >
              {LAST_ACTIVITY_OPTIONS.map((option) => (
                <SelectMenuItem
                  key={option.value}
                  label={t(option.labelKey)}
                  selected={lastActivity === option.value}
                  onSelect={() => setLastActivity(option.value)}
                  keepOpen
                />
              ))}
            </MenuSubRow>

            <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                resetContentFilters();
              }}
              disabled={!isSessionContentFiltered}
              className={MENU_ITEM_CLASS}
            >
              <span className="truncate text-[var(--text-secondary)]">
                {t('ccAgent.sidebar.filterReset')}
              </span>
            </DropdownMenuItem>
          </MenuSubRow>

          <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

          {/* ── 显示：主列表形态 + 任务信息复选 ── */}
          <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.sidebar.displayHeading')}
          </div>
          {MAIN_VIEW_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={mainViewMode === option.value}
              onSelect={() => setMainViewMode(option.value)}
              Icon={option.Icon}
            />
          ))}
          <MenuSubRow
            label={t('ccAgent.sidebar.taskInfoHeading')}
            value={taskInfoSummary}
            Icon={Info}
            valueNode={
              taskInfoFields.length > 0 ? (
                // 已选项用图标串表示,不再罗列短词。顺序 = 用户勾选顺序(遍历
                // taskInfoFields 而非选项表),与列表行的渲染顺序一致。
                <span className="flex items-center justify-end gap-1">
                  {taskInfoFields.map((field) => {
                    const Icon = TASK_INFO_OPTIONS.find((option) => option.value === field)?.Icon;
                    return Icon ? (
                      <Icon
                        key={field}
                        size={13}
                        strokeWidth={1.8}
                        className="shrink-0"
                        aria-hidden
                      />
                    ) : null;
                  })}
                </span>
              ) : undefined
            }
            valueEmphasized={!taskInfoIsDefault}
          >
            {TASK_INFO_OPTIONS.map((option) => (
              <CheckMenuItem
                key={option.value}
                label={t(option.labelKey)}
                checked={taskInfoFields.includes(option.value)}
                onToggle={() => toggleTaskInfoField(option.value)}
                Icon={option.Icon}
              />
            ))}
          </MenuSubRow>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
