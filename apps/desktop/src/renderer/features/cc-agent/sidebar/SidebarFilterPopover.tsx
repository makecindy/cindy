/**
 * SidebarFilterPopover — 侧边栏显示设置菜单
 * ---------------------------------------------------------------------------
 * 2026-11-28 改版（docs/product-rules/sidebar-redesign-plan.md §3）：
 *   - 顶部一排「任务列表 / 收件箱」切换，下面的行随模式当场变化；
 *   - 选项少的直接摆成分段按钮（任务状态、显示、最近活跃），不再进子菜单；
 *   - 任务排序与项目排序合成一个「排序」子菜单；
 *   - 「隐藏」独立成一行，和分组一样勾选；「筛选」里只剩「只看哪些」；
 *   - Harness 是可多选的列表，插件带来的 Harness 装了多少列多少。
 * 任务列表：分组 / 排序 ｜ 任务状态 / 筛选 / 隐藏 ｜ 显示 / 任务信息。
 * 收件箱：分区和区内排序固定，只有 筛选 / 隐藏 ｜ 显示 / 任务信息 ｜ 收件箱使用技巧，数值与任务列表各记各的。
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

import { MountedMenuContent } from './MountedMenuContent';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  AlignJustify,
  ArrowDownWideNarrow,
  CalendarPlus,
  createLucideIcon,
  EyeOff,
  GripVertical,
  Layers,
  ListChecks,
  ListOrdered,
  MessageSquare,
  Monitor,
  RotateCcw,
  SquareTerminal,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Coins,
  CornerDownRight,
  Filter,
  Folder,
  Folders,
  GitPullRequest,
  Globe,
  Info,
  LayoutList,
  Lightbulb,
  SlidersHorizontal,
  Timer,
  Wallet,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';
import { isSharedTaskPeer, providerSharePickerState } from '@cindy/device-link';

import { BotAvatar } from '@/features/bots/BotAvatar';
import { taskCreatorFilterKey } from '@/features/bots/cindyDeviceRoster';
import { usePluginEngineIdentity } from '@/hooks/usePluginEngines';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { useProviderShareReceived } from '@/features/provider-share/providerShareStore';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';
import { pluginEngineKeyFromProviderId } from '../../../../shared/pluginEngines';
import { isProviderShareAgentDeviceId, providerShareIdOfAgentDeviceId } from '../../../../shared/providerShare';
import type { TaskListMode } from '@/hooks/useTaskListMode';
import { cn } from '@/lib/utils';
import { VendorIcon } from '@/components/sidebar/VendorIcon';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { useSidebarMainViewMode, type SidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  projectOrderWriteLedger,
  resolveDisplayedProjectOrder,
} from '@cindy/maker-shared/project-order-sync';
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
  FilterLastActivity,
  FilterProjectOrder,
  FilterSortBy,
  FilterStatus,
  UseSidebarFilterReturn,
} from '../hooks/useSidebarFilter';
import {
  BUILTIN_HARNESS_KEYS,
  DEFAULT_TASK_INFO_FIELDS,
  DIALOGUE_FILTER_KEY,
  projectFilterIncludes,
  sidebarContentFilterCount,
} from '../hooks/helpers/sidebarFilterCore';
import { useTaskInfoFields, type TaskInfoField } from '../hooks/useTaskInfoFields';
import { MENU_ITEM_CLASS, MENU_ROW_CLASS } from './menuStyles';
import { FilterReminderDot } from './FilterReminderDot';
import { useTaskListModeSwitch } from './TaskInboxIntro';

type Option<T extends string> = {
  value: T;
  labelKey: string;
  /** 子菜单动作文案；一级摘要仍用简短标签。 */
  menuLabelKey?: string;
  /** 菜单行统一配图标；分组入口按侧栏「组标题 + 缩进任务行」绘制。 */
  Icon?: LucideIcon;
  /** 行尾一句灰字：直接写出这个选项按什么排、收哪些任务，不用悬停才看得到。 */
  hintKey?: string;
  /**
   * hover 说明(2026-08-13 用户裁决)。只给「一句灰字说不完」的选项——
   * 「优先级」的四档顺序放在这里，行尾灰字只写最要紧的那一档。
   */
  tipKey?: string;
};

const STATUS_OPTIONS: ReadonlyArray<Option<FilterStatus>> = [
  { value: 'active', labelKey: 'ccAgent.sidebar.taskStatus.active' },
  { value: 'archived', labelKey: 'ccAgent.sidebar.taskStatus.archived' },
  { value: 'all', labelKey: 'ccAgent.sidebar.taskStatus.all' },
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
  {
    value: 'priority',
    labelKey: 'ccAgent.sidebar.filterSortBy.priority',
    hintKey: 'ccAgent.sidebar.filterSortByHint.priority',
    tipKey: 'ccAgent.sidebar.filterSortByTip.priority',
    menuLabelKey: 'ccAgent.sidebar.sortTaskBy.priority',
    Icon: ArrowDownWideNarrow,
  },
  {
    value: 'recency',
    labelKey: 'ccAgent.sidebar.filterSortBy.activity',
    hintKey: 'ccAgent.sidebar.filterSortByHint.activity',
    menuLabelKey: 'ccAgent.sidebar.sortTaskBy.activity',
    Icon: Clock,
  },
  {
    value: 'created',
    labelKey: 'ccAgent.sidebar.filterSortBy.created',
    hintKey: 'ccAgent.sidebar.filterSortByHint.created',
    menuLabelKey: 'ccAgent.sidebar.sortTaskBy.created',
    Icon: CalendarPlus,
  },
];

