/**
 * InProgressSection — 置顶段下方的「进行中」段
 * ---------------------------------------------------------------------------
 * 把各项目 / 对话里等你处理、完成未读、运行中的任务提到这里(成员与顺序见
 * lib/inProgressSessions),一个项目任务很多时,其它项目正在进行的任务不会被挤出视野。
 * 这些任务在此期间从原项目里移出,不重复显示;看完离开后回到原项目。
 *
 * 段头与置顶段同款:文字标题 + hover 浮现的折叠箭头,折叠态按本机记住。
 * 列表复用 SessionEntryList,跟随主列表的显示形态(文字 / 列表),行尾带项目来源
 * 标签;不做「最多 N 条」折叠,也不把同一定时任务的多次运行收成组头——进行中的
 * 任务都需要直接看得见。
 *
 * 受控组件——sessions 为空时返回 null(不渲染段)。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import type { Session } from '@/lib/ccAgent.types';
import {
  getRemoteSessionActivity,
  isRemoteSessionActivityActive,
  subscribeRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { absorbSessionStarting } from '@/lib/sessionStartingStore';
import { SectionCollapse } from '../SectionCollapse';
import { SessionEntryList, type SessionEntryListProps } from '../SessionEntryList';
import type { ProjectNode as ProjectNodeData } from '../../lib/projectGrouping';
import { buildSessionSourceLabelMap } from '../../lib/sessionSourceLabel';
import {
  loadInProgressSectionCollapsed,
  persistInProgressSectionCollapsed,
} from '../../hooks/helpers/sidebarFilterCore';

/** 空索引 = 不做定时任务分组,每次运行各占一行。 */
const NO_AUTOMATION_GROUPING: SessionEntryListProps['scheduleSessionIndex'] = new Map();

const FOCUS_RING_CLASS =
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]';

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
);

export interface InProgressSectionProps
  extends Omit<
    SessionEntryListProps,
    'sessions' | 'sourceLabelMap' | 'sessionVariant' | 'sectionCollapsed' | 'scheduleSessionIndex'
  > {
  sessions: readonly Session[];
  /** 已知项目全集,用于行尾的项目来源标签。 */
  allKnownProjects: readonly ProjectNodeData[];
}

export function InProgressSection({
  sessions,
  allKnownProjects,
  ...listProps
}: InProgressSectionProps) {
  const { t } = useTranslation();
  const { mode: mainViewMode } = useSidebarMainViewMode();
  const [collapsed, setCollapsed] = useState(loadInProgressSectionCollapsed);
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    persistInProgressSectionCollapsed(next);
  }, [collapsed]);

  // 本段的行不在 ProjectsSection 里,它的 starting 收口覆盖不到;与置顶段同口径
  // 只收口正在推送的远程活动,重渲染不翻旧的等待态。
  useEffect(
    () =>
      subscribeRemoteSessionActivity((deviceId, sessionId) => {
        if (!deviceId || !sessionId || getSessionDeviceId(sessionId) !== deviceId) return;
        if (
          !sessions.some(
            (session) => session.id === sessionId && session.deviceLinkDeviceId === deviceId,
          )
        )
          return;
        if (isRemoteSessionActivityActive(getRemoteSessionActivity(sessionId, deviceId))) {
          absorbSessionStarting([sessionId]);
        }
      }),
    [sessions],
  );

  const sourceLabelMap = useMemo(
    () =>
      buildSessionSourceLabelMap(
        sessions,
        allKnownProjects,
        t('ccAgent.sidebar.dialogues'),
        t('settings.cindyMake.title'),
      ),
    [sessions, allKnownProjects, t],
  );

  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const toggleLabel = collapsed
    ? t('ccAgent.sidebar.inProgressToggleExpand')
    : t('ccAgent.sidebar.inProgressToggleCollapse');

  if (sessions.length === 0) return null;

  return (
    <div className="flex w-full flex-col select-none">
      <div className="group/sidebar-header flex h-6 items-center pr-3 pl-6">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            className={cn(
              'rounded-md text-sm leading-5 font-medium text-[var(--sidebar-list-muted)]',
              'transition-colors hover:text-[var(--sidebar-nav-text)]',
              FOCUS_RING_CLASS,
            )}
          >
            {t('ccAgent.sidebar.inProgress')}
          </button>
          <div className={cn(HEADER_HOVER_ACTION_CLASS, 'flex items-center gap-0.5')}>
            <Tip text={toggleLabel} side="bottom">
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                  FOCUS_RING_CLASS,
                )}
              >
                <ToggleIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
      </div>
      <SectionCollapse collapsed={collapsed}>
        <div className="flex flex-col gap-0.5 pt-1 pr-0 pl-3">
          <SessionEntryList
            {...listProps}
            sessions={sessions}
            scheduleSessionIndex={NO_AUTOMATION_GROUPING}
            sourceLabelMap={sourceLabelMap}
            sectionCollapsed={collapsed}
            sessionVariant={mainViewMode === 'list' ? 'list' : 'text'}
          />
        </div>
      </SectionCollapse>
    </div>
  );
}
