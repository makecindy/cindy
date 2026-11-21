import { useMemo } from 'react';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
  SidebarSessionEntry,
} from '../lib/automationSidebarGrouping';
import {
  getEntryActivityMs,
  groupAutomationSidebarEntries,
} from '../lib/automationSidebarGrouping';
import { getSidebarSessionCollapseView } from '../lib/sessionListCollapse';
import { useSidebarActivityNow, useSidebarIdleCollapse } from './SidebarActivityClock';
import { AutomationSessionGroupItem } from './AutomationSessionGroupItem';
import { SessionItem } from './SessionItem';
import type { SessionClickHandler } from './SessionItem';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from './sessionMoveTarget';
import { useCollapsibleShowAll } from './hooks/useCollapsibleShowAll';
import { SessionCard } from './SessionCard';
import { sessionRowKey } from './sessionRowKey';

/** 条目是否为当前激活会话(group 命中其下任一会话)。 */
function entryIsActive(entry: SidebarSessionEntry, activeSessionId?: string): boolean {
  if (!activeSessionId) return false;
  if (entry.kind === 'session') return entry.session.id === activeSessionId;
  return entry.group.sessions.some((s) => s.id === activeSessionId);
}
/** 条目是否需关注(group 命中其下任一会话)。 */
function entryHasAttention(
  entry: SidebarSessionEntry,
  notifications: ReadonlySet<string>,
): boolean {
  if (entry.kind === 'session') return notifications.has(entry.session.id);
  return entry.group.sessions.some((s) => notifications.has(s.id));
}

export interface SessionEntryListProps {
  sessions: readonly Session[];
  inboxMode?: boolean;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'complete' | 'unarchive') => void | 'marked-read' | Promise<void | 'marked-read'>;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  matchMap?: ReadonlyMap<string, readonly number[]>;
  /**
   * 会话行 hover 时右侧展示的"项目来源"标签映射(sessionId → displayName/"对话")。
   * 仅时间排序视图会注入;项目分组下不传(项目名已由 ProjectNode 表头承载)。
   */
  sourceLabelMap?: ReadonlyMap<string, string>;
  /** 启用闲置折叠（保留需关注、运行中、置顶与当前会话）。不传则全量渲染。 */
  collapsible?: boolean;
  /** 默认模式保留在收起视图中的最少条目数。 */
  collapseLimit?: number;
  /** 带标题操作的分组受控展开，底部只保留快捷展开入口。 */
  showAll?: boolean;
  onShowAllChange?: (showAll: boolean) => void;
  /** collapsible 时临时禁用(如按内容搜索/筛选中,应展开全部命中)。 */
  disableCollapse?: boolean;
  /**
   * 折叠豁免的追加会话集合(只影响折叠,不影响行内视觉)。基础豁免 =
   * notifications ∪ runningSessionIds;展开态父层用它并入 device-link 远程
   * 活动镜像(远程 running/未读不在上面两个本地集合里),保证上层聚合灯
   * 点亮的会话不被折进「显示全部」。
   */
  foldExemptSessionIds?: ReadonlySet<string>;
  /** 父级 SectionCollapse 的折叠态;用于收起动画结束后复位「显示全部」。 */
  sectionCollapsed?: boolean;
  /** 项目置顶到列表模式时，项目内会话复用满宽列表卡片；其它场景保持紧凑文字行。 */
  sessionVariant?: 'text' | 'list';
  /**
   * list 变体的分割线规则是「每行画底线 + 列表首行补顶线」。混排主列表把**每条**
   * 散排对话各渲染成一个独立的 SessionEntryList,每个都自认首行 → 上一行底线 +
   * 本行顶线叠成两根(2026-08-12 实机反馈)。这种「本列表只是长列表中的一段」的
   * 场景传 false 关掉顶线;真正的列表首行(置顶段 / 项目内会话)保持默认。
   */
  showFirstDivider?: boolean;
}

export interface SessionEntryRowsProps extends Omit<
  SessionEntryListProps,
  'sessions' | 'scheduleSessionIndex' | 'sectionCollapsed'
> {
  entries: readonly SidebarSessionEntry[];
  automationGroupCollapsed?: (groupKey: string) => boolean;
  onAutomationGroupCollapsedChange?: (groupKey: string, collapsed: boolean) => void;
}

