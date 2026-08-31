/**
 * ProjectsSection — Sidebar 中部的 Projects 段
 * ---------------------------------------------------------------------------
 * Projects 段视觉规格：
 *   - Section 容器：vertical layout, gap 2
 *   - Section Title：padding [0, 12, 0, 24], height 24, space_between
 *     · 左：文字 "Projects" Inter 14 / 600 #262626 (Light) / #f5f0e8 (Dark)
 *       （2026-04-20 修订对齐设计稿；与 PinnedSection 同色）
 *       旁边的单箭头只负责收起 / 展开整个 Projects 列表，项目标题本身仍显示。
 *     · 右：Toggle All Button + Sidebar filter button
 *       Toggle All 保留原行为：收起 / 展开每个 ProjectNode 下面的会话，项目行仍显示。
 *   - Projects Tree：padding [4, 12, 0, 12], gap 4
 *     · 包含 UnclassifiedSection（若有）+ ProjectNode 列表
 *
 * ProjectNode 的展开折叠由父层受控；段级收起是本组件内的纯 UI 状态。
 * 完全没有 project / 未分类 / 对话时仍渲染范围标题行(2026-08-13 第 4 轮
 * review P1:段头恒在),列表树不画。
 *
 * 拖拽：projectOrder === 'custom' 且按项目分组时由 SortableList 接管。只从
 *   项目标题行 (`data-project-header`) 起手；子任务区 `data-no-drag`，标题行内
 *   按钮走 filter。不要把 handle 自己写进 filter，否则整行没有可拖热区。
 *   任务排序 (sortBy) 仍作用于组内任务与项目之后的散排对话。落定后写回
 *   manualProjectOrder。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  MessagesSquare,
  MonitorSmartphone,
  SquarePen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useEffectiveSelectedMachineId } from '@/features/device-link/useMachineSwitcher';
import { MACHINE_ALL } from '@/features/device-link/selectedMachineStore';
import {
  projectOrderWriteLedger,
  resolveDisplayedProjectOrder,
} from '@cindy/maker-shared/project-order-sync';
import {
  controllerManualOrderForDevice,
  projectOrderWriteScopeForSelection,
  useLocalHostProjectOrder,
  useRemoteHostProjectOrders,
} from '../../hooks/useRemoteHostProjectOrders';
import { SortableList } from '@/components/sidebar/SortableList';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import { ProjectNode } from './ProjectNode';
import { UnclassifiedSection } from './UnclassifiedSection';
import { getSessionListCollapseView } from '../../lib/sessionListCollapse';
import {
  getProjectCollapseLimit,
  getProjectSessionCollapseLimit,
} from '../../lib/sidebarCollapseConfig';
import {
  normalizeManualProjectOrder,
  mergeVisibleReorder,
  snapshotManualProjectOrder,
  loadDialogueGroupCollapsedKeys,
  persistDialogueGroupCollapsedKeys,
  DIALOGUE_GROUP_ALL_KEY,
} from '../../hooks/helpers/sidebarFilterCore';
import {
  advanceViewedPriorityHold,
  buildMainListEntries,
  getMainListEntrySessions,
  holdViewedPriorityRank,
  splitEntriesByDevice,
  type MainListDeviceSection,
  type MainListEntry,
  type ViewedPriorityHoldState,
} from '../../lib/mainListModel';
import { buildSessionSourceLabelMap } from '../../lib/sessionSourceLabel';
import { useSessionAttentionKinds } from '@/lib/sessionAttentionStore';
import { useSessionAttentionUrgencySet } from '../../contexts/SessionAttentionUrgencyContext';
import {
  getRemoteSessionActivity,
  isRemoteSessionActivityActive,
  useRemoteSessionActivityRevision,
} from '@/features/device-link/remoteSessionActivityStore';
import { absorbSessionStarting } from '@/lib/sessionStartingStore';
import type { DialogueDeviceTarget } from '../../lib/dialogueCreateTarget';
import { MainListScopeHeader } from '../MainListScopeHeader';
import { SectionCollapse } from '../SectionCollapse';
import { SessionEntryList, SessionEntryRows } from '../SessionEntryList';
import { useCollapsibleShowAll } from '../hooks/useCollapsibleShowAll';
import { useAutomationGroupsCollapsed } from '../../hooks/useAutomationGroupCollapsed';
import type { SessionClickHandler } from '../SessionItem';
import type { ProjectNode as ProjectNodeData } from '../../lib/projectGrouping';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import type { Session } from '@/lib/ccAgent.types';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';
import { resolveCollapsedProjectAttentionTone } from '../projectCollapsedAttention';

/** 手动排序只从项目标题行起手。点击折叠仍走标题行；SortableJS 的
 *  fallbackTolerance + ignoreNextClick 把点击和拖拽分开。 */
const MANUAL_PROJECT_SORT_HANDLE = '[data-project-header]';

/** 标题行里的按钮、以及子任务区,都不能当成"拖整个项目"的起点。 */
const MANUAL_PROJECT_SORT_FILTER = 'button, input, textarea, select, a, [data-no-drag]';

/** 设备段折叠/对话组折叠共用的段 key:本机段 'local',远程段用 deviceId。 */
const deviceSectionKey = (deviceId: string | null) => deviceId ?? 'local';

// 优先级排序的「看的时候钉住;只有从完成未读切走才置顶」是模块生命周期内的展示态,
// 不落盘。放模块级而不是组件 ref:ProjectsSection 重挂(含 React Strict Mode
// 双挂)不能丢掉正在看的档位,否则看的过程中会跳到其余档。
export const viewedPriorityHold: ViewedPriorityHoldState = {
  prevViewedId: undefined,
  heldPriorityRanks: new Map(),
  recentlyViewedAtMs: new Map(),
};

export function holdSidebarViewedPriority(
  sessionId: string,
  ctx: Parameters<typeof holdViewedPriorityRank>[2],
): void {
  holdViewedPriorityRank(viewedPriorityHold, sessionId, ctx);
}

/** 顶层条目折叠的「显示全部 N 项」页脚(单段路径与设备分组的每段共用同一份样式)。 */
function ShowAllEntriesButton({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={cn(
        'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
        'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
      )}
      onClick={onClick}
    >
      {t('ccAgent.sidebar.showAllSessions', { count })}
    </button>
  );
}

