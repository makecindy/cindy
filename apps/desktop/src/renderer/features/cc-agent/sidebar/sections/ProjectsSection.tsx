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
 * projects + unclassified 都为空时整段不渲染。
 *
 * 拖拽：sortBy === 'manual' 时由 SortableList (SortableJS) 接管整行拖拽；
 *   其它排序模式 disabled。落定后通过 filter.setManualProjectOrder 写回。
 *   原先的手写 PointerEvents + 1px 落点指示线已下线，统一由 SortableJS 的
 *   ghost / chosen / drag class 提供视觉。
 */

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { SortableList } from '@/components/sidebar/SortableList';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { ProjectNode } from './ProjectNode';
import { UnclassifiedSection } from './UnclassifiedSection';
import { getSessionListCollapseView } from '../../lib/sessionListCollapse';
import { getProjectCollapseLimit } from '../../lib/sidebarCollapseConfig';
import {
  normalizeManualProjectOrder,
  mergeVisibleReorder,
} from '../../hooks/helpers/sidebarFilterCore';
import { SidebarFilterPopover } from '../SidebarFilterPopover';
import { SectionCollapse } from '../SectionCollapse';
import { useCollapsibleShowAll } from '../hooks/useCollapsibleShowAll';
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

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  // Pointer click focus must not pin these hover-only actions after the mouse leaves.
  // Keyboard focus-visible still reveals them for tab navigation.
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  // 段头内任一菜单(远程机器 / 整理侧边栏)展开时(其 trigger 带 data-state=open),
  // 整排 action 保持可见——鼠标移进展开的菜单、段头不再 hover 时,其它按钮不该消失。
  'group-has-[[data-state=open]]/sidebar-header:pointer-events-auto group-has-[[data-state=open]]/sidebar-header:opacity-100',
);

const HEADER_ACTIONS_CLASS = cn('flex items-center gap-0.5 -mt-px', HEADER_HOVER_ACTION_CLASS);

export interface ProjectsSectionProps {
  unclassified: Session[];
  /** 已经按 filter.projects 过滤后、仅会被渲染的 Project 子集。 */
  projects: ProjectNodeData[];
  /**
   * F-PJ-10：未经过过滤的全量 Project（用于 SidebarFilterPopover 列表渲染）。
   * 与 `projects` 区分以便 Popover 始终展示完整候选集。
   */
  allKnownProjects: ProjectNodeData[];
  /** F-PJ-10：filter 完整对象传给 Popover；段内不直接读取，仅透传给子组件。 */
  filter: UseSidebarFilterReturn;
  collapsed: Set<string>;
  isAllCollapsed: boolean;
  activeSessionId?: string;
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
  onCollapseAll: () => void;
  onExpandAll: () => void;
  /** 段头新建项目：选择一个新项目目录后进入 transient draft route。 */
  onCreateProject: () => void;
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
}