export function SessionEntryRows({
  entries,
  inboxMode = false,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  matchMap,
  sourceLabelMap,
  sessionVariant = 'text',
  showFirstDivider = true,
  automationGroupCollapsed,
  onAutomationGroupCollapsedChange,
  foldExemptSessionIds,
}: SessionEntryRowsProps) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'session') {
          const nextEntry = entries[index + 1];
          const nextHighlighted =
            nextEntry?.kind === 'session' &&
            (nextEntry.session.id === activeSessionId ||
              (selectedSessionIds?.has(nextEntry.session.id) ?? false));
          const commonProps = {
            session: entry.session,
            inboxMode,
            isActive: entry.session.id === activeSessionId,
            isRunning: runningSessionIds.has(entry.session.id),
            isAttached: attachedSessionIds.has(entry.session.id),
            hasAttentionNotification: notifications.has(entry.session.id),
            isSelected: selectedSessionIds?.has(entry.session.id) ?? false,
            onClick: onSessionClick,
            onAction,
            onRename,
            onTogglePin,
            onMoveSession,
            projectOptions,
            matchIndices: matchMap?.get(entry.session.id),
          };

          return sessionVariant === 'list' ? (
            <SessionCard
              key={sessionRowKey(entry.session)}
              {...commonProps}
              variant="list"
              isFirst={showFirstDivider && index === 0}
              hideBottomDivider={nextHighlighted}
              sourceLabel={sourceLabelMap?.get(entry.session.id)}
            />
          ) : (
            <SessionItem
              key={sessionRowKey(entry.session)}
              {...commonProps}
              sourceLabel={sourceLabelMap?.get(entry.session.id)}
            />
          );
        }

        return (
          <AutomationSessionGroupItem
            key={entry.group.id}
            group={entry.group}
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
            collapsed={automationGroupCollapsed?.(entry.group.id)}
            foldExemptSessionIds={foldExemptSessionIds}
            onCollapsedChange={
              onAutomationGroupCollapsedChange
                ? (collapsed) => onAutomationGroupCollapsedChange(entry.group.id, collapsed)
                : undefined
            }
            matchMap={matchMap}
            sourceLabelMap={sourceLabelMap}
            sessionVariant={sessionVariant}
          />
        );
      })}
    </>
  );
}

type SessionEntryListViewInput = Pick<
  SessionEntryListProps,
  'sessions' | 'activeSessionId' | 'runningSessionIds' | 'notifications' |
  'scheduleSessionIndex' | 'collapsible' | 'collapseLimit' | 'disableCollapse' | 'foldExemptSessionIds'
>;

/** Share the folded result between a group's title action and its task list. */
export function useSessionEntryListView({
  sessions,
  activeSessionId,
  runningSessionIds,
  notifications,
  scheduleSessionIndex,
  collapsible = false,
  collapseLimit,
  disableCollapse = false,
  foldExemptSessionIds,
}: SessionEntryListViewInput) {
  const nowMs = useSidebarActivityNow();
  const { idleCollapseEnabled } = useSidebarIdleCollapse();
  const entries = useMemo(
    () => groupAutomationSidebarEntries(sessions, { notifications, scheduleSessionIndex }),
    [notifications, scheduleSessionIndex, sessions],
  );

  // 默认保留前 N 条；开启闲置折叠后按活动时间收起，需关注等任务继续保留。
  // running 豁免与上层聚合灯同口径(Greptile P1):项目行/设备段头的呼吸灯为
  // running 会话点亮,该会话就不能折进「显示全部」——灯亮进去必须找得到行。
  // foldExemptSessionIds 供父层追加口径(如展开态并入 device-link 远程镜像)。
  const folded = useMemo(
    () => getSidebarSessionCollapseView({
      entries,
      minVisibleCount: collapseLimit,
      showAll: false,
      disableCollapse: disableCollapse || !collapsible,
      isFiltering: false,
      nowMs,
      idleCollapseEnabled,
      getActivityMs: getEntryActivityMs,
      isActiveEntry: (entry) => entryIsActive(entry, activeSessionId),
      hasAttentionEntry: (entry) =>
        entryHasAttention(entry, notifications) ||
        entryHasAttention(entry, runningSessionIds) ||
        (entry.kind === 'session' ? !!entry.session.pinnedAt : entry.group.sessions.some((s) => !!s.pinnedAt)) ||
        (foldExemptSessionIds != null && entryHasAttention(entry, foldExemptSessionIds)),
    }),
    [entries, collapseLimit, disableCollapse, collapsible, nowMs, idleCollapseEnabled,
      activeSessionId, notifications, runningSessionIds, foldExemptSessionIds],
  );
  return { entries, folded, canToggleIdle: idleCollapseEnabled && folded.isOverflowing };
}

export function SessionEntryList(props: SessionEntryListProps) {
  const view = useSessionEntryListView(props);
  const { sessions, scheduleSessionIndex, collapsible, collapseLimit, disableCollapse, ...contentProps } = props;
  return <SessionEntryListContent {...contentProps} view={view} />;
}

export function SessionEntryListContent({
  view,
  showAll: controlledShowAll,
  onShowAllChange,
  sectionCollapsed = false,
  ...props
}: Omit<SessionEntryListProps, 'sessions' | 'scheduleSessionIndex' | 'collapsible' | 'collapseLimit' | 'disableCollapse'> & {
  view: ReturnType<typeof useSessionEntryListView>;
}) {
  const { t } = useTranslation();
  const [localShowAll, setLocalShowAll] = useCollapsibleShowAll(sectionCollapsed);
  const showAll = controlledShowAll ?? localShowAll;
  const setShowAll = onShowAllChange ?? setLocalShowAll;
  const { visibleEntries, isOverflowing, hiddenCount } = view.folded;

  // 有标题按钮的分组即使没有可见任务，也可以从标题展开。
  const hasHeaderToggle = view.canToggleIdle && controlledShowAll !== undefined;
  const showFooter = showAll
    ? view.canToggleIdle && !hasHeaderToggle
    : isOverflowing && (!hasHeaderToggle || visibleEntries.length > 0);

  return (
    <>
      <SessionEntryRows
        entries={showAll ? view.entries : visibleEntries}
        {...props}
      />
      {showFooter && (
        <button
          type="button"
          className={cn(
            'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
            'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
          )}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? t('ccAgent.sidebar.collapseInactiveSessions')
            : t('ccAgent.sidebar.showMoreSessions', { count: hiddenCount })}
        </button>
      )}
    </>
  );
}