export interface ProjectsSectionProps {
  unclassified: Session[];
  /** 已经按 filter.projects 过滤后、仅会被渲染的 Project 子集。 */
  projects: ProjectNodeData[];
  /**
   * 无项目归属(workspaceKind dialogue)的可见会话(D 期混排)。
   * 与项目行按同一口径混排;「对话归为一组」开启时收进对话组行。
   */
  dialogues: Session[];
  /**
   * 未经过用户筛选、但已排除“从侧栏移除”项目的候选集。
   * 用于 SidebarFilterPopover 与来源标签；隐藏项目不能从这些入口泄漏。
   */
  allKnownProjects: ProjectNodeData[];
  /** 项目筛选前的无项目任务数,供菜单「对话」选项用。 */
  dialogueCount?: number;
  /**
   * 原始项目全集的规范 key。手动排序以此为 baseline，保证隐藏项目的
   * 位置记忆不会因用户拖动其它可见项目而被 GC。
   */
  allProjectKeysForOrder: readonly string[];
  /** F-PJ-10：filter 完整对象传给 Popover；段内不直接读取，仅透传给子组件。 */
  filter: UseSidebarFilterReturn;
  collapsed: Set<string>;
  isAllCollapsed: boolean;
  activeSessionId?: string;
  /**
   * 当前注视中的任务(files 路由下 activeSessionId 为空,回落到被浏览文件所属任务)。
   * 优先级排序用它钉住打开时的档位;只有从完成未读切走才置顶。
   */
  viewedSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  /** /ctr 接管中的 sessionIds — SessionItem 用来切换左侧 icon */
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  onToggleProject: (projectKey: string) => void;
  onToggleProjectPin: (project: ProjectNodeData, currentlyPinned: boolean) => void;
  onRenameProject: (project: ProjectNodeData, alias: string) => Promise<void>;
  onRemoveFromSidebar: (project: ProjectNodeData) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  /**
   * 段头新建项目：选择一个新项目目录后进入 transient draft route。
   * 2026-08-12 起段头按钮暂时隐藏(见下方段头注释),prop 保留以便恢复入口。
   */
  onCreateProject?: () => void;
  /** delayed-create:在该 project 的 workingDir 下进 transient draft route。
   *  父层 wrapper 会处理"预填 workingDir 到 newMakerDraft store + navigate('/cc-agent/new')"。
   *  vendor 由用户在 NewMakerDraftRoute 内的 VendorSegmentedSwitcher 决定(读 draft.vendor)。 */
  onCreateInProject: (project: ProjectNodeData) => void;
  /** 用当前 project 锁定全局对话搜索入口。 */
  onOpenConversationSearch: (project: ProjectNodeData) => void;
  /** 在系统文件管理器中打开 project 的 workingDir。 */
  onOpenInExplorer: (workingDir: string) => void;
  onLinkCodexProject: (project: ProjectNodeData) => void;
  linkingCodexProject: string | null;
  /** 进入 workdir 文件浏览模式 (vscode-style file tree + body viewer)。 */
  onBrowseFiles: (project: ProjectNodeData) => void;
  /** 右键菜单 → 归档该 project 下所有非执行中的 session（带二次确认）。 */
  onArchiveAll: (project: ProjectNodeData) => void;
  /**
   * E 期「按设备分组」:远程设备的展示顺序与名称/在线状态(设备切换栏同源)。
   * null / 空数组 = 没有远程设备连接 → 设备分组选项隐藏、不切段。
   */
  remoteDeviceIndex?: ReadonlyMap<string, { name: string; online: boolean }> | null;
  /**
   * 「对话」组行右侧的新建入口(与项目行 SquarePen 等位):新建不绑项目的对话任务。
   * 按设备分组时对话组隶属于某个设备段,这里显式给出该段的设备作为创建目标
   * (null = 本机段),不再让上层按当前机器作用域猜(2026-08-12 用户裁决);
   * 不分组时不传,沿用上层的作用域推断。
   */
  onCreateDialogue: (deviceTarget?: DialogueDeviceTarget | null) => void;
  /** 对话设备解析在途时禁用新建(与旧对话段 createDisabled 同语义)。 */
  isCreateDialogueDisabled?: boolean;
}