export function ProjectsSection({
  unclassified,
  projects,
  allKnownProjects,
  filter,
  collapsed,
  isAllCollapsed,
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
  onToggleProject,
  onToggleProjectPin,
  onRenameProject,
  onCollapseAll,
  onExpandAll,
  onCreateProject,
  onCreateInProject,
  onOpenConversationSearch,
  onOpenInExplorer,
  onLinkCodexProject,
  linkingCodexProject,
  onBrowseFiles,
  onArchiveAll,
}: ProjectsSectionProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  // 拖拽只在 Project 分组下才有意义；sortBy 不强制要 'manual'——用户随手拖一下
  // 我们就在 onReorder 里自动切到 manual 并持久化，避免"默认 recency 排序下永远拖不动"
  // 的反直觉体验。
  const projectDragEnabled = filter.groupBy === 'project';
  const activeProjectWorkingDirs = useMemo(
    () => allKnownProjects.map((project) => project.projectKey),
    [allKnownProjects],
  );
  const [isSectionCollapsed, setIsSectionCollapsed] = useState(false);
  const [showAllProjects, setShowAllProjects] = useCollapsibleShowAll(isSectionCollapsed);

  const getProjectId = useCallback((p: ProjectNodeData) => p.projectKey, []);

  const handleReorder = useCallback(
    (visibleNewOrder: string[]) => {
      // SortableList 给我们的是当前 **可见** projects 的新顺序。机器 / vendor / 项目过滤态下,
      // 不可见的 project(其它机器 / 被过滤掉的)必须**保持原位** —— 与置顶拖拽同一套「原位 merge」
      // 语义(mergeVisibleReorder),而不是把它们甩到末尾(否则切回「所有」时其它机器项目的相对
      // 位置会被无关拖拽悄悄打乱)。做法:先取全量规范顺序作 baseline,再把可见新序原位填回。
      // activeProjectWorkingDirs = allKnownProjects(未过滤全量 universe)的 key,因此 baseline 含
      // 隐藏项;setManualProjectOrder 内部会再归一化一次(对已规范的 merged 结果幂等)。
      const fullOrder = normalizeManualProjectOrder(
        filter.manualProjectOrder,
        activeProjectWorkingDirs,
      );
      const merged = mergeVisibleReorder(fullOrder, visibleNewOrder);
      filter.setManualProjectOrder(merged, activeProjectWorkingDirs);
      // 用户随手一拖即表达"我要手动排序"的意图；如果当前不是 manual，自动切过去
      // 并持久化，让拖拽结果立刻生效，不需要用户先去 Filter Popover 切换排序模式。
      if (filter.sortBy !== 'manual') {
        filter.setSortBy('manual');
      }
    },
    [filter, activeProjectWorkingDirs],
  );

  // F-PJ-10：即使 projects 因 filter 收窄到空，也要保留段头供用户切回 Filter。
  // 这里用 allKnownProjects 作为"是否有过任何 project"的判定 — 完全没有 project
  // 且没有未分类 → 整段不渲染。(机器切换入口已移到侧栏顶部固定行,不再依赖本段头,
  // 故无需再为「有远程机器」保留空段头。)
  if (allKnownProjects.length === 0 && unclassified.length === 0 && !filter.isFilterActive) {
    return null;
  }

  const SectionToggleIcon = isSectionCollapsed ? ChevronRight : ChevronDown;
  const sectionToggleLabel = isSectionCollapsed
    ? t('ccAgent.sidebar.projectsSectionToggleExpand')
    : t('ccAgent.sidebar.projectsSectionToggleCollapse');
  // 右侧旧按钮保留 ProjectNode 级别行为：折叠/展开所有项目下面的会话。
  const ProjectNodesToggleIcon = isAllCollapsed ? ChevronsUpDown : ChevronsDownUp;
  const handleToggleAllProjectNodes = isAllCollapsed ? onExpandAll : onCollapseAll;
  const projectNodesToggleLabel = isAllCollapsed
    ? t('ccAgent.sidebar.projectsToggleExpand')
    : t('ccAgent.sidebar.projectsToggleCollapse');
  // toggleDisabled 用 allKnownProjects（不是过滤后的 projects），避免 filter 收窄到 0 时
  // 即便没真正可折叠的目标，也保留视觉一致——但禁用按钮以避免无意义点击。
  const projectNodesToggleDisabled = allKnownProjects.length === 0;
  // 折叠上限始终生效(用户定稿):任何筛选(最近活跃 / 状态 / 项目 / Vendor)、任何排序
  // (含「时间」)下,每项目都最多显示 N 条 + 「显示全部」。折叠是纯显示上限,与筛选正交;
  // 文字搜索是独立面板、不在本段内联过滤,故无需为它禁用。
  const disableSessionCollapse = false;

  // 项目列表本身也折叠:最多显示 10 个项目,超出收起 + 「显示全部 N 项」。与会话同一套
  // 规则(getSessionListCollapseView):始终保留"有需关注会话"的项目、以及包含当前会话的
  // 项目;任何排序/筛选下都生效。
  const {
    visibleEntries: visibleProjectNodes,
    isOverflowing: projectsOverflow,
    totalCount: projectsTotal,
  } = getSessionListCollapseView({
    entries: projects,
    minVisibleCount: getProjectCollapseLimit(),
    showAll: showAllProjects,
    disableCollapse: false,
    isFiltering: false,
    isActiveEntry: (p) => p.sessions.some((s) => s.id === activeSessionId),
    hasAttentionEntry: (p) => p.sessions.some((s) => notifications.has(s.id)),
  });

  // F-PJ-10：未分类区在 projects 为具体多选状态时不渲染（spec 验收第 14 条）
  const unclassifiedHidden = filter.projects !== 'all';

  return (
    <div className="flex flex-col gap-0.5 w-full">
      {/* Section Title — 左侧标题 + 段级收起箭头；右侧保留 ProjectNode 全部折叠 + Filter。
          pr-0：与下方 cells 子容器一样依赖 scrollbar-gutter:stable 预留 12px，
          按钮组右边自然对齐 cell 右边。 */}
      <div className="group/sidebar-header flex h-6 items-center justify-between pr-0 pl-6">
        {/* 段标题:淡灰(text-tertiary,对齐 Codex 的低对比栏目标题;2026-07 用户定稿,
            取代原 msg-assistant-text 深色),点击标题即可收起/展开整段(与右侧 hover
            箭头同一行为,标题是更大的点击目标)。 */}
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setIsSectionCollapsed((value) => !value)}
            aria-expanded={!isSectionCollapsed}
            className="text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
          >
            {t('ccAgent.sidebar.projects')}
          </button>
          <div className={HEADER_HOVER_ACTION_CLASS}>
            <Tip text={sectionToggleLabel} side="bottom">
              <button
                type="button"
                onClick={() => setIsSectionCollapsed((value) => !value)}
                aria-label={sectionToggleLabel}
                aria-expanded={!isSectionCollapsed}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  // 无灰底 hover(2026-07 用户定稿):纯色加深反馈,与段标题一致。
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <SectionToggleIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
        {/* 右侧工具组：ProjectNode Toggle All → Filter → New Project
            -mt-px：h-7 按钮在 h-6 行里中心对齐时视觉偏低，上移 1px 与 "Projects" 文字
            视觉中线对齐 */}
        {/* 右侧:hover 才浮现的工具组(远程机器切换入口已移到侧栏顶部固定行,不在段头)。 */}
        <div className="flex items-center gap-0.5 -mt-px">
          <div className={HEADER_ACTIONS_CLASS}>
            {!isSectionCollapsed && (
              <Tip text={projectNodesToggleLabel} side="bottom">
                <button
                  type="button"
                  onClick={handleToggleAllProjectNodes}
                  disabled={projectNodesToggleDisabled}
                  aria-label={projectNodesToggleLabel}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md',
                    'text-[var(--sidebar-list-muted)]',
                    'transition-colors hover:text-[var(--sidebar-nav-text)]',
                    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                  )}
                >
                  <ProjectNodesToggleIcon size={14} strokeWidth={2} />
                </button>
              </Tip>
            )}
            {/* F-PJ-10：Filter Popover 入口。allKnownProjects 是未过滤前的 Project 全集。 */}
            <SidebarFilterPopover filter={filter} allKnownProjects={allKnownProjects} />
            <Tip text={t('ccAgent.sidebar.newProject')} side="bottom">
              <button
                type="button"
                onClick={onCreateProject}
                aria-label={t('ccAgent.sidebar.newProject')}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <Plus size={14} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
      </div>

      {/* 段级收起走 SectionCollapse 高度动画；项目列表「显示全部」在收起动画结束后复位。 */}
      <SectionCollapse collapsed={isSectionCollapsed}>
        {/* Projects Tree — padding [4,0,0,12], gap 4
            pr-0：右侧依赖 scroll body 的 scrollbar-gutter:stable 预留 12px，
            与左 pl-3 视觉对称；全局滚动条已收窄到 12px 与 pl-3 等宽。 */}
        <div className="relative flex flex-col gap-1 pt-1 pr-0 pl-3">
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
          />
          {/* 折叠+溢出时 visibleProjectNodes 仅是当前子集:拖拽重排只会重排该子集,
              持久化时隐藏项按 allKnownProjects 顺序追加、静默改写其 manual order
              (PR #246 review)。此时禁用拖拽,点「显示全部」展开为完整列表后再拖。 */}
          <SortableList
            items={visibleProjectNodes}
            getId={getProjectId}
            onReorder={handleReorder}
            disabled={!projectDragEnabled || (projectsOverflow && !showAllProjects)}
            reducedMotion={reducedMotion}
            filter="button, input, textarea, select, a, [data-no-drag], [data-project-header]"
            className="flex flex-col gap-1"
            renderItem={(project) => (
              <ProjectNode
                project={project}
                statusFilter={filter.status}
                isCollapsed={collapsed.has(project.projectKey)}
                parentSectionCollapsed={isSectionCollapsed}
                activeSessionId={activeSessionId}
                runningSessionIds={runningSessionIds}
                attachedSessionIds={attachedSessionIds}
                notifications={notifications}
                scheduleSessionIndex={scheduleSessionIndex}
                selectedSessionIds={selectedSessionIds}
                disableSessionCollapse={disableSessionCollapse}
                onToggle={onToggleProject}
                isProjectPinned={false}
                onToggleProjectPin={onToggleProjectPin}
                onRenameProject={onRenameProject}
                onSessionClick={onSessionClick}
                onAction={onAction}
                onRename={onRename}
                onTogglePin={onTogglePin}
                onMoveSession={onMoveSession}
                projectOptions={projectOptions}
                onScheduleAction={onScheduleAction}
                onCreateInProject={onCreateInProject}
                onOpenConversationSearch={onOpenConversationSearch}
                onOpenInExplorer={onOpenInExplorer}
                onLinkCodexProject={onLinkCodexProject}
                linkingCodexProject={linkingCodexProject === project.projectKey}
                onBrowseFiles={onBrowseFiles}
                onArchiveAll={onArchiveAll}
              />
            )}
          />
          {projectsOverflow && (
            <button
              type="button"
              className={cn(
                'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
                'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
              )}
              onClick={() => setShowAllProjects(true)}
            >
              {t('ccAgent.sidebar.showAllSessions', { count: projectsTotal })}
            </button>
          )}
        </div>
      </SectionCollapse>
    </div>
  );
}