const PROJECT_ORDER_OPTIONS: ReadonlyArray<Option<FilterProjectOrder>> = [
  { value: 'activity', labelKey: 'ccAgent.sidebar.filterProjectOrder.activity', Icon: ListOrdered },
  {
    value: 'custom',
    labelKey: 'ccAgent.sidebar.filterProjectOrder.custom',
    hintKey: 'ccAgent.sidebar.filterProjectOrderHint.custom',
    tipKey: 'ccAgent.sidebar.filterProjectOrderTip.custom',
    Icon: GripVertical,
  },
];

/**
 * 任务标识：行上表明「这是谁的、在哪、用什么跑」的三样，只有显示或不显示。
 * 图标对应各自的数据类型。
 */
const TASK_IDENTITY_OPTIONS: ReadonlyArray<Option<TaskInfoField>> = [
  { value: 'harness', labelKey: 'ccAgent.sidebar.taskInfo.harness', Icon: SquareTerminal },
  { value: 'project', labelKey: 'ccAgent.sidebar.taskInfo.project', Icon: Folder },
  { value: 'teammate', labelKey: 'ccAgent.sidebar.taskInfo.teammate', Icon: Bot },
];

/**
 * 右侧信息：本表的顺序 = 菜单里复选项的排列顺序(固定)。列表行的**渲染顺序**另算:
 * 按用户勾选先后(2026-08-12 用户裁决),见 SessionInfoMeta；菜单在已选项后标出序号。
 * 时间=Clock(Timer 已被自动任务独占,不复用避免撞义)、PR=GitPullRequest、
 * worktree=Folders(独立工作副本,不跟 PR 的 git 分叉抢形)、token=Coins、费用=Wallet。
 */
const TASK_META_OPTIONS: ReadonlyArray<Option<TaskInfoField>> = [
  { value: 'time', labelKey: 'ccAgent.sidebar.taskInfo.time', Icon: Clock },
  { value: 'pr', labelKey: 'ccAgent.sidebar.taskInfo.pr', Icon: GitPullRequest },
  { value: 'worktree', labelKey: 'ccAgent.sidebar.taskInfo.worktree', Icon: Folders },
  { value: 'tokens', labelKey: 'ccAgent.sidebar.taskInfo.tokens', Icon: Coins },
  { value: 'cost', labelKey: 'ccAgent.sidebar.taskInfo.cost', Icon: Wallet },
];

