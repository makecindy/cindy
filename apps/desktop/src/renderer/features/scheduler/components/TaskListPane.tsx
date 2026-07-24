/**
 * TaskListPane — 左侧任务列表面板
 * ---------------------------------------------------------------------------
 * 设计稿：右侧 1px Board 边，顶部 status 筛选 popover + 数量徽标，
 * 然后是可滚动的 cell 列表。
 *
 * 宽度：默认 300，由父级通过 useHorizontalResize 控制（拖拽 + 持久化），
 *      sidebar 同款 4px hit-area handle，hover 出 1px 高亮线，双击重置。
 *
 * 排序、过滤、selectedId 都在 SchedulerPage 处理；本组件只负责渲染。
 */

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { normalizeWorkingDir } from '@/features/cc-agent/lib/projectGrouping';
import type { Schedule, SchedulerRuntimeSnapshot } from '@cindy/maker-scheduler';

import { TaskListCell } from './TaskListCell';
import { TaskListFilterPopover, type StatusFilter } from './TaskListFilterPopover';
import type { ScheduleCostSummary } from '../hooks/useScheduleCostSummaries';

const COLLAPSE_KEY = 'xdt:scheduler.collapsedProjects';
const OTHER_GROUP_KEY = 'other';
const DIALOGUE_GROUP_KEY = 'dialogue';

interface Props {
  schedules: Schedule[];
  selectedId: string | null;
  unreadRunCounts: ReadonlyMap<string, number>;
  costSummaries: ReadonlyMap<string, ScheduleCostSummary>;
  costSummariesLoaded: boolean;
  onSelect: (s: Schedule) => void;
  /** 当前 status 筛选值；默认 'active'。 */
  statusFilter: StatusFilter;
  /** Status 筛选变化回调。 */
  onStatusFilterChange: (v: StatusFilter) => void;
  /** Cell 右键菜单的动作回调，转发给 TaskListCell。 */
  onTogglePause: (s: Schedule) => void | Promise<void>;
  onDelete: (s: Schedule) => void | Promise<void>;
  onRename?: (s: Schedule, newName: string) => void | Promise<void>;
  onPromoteToProject?: (s: Schedule) => void | Promise<void>;
  onEditProjectSchedule?: (s: Schedule) => void | Promise<void>;
  onCloneToUser?: (s: Schedule) => void | Promise<void>;
  onRemoveProjectSchedule?: (s: Schedule) => void | Promise<void>;
  /** Cell 行悬浮时露出的「立即运行」按钮回调。 */
  onRunNow?: (s: Schedule) => void | Promise<void>;
  /** 页面级 runNow busy 守卫集合；has(s.id) === true 时对应行按钮禁用。 */
  runNowBusyIds?: ReadonlySet<string>;
  /** Scheduler 运行时快照；用于标识真实被并发闸门扣住的到期任务。 */
  runtimeSnapshot: SchedulerRuntimeSnapshot | null;
  /** Project-level action: open .cindy/automations/schedules.json. */
  onOpenProjectConfig: (workingDir: string) => void | Promise<void>;
  /** Project-level action: reconcile this workingDir's automation config. */
  onReloadProject: (workingDir: string) => void | Promise<void>;
  /** Project-level action: create a new project automation in this workingDir. */
  onCreateProjectSchedule: (workingDir: string) => void;
  /** 当前宽度（px），由父级 useHorizontalResize 维护。 */
  width: number;
  /** Pointer down on resize handle，开始拖拽。 */
  onResizeStart: (e: React.PointerEvent) => void;
  /** Double click on resize handle，重置默认宽度。 */
  onResizeReset: () => void;
}

