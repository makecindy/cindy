/**
 * SidebarFilterPopover — Sidebar 整理菜单
 * ---------------------------------------------------------------------------
 * 菜单分两层语义：
 *   - 上半区是筛选：Status / Project / Agent / Last activity
 *   - 下半区是整理方式：Group by / Sort by
 *
 * 入口仍复用 sliders-horizontal 图标；内容改成行式菜单 + 子菜单，避免后续
 * 增加分组、排序或过滤维度时继续堆叠 chip。
 */

import type { ReactNode, Ref } from 'react';
import { Check, ChevronRight, Globe, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
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
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import { getRemoteProjectMachineIdentity } from '../lib/remoteProjectIdentity';
import {
  buildProjectKeyComparisonSet,
  projectKeyComparisonSetHas,
} from '../lib/sidebarProjectVisibility';
import type {
  FilterGroupBy,
  FilterLastActivity,
  FilterSortBy,
  FilterStatus,
  FilterVendor,
  UseSidebarFilterReturn,
} from '../hooks/useSidebarFilter';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from './menuStyles';
import { HoverMenuAreaContext, useHoverMenuArea, useHoverOpenMenu } from './useHoverOpenMenu';

type Option<T extends string> = {
  value: T;
  labelKey: string;
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

const GROUP_BY_OPTIONS: ReadonlyArray<Option<FilterGroupBy>> = [
  { value: 'project', labelKey: 'ccAgent.sidebar.filterGroupBy.project' },
  { value: 'date', labelKey: 'ccAgent.sidebar.filterGroupBy.date' },
];

const DATE_SORT_BY_OPTIONS: ReadonlyArray<Option<FilterSortBy>> = [
  { value: 'recency', labelKey: 'ccAgent.sidebar.filterSortBy.recency' },
  { value: 'time', labelKey: 'ccAgent.sidebar.filterSortBy.time' },
];

const PROJECT_SORT_BY_OPTIONS: ReadonlyArray<Option<FilterSortBy>> = [
  ...DATE_SORT_BY_OPTIONS,
  { value: 'manual', labelKey: 'ccAgent.sidebar.filterSortBy.manual' },
  { value: 'alphabetic', labelKey: 'ccAgent.sidebar.filterSortBy.alphabetic' },
];

export interface SidebarFilterPopoverProps {
  filter: UseSidebarFilterReturn;
  /** 用于 Project 多选列表的完整候选集（不受 Last activity 收窄影响）。 */
  allKnownProjects: ProjectNodeData[];
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
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  // 子菜单也挂 hover-area 处理:鼠标从主菜单移入(Portal 渲染的)SubContent 时,
  // 主 Content 的 onMouseLeave 会排一次 close,这里的 onMouseEnter=cancelClose 立即取消,
  // 避免整棵菜单被误关(见 useHoverOpenMenu 文件头)。纯点击场景下 hoverArea 为 null。
  const hoverArea = useHoverMenuArea();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <span className="truncate">{label}</span>
        <span className="ml-auto max-w-[96px] truncate text-right text-[var(--cmd-palette-item-meta)]">
          {value}
        </span>
        <ChevronRight size={14} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        {...(hoverArea ?? {})}
        className={cn(MENU_SUB_CONTENT_CLASS, 'w-[220px]')}
      >
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function SelectMenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={MENU_ITEM_CLASS}>
      <span className="truncate">{label}</span>
      {selected && <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />}
    </DropdownMenuItem>
  );
}

export function SidebarFilterPopover({
  filter,
  allKnownProjects,
}: SidebarFilterPopoverProps) {
  const { t } = useTranslation();
  const {
    status,
    projects,
    projectsAsSet,
    isFilterActive,
    vendor,
    lastActivity,
    groupBy,
    sortBy,
    setStatus,
    toggleProject,
    setProjectsAll,
    setVendor,
    setLastActivity,
    setGroupBy,
    setSortBy,
  } = filter;

  // 「鼠标移上去就展开」:hover 触发按钮即开、移开即关(受控开合,详见 useHoverOpenMenu)。
  const { open, onOpenChange, triggerRef, triggerProps, contentProps, hoverAreaProps } =
    useHoverOpenMenu();

  const statusValue = optionLabel(STATUS_OPTIONS, status, t);
  const vendorValue = optionLabel(VENDOR_OPTIONS, vendor, t);
  const lastActivityValue = optionLabel(LAST_ACTIVITY_OPTIONS, lastActivity, t);
  const groupByValue = optionLabel(GROUP_BY_OPTIONS, groupBy, t);
  const sortByOptions = groupBy === 'project' ? PROJECT_SORT_BY_OPTIONS : DATE_SORT_BY_OPTIONS;
  const effectiveSortBy = sortByOptions.some((option) => option.value === sortBy)
    ? sortBy
    : 'recency';
  const sortByValue = optionLabel(sortByOptions, effectiveSortBy, t);
  const projectValue =
    projects === 'all'
      ? t('ccAgent.sidebar.filterAllText')
      : t('ccAgent.sidebar.filterSelectedProjects', { count: projects.length });
  const projectComparisonKeys =
    projectsAsSet == null
      ? null
      : buildProjectKeyComparisonSet(projectsAsSet, window.electronAPI.platform);

  const ariaLabel = t('ccAgent.sidebar.filterAria', {
    status: statusValue,
    vendor: vendorValue,
    lastActivity: lastActivityValue,
    groupBy: groupByValue,
    sortBy: sortByValue,
    projects: projectValue,
  });

  return (
    <HoverMenuAreaContext.Provider value={hoverAreaProps}>
    {/* modal={false}:hover 展开必须非模态,否则模态给 body 加 pointer-events:none 会让
        trigger 不可命中,触发 mouseleave→关→mouseenter→开 的闪烁循环(仍支持点外部 / Esc 关)。 */}
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          ref={triggerRef as Ref<HTMLButtonElement>}
          aria-label={ariaLabel}
          aria-pressed={isFilterActive}
          {...triggerProps}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md',
            'text-[var(--text-tertiary)]',
            'transition-colors hover:text-[var(--text-secondary)]',
          )}
        >
          <SlidersHorizontal size={14} strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={8}
        {...contentProps}
        className={cn(MENU_CONTENT_CLASS, 'w-[248px]')}
      >
        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.organizeSidebar')}
        </div>

        <MenuSubRow label={t('ccAgent.sidebar.filterStatusHeading')} value={statusValue}>
          {STATUS_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={status === option.value}
              onSelect={() => setStatus(option.value)}
            />
          ))}
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterProjectsHeading')} value={projectValue}>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setProjectsAll();
            }}
            className={MENU_ITEM_CLASS}
          >
            <span className="truncate">{t('ccAgent.sidebar.filterAllProjects')}</span>
            {projects === 'all' && <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />}
          </DropdownMenuItem>
          {allKnownProjects.length > 0 && (
            <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
          )}
          <div className="max-h-[256px] overflow-y-auto">
            {allKnownProjects.map((project) => {
              const selected =
                projects === 'all' ||
                (projectComparisonKeys != null &&
                  projectKeyComparisonSetHas(
                    projectComparisonKeys,
                    project.projectKey,
                    window.electronAPI.platform,
                  ));
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
                  {selected && <Check size={15} className="shrink-0 text-[var(--msg-assistant-text)]" />}
                </DropdownMenuItem>
              );
            })}
          </div>
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterAgentHeading')} value={vendorValue}>
          {VENDOR_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={vendor === option.value}
              onSelect={() => setVendor(option.value)}
            />
          ))}
        </MenuSubRow>

        <MenuSubRow label={t('ccAgent.sidebar.filterLastActivityHeading')} value={lastActivityValue}>
          {LAST_ACTIVITY_OPTIONS.map((option) => (
            <SelectMenuItem
              key={option.value}
              label={t(option.labelKey)}
              selected={lastActivity === option.value}
              onSelect={() => setLastActivity(option.value)}
            />
          ))}
        </MenuSubRow>

        <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.filterGroupByHeading')}
        </div>
        {GROUP_BY_OPTIONS.map((option) => (
          <SelectMenuItem
            key={option.value}
            label={t(option.labelKey)}
            selected={groupBy === option.value}
            onSelect={() => setGroupBy(option.value)}
          />
        ))}

        <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.filterSortByHeading')}
        </div>
        {sortByOptions.map((option) => (
          <SelectMenuItem
            key={option.value}
            label={t(option.labelKey)}
            selected={effectiveSortBy === option.value}
            onSelect={() => setSortBy(option.value)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    </HoverMenuAreaContext.Provider>
  );
}