const TASK_INFO_OPTIONS: ReadonlyArray<Option<TaskInfoField>> = [
  ...TASK_IDENTITY_OPTIONS,
  ...TASK_META_OPTIONS,
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

const TASK_LIST_MODES: readonly TaskListMode[] = ['tasks', 'inbox'];

// 复现侧栏两段「组标题 + 缩进任务行」，与其它 Lucide 图标共享尺寸和描边。
const SidebarGroupsIcon = createLucideIcon('SidebarGroups', [
  ['path', { d: 'm3 4 2 2 2-2M11 5h10M10 10h8m-15 5 2 2 2-2M11 16h10M10 21h8', key: 'groups' }],
]);

/** 插件带来的 Harness：键见 sessionHarnessKey；名称与图标按 providerId 从所在电脑的目录解析。 */
export interface SidebarPluginHarness {
  key: string;
  providerId: string | null;
  /** 任务所在的远程电脑；本机任务不传。 */
  deviceId?: string;
  /** 插件引擎所在电脑；缺省表示运行在任务所在电脑。 */
  agentDeviceId?: string;
  remoteHostId?: string | null;
  deviceConnected?: boolean;
}

export interface SidebarFilterPopoverProps {
  filter: UseSidebarFilterReturn;
  /** 用于 Project 多选列表的完整候选集（不受 Last activity 收窄影响）。 */
  allKnownProjects: ProjectNodeData[];
  /** 当前范围内无项目任务数,用来在项目筛选里画「对话」选项。 */
  dialogueCount?: number;
  /** 当前范围内任务用到的插件 Harness；内置三种始终列出，不在此列。 */
  pluginHarnesses?: readonly SidebarPluginHarness[];
  /**
   * 是否有可选的远程设备（含断线缓存）。设备仍在切换栏可选时保留分组选项，
   * 仅剩本机或被拒设备时隐藏，不因连接状态抖动改变分组。
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
  contentClassName,
  children,
}: {
  label: string;
  /** 文字摘要;给了 valueNode 时忽略(仍需传,用于 aria-label 之类的可读兜底)。 */
  value: string;
  /** 行首图标,与 MenuItemIcon 同规格。 */
  Icon?: LucideIcon;
  /**
   * 自定义摘要节点。分组、隐藏、任务信息行用它渲染「已选项的图标串」——图标比逗号分隔的
   * 短词更快扫读,且不会在全选时把行挤爆、被截断(2026-08-12 用户裁决;2026-11-28 推广到分组)。
   */
  valueNode?: ReactNode;
  /** 偏离默认值时右侧摘要转正文色，提示筛选生效。 */
  valueEmphasized?: boolean;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <MenuItemIcon Icon={Icon} />
        <span className="truncate" title={label}>{label}</span>
        <span
          className={cn(
            'ml-auto max-w-[148px] truncate text-right',
            valueEmphasized ? 'text-foreground' : 'text-[var(--cmd-palette-item-meta)]',
          )}
          // 图标摘要下把文字版留给读屏(图标本身 aria-hidden)。
          aria-label={valueNode ? value : undefined}
          title={valueNode ? undefined : value}
        >
          {valueNode ?? value}
        </span>
        <ChevronRight size={14} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={8} className={cn('w-[220px]', contentClassName)}>
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

/** 一级行右侧的图标摘要：已选项各一个图标，读屏文字由 MenuSubRow 的 aria-label 给出。 */
function IconSummary({ icons }: { icons: readonly LucideIcon[] }) {
  return (
    <span className="flex items-center justify-end gap-1.5">
      {icons.map((Icon, index) => (
        <Icon key={index} size={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
      ))}
    </span>
  );
}

/** 选项名后面的一句灰字说明；放不下时它先截断（shrink 权重远大于选项名），不挤选项名。 */
function RowHint({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span className="ml-auto min-w-0 shrink-[100] truncate pl-2 text-12 font-normal text-[var(--cmd-palette-item-meta)]" title={text}>
      {text}
    </span>
  );
}

function SelectMenuItem({
  label,
  selected,
  onSelect,
  Icon,
  hint,
  tip,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  Icon?: LucideIcon;
  /** 行尾灰字(见 Option.hintKey)。 */
  hint?: string;
  /** 可选 hover 说明(见 Option.tipKey);为空时 Tip 透明透传,不挂 tooltip。 */
  tip?: string;
}) {
  return (
    // side="right":菜单本身贴着侧栏右缘,提示往上/下会压住相邻选项,往右才有空间
    // (与项目多选行的远程 Tip 同侧)。Tip 在 text 为空时直接透传 children,
    // 无提示的选项零额外开销、也不会多包一层影响 Radix 的键盘导航。
    <Tip text={tip} side="right">
      <DropdownMenuItem
        onSelect={(event) => {
          // Keep the whole menu open so users can adjust multiple settings.
          event.preventDefault();
          onSelect();
        }}
        className={MENU_ITEM_CLASS}
      >
        <MenuItemIcon Icon={Icon} />
        <span className="truncate" title={label}>{label}</span>
        <RowHint text={hint} />
        {/* 勾的位置恒留:选中与否,行尾灰字的右缘都对齐。 */}
        <span className={cn('flex w-[15px] shrink-0 justify-end', !hint && 'ml-auto')}>
          {selected && <Check size={15} className="text-[var(--msg-assistant-text)]" />}
        </span>
      </DropdownMenuItem>
    </Tip>
  );
}

/** 复选行：使用共享菜单的左侧勾选列，点击后保持菜单打开。 */
function CheckMenuItem({
  label,
  checked,
  onToggle,
  Icon,
  icon,
  hint,
  disabled = false,
  tip,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  Icon?: LucideIcon;
  /** 非 Lucide 的行首图标(Harness 的品牌标记、插件图标)；与 Icon 二选一。 */
  icon?: ReactNode;
  /** 行尾灰字：说明或序号。 */
  hint?: string;
  disabled?: boolean;
  tip?: string;
}) {
  return (
    <Tip text={tip} side="right">
      <DropdownMenuCheckboxItem
        checked={checked}
        disabled={disabled}
        onSelect={(event) => {
          event.preventDefault();
          if (disabled) return;
          onToggle();
        }}
        className={MENU_ITEM_CLASS}
      >
        {/* 品牌标记可能自带文字(Pi 的 π),不计入行的可读名称。 */}
        {icon ? <span aria-hidden className="inline-flex shrink-0">{icon}</span> : <MenuItemIcon Icon={Icon} />}
        <span className="truncate" title={label}>{label}</span>
        <RowHint text={hint} />
      </DropdownMenuCheckboxItem>
    </Tip>
  );
}

type SegmentChoice<T extends string> = { value: T; label: string; Icon?: LucideIcon };

/**
 * 菜单里的分段选择行：选项少的设置直接摆出来，点一下就换，不进子菜单。
 * 行本身仍是一个菜单项（方向键上下能走到它）：左右键换选项，回车 / 空格 / 点行首图标切到下一个。
 * 鼠标点分段按钮时焦点留在行上（preserveMouseFocus），不打断菜单的键盘导航。
 *
 * 分段始终撑满所在的列，各行的分段因此左右对齐、宽度一致，也不随语言长短换行：
 *   - bar：行首图标 + 撑满内容列的分段，不写行名（选项本身能说明含义，行名留给读屏和悬停提示）。
 *     菜单里每一行都是「图标列 + 内容列」，分段与普通行的行名从同一条竖线起。
 *   - block：分段撑满整行；heading 给了就在上方画小标题（子菜单里选项含义不够明确时用）。
 */
function SegmentedMenuRow<T extends string>({
  label,
  Icon,
  value,
  options,
  onChange,
  layout = 'bar',
  heading = false,
  density = 'xs',
}: {
  label: string;
  Icon?: LucideIcon;
  value: T;
  options: ReadonlyArray<SegmentChoice<T>>;
  onChange: (value: T) => void;
  layout?: 'bar' | 'block';
  /** block 下是否在分段上方显示行名。 */
  heading?: boolean;
  density?: 'xs' | 'sm';
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const step = (delta: number) => {
    const next = options[(index + delta + options.length) % options.length];
    if (next && next.value !== value) onChange(next.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // 子菜单里左键本来是「收起子菜单」；落在分段行上时改为换选项，Esc 仍可收起。
    event.preventDefault();
    step(event.key === 'ArrowRight' ? 1 : -1);
  };
  return (
    <>
      {layout === 'block' && heading && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
      <DropdownMenuItem
        aria-label={`${label} ${options[index]?.label ?? ''}`.trim()}
        onSelect={(event) => {
          event.preventDefault();
          step(1);
        }}
        onKeyDown={onKeyDown}
        // 分段自己就是这一行的内容：不再垫一层行高亮，键盘走到时给分段画焦点环。
        className={cn(
          'h-auto cursor-default gap-2 data-[highlighted]:bg-transparent',
          '[&:focus-visible_.cindy-segmented]:outline [&:focus-visible_.cindy-segmented]:outline-2 [&:focus-visible_.cindy-segmented]:outline-[var(--focus-ring)]',
          layout === 'block' ? 'px-1 py-1' : 'min-h-8 py-1',
        )}
      >
        {layout === 'bar' && (
          <span className="inline-flex shrink-0" title={label}>
            <MenuItemIcon Icon={Icon} />
          </span>
        )}
        {/* 点分段按钮只换选项，不再触发行自己的「切到下一个」。 */}
        <span className="min-w-0 flex-1" onClick={(event) => event.stopPropagation()}>
          <SegmentedControl
            aria-label={label}
            value={value}
            onValueChange={onChange}
            density={density}
            fullWidth
            preserveMouseFocus
            // 内容列里的分段要容下最长的语言（日文的三个状态名），内边距比撑满整行的那种小一档。
            optionClassName={layout === 'bar' ? 'px-1.5' : 'px-2'}
            options={options.map((option) => ({
              value: option.value,
              label: option.Icon ? (
                <>
                  <option.Icon size={12} strokeWidth={1.8} aria-hidden />
                  {option.label}
                </>
              ) : (
                option.label
              ),
            }))}
          />
        </span>
      </DropdownMenuItem>
    </>
  );
}

const HARNESS_ICON_CLASS = 'text-[var(--cmd-palette-item-meta)]';

/** 插件 Harness 的勾选行：名称与图标跟任务行同源（usePluginEngineIdentity）。 */
function PluginHarnessMenuItem({
  harness,
  checked,
  onToggle,
}: {
  harness: SidebarPluginHarness;
  checked: boolean;
  onToggle: () => void;
}) {
  const selfDeviceId = useOptionalAuthDeviceId();
  const { received, loaded } = useProviderShareReceived();
  const taskDeviceId = harness.deviceId;
  const isSharedTask = isSharedTaskPeer(taskDeviceId);
  // Keep the menu's plugin identity aligned with SessionStatusIcon, including a locally stored
  // task whose Agent runs on another computer and a received provider share.
  const agentDeviceId = harness.remoteHostId ? undefined : harness.agentDeviceId;
  const sharedPluginDeviceId = !isSharedTask && agentDeviceId && isProviderShareAgentDeviceId(agentDeviceId)
    ? agentDeviceId : undefined;
  const shareId = sharedPluginDeviceId ? providerShareIdOfAgentDeviceId(sharedPluginDeviceId) : null;
  const share = shareId ? received.find((entry) => entry.shareId === shareId) : undefined;
  const directReadable = Boolean(
    share && providerSharePickerState(share) === 'available' && share.hostCapable
    && pluginEngineKeyFromProviderId(share.providerId) !== null,
  );
  const routed = Boolean(sharedPluginDeviceId && taskDeviceId && loaded && !share);
  const resolvedDeviceId = sharedPluginDeviceId
    ? (routed ? modelCatalogKey(sharedPluginDeviceId, taskDeviceId) : sharedPluginDeviceId)
    : (isSharedTask ? taskDeviceId : (agentDeviceId ?? taskDeviceId));
  const deviceId = resolvedDeviceId === selfDeviceId ? undefined : resolvedDeviceId;
  const readRemote = sharedPluginDeviceId
    ? (routed ? harness.deviceConnected !== false : directReadable)
    : (isSharedTask ? false : (agentDeviceId ? true : harness.deviceConnected !== false));
  const { name, iconDataUrl } = usePluginEngineIdentity(harness.providerId, deviceId, { readRemote });
  return (
    <CheckMenuItem
      label={name}
      checked={checked}
      onToggle={onToggle}
      icon={<VendorIcon vendor="acp" size={14} colorClassName={HARNESS_ICON_CLASS} iconDataUrl={iconDataUrl} />}
    />
  );
}

export function SidebarFilterPopover({
  filter,
  allKnownProjects,
  dialogueCount = 0,
  pluginHarnesses = [],
  hasRemoteDevices = false,
  contextMenuPos,
  onContextMenuOpenChange,
  open,
  onOpenChange,
}: SidebarFilterPopoverProps) {
  const { t } = useTranslation();
  const { mode: taskListMode, switchMode, showIntro: showInboxIntro, intro: inboxIntro } = useTaskListModeSwitch();
  const inboxMode = taskListMode === 'inbox';
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
    creators,
    creatorOptions,
    toggleCreator,
    setCreatorsAll,
    setCreatorsNone,
    isFilterActive,
    vendor,
    lastActivity,
    groupBy,
    groupDialogue,
    groupAutomation,
    groupDevice,
    sortBy,
    projectOrder,
    manualProjectOrder,
    hideAutomations,
    hideTaskCreated,
    setStatus,
    toggleProject,
    setProjectsAll,
    resetContentFilters,
    setVendor,
    toggleVendor,
    setLastActivity,
    setGroupBy,
    setGroupDialogue,
    setGroupAutomation,
    setGroupDevice,
    setSortBy,
    setHideAutomations,
    setHideTaskCreated,
    setProjectOrder: setViewerProjectOrder,
  } = filter;

  // 任务信息复选(独立共享状态:列表行与本菜单同源,见 useTaskInfoFields)。
  const { fields: taskInfoFields, toggleField: toggleTaskInfoField } = useTaskInfoFields();

  // 主列表显示形态(独立于置顶段的三态设置,B 期拆分)。
  const { mode: mainViewMode, setMode: setMainViewMode } = useSidebarMainViewMode();

  const statusValue = optionLabel(STATUS_OPTIONS, status, t);
  const lastActivityValue = optionLabel(LAST_ACTIVITY_OPTIONS, lastActivity, t);
  // 分组的层级固定为 设备 → 项目 / 对话 / 自动化 → 任务，摘要与子菜单都按这个顺序排。
  const groupChoices = [
    ...(hasRemoteDevices
      ? [{
          key: 'device', Icon: Monitor, checked: groupDevice, onToggle: () => setGroupDevice(!groupDevice),
          hintKey: 'ccAgent.sidebar.filterGroupByHint.device',
        }]
      : []),
    {
      key: 'project', Icon: Folder, checked: groupBy === 'project',
      onToggle: () => setGroupBy(groupBy === 'project' ? 'flat' : 'project'),
      hintKey: undefined,
    },
    {
      key: 'dialogue', Icon: MessageSquare, checked: groupDialogue, onToggle: () => setGroupDialogue(!groupDialogue),
      hintKey: 'ccAgent.sidebar.filterGroupByHint.dialogue',
    },
    {
      key: 'automation', Icon: Timer, checked: groupAutomation, onToggle: () => setGroupAutomation(!groupAutomation),
      hintKey: 'ccAgent.sidebar.filterGroupByHint.automation',
    },
  ];
  const activeGroups = groupChoices.filter((choice) => choice.checked);
  const groupByValue =
    activeGroups
      .map((choice) => t(`ccAgent.sidebar.groupSummary.${choice.key}`))
      .join(t('ccAgent.sidebar.taskInfoSummarySeparator')) || t('ccAgent.sidebar.filterSummaryNone');
  const MainViewIcon = MAIN_VIEW_OPTIONS.find((option) => option.value === mainViewMode)?.Icon;
  const sortByValue = optionLabel(SORT_BY_OPTIONS, sortBy, t);
  const hostSnapshotForWrite =
    projectOrderScope.kind === 'host' && projectOrderScope.deviceId === null
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
        ? (controllerManualOrderForDevice(projectOrderScope.deviceId, hostSnapshotForWrite) ?? [])
        : [],
  ).projectOrder;
  const setProjectOrder = (next: FilterProjectOrder) => {
    if (
      projectOrderScope.kind === 'viewer' ||
      groupBy !== 'project' ||
      projectOrderWriteLedger(projectOrderScope, hostSnapshotForWrite) === 'viewer'
    ) {
      setViewerProjectOrder(next);
      return;
    }
    const hostKeys =
      projectOrderScope.deviceId === null
        ? allKnownProjects
            .map((project) => project.projectKey)
            .filter((key) => key.startsWith('local:'))
        : allKnownProjects
            .map((project) => project.projectKey)
            .filter((key) =>
              key.startsWith(`device:${encodeURIComponent(projectOrderScope.deviceId!)}:`),
            );
    if (next === 'custom') {
      if (projectOrderScope.deviceId === null) {
        void localHostProjectOrder
          .apply({
            manualProjectOrder:
              localHostProjectOrder.snapshot.manualProjectOrder.length > 0
                ? localHostProjectOrder.snapshot.manualProjectOrder
                : hostKeys,
            projectOrder: 'custom',
          })
          .then((result) => {
            if (result.kind === 'unavailable') setViewerProjectOrder('custom');
          });
        return;
      }
      const current =
        controllerManualOrderForDevice(
          projectOrderScope.deviceId,
          remoteHostProjectOrders.orders.get(projectOrderScope.deviceId),
        ) ?? hostKeys;
      void remoteHostProjectOrders
        .apply(projectOrderScope.deviceId, {
          manualProjectOrder: current,
          projectOrder: 'custom',
        })
        .then((result) => {
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
      manualProjectOrder:
        controllerManualOrderForDevice(
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

  const creatorValue = creators === 'all' ? t('ccAgent.sidebar.filterCreatorsAny')
    : creators === 'none' ? t('ccAgent.sidebar.filterCreatorsNone')
    : creators.length === 1
      ? (creatorOptions.find(bot => taskCreatorFilterKey(bot) === creators[0])?.name
        ?? t('ccAgent.sidebar.filterSelectedCreators', { count: creators.length }))
      : t('ccAgent.sidebar.filterSelectedCreators', { count: creators.length });

  // Harness 摘要：全部 / 单选内置时写名字 / 其余写个数（插件 Harness 的名字要到子菜单里才解析）。
  const builtinHarnessKeys: readonly string[] = BUILTIN_HARNESS_KEYS;
  const vendorValue =
    vendor === 'all'
      ? t('ccAgent.sidebar.filterVendor.all')
      : vendor.length === 1 && builtinHarnessKeys.includes(vendor[0])
        ? t(`ccAgent.sidebar.filterVendor.${vendor[0]}`)
        : t('ccAgent.sidebar.filterSelectedHarnesses', { count: vendor.length });
  const harnessChecked = (key: string) => vendor === 'all' || vendor.includes(key);

  // 「隐藏」行摘要：藏了哪几类，各一个图标；没有则写「无」。
  const hideChoices = [
    {
      key: 'automations', Icon: Timer, checked: hideAutomations,
      onToggle: () => setHideAutomations(!hideAutomations),
    },
    {
      key: 'taskCreated', Icon: CornerDownRight, checked: hideTaskCreated,
      onToggle: () => setHideTaskCreated(!hideTaskCreated),
    },
    // 伙伴筛选的 'none'（原「筛选 › 伙伴 › 都不显示」，2026-11-28 用户决定挪到这里）：
    // 取消勾选回到「全部」；在「筛选 › 伙伴」里点选具体伙伴也会取消它。
    {
      key: 'teammates', Icon: Users, checked: creators === 'none',
      onToggle: () => (creators === 'none' ? setCreatorsAll() : setCreatorsNone()),
    },
  ];
  const activeHides = hideChoices.filter((choice) => choice.checked);
  const hideValue =
    activeHides
      .map((choice) => t(`ccAgent.sidebar.hideOptions.${choice.key}`))
      .join(t('ccAgent.sidebar.taskInfoSummarySeparator')) || t('ccAgent.sidebar.filterSummaryNone');

  // 段头按钮上的提醒点仍看全部收窄条件（含隐藏）；一级「筛选」行只数「只看哪些」的维度。
  const activeFilterCount = sidebarContentFilterCount(filter);
  const narrowFilterCount = activeFilterCount - activeHides.length;
  const filterSummary =
    narrowFilterCount > 0
      ? t('ccAgent.sidebar.filterSummaryActive', { count: narrowFilterCount })
      : t('ccAgent.sidebar.filterSummaryNone');

  // 「任务信息」行摘要：已选项的短标签串;全不选显示「无」。
  const summaryFields = taskInfoFields.length > 5 ? taskInfoFields.slice(0, 4) : taskInfoFields;
  const taskInfoSummary =
    taskInfoFields.length > 0
      ? taskInfoFields
          .map((field) =>
            t(TASK_INFO_OPTIONS.find((option) => option.value === field)?.labelKey ?? ''),
          )
          .join(t('ccAgent.sidebar.taskInfoSummarySeparator'))
      : t('ccAgent.sidebar.taskInfoSummaryNone');
  const taskInfoIsDefault =
    taskInfoFields.length === DEFAULT_TASK_INFO_FIELDS.length &&
    DEFAULT_TASK_INFO_FIELDS.every((field, index) => taskInfoFields[index] === field);
  // 右侧信息按勾选先后显示：勾了两项以上才标序号，只有一项时序号没有信息量。
  const orderedMetaFields = taskInfoFields.filter((field) =>
    TASK_META_OPTIONS.some((option) => option.value === field),
  );
  const metaOrderHint = (field: TaskInfoField) => {
    const position = orderedMetaFields.indexOf(field);
    return orderedMetaFields.length > 1 && position >= 0 ? String(position + 1) : undefined;
  };

  const ariaLabel = inboxMode ? [t('ccAgent.sidebar.organizeSidebar'), filterSummary].join(' · ') : t('ccAgent.sidebar.filterAria', {
    status: statusValue,
    vendor: vendorValue,
    lastActivity: lastActivityValue,
    groupBy: groupByValue,
    sortBy: sortByValue,
    projects: projectValue,
    creators: creatorValue,
  });

  const closeMenu = () => {
    if (isContextMode) onContextMenuOpenChange?.(false);
    else onOpenChange?.(false);
  };

  return (
    <>
    {/* modal={false}:侧栏是常驻面板,整理菜单不该锁住列表滚动、也不该给 body
        加 pointer-events:none 屏蔽其余界面(点外部 / Esc 仍正常关闭)。 */}
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
              aria-pressed={inboxMode ? activeFilterCount > 0 : isFilterActive}
              className={cn(
                // 配色与段头其余按钮统一(侧栏 token 对),不用通用 text-tertiary。
                'relative flex h-7 w-7 items-center justify-center rounded-lg',
                'text-[var(--sidebar-list-muted)]',
                'transition-colors hover:text-[var(--sidebar-nav-text)]',
              )}
            >
              <SlidersHorizontal size={14} strokeWidth={2} />
              {/* 收件箱里有筛选或隐藏生效时标一个点（段头会让这个按钮常驻显示）。
                  查看已归档任务不再标点（2026-11-28 用户决定）：任务状态已经摆在菜单第一层。 */}
              {inboxMode && activeFilterCount > 0 && <FilterReminderDot />}
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
        className="w-[288px]"
      >
        {/* 菜单自身的标题行已去掉(2026-08-12 用户裁决,节约高度;与远程机器菜单
            2026-07 的「无标题行」同规)——触发按钮的 tooltip 已经说明这是什么。

            高度兜底:窗口矮 / 触发按钮居中时上下都放不下,
            而 DropdownMenuContent 基础样式带 overflow-hidden 且无 max-height,
            超出部分会被**静默切掉**(实机:最上面的「分组」整段不见)。渲染进程
            画不到 BrowserWindow 外面,所以这里按 Radix 给出的可用高度收口并允许
            纵向滚动；禁止横向滚动，避免分隔线的负边距撑出底部滚动条占位。
            滚动容器放内层(与下方项目列表同款做法),不与 content 的
            overflow-hidden 抢同一属性。减 0.75rem 让出 content 的 p-1 与边框。 */}
        <MountedMenuContent>
          {() => (
            <div className="max-h-[calc(var(--radix-dropdown-menu-content-available-height)-0.75rem)] overflow-x-hidden overflow-y-auto">
              {/* 列表模式：与侧栏顶部的收件箱开关是同一个设置。切换后下面的行当场变化，
                  用户能直接看到两种模式各有哪些选项(2026-11-28 用户决定保留在菜单里)。 */}
              <SegmentedMenuRow
                label={t('ccAgent.sidebar.taskListMode.heading')}
                layout="block"
                density="sm"
                value={taskListMode}
                options={TASK_LIST_MODES.map((value) => ({
                  value,
                  label: t(`ccAgent.sidebar.taskListMode.${value}`),
                }))}
                onChange={(next) => {
                  // 第一次进收件箱会弹介绍页：把菜单收起，不压在介绍页下面。
                  if (switchMode(next)) closeMenu();
                }}
              />
              <DropdownMenuSeparator />
              {!inboxMode && (
                <>
                  <MenuSubRow
                    label={t('ccAgent.sidebar.filterGroupByHeading')}
                    value={groupByValue}
                    valueNode={
                      activeGroups.length > 0 ? (
                        <IconSummary icons={activeGroups.map((choice) => choice.Icon)} />
                      ) : undefined
                    }
                    Icon={SidebarGroupsIcon}
                    contentClassName="w-max min-w-[220px] max-w-[340px]"
                  >
                    {groupChoices.map((choice) => (
                      <CheckMenuItem
                        key={choice.key}
                        label={t(`ccAgent.sidebar.filterGroupBy.${choice.key}`)}
                        checked={choice.checked}
                        onToggle={choice.onToggle}
                        Icon={choice.Icon}
                        hint={choice.hintKey ? t(choice.hintKey) : undefined}
                      />
                    ))}
                  </MenuSubRow>
                  <MenuSubRow
                    label={t('ccAgent.sidebar.filterSortByHeading')}
                    value={sortByValue}
                    Icon={ArrowDownWideNarrow}
                    contentClassName="w-max min-w-[220px] max-w-[340px]"
                  >
                    <DropdownMenuLabel>{t('ccAgent.sidebar.filterTaskSortHeading')}</DropdownMenuLabel>
                    {SORT_BY_OPTIONS.map((option) => (
                      <SelectMenuItem
                        key={option.value}
                        label={t(option.menuLabelKey ?? option.labelKey)}
                        selected={sortBy === option.value}
                        Icon={option.Icon}
                        onSelect={() => setSortBy(option.value)}
                        hint={option.hintKey ? t(option.hintKey) : undefined}
                        tip={option.tipKey ? t(option.tipKey) : undefined}
                      />
                    ))}
                    {/* 项目的顺序只在按项目分组时有意义。 */}
                    {groupBy === 'project' && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t('ccAgent.sidebar.filterProjectOrderHeading')}</DropdownMenuLabel>
                        {PROJECT_ORDER_OPTIONS.map((option) => (
                          <SelectMenuItem
                            key={option.value}
                            label={t(option.labelKey)}
                            selected={scopedProjectOrder === option.value}
                            Icon={option.Icon}
                            onSelect={() => setProjectOrder(option.value)}
                            hint={option.hintKey ? t(option.hintKey) : undefined}
                            tip={option.tipKey ? t(option.tipKey) : undefined}
                          />
                        ))}
                      </>
                    )}
                  </MenuSubRow>
                  <DropdownMenuSeparator />
                  <SegmentedMenuRow
                    label={t('ccAgent.sidebar.taskStatusHeading')}
                    Icon={ListChecks}
                    value={status}
                    options={STATUS_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setStatus}
                  />
                </>
              )}
              <MenuSubRow
                label={t('ccAgent.sidebar.filterHeading')}
                value={filterSummary}
                valueEmphasized={narrowFilterCount > 0}
                Icon={Filter}
                contentClassName="w-[280px]"
              >
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
                    <MenuItemIcon Icon={Folders} />
                    <span className="truncate">{t('ccAgent.sidebar.filterAllProjects')}</span>
                    {projects === 'all' && (
                      <Check
                        size={15}
                        className="ml-auto shrink-0 text-[var(--msg-assistant-text)]"
                      />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <div className="max-h-[256px] overflow-y-auto">
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        toggleProject(DIALOGUE_FILTER_KEY);
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <MenuItemIcon Icon={MessageSquare} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{t('ccAgent.sidebar.dialogues')}</span>
                      </span>
                      <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                        {dialogueCount}
                      </span>
                      {(projects === 'all' ||
                        (projectsAsSet?.has(DIALOGUE_FILTER_KEY) ?? false)) && (
                        <Check size={15} className="shrink-0 text-[var(--msg-assistant-text)]" />
                      )}
                    </DropdownMenuItem>
                    {allKnownProjects.map((project) => {
                      // A teammate's project is chosen through the teammate filter.
                      if (isTeammateProjectPath(project.workingDir)) return null;
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
                          ) : (
                            <MenuItemIcon Icon={Folder} />
                          )}
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
                            <Check
                              size={15}
                              className="shrink-0 text-[var(--msg-assistant-text)]"
                            />
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                </MenuSubRow>

                <MenuSubRow label={t('ccAgent.sidebar.filterCreatorsHeading')} value={creatorValue} Icon={Users}>
                  <SelectMenuItem label={t('ccAgent.sidebar.filterCreatorsAny')} selected={creators === 'all'}
                    onSelect={setCreatorsAll} Icon={Users} />
                  {creatorOptions.length > 0 && <DropdownMenuSeparator />}
                  <div className="max-h-[256px] overflow-y-auto">
                    {creatorOptions.map(bot => {
                      const key = taskCreatorFilterKey(bot);
                      return (
                        <DropdownMenuItem key={key} className={cn(MENU_ITEM_CLASS, bot.deviceName && 'h-auto min-h-8 items-start')}
                          role="menuitemcheckbox" aria-label={[bot.name, bot.deviceName].filter(Boolean).join(' ')} aria-checked={Array.isArray(creators) && creators.includes(key)}
                          onSelect={event => { event.preventDefault(); toggleCreator(key); }}>
                          <BotAvatar bot={bot} size="xs" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate" title={bot.name}>{bot.name}</span>
                            {bot.deviceName && <span className="block truncate text-xs text-[var(--cmd-palette-item-meta)]" title={bot.deviceName}>{bot.deviceName}</span>}
                          </span>
                          {Array.isArray(creators) && creators.includes(key) &&
                            <Check size={15} className={cn('shrink-0 text-[var(--msg-assistant-text)]', bot.deviceName && 'mt-0.5')} />}
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                </MenuSubRow>

                <MenuSubRow
                  label={t('ccAgent.sidebar.filterAgentHeading')}
                  value={vendorValue}
                  Icon={Bot}
                  contentClassName="w-max min-w-[220px] max-w-[340px]"
                >
                  <SelectMenuItem
                    label={t('ccAgent.sidebar.filterVendor.all')}
                    selected={vendor === 'all'}
                    onSelect={() => setVendor('all')}
                    Icon={Layers}
                  />
                  <DropdownMenuSeparator />
                  <div className="max-h-[256px] overflow-y-auto">
                    {BUILTIN_HARNESS_KEYS.map((key) => (
                      <CheckMenuItem
                        key={key}
                        label={t(`ccAgent.sidebar.filterVendor.${key}`)}
                        checked={harnessChecked(key)}
                        onToggle={() => toggleVendor(key)}
                        icon={<VendorIcon vendor={key} size={14} colorClassName={HARNESS_ICON_CLASS} />}
                      />
                    ))}
                    {pluginHarnesses.length > 0 && (
                      <DropdownMenuLabel>{t('ccAgent.sidebar.filterVendorPluginHeading')}</DropdownMenuLabel>
                    )}
                    {pluginHarnesses.map((harness) => (
                      <PluginHarnessMenuItem
                        key={harness.key}
                        harness={harness}
                        checked={harnessChecked(harness.key)}
                        onToggle={() => toggleVendor(harness.key)}
                      />
                    ))}
                  </div>
                </MenuSubRow>

                <DropdownMenuSeparator />
                <SegmentedMenuRow
                  label={t('ccAgent.sidebar.filterLastActivityHeading')}
                  layout="block"
                  heading
                  value={lastActivity}
                  options={LAST_ACTIVITY_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                  onChange={setLastActivity}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    resetContentFilters();
                  }}
                  disabled={narrowFilterCount === 0}
                  className={MENU_ITEM_CLASS}
                >
                  <MenuItemIcon Icon={RotateCcw} />
                  <span className="truncate text-[var(--text-secondary)]">
                    {t('ccAgent.sidebar.filterReset')}
                  </span>
                </DropdownMenuItem>
              </MenuSubRow>
              {/* 隐藏：和分组一样逐项勾选，一级行用图标列出当前藏了哪几类。
                  筛选是「只看哪些」，这里是「不看哪些」，两边互不影响(2026-11-28 用户决定)。 */}
              <MenuSubRow
                label={t('ccAgent.sidebar.hideHeading')}
                value={hideValue}
                valueNode={
                  activeHides.length > 0 ? (
                    <IconSummary icons={activeHides.map((choice) => choice.Icon)} />
                  ) : undefined
                }
                valueEmphasized={activeHides.length > 0}
                Icon={EyeOff}
                contentClassName="w-max min-w-[220px] max-w-[340px]"
              >
                {hideChoices.map((choice) => (
                  <CheckMenuItem
                    key={choice.key}
                    label={t(`ccAgent.sidebar.hideOptions.${choice.key}`)}
                    checked={choice.checked}
                    onToggle={choice.onToggle}
                    Icon={choice.Icon}
                  />
                ))}
              </MenuSubRow>

              <DropdownMenuSeparator />

              <SegmentedMenuRow
                label={t('ccAgent.sidebar.displayHeading')}
                Icon={MainViewIcon}
                value={mainViewMode}
                options={MAIN_VIEW_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                onChange={setMainViewMode}
              />
              <MenuSubRow
                label={t('ccAgent.sidebar.taskInfoHeading')}
                contentClassName="w-max min-w-[220px] max-w-[340px]"
                value={taskInfoSummary}
                Icon={Info}
                valueNode={
                  taskInfoFields.length > 0 ? (
                    // 已选项用图标串表示,不再罗列短词。顺序 = 用户勾选顺序(遍历
                    // taskInfoFields 而非选项表),与列表行的渲染顺序一致。
                    <span className="flex items-center justify-end gap-1.5">
                      {summaryFields.map((field) => {
                        const Icon = TASK_INFO_OPTIONS.find(
                          (option) => option.value === field,
                        )?.Icon;
                        return Icon ? (
                          <Icon
                            key={field}
                            size={14}
                            strokeWidth={1.8}
                            className="shrink-0"
                            aria-hidden
                          />
                        ) : null;
                      })}
                      {summaryFields.length < taskInfoFields.length && (
                        <span aria-hidden>+{taskInfoFields.length - summaryFields.length}</span>
                      )}
                    </span>
                  ) : undefined
                }
                valueEmphasized={!taskInfoIsDefault}
              >
                <DropdownMenuLabel>{t('ccAgent.sidebar.taskInfoSection.identity')}</DropdownMenuLabel>
                {TASK_IDENTITY_OPTIONS.map((option) => (
                  <CheckMenuItem
                    key={option.value}
                    label={t(option.labelKey)}
                    checked={taskInfoFields.includes(option.value)}
                    onToggle={() => toggleTaskInfoField(option.value)}
                    Icon={option.Icon}
                  />
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('ccAgent.sidebar.taskInfoSection.meta')}</DropdownMenuLabel>
                {TASK_META_OPTIONS.map((option) => (
                  <CheckMenuItem
                    key={option.value}
                    label={t(option.labelKey)}
                    checked={taskInfoFields.includes(option.value)}
                    onToggle={() => toggleTaskInfoField(option.value)}
                    Icon={option.Icon}
                    hint={metaOrderHint(option.value)}
                  />
                ))}
              </MenuSubRow>
              {inboxMode && (
                <>
                  <DropdownMenuSeparator />
                  {/* 介绍页只在第一次进收件箱时自动出现一次；这里让用户随时能再看（选中后菜单照常关闭）。 */}
                  <DropdownMenuItem onSelect={showInboxIntro} className={MENU_ITEM_CLASS}>
                    <MenuItemIcon Icon={Lightbulb} />
                    <span className="truncate">{t('ccAgent.sidebar.taskListMode.inboxTips')}</span>
                  </DropdownMenuItem>
                </>
              )}
            </div>
          )}
        </MountedMenuContent>
      </DropdownMenuContent>
    </DropdownMenu>
    {inboxIntro}
    </>
  );
}