export function TaskListPane({
  schedules,
  selectedId,
  unreadRunCounts,
  costSummaries,
  costSummariesLoaded,
  onSelect,
  statusFilter,
  onStatusFilterChange,
  onTogglePause,
  onDelete,
  onRename,
  onPromoteToProject,
  onEditProjectSchedule,
  onCloneToUser,
  onRemoveProjectSchedule,
  onRunNow,
  runNowBusyIds,
  runtimeSnapshot,
  onOpenProjectConfig,
  onReloadProject,
  onCreateProjectSchedule,
  width,
  onResizeStart,
  onResizeReset,
}: Props) {
  const { t } = useTranslation();
  const [collapsed, toggleCollapsed] = useCollapsedProjects();
  const waitingScheduleIds = useMemo(
    () => new Set(runtimeSnapshot?.waitingSchedules.map((waiting) => waiting.scheduleId) ?? []),
    [runtimeSnapshot],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, Schedule[]>();
    for (const schedule of schedules) {
      const key =
        schedule.workspaceKind === 'dialogue'
          ? DIALOGUE_GROUP_KEY
          : normalizeScheduleWorkingDir(schedule.workingDir);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(schedule);
      else grouped.set(key, [schedule]);
    }

    return [...grouped.entries()]
      .map(([key, items]) => ({
        workingDir: key,
        displayName:
          key === DIALOGUE_GROUP_KEY
            ? t('newChat.folderPicker.dialogue')
            : key === OTHER_GROUP_KEY
              ? t('scheduler.list.section.otherGroup')
              : lastPathSegment(items[0].workingDir ?? key),
        schedules: sortWithinGroup(items),
        hasProjectSchedules: items.some((s) => s.source === 'project'),
      }))
      .sort((a, b) => {
        if (a.workingDir === OTHER_GROUP_KEY) return 1;
        if (b.workingDir === OTHER_GROUP_KEY) return -1;
        if (a.workingDir === DIALOGUE_GROUP_KEY) return 1;
        if (b.workingDir === DIALOGUE_GROUP_KEY) return -1;
        return 0;
      });
  }, [schedules, t]);

  return (
    <aside
      style={{ width }}
      className={cn(
        'relative flex shrink-0 flex-col',
        'border-r border-[var(--cmd-palette-border)]',
      )}
    >
      <div className="flex shrink-0 items-center justify-between px-[10px] pb-2 pt-[14px]">
        <TaskListFilterPopover value={statusFilter} onChange={onStatusFilterChange} />
        <span className="text-11 text-[var(--settings-section-desc)]">{schedules.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.workingDir);
          return (
            <div key={group.workingDir} className="flex flex-col">
              <div
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-md px-1.5',
                  'cursor-pointer text-xs font-medium text-[var(--msg-assistant-text)] transition-colors',
                  'hover:bg-[var(--surface-hover)]',
                )}
                onClick={() => toggleCollapsed(group.workingDir)}
              >
                {isCollapsed ? (
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className="shrink-0 text-[var(--cmd-palette-item-meta)]"
                  />
                ) : (
                  <ChevronDown
                    size={12}
                    strokeWidth={2}
                    className="shrink-0 text-[var(--cmd-palette-item-meta)]"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                {!isCollapsed &&
                  group.workingDir !== OTHER_GROUP_KEY &&
                  group.workingDir !== DIALOGUE_GROUP_KEY && (
                    <button
                      type="button"
                      aria-label={t('scheduler.list.section.createProjectAria')}
                      title={t('scheduler.list.section.createProject')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateProjectSchedule(group.workingDir);
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--cmd-palette-item-meta)] hover:bg-[var(--confirm-btn-secondary-hover)] hover:text-[var(--msg-assistant-text)]"
                    >
                      <SquarePen size={14} strokeWidth={2} />
                    </button>
                  )}
                {group.hasProjectSchedules &&
                  !isCollapsed &&
                  group.workingDir !== OTHER_GROUP_KEY &&
                  group.workingDir !== DIALOGUE_GROUP_KEY && (
                    <>
                      <button
                        type="button"
                        aria-label={t('scheduler.list.section.openConfigAria')}
                        title={t('scheduler.list.section.openConfig')}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onOpenProjectConfig(group.workingDir);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--cmd-palette-item-meta)] hover:bg-[var(--confirm-btn-secondary-hover)] hover:text-[var(--msg-assistant-text)]"
                      >
                        <ExternalLink size={12} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        aria-label={t('scheduler.list.section.reloadAria')}
                        title={t('scheduler.list.section.reload')}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onReloadProject(group.workingDir);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--cmd-palette-item-meta)] hover:bg-[var(--confirm-btn-secondary-hover)] hover:text-[var(--msg-assistant-text)]"
                      >
                        <RefreshCw size={12} strokeWidth={2} />
                      </button>
                    </>
                  )}
              </div>
              {!isCollapsed && (
                <ul className="flex flex-col gap-1 pt-1 pl-[18px]">
                  {group.schedules.map((s) => (
                    <li key={s.id}>
                      <TaskListCell
                        schedule={s}
                        selected={s.id === selectedId}
                        unreadCount={unreadRunCounts.get(s.id) ?? 0}
                        totalMoney={
                          costSummariesLoaded
                            ? costSummaries.get(s.id)?.totalMoney
                            : undefined
                        }
                        totalEstimatedValueMoney={
                          costSummariesLoaded
                            ? costSummaries.get(s.id)?.totalEstimatedValueMoney
                            : undefined
                        }
                        hasUnavailableCost={
                          costSummariesLoaded
                            ? costSummaries.get(s.id)?.hasUnavailableCost
                            : undefined
                        }
                        onSelect={onSelect}
                        onTogglePause={onTogglePause}
                        onDelete={s.source === 'project' ? undefined : onDelete}
                        onRename={s.source === 'project' ? undefined : onRename}
                        onPromoteToProject={s.source === 'project' ? undefined : onPromoteToProject}
                        onEditProjectSchedule={
                          s.source === 'project' ? onEditProjectSchedule : undefined
                        }
                        onCloneToUser={s.source === 'project' ? onCloneToUser : undefined}
                        onRemoveProjectSchedule={
                          s.source === 'project' ? onRemoveProjectSchedule : undefined
                        }
                        onRunNow={onRunNow}
                        runBusy={runNowBusyIds?.has(s.id) ?? false}
                        waitingForResources={
                          waitingScheduleIds.has(s.id) && runtimeSnapshot
                            ? {
                                inFlight: runtimeSnapshot.inFlight,
                                maxConcurrentRuns: runtimeSnapshot.maxConcurrentRuns,
                              }
                            : undefined
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Resize handle — 4px hit-area，hover 出 1px Stone 高亮线（与主侧边栏同款）。
          aside 自身的 border-r 已提供常态 1px Board 分隔线，handle 仅在 hover 时叠一根更深的线
          来提示"可拖拽"。双击回默认宽度。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('scheduler.list.resizeAria')}
        className="group/handle absolute right-0 top-0 z-10 h-full w-[4px] cursor-col-resize"
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
      >
        <div className="absolute right-0 top-0 h-full w-px bg-transparent transition-colors group-hover/handle:bg-[var(--settings-section-desc)]" />
      </div>
    </aside>
  );
}

function useCollapsedProjects(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore quota / disabled storage */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

function normalizeScheduleWorkingDir(workingDir: string | null | undefined): string {
  const normalized = normalizeWorkingDir(workingDir);
  if (!normalized) return OTHER_GROUP_KEY;
  return window.electronAPI.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sortWithinGroup(items: Schedule[]): Schedule[] {
  return [...items].sort((a, b) => {
    const sourceA = a.source === 'project' ? 0 : 1;
    const sourceB = b.source === 'project' ? 0 : 1;
    if (sourceA !== sourceB) return sourceA - sourceB;
    const firedA = a.lastFiredAt ?? 0;
    const firedB = b.lastFiredAt ?? 0;
    if (firedA !== firedB) return firedB - firedA;
    return b.updatedAt - a.updatedAt;
  });
}

function lastPathSegment(input: string): string {
  return input.split(/[\\/]/).filter(Boolean).pop() ?? input;
}