export function ProjectsSection({
  unclassified,
  projects,
  dialogues,
  allKnownProjects,
  dialogueCount = 0,
  allProjectKeysForOrder,
  filter,
  collapsed,
  isAllCollapsed,
  activeSessionId,
  viewedSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  onToggleProject,
  onToggleProjectPin,
  onRenameProject,
  onRemoveFromSidebar,
  onCollapseAll,
  onExpandAll,
  onCreateInProject,
  onOpenConversationSearch,
  onOpenInExplorer,
  onLinkCodexProject,
  linkingCodexProject,
  onBrowseFiles,
  onArchiveAll,
  remoteDeviceIndex = null,
  onCreateDialogue,
  isCreateDialogueDisabled = false,
}: ProjectsSectionProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const selectedMachineForOrder = useEffectiveSelectedMachineId();
  const localHostProjectOrder = useLocalHostProjectOrder();
  const remoteHostProjectOrders = useRemoteHostProjectOrders(selectedMachineForOrder);
  // 主列表显示形态(B 期):text 紧凑行 / list 满宽两行卡。独立于置顶段的三态设置。
  const { mode: mainViewMode } = useSidebarMainViewMode();
  const mainSessionVariant: 'text' | 'list' = mainViewMode === 'list' ? 'list' : 'text';
  // SortableList 只在自定义项目顺序且按项目分组时挂载。
  // 折叠溢出且未点「显示全部」时禁用，避免只重排可见前缀。
  const projectOrderScope = projectOrderWriteScopeForSelection(selectedMachineForOrder);
  const hostSnapshotForDisplay = projectOrderScope.kind === 'host' && projectOrderScope.deviceId === null
    ? localHostProjectOrder.snapshot
    : projectOrderScope.kind === 'host' && projectOrderScope.deviceId
      ? remoteHostProjectOrders.orders.get(projectOrderScope.deviceId)
      : undefined;
  const displayedProjectOrder = resolveDisplayedProjectOrder(
    projectOrderScope,
    hostSnapshotForDisplay,
    filter,
    projectOrderScope.kind === 'host' && projectOrderScope.deviceId === null
      ? localHostProjectOrder.snapshot.manualProjectOrder
      : projectOrderScope.kind === 'host' && projectOrderScope.deviceId
        ? controllerManualOrderForDevice(projectOrderScope.deviceId, hostSnapshotForDisplay) ?? []
        : [],
  );
  const customProjectOrder = filter.groupBy === 'project' && displayedProjectOrder.projectOrder === 'custom';
  const projectDragEnabled = customProjectOrder;
  const projectKeysForOrderBaseline = allProjectKeysForOrder;
  // 段级收起已随「全部任务 = 范围下拉」取消(2026-08-13 用户定稿):标题的点击
  // 语义让给机器范围切换;「想要紧凑」由右侧「收起所有分组」承接。
  const [showAllProjects, setShowAllProjects] = useCollapsibleShowAll(false);
  // 设备段各自的「显示全部」(2026-08-13 复核 P2:共用一个标志会让点任一段的
  // 段内按钮把所有段一起展开——按钮看起来是段内操作,作用域也必须是段内)。
  const [expandedDeviceSections, setExpandedDeviceSections] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const getProjectId = useCallback((p: ProjectNodeData) => p.projectKey, []);

  const handleReorder = useCallback(
    (visibleNewOrder: string[]) => {
      // SortableList 给我们的是当前 **可见** projects 的新顺序。机器 / vendor / 项目过滤态下,
      // 不可见的 project(其它机器 / 被过滤掉的)必须**保持原位** —— 与置顶拖拽同一套「原位 merge」
      // 语义(mergeVisibleReorder),而不是把它们甩到末尾(否则切回「所有」时其它机器项目的相对
      // 位置会被无关拖拽悄悄打乱)。做法:先取全量规范顺序作 baseline,再把可见新序原位填回。
      const scope = projectOrderWriteScopeForSelection(selectedMachineForOrder);
      const hostSnapshot = scope.kind === 'host' && scope.deviceId === null
        ? localHostProjectOrder.snapshot
        : scope.kind === 'host' && scope.deviceId
          ? remoteHostProjectOrders.orders.get(scope.deviceId)
          : undefined;
      const persistViewer = (order: readonly string[]) => {
        const fullOrder = normalizeManualProjectOrder(filter.manualProjectOrder, projectKeysForOrderBaseline);
        const merged = mergeVisibleReorder(fullOrder, order);
        filter.setManualProjectOrder(merged, projectKeysForOrderBaseline);
        if (filter.projectOrder !== 'custom') filter.setProjectOrder('custom');
      };
      if (projectOrderWriteLedger(scope, hostSnapshot) === 'host' && scope.kind === 'host' && scope.deviceId === null) {
        const localKeys = projectKeysForOrderBaseline.filter((key) => key.startsWith('local:'));
        const fullOrder = normalizeManualProjectOrder(
          localHostProjectOrder.snapshot.manualProjectOrder,
          localKeys,
        );
        const next = mergeVisibleReorder(fullOrder, visibleNewOrder);
        void localHostProjectOrder.apply({
          manualProjectOrder: next,
          projectOrder: 'custom',
        }).then((result) => {
          if (result.kind === 'unavailable') persistViewer(visibleNewOrder);
        });
        return;
      }
      if (projectOrderWriteLedger(scope, hostSnapshot) === 'host' && scope.kind === 'host' && scope.deviceId) {
        const deviceId = scope.deviceId;
        const remoteKeys = projectKeysForOrderBaseline.filter((key) => key.startsWith(`device:${encodeURIComponent(deviceId)}:`));
        const current = controllerManualOrderForDevice(
          deviceId,
          remoteHostProjectOrders.orders.get(deviceId),
        ) ?? [];
        const fullOrder = normalizeManualProjectOrder(current, remoteKeys);
        const next = mergeVisibleReorder(fullOrder, visibleNewOrder);
        void remoteHostProjectOrders.apply(deviceId, {
          manualProjectOrder: next,
          projectOrder: 'custom',
        }).then((result) => {
          if (result.kind === 'unavailable') persistViewer(visibleNewOrder);
        });
        return;
      }
      persistViewer(visibleNewOrder);
    },
    [
      filter,
      localHostProjectOrder,
      projectKeysForOrderBaseline,
      remoteHostProjectOrders,
      selectedMachineForOrder,
    ],
  );

  // toggleDisabled 用 allKnownProjects（不是过滤后的 projects），避免 filter 收窄到 0 时
  // 即便没真正可折叠的目标，也保留视觉一致——但禁用按钮以避免无意义点击。
  const projectNodesToggleDisabled = allKnownProjects.length === 0;
  // 折叠上限始终生效(用户定稿):任何筛选(最近活跃 / 状态 / 项目 / Vendor)、任何排序
  // (含「时间」)下,每项目都最多显示 N 条 + 「显示全部」。折叠是纯显示上限,与筛选正交;
  // 文字搜索是独立面板、不在本段内联过滤,故无需为它禁用。
  const disableSessionCollapse = false;

  // 优先级排序的运行时上下文。三个集合都在本地链路之上并入 device-link 远程
  // 活动镜像(2026-08-13 review P1:此前只喂本地 maker/attention,远程行自己的
  // 状态点亮着、排序却把它当 idle):
  //   - waiting:本地 attention kind 为 awaiting / error、定时任务失败未读
  //     (urgentSet,语义对齐 SessionItem 的 isUrgentFromContext)、远程
  //     needs-interaction / error;
  //   - attention:本地未读集 ∪ 远程有活动条目的会话(waiting ⊆ attention,
  //     rank 函数先查 attention 再分档);
  //   - running:本地 running ∪ 远程 running。
  // 整表订阅仅限本聚合组件(两个 store 头注的性能边界):本组件本就随
  // notifications 整集变化重渲染,不额外放大;远程镜像走整表版本号 + 逐 id 读,
  // 与 CCAgentSidebarUpper.projectAgg 同款先例。
  const attentionKinds = useSessionAttentionKinds();
  const urgentSet = useSessionAttentionUrgencySet();
  const remoteActivityRevision = useRemoteSessionActivityRevision();
  const collapsedAttentionToneFor = useCallback(
    (sessions: readonly Session[]) =>
      resolveCollapsedProjectAttentionTone({
        sessions,
        runningSessionIds,
        notifications,
        attentionKinds,
        urgentSessionIds: urgentSet,
        remotePhaseOf: (sessionId) => getRemoteSessionActivity(sessionId)?.phase,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表 getRemoteSessionActivity 读到的整表内容
    [runningSessionIds, notifications, attentionKinds, urgentSet, remoteActivityRevision],
  );
  // 正在看的任务 id:files 路由下回落到被浏览文件所属任务。
  const viewedIdForSort = viewedSessionId ?? activeSessionId;
  const priorityContext = useMemo(() => {
    const running = new Set(runningSessionIds);
    const attention = new Set(notifications);
    const waiting = new Set<string>(urgentSet);
    for (const [sessionId, kind] of attentionKinds) {
      if (kind === 'awaiting' || kind === 'error') waiting.add(sessionId);
    }
    const considerRemote = (session: Session) => {
      const activity = getRemoteSessionActivity(session.id);
      if (!activity) return; // 本地会话 / 无活动条目:一次 Map 查找即返回
      if (activity.phase === 'running') {
        running.add(session.id);
        return;
      }
      // needs-interaction / error → waiting;completed(镜像只保留未读终态,
      // 已读收尾包会删条目)→ 完成未读档。
      attention.add(session.id);
      if (activity.phase === 'needs-interaction' || activity.phase === 'error') {
        waiting.add(session.id);
      }
    };
    for (const project of projects) for (const session of project.sessions) considerRemote(session);
    for (const session of dialogues) considerRemote(session);
    for (const session of unclassified) considerRemote(session);

    const hold = advanceViewedPriorityHold(
      viewedPriorityHold,
      viewedIdForSort,
      { runningSessionIds: running, attentionSessionIds: attention, waitingSessionIds: waiting },
      Date.now(),
    );

    return {
      runningSessionIds: running,
      attentionSessionIds: attention,
      waitingSessionIds: waiting,
      heldPriorityRanks: hold.heldPriorityRanks,
      recentlyViewedAtMs: hold.recentlyViewedAtMs,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表 getRemoteSessionActivity 读到的整表内容
  }, [
    runningSessionIds,
    notifications,
    urgentSet,
    attentionKinds,
    projects,
    dialogues,
    unclassified,
    remoteActivityRevision,
    viewedIdForSort,
  ]);

  // starting 只让位给真实 in-flight:本地 isRunning(见 useStartingSessionIds),
  // 远程 running / needs-interaction。终态 attention 不再吸收 —— 旧终态会误伤
  // 新发送,新终态又要代次才能和旧的区分,两边补丁会来回打。没经过 running
  // 的快完成靠 TTL。
  useEffect(() => {
    const settled = new Set<string>();
    const considerRemote = (session: Session) => {
      if (isRemoteSessionActivityActive(getRemoteSessionActivity(session.id))) {
        settled.add(session.id);
      }
    };
    for (const project of projects) {
      for (const session of project.sessions) considerRemote(session);
    }
    for (const session of dialogues) considerRemote(session);
    for (const session of unclassified) considerRemote(session);
    absorbSessionStarting(settled);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表 getRemoteSessionActivity 读到的整表内容
  }, [projects, dialogues, unclassified, remoteActivityRevision]);

  // E 期「按设备分组」:有远程设备连接 + 开关开 → 按设备切段(本机在前,
  // 远程按设备切换栏顺序);其余情况单段直渲。切段后按当前排序重排本段。
  // 自定义项目顺序可以和设备分组叠加:每段内项目行按全局序的子集排,段内可拖。
  // 范围收窄到单台机器时同样退场(2026-08-13 用户定稿):只有一台无段可切,
  // 唯一的段头还会和范围标题重复报同一个设备名;整理菜单的选项行同步隐藏
  // (deviceGroupingAvailable),偏好照旧不改写、范围放宽自动恢复。
  const hasRemoteDevices = (remoteDeviceIndex?.size ?? 0) > 0;
  const selectedMachineId = useEffectiveSelectedMachineId();
  const singleMachineScope = selectedMachineId !== MACHINE_ALL && selectedMachineId.length === 1;
  const deviceGroupingAvailable = hasRemoteDevices && !singleMachineScope;
  const deviceGroupingActive = deviceGroupingAvailable && filter.groupDevice;
  // F-PJ-10：未分类区在 projects 为具体多选状态时不渲染（spec 验收第 14 条）
  const unclassifiedHidden = filter.projects !== 'all';

  // 混排模型(D 期):项目行 / 散排对话 / 对话组统一为顶层条目并按同一口径排序。
  // 这有意推翻旧「Dialogue 固定段在 Projects 之后」的裁决(mainListModel.ts 文件头)。
  // 设备分组开启时,未分类草稿并进混排再按设备切段;单段路径仍走顶部独立段。
  const mixedEntries = useMemo(
    () =>
      buildMainListEntries({
        projects,
        dialogues,
        unclassified: deviceGroupingActive && !unclassifiedHidden ? unclassified : [],
        groupBy: filter.groupBy,
        groupDialogue: filter.groupDialogue,
        sortBy: filter.sortBy,
        projectOrder: displayedProjectOrder.projectOrder,
        manualProjectOrder: displayedProjectOrder.manualProjectOrder,
        priorityContext,
        notifications,
        scheduleSessionIndex,
      }),
    [
      projects,
      dialogues,
      unclassified,
      unclassifiedHidden,
      deviceGroupingActive,
      filter.groupBy,
      filter.groupDialogue,
      filter.sortBy,
      displayedProjectOrder,
      priorityContext,
      notifications,
      scheduleSessionIndex,
    ],
  );

  // 顶层条目折叠:最多显示 N 条,超出收起 + 「显示全部 N 项」。与会话同一套
  // 规则(getSessionListCollapseView):始终保留"有需关注会话"的条目、以及包含当前会话的
  // 条目;任何排序/筛选下都生效。
  const entrySessions = getMainListEntrySessions;
  // 折叠视图共用一份参数:非设备分组 = 全列表一份;设备分组 = 每段各一份(见
  // deviceSections)。attention 豁免用 priorityContext.attentionSessionIds——与
  // 排序同一口径(含远程活动镜像),远程 waiting/unread 的条目不能被折进
  // 「显示全部」。
  const collapseEntries = useCallback(
    (entries: readonly MainListEntry[], showAll: boolean) =>
      getSessionListCollapseView({
        entries,
        minVisibleCount: getProjectCollapseLimit(),
        showAll,
        disableCollapse: false,
        isFiltering: false,
        isActiveEntry: (entry) => entrySessions(entry).some((s) => s.id === viewedIdForSort),
        hasAttentionEntry: (entry) =>
          entrySessions(entry).some((s) => priorityContext.attentionSessionIds.has(s.id)),
      }),
    [viewedIdForSort, entrySessions, priorityContext],
  );
  const {
    visibleEntries: visibleMixedEntries,
    isOverflowing: projectsOverflow,
    totalCount: projectsTotal,
  } = collapseEntries(mixedEntries, showAllProjects);
  // SortableList 拖拽仍只作用于项目行(手动排序收窄裁决,设计文档 §9.3):
  // 混排下把可见条目切成「连续的项目行 run + 其间的散排条目」,项目 run 内可拖。
  const visibleProjectNodes = visibleMixedEntries
    .filter(
      (entry): entry is Extract<MainListEntry, { kind: 'project' }> => entry.kind === 'project',
    )
    .map((entry) => entry.project);

  // 第一次切到手动时,必须用切换前的视觉序(recency / priority 混排结果),
  // 不能在 custom+空序重算后再采集——那时项目行已按上游入参序排好,优先级视觉会丢。
  // 可见子集还要 merge 回全量 baseline,避免隐藏项目被甩到末尾。
  const preCustomVisualKeysRef = useRef<string[]>([]);
  if (filter.projectOrder !== 'custom') {
    preCustomVisualKeysRef.current = mixedEntries
      .filter(
        (entry): entry is Extract<MainListEntry, { kind: 'project' }> => entry.kind === 'project',
      )
      .map((entry) => entry.project.projectKey);
  }
  const prevProjectOrderRef = useRef(filter.projectOrder);
  useEffect(() => {
    const previous = prevProjectOrderRef.current;
    prevProjectOrderRef.current = filter.projectOrder;
    if (
      previous === 'custom' ||
      filter.projectOrder !== 'custom' ||
      filter.groupBy !== 'project' ||
      filter.manualProjectOrder.length > 0
    ) {
      return;
    }
    const keys = preCustomVisualKeysRef.current;
    if (keys.length === 0) return;
    filter.setManualProjectOrder(
      snapshotManualProjectOrder(keys, projectKeysForOrderBaseline),
      projectKeysForOrderBaseline,
    );
  }, [filter, projectKeysForOrderBaseline]);

  const deviceSections = useMemo<MainListDeviceSection[]>(() => {
    if (!deviceGroupingActive) return [{ deviceId: null, entries: [...visibleMixedEntries] }];
    // 设备分组:对**全量**条目先切段,折叠上限在渲染时每段独立应用(2026-08-13
    // review P1:此前先全局折叠再切段,排在前 N 名之外的设备连段头一起消失,
    // 看起来像"这台设备没有任务"——设备是最外层层级,折叠只能发生在段内)。
    return splitEntriesByDevice(mixedEntries, [...(remoteDeviceIndex?.keys() ?? [])], {
      sortBy: filter.sortBy,
      projectOrder: filter.projectOrder,
      manualProjectOrder: filter.manualProjectOrder,
      priorityContext,
    });
  }, [
    deviceGroupingActive,
    visibleMixedEntries,
    mixedEntries,
    remoteDeviceIndex,
    filter.sortBy,
    filter.projectOrder,
    filter.manualProjectOrder,
    priorityContext,
  ]);
  // 设备段折叠(E 期):本机段 key 'local'。
  const [collapsedDevices, setCollapsedDevices] = useState<ReadonlySet<string>>(new Set());
  // 「对话」组折叠:与项目行折叠同级的分组状态(用户裁决:对话组的折叠交互与
  // 项目分组一致,含「收起所有分组」批量操作)。按分组 key 记忆——单一列表只有
  // 一个组(DIALOGUE_GROUP_ALL_KEY);按设备分组时每个设备段各有一个对话组,
  // 折叠互相独立(2026-08-12 实机反馈:共用一个 boolean 会点一个全展开)。
  // 持久化为显示类本地偏好。
  const [collapsedDialogueGroups, setCollapsedDialogueGroups] = useState<ReadonlySet<string>>(() =>
    loadDialogueGroupCollapsedKeys(),
  );
  const setDialogueCollapsed = useCallback((keys: readonly string[], next: boolean) => {
    setCollapsedDialogueGroups((prev) => {
      const nextSet = new Set(prev);
      for (const key of keys) {
        if (next) nextSet.add(key);
        else nextSet.delete(key);
      }
      // 在函数式更新里持久化:批量收起与单组切换共用一条路径;localStorage
      // 同值重写幂等,StrictMode 双调用无副作用差异。
      persistDialogueGroupCollapsedKeys(nextSet);
      return nextSet;
    });
  }, []);
  const toggleDeviceSection = useCallback((key: string) => {
    setCollapsedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 「展开/收起所有分组」按钮(E 期):
  //   单层(仅组层或仅设备层)→ 收起所有 ↔ 展开所有;
  //   双层(设备 + 组层同时存在)→ 循环:收组层 → 收设备层 → 全部展开。
  // 组层 = 项目行 + 自动任务组 + 「对话」组行。项目侧复用 ProjectNode 折叠状态,
  // 自动任务组复用 owner-scoped 持久化状态,对话组沿用本地显示偏好。
  const hasGroupLayer = mixedEntries.some((entry) => entry.kind !== 'session');
  // 当前可见的对话组 key:设备分组下 = 各含对话组条目的设备段;否则单一组。
  // 「收起/展开所有分组」只作用于这些可见 key,不动其它模式下的记忆。
  const visibleDialogueGroupKeys = useMemo<string[]>(() => {
    if (!deviceGroupingActive) {
      return visibleMixedEntries.some((entry) => entry.kind === 'dialogue-group')
        ? [DIALOGUE_GROUP_ALL_KEY]
        : [];
    }
    return deviceSections
      .filter((section) => section.entries.some((entry) => entry.kind === 'dialogue-group'))
      .map((section) => deviceSectionKey(section.deviceId));
  }, [deviceGroupingActive, visibleMixedEntries, deviceSections]);
  const allDialogueGroupsCollapsed =
    visibleDialogueGroupKeys.length === 0 ||
    visibleDialogueGroupKeys.every((key) => collapsedDialogueGroups.has(key));
  const visibleAutomationGroupKeys = useMemo(
    () =>
      mixedEntries
        .filter(
          (entry): entry is Extract<MainListEntry, { kind: 'automation-group' }> =>
            entry.kind === 'automation-group',
        )
        .map((entry) => entry.group.id),
    [mixedEntries],
  );
  const legacyAutomationGroupKeys = useMemo(
    () =>
      new Map(
        mixedEntries.flatMap((entry) =>
          entry.kind === 'automation-group' && entry.group.legacyId
            ? [[entry.group.id, entry.group.legacyId] as const]
            : [],
        ),
      ),
    [mixedEntries],
  );
  const [
    allAutomationGroupsCollapsed,
    setAllAutomationGroupsCollapsed,
    isAutomationGroupCollapsed,
    setAutomationGroupCollapsed,
  ] = useAutomationGroupsCollapsed(
    visibleAutomationGroupKeys,
    filter.groupBy,
    legacyAutomationGroupKeys,
  );
  // 组层是否收齐必须看**当前范围**有没有项目行。allKnownProjects 是全机器宇宙,
  // 单机范围下本机只有对话组、远端仍有项目时 length>0;isAllCollapsed 却来自
  // 当前范围的 activeWorkingDirs,此时为空并恒为 false,foldState 会卡在
  // collapse-groups。有可见项目行才并上 isAllCollapsed。
  const hasVisibleProjectGroups = mixedEntries.some((entry) => entry.kind === 'project');
  const allGroupsCollapsed =
    (!hasVisibleProjectGroups || isAllCollapsed) &&
    allDialogueGroupsCollapsed &&
    allAutomationGroupsCollapsed;
  const hasDeviceLayer = deviceGroupingActive && deviceSections.length > 0;
  const allDevicesCollapsed =
    hasDeviceLayer &&
    deviceSections.every((section) => collapsedDevices.has(deviceSectionKey(section.deviceId)));
  const foldState: 'collapse-groups' | 'collapse-devices' | 'expand-all' | null = (() => {
    if (!hasGroupLayer && !hasDeviceLayer) return null;
    if (hasGroupLayer && !allGroupsCollapsed) return 'collapse-groups';
    if (hasDeviceLayer && !allDevicesCollapsed) return 'collapse-devices';
    return 'expand-all';
  })();
  const handleFoldAll = useCallback(() => {
    if (foldState === 'collapse-groups') {
      onCollapseAll();
      setDialogueCollapsed(visibleDialogueGroupKeys, true);
      setAllAutomationGroupsCollapsed(true);
      return;
    }
    if (foldState === 'collapse-devices') {
      setCollapsedDevices(
        new Set(deviceSections.map((section) => deviceSectionKey(section.deviceId))),
      );
      return;
    }
    // expand-all:全部层级展开(设备段 + 项目行 + 自动任务组 + 对话组)。
    setCollapsedDevices(new Set());
    onExpandAll();
    setDialogueCollapsed(visibleDialogueGroupKeys, false);
    setAllAutomationGroupsCollapsed(false);
  }, [
    foldState,
    deviceSections,
    visibleDialogueGroupKeys,
    onCollapseAll,
    onExpandAll,
    setDialogueCollapsed,
    setAllAutomationGroupsCollapsed,
  ]);
  const foldLabel =
    foldState === 'collapse-groups'
      ? hasDeviceLayer
        ? t('ccAgent.sidebar.foldAll.collapseProjects')
        : t('ccAgent.sidebar.foldAll.collapseGroups')
      : foldState === 'collapse-devices'
        ? t('ccAgent.sidebar.foldAll.collapseDevices')
        : t('ccAgent.sidebar.foldAll.expandAll');
  const FoldIcon = foldState === 'expand-all' ? ChevronsUpDown : ChevronsDownUp;
  // 散排行的来源标签:平铺时项目会话也要标项目名,不能只喂 dialogues。
  const flattenedSessionsForSourceLabels = useMemo(() => {
    if (filter.groupBy === 'project') return dialogues;
    return [...projects.flatMap((project) => project.sessions), ...dialogues];
  }, [filter.groupBy, projects, dialogues]);
  const dialogueSourceLabelMap = useMemo(
    () =>
      buildSessionSourceLabelMap(
        flattenedSessionsForSourceLabels,
        allKnownProjects,
        t('ccAgent.sidebar.dialogues'),
      ),
    [flattenedSessionsForSourceLabels, allKnownProjects, t],
  );

  // F-PJ-10：即使 projects 因 filter 收窄到空，也要保留段头供用户切回 Filter。
  // 这里用原始 key 全集作为"是否有过任何 project"的判定 — 全部项目都被隐藏时
  // 仍保留段头,用户才能重新选择目录恢复项目。完全没有 project、未分类与对话
  // 时仍画范围标题行(2026-08-13 第 4 轮 review P1:段头恒在),不画列表树。
  // 早退必须在全部 hooks 之后——rules of hooks。
  const hasMainListContent =
    allProjectKeysForOrder.length > 0 ||
    unclassified.length > 0 ||
    dialogues.length > 0 ||
    filter.isFilterActive;

  const renderProjectNode = (project: ProjectNodeData): ReactNode => (
    <ProjectNode
      key={project.projectKey}
      project={project}
      statusFilter={filter.status}
      isCollapsed={collapsed.has(project.projectKey)}
      collapsedAttentionTone={
        collapsed.has(project.projectKey) ? collapsedAttentionToneFor(project.sessions) : null
      }
      parentSectionCollapsed={false}
      activeSessionId={activeSessionId}
      runningSessionIds={runningSessionIds}
      attachedSessionIds={attachedSessionIds}
      notifications={notifications}
      scheduleSessionIndex={scheduleSessionIndex}
      selectedSessionIds={selectedSessionIds}
      disableSessionCollapse={disableSessionCollapse}
      // 按设备分段时段头已写明设备,行内不再重复标注归属(2026-08-12 用户裁决)。
      hideRemoteMachineLabel={deviceGroupingActive}
      onToggle={onToggleProject}
      isProjectPinned={false}
      onToggleProjectPin={onToggleProjectPin}
      onRenameProject={onRenameProject}
      onRemoveFromSidebar={onRemoveFromSidebar}
      onSessionClick={onSessionClick}
      onAction={onAction}
      onRename={onRename}
      onTogglePin={onTogglePin}
      onMoveSession={onMoveSession}
      projectOptions={projectOptions}
      onScheduleAction={onScheduleAction}
      sessionVariant={mainSessionVariant}
      onCreateInProject={onCreateInProject}
      onOpenConversationSearch={onOpenConversationSearch}
      onOpenInExplorer={onOpenInExplorer}
      onLinkCodexProject={onLinkCodexProject}
      linkingCodexProject={linkingCodexProject === project.projectKey}
      onBrowseFiles={onBrowseFiles}
      onArchiveAll={onArchiveAll}
    />
  );

  // 散排任务行 / 自动任务组 / 「对话」组行。散排行与自动任务组带来源标签(hover);
  // 对话组行 = 可折叠的分组头 + 组内会话(折叠上限与对话段旧口径一致)。dialogueGroupKey 标识
  // 该组属于哪个段(设备段 key / 单一列表 DIALOGUE_GROUP_ALL_KEY),折叠独立。
  // dialogueDeviceTarget:按设备分组时该段的设备(null = 本机段),组头新建即落在
  // 这台设备上;不分组时传 undefined,由上层按当前机器作用域推断。
  const renderNonProjectEntry = (
    entry: MainListEntry,
    dialogueGroupKey: string,
    dialogueDeviceTarget?: DialogueDeviceTarget | null,
  ): ReactNode => {
    if (entry.kind === 'session' || entry.kind === 'automation-group') {
      return (
        <SessionEntryRows
          key={entry.kind === 'session' ? entry.session.id : `automation-group:${entry.group.id}`}
          entries={[entry]}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          attachedSessionIds={attachedSessionIds}
          notifications={notifications}
          selectedSessionIds={selectedSessionIds}
          onSessionClick={onSessionClick}
          onAction={onAction}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onMoveSession={onMoveSession}
          projectOptions={projectOptions}
          onScheduleAction={onScheduleAction}
          automationGroupCollapsed={isAutomationGroupCollapsed}
          onAutomationGroupCollapsedChange={setAutomationGroupCollapsed}
          sourceLabelMap={dialogueSourceLabelMap}
          sessionVariant={mainSessionVariant}
          // 混排下每条散排对话各是一个单条列表,若都补顶线,会与上一行的底线叠成
          // 两根横线(2026-08-12 实机反馈)。底线已覆盖行间分割,这里只关顶线。
          showFirstDivider={false}
        />
      );
    }
    if (entry.kind === 'dialogue-group') {
      const isCollapsed = collapsedDialogueGroups.has(dialogueGroupKey);
      // 目标设备离线时不能在它上面新建(被控端才是真正的创建方)——与远程项目行的
      // 新建同款保护(isDeviceLinkWriteBlocked / actionsUnavailable 文案)。
      const targetDeviceOffline = Boolean(
        dialogueDeviceTarget && !remoteDeviceIndex?.get(dialogueDeviceTarget.deviceId)?.online,
      );
      // 显式目标下不看作用域解析的 pending:目标已定,无需等设备目录 settle。
      const createDisabled =
        (dialogueDeviceTarget === undefined ? isCreateDialogueDisabled : false) ||
        targetDeviceOffline;
      return (
        <DialogueGroupNode
          key={`dialogue-group:${dialogueGroupKey}`}
          sessions={entry.sessions}
          collapsed={isCollapsed}
          onToggle={() => setDialogueCollapsed([dialogueGroupKey], !isCollapsed)}
          onCreateDialogue={() => onCreateDialogue(dialogueDeviceTarget)}
          isCreateDisabled={createDisabled}
          createDisabledReason={
            targetDeviceOffline ? t('ccAgent.remoteSession.actionsUnavailable') : undefined
          }
          parentSectionCollapsed={false}
          disableSessionCollapse={disableSessionCollapse}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          attachedSessionIds={attachedSessionIds}
          notifications={notifications}
          scheduleSessionIndex={scheduleSessionIndex}
          selectedSessionIds={selectedSessionIds}
          onSessionClick={onSessionClick}
          onAction={onAction}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onMoveSession={onMoveSession}
          projectOptions={projectOptions}
          onScheduleAction={onScheduleAction}
          sessionVariant={mainSessionVariant}
        />
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-0.5 w-full">
      {/* 范围标题恒在:无列表内容时仍画这一行,不把设置入口一起摘掉。 */}
      <MainListScopeHeader
        filter={filter}
        allKnownProjects={allKnownProjects}
        dialogueCount={dialogueCount}
        hasRemoteDevices={deviceGroupingAvailable}
        fold={
          hasMainListContent && foldState !== null
            ? {
                label: foldLabel,
                Icon: FoldIcon,
                onClick: handleFoldAll,
                disabled: projectNodesToggleDisabled && !hasDeviceLayer && !hasGroupLayer,
              }
            : null
        }
      />
      {hasMainListContent ? (
      <div className="relative flex flex-col gap-1 pt-1 pr-0 pl-3">
        {!deviceGroupingActive ? (
          <UnclassifiedSection
            sessions={unclassified}
            hidden={unclassifiedHidden}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            attachedSessionIds={attachedSessionIds}
            notifications={notifications}
            scheduleSessionIndex={scheduleSessionIndex}
            selectedSessionIds={selectedSessionIds}
            onSessionClick={onSessionClick}
            onAction={onAction}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onMoveSession={onMoveSession}
            projectOptions={projectOptions}
            onScheduleAction={onScheduleAction}
            sessionVariant={mainSessionVariant}
          />
        ) : null}
        {/* 混排渲染(D / E 期):
              - 自定义项目顺序:模型保证项目行连续在前 → 项目段走 SortableList,
                其后是散排对话 / 对话组。折叠+溢出时禁用拖拽,点「显示全部」后再拖。
                可与设备分组叠加:每段各自拖本段项目。
              - 按最近活动:按 deviceSections 切段(设备分组开启时),段内项目行与
                散排对话按任务排序口径交错,项目行不可拖。 */}
        {customProjectOrder && !deviceGroupingActive ? (
          <>
            <SortableList
              items={visibleProjectNodes}
              getId={getProjectId}
              onReorder={handleReorder}
              disabled={!projectDragEnabled || (projectsOverflow && !showAllProjects)}
              reducedMotion={reducedMotion}
              handle={MANUAL_PROJECT_SORT_HANDLE}
              filter={MANUAL_PROJECT_SORT_FILTER}
              className="flex flex-col gap-1"
              renderItem={(project) => renderProjectNode(project)}
            />
            {visibleMixedEntries
              .filter((entry) => entry.kind !== 'project')
              .map((entry) => renderNonProjectEntry(entry, DIALOGUE_GROUP_ALL_KEY))}
          </>
        ) : deviceGroupingActive ? (
          <div className="flex flex-col gap-1">
            {deviceSections.map((section) => {
              const key = deviceSectionKey(section.deviceId);
              const device = section.deviceId
                ? remoteDeviceIndex?.get(section.deviceId)
                : undefined;
              const name = section.deviceId
                ? (device?.name ?? section.deviceId)
                : t('ccAgent.sidebar.deviceGroup.local');
              const online = section.deviceId ? (device?.online ?? false) : true;
              const sectionCollapsed = collapsedDevices.has(key);
              return (
                <div key={key} className="flex flex-col gap-1">
                  {/* 设备分组头:可折叠。在线设备不画状态点;离线设备保留灰点与文字提示。 */}
                  <button
                    type="button"
                    onClick={() => toggleDeviceSection(key)}
                    aria-expanded={!sectionCollapsed}
                    aria-label={
                      sectionCollapsed
                        ? t('ccAgent.sidebar.deviceGroup.expand')
                        : t('ccAgent.sidebar.deviceGroup.collapse')
                    }
                    className={cn(
                      'flex h-6 w-full items-center gap-1.5 rounded-md px-1.5',
                      'text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]',
                    )}
                  >
                    {sectionCollapsed ? (
                      <ChevronRight size={12} strokeWidth={2} className="shrink-0" />
                    ) : (
                      <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
                    )}
                    <MonitorSmartphone size={13} strokeWidth={2} className="shrink-0" />
                    <span className="min-w-0 truncate text-xs font-medium">{name}</span>
                    {!online && (
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-[var(--text-tertiary)]"
                      />
                    )}
                    {/* 条数已去掉(2026-08-12 用户裁决):它数的是顶层条目
                          (项目行 + 散排对话 + 对话组),不是任务数,读起来只会误导;
                          段展开后内容本身就是答案。「离线」接手 ml-auto 保持靠右。 */}
                    {!online && (
                      <span className="ml-auto shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                        {t('ccAgent.sidebar.deviceGroup.offline')}
                      </span>
                    )}
                  </button>
                  <SectionCollapse collapsed={sectionCollapsed}>
                    <div className="flex flex-col gap-1 pl-2">
                      {/* 折叠上限每段独立应用(切段在前,见 deviceSections 注释);
                            「显示全部」的作用域同样是段内(expandedDeviceSections)。 */}
                      {(() => {
                        const sectionView = collapseEntries(
                          section.entries,
                          expandedDeviceSections.has(key),
                        );
                        const sectionDialogueTarget = section.deviceId
                          ? { deviceId: section.deviceId, deviceName: name }
                          : null;
                        const sectionProjects = sectionView.visibleEntries
                          .filter(
                            (entry): entry is Extract<MainListEntry, { kind: 'project' }> =>
                              entry.kind === 'project',
                          )
                          .map((entry) => entry.project);
                        return (
                          <>
                            {customProjectOrder ? (
                              <>
                                <SortableList
                                  items={sectionProjects}
                                  getId={getProjectId}
                                  onReorder={handleReorder}
                                  disabled={
                                    !projectDragEnabled ||
                                    (sectionView.isOverflowing &&
                                      !expandedDeviceSections.has(key))
                                  }
                                  reducedMotion={reducedMotion}
                                  handle={MANUAL_PROJECT_SORT_HANDLE}
                                  filter={MANUAL_PROJECT_SORT_FILTER}
                                  className="flex flex-col gap-1"
                                  renderItem={(project) => renderProjectNode(project)}
                                />
                                {sectionView.visibleEntries
                                  .filter((entry) => entry.kind !== 'project')
                                  .map((entry) =>
                                    renderNonProjectEntry(entry, key, sectionDialogueTarget),
                                  )}
                              </>
                            ) : (
                              sectionView.visibleEntries.map((entry) =>
                                entry.kind === 'project'
                                  ? renderProjectNode(entry.project)
                                  : renderNonProjectEntry(entry, key, sectionDialogueTarget),
                              )
                            )}
                            {sectionView.isOverflowing && (
                              <ShowAllEntriesButton
                                count={sectionView.totalCount}
                                onClick={() =>
                                  setExpandedDeviceSections((prev) => new Set(prev).add(key))
                                }
                              />
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </SectionCollapse>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleMixedEntries.map((entry) =>
              entry.kind === 'project'
                ? renderProjectNode(entry.project)
                : renderNonProjectEntry(entry, DIALOGUE_GROUP_ALL_KEY),
            )}
          </div>
        )}
        {/* 全局「显示全部」只属于未按设备分组的单段路径;设备分组下折叠与 footer 都在段内。 */}
        {!deviceGroupingActive && projectsOverflow && (
          <ShowAllEntriesButton count={projectsTotal} onClick={() => setShowAllProjects(true)} />
        )}
      </div>
      ) : null}
    </div>
  );
}

/**
 * DialogueGroupNode — 「对话」组行(D 期,「对话归为一组」开启时)。
 * 视觉与交互与 ProjectNode 表头**同款**(2026-08-12 用户裁决:对话组的分组 UI、
 * 交互与自动收起逻辑都与项目分组一致):h-8 药丸 hover 行、15px 图标、meta 灰文字、
 * 标题右侧 hover 渐显展开箭头;组内会话折叠上限同项目内会话
 * (getProjectSessionCollapseLimit)。折叠状态受控(父层持久化),并纳入
 * 「收起所有分组」的批量收起/展开。
 * 标题「对话」是归属分类名(task-and-conversation-naming §2.3)。
 */
function DialogueGroupNode({
  sessions,
  collapsed,
  onToggle,
  onCreateDialogue,
  isCreateDisabled,
  createDisabledReason,
  parentSectionCollapsed,
  disableSessionCollapse,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  sessionVariant,
}: {
  sessions: Session[];
  collapsed: boolean;
  onToggle: () => void;
  /**
   * 组头右侧的新建入口(与项目行 SquarePen 等位):新建不绑项目的对话任务。
   * 目标设备由父层按所在设备段决定(闭包传入),本组件不关心。
   */
  onCreateDialogue: () => void;
  isCreateDisabled: boolean;
  /** 禁用原因(目标设备离线),有值时替换按钮 tooltip / aria——与远程项目行同款。 */
  createDisabledReason?: string;
  parentSectionCollapsed: boolean;
  disableSessionCollapse: boolean;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  sessionVariant: 'text' | 'list';
}) {
  const { t } = useTranslation();
  // 与 ProjectNode 同款:标题右侧 hover 渐显的展开/收起指示箭头。
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="relative flex w-full select-none flex-col" data-no-drag>
      {/* 段头:与 ProjectNode Header 同款规格(h-8 药丸 hover / pl-3 pr-1 /
          gap-2.5 / 15px 图标 / meta 灰 font-normal),仅图标换 MessagesSquare、
          无重命名与右键菜单(「对话」是固定分类名,没有项目那套操作)。 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          'group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-full pl-3 pr-1',
          'text-sm font-normal text-[var(--sidebar-list-muted)]',
          'transition-colors hover:bg-sidebar-item-hover',
        )}
      >
        <MessagesSquare
          size={15}
          strokeWidth={1.8}
          className="shrink-0 text-[var(--sidebar-list-muted)]"
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{t('ccAgent.sidebar.dialogues')}</span>
          <Chevron
            size={13}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
          />
        </div>
        {/* 悬浮工具组:与 ProjectNode Header 同款——常态隐藏,hover 整行淡入。
            对话组没有项目那套 More 菜单,只保留新建(SquarePen,与项目行等位)。 */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5',
            'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <Tip text={createDisabledReason ?? t('ccAgent.sidebar.newDialogue')}>
            <button
              type="button"
              aria-label={createDisabledReason ?? t('ccAgent.sidebar.newDialogue')}
              disabled={isCreateDisabled}
              onClick={(e) => {
                e.stopPropagation();
                if (!isCreateDisabled) onCreateDialogue();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-md',
                'text-sidebar-action-icon hover:text-foreground',
                'hover:bg-sidebar-item-hover focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
              )}
            >
              <SquarePen size={14} strokeWidth={2} />
            </button>
          </Tip>
        </div>
      </div>
      {/* 组内会话:与 ProjectNode 的会话区同款容器(gap / pt / pb 呼吸、list 缩进)
          与同一份折叠上限(getProjectSessionCollapseLimit)。 */}
      <SectionCollapse collapsed={collapsed} data-no-drag>
        <div
          className={cn(
            'flex flex-col gap-0.5 pt-0.5 pb-1.5 pr-0',
            sessionVariant === 'list' ? 'pl-3' : 'pl-0',
          )}
        >
          <SessionEntryList
            sessions={sessions}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            attachedSessionIds={attachedSessionIds}
            notifications={notifications}
            scheduleSessionIndex={scheduleSessionIndex}
            selectedSessionIds={selectedSessionIds}
            onSessionClick={onSessionClick}
            onAction={onAction}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onMoveSession={onMoveSession}
            projectOptions={projectOptions}
            onScheduleAction={onScheduleAction}
            indented
            collapsible
            collapseLimit={getProjectSessionCollapseLimit()}
            disableCollapse={disableSessionCollapse}
            sectionCollapsed={parentSectionCollapsed || collapsed}
            sessionVariant={sessionVariant}
          />
        </div>
      </SectionCollapse>
    </div>
  );
}
