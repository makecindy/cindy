import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { SessionEntryList } from '../SessionEntryList';
import type { SessionClickHandler } from '../SessionItem';
import { SidebarFilterPopover } from '../SidebarFilterPopover';
import { MACHINE_ALL } from '@/features/device-link/selectedMachineStore';
import { useMachineSwitcher } from '@/features/device-link/useMachineSwitcher';
import { groupSessionsByActivityDate, type DateSessionGroup } from '../../lib/dateSessionGrouping';
import { type ProjectNode as ProjectNodeData } from '../../lib/projectGrouping';
import { buildSessionSourceLabelMap } from '../../lib/sessionSourceLabel';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import type { Session } from '@/lib/ccAgent.types';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';

/**
 * 段头 action 默认隐藏、hover 段头(group/sidebar-header)或键盘聚焦时才浮现——
 * 与 ProjectsSection 的 HEADER_HOVER_ACTION_CLASS 同款,让「按时间分组」视图的
 * 「整理侧边栏」(SidebarFilterPopover)等 action 默认收起、保持段头干净。
 */
const HEADER_HOVER_ACTION_CLASS =
  'pointer-events-none opacity-0 transition-opacity duration-150 ' +
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100 ' +
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 ' +
  // 段头内菜单展开时(trigger 带 data-state=open)保持可见,移进展开菜单不致其它按钮消失。
  'group-has-[[data-state=open]]/sidebar-header:pointer-events-auto group-has-[[data-state=open]]/sidebar-header:opacity-100';

export interface DateGroupedSessionsSectionProps {
  sessions: Session[];
  /** 首次载入会话列表时避免把暂时的空数组误报成真正空态。 */
  isLoading: boolean;
  allKnownProjects: ProjectNodeData[];
  filter: UseSidebarFilterReturn;
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
}

function formatDateGroupLabel(
  group: DateSessionGroup,
  t: TFunction,
  formatter: Intl.DateTimeFormat,
): string {
  if (group.kind === 'today') return t('ccAgent.sidebar.dateGroup.today');
  if (group.kind === 'yesterday') return t('ccAgent.sidebar.dateGroup.yesterday');
  if (group.kind === 'older') return t('ccAgent.sidebar.dateGroup.older');
  return group.date ? formatter.format(group.date) : group.dayKey;
}

export function DateGroupedSessionsSection({
  sessions,
  isLoading,
  allKnownProjects,
  filter,
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
}: DateGroupedSessionsSectionProps) {
  const { t, i18n } = useTranslation();
  // 机器过滤态:选中非「所有」的远程机器时,即便当前机器 0 会话导致 groups 为空,也保留
  // 空态段头(「空」标签 + filter 入口),让用户看得出是过滤导致的空列表而非白屏。机器切换
  // 入口本身已移到侧栏顶部固定行(CCAgentSidebarUpper),不再依赖本段头。机器选择不在
  // filter.isFilterActive 里(它在 CCAgentSidebarUpper 合并点先于本组件过滤 sessions),
  // 故需单独判定(Codex P2)。
  const { selectedDeviceId, hasRemote } = useMachineSwitcher();
  const machineFilterActive = hasRemote && selectedDeviceId !== MACHINE_ALL;
  const groups = useMemo(
    () => groupSessionsByActivityDate(sessions, new Date(), filter.sortBy),
    [sessions, filter.sortBy],
  );
  // hover 项目来源标签映射(口径见 buildSessionSourceLabelMap):时间视图传全量 sessions。
  const sourceLabelMap = useMemo(
    () => buildSessionSourceLabelMap(sessions, allKnownProjects, t('ccAgent.sidebar.dialogues')),
    [sessions, allKnownProjects, t],
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }),
    [i18n.language],
  );

  if (groups.length === 0 && !isLoading && !filter.isFilterActive && !machineFilterActive) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {groups.length === 0 ? (
        <div className="group/sidebar-header flex h-6 select-none items-center justify-between pr-0 pl-6">
          <span className="text-sm font-semibold text-[var(--cmd-palette-item-meta)]">
            {t(
              isLoading
                ? 'ccAgent.sidebar.loadingDialogues'
                : 'ccAgent.sidebar.dateGroup.empty',
            )}
          </span>
          <div className="-mt-px flex items-center gap-0.5">
            <div className={HEADER_HOVER_ACTION_CLASS}>
              <SidebarFilterPopover filter={filter} allKnownProjects={allKnownProjects} />
            </div>
          </div>
        </div>
      ) : (
        groups.map((group, index) => (
          <div
            key={group.kind === 'date' ? group.dayKey : group.kind}
            className="flex w-full flex-col gap-0.5"
          >
            <div className="group/sidebar-header flex h-6 select-none items-center justify-between pr-0 pl-6">
              <span className="text-sm font-semibold text-[var(--cmd-palette-item-meta)]">
                {formatDateGroupLabel(group, t, dateFormatter)}
              </span>
              {index === 0 && (
                <div className="-mt-px flex items-center gap-0.5">
                  <div className={HEADER_HOVER_ACTION_CLASS}>
                    <SidebarFilterPopover filter={filter} allKnownProjects={allKnownProjects} />
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-0.5 pt-1 pr-0 pl-3">
              <SessionEntryList
                sessions={group.sessions}
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
                sourceLabelMap={sourceLabelMap}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
