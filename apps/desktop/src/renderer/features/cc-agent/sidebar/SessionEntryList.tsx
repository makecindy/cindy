import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
  groupSessionFamilySidebarEntries,
  type SessionFamilyNode,
} from '../lib/automationSidebarGrouping';
import { getSessionListCollapseView } from '../lib/sessionListCollapse';
import { AutomationSessionGroupItem } from './AutomationSessionGroupItem';
import { SessionItem } from './SessionItem';
import type { SessionClickHandler } from './SessionItem';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from './sessionMoveTarget';
import { useCollapsibleShowAll } from './hooks/useCollapsibleShowAll';
import { SessionCard } from './SessionCard';
import { Tip } from '@/components/ui/tooltip';

/** 条目是否为当前激活会话(group 命中其下任一会话)。 */
function entryIsActive(entry: SidebarSessionEntry, activeSessionId?: string): boolean {
  if (!activeSessionId) return false;
  if (entry.kind === 'session') return entry.session.id === activeSessionId;
  if (entry.kind === 'session-family') {
    return entry.family.sessions.some((session) => session.id === activeSessionId);
  }
  return entry.group.sessions.some((s) => s.id === activeSessionId);
}
/** 条目是否需关注(group 命中其下任一会话)。 */
function entryHasAttention(
  entry: SidebarSessionEntry,
  notifications: ReadonlySet<string>,
): boolean {
  if (entry.kind === 'session') return notifications.has(entry.session.id);
  if (entry.kind === 'session-family') {
    return entry.family.sessions.some((session) => notifications.has(session.id));
  }
  return entry.group.sessions.some((s) => notifications.has(s.id));
}

export interface SessionEntryListProps {
  sessions: readonly Session[];
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
  indented?: boolean;
  matchMap?: ReadonlyMap<string, readonly number[]>;
  /**
   * 会话行 hover 时右侧展示的"项目来源"标签映射(sessionId → displayName/"对话")。
   * 仅时间排序视图会注入;项目分组下不传(项目名已由 ProjectNode 表头承载)。
   */
  sourceLabelMap?: ReadonlyMap<string, string>;
  /** 启用「最多显示 N 条 + 显示全部」折叠(保留需关注 / 当前会话)。不传则全量渲染。 */
  collapsible?: boolean;
  /** collapsible 时的显示上限(由调用方按场景给:对话段 / 项目内会话各自不同)。 */
  collapseLimit?: number;
  /** collapsible 时临时禁用(如按内容搜索/筛选中,应展开全部命中)。 */
  disableCollapse?: boolean;
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

interface SessionFamilyBranchProps {
  node: SessionFamilyNode;
  depth: number;
  rowProps: SessionEntryRowsProps;
  isFirst: boolean;
}

/**
 * 任务 family 的递归渲染节点。折叠按钮位于任务行外，不进入 SessionItem/SessionCard
 * 的原生拖拽热区，因此不会抢占置顶排序或分屏拖拽手势。
 */
function SessionFamilyBranch({ node, depth, rowProps, isFirst }: SessionFamilyBranchProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const { session } = node;
  const hasChildren = node.children.length > 0;
  const toggleLabel = collapsed
    ? t('ccAgent.sidebar.sessionFamily.expand')
    : t('ccAgent.sidebar.sessionFamily.collapse');
  const commonProps = {
    session,
    isActive: session.id === rowProps.activeSessionId,
    isRunning: rowProps.runningSessionIds.has(session.id),
    isAttached: rowProps.attachedSessionIds.has(session.id),
    hasAttentionNotification: rowProps.notifications.has(session.id),
    isSelected: rowProps.selectedSessionIds?.has(session.id) ?? false,
    onClick: rowProps.onSessionClick,
    onAction: rowProps.onAction,
    onRename: rowProps.onRename,
    onTogglePin: rowProps.onTogglePin,
    onMoveSession: rowProps.onMoveSession,
    projectOptions: rowProps.projectOptions,
    indented: rowProps.indented,
    matchIndices: rowProps.matchMap?.get(session.id),
    sourceLabel: rowProps.sourceLabelMap?.get(session.id),
  };

  return (
    <div role="group" aria-label={hasChildren ? toggleLabel : undefined}>
      <div className="flex min-w-0 items-start" style={{ paddingLeft: `${depth * 14}px` }}>
        <span className="flex h-8 w-4 shrink-0 items-center justify-center">
          {hasChildren ? (
            <Tip text={toggleLabel} side="bottom">
              <button
                type="button"
                data-no-drag
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
                className={cn(
                  'flex size-4 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                {collapsed ? (
                  <ChevronRight size={12} strokeWidth={2} />
                ) : (
                  <ChevronDown size={12} strokeWidth={2} />
                )}
              </button>
            </Tip>
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          {rowProps.sessionVariant === 'list' ? (
            <SessionCard
              {...commonProps}
              variant="list"
              isFirst={rowProps.showFirstDivider && isFirst}
            />
          ) : (
            <SessionItem {...commonProps} />
          )}
        </div>
      </div>
      {!collapsed &&
        node.children.map((child) => (
          <SessionFamilyBranch
            key={child.session.id}
            node={child}
            depth={depth + 1}
            rowProps={rowProps}
            isFirst={false}
          />
        ))}
    </div>
  );
}

export function SessionEntryRows({
  entries,
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
  indented = false,
  matchMap,
  sourceLabelMap,
  sessionVariant = 'text',
  showFirstDivider = true,
  automationGroupCollapsed,
  onAutomationGroupCollapsedChange,
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
            indented,
            matchIndices: matchMap?.get(entry.session.id),
          };

          return sessionVariant === 'list' ? (
            <SessionCard
              key={entry.session.id}
              {...commonProps}
              variant="list"
              isFirst={showFirstDivider && index === 0}
              hideBottomDivider={nextHighlighted}
              sourceLabel={sourceLabelMap?.get(entry.session.id)}
            />
          ) : (
            <SessionItem
              key={entry.session.id}
              {...commonProps}
              sourceLabel={sourceLabelMap?.get(entry.session.id)}
            />
          );
        }

        if (entry.kind === 'session-family') {
          return (
            <SessionFamilyBranch
              key={entry.family.id}
              node={entry.family.root}
              depth={0}
              rowProps={{
                entries,
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
                indented,
                matchMap,
                sourceLabelMap,
                sessionVariant,
                showFirstDivider,
                automationGroupCollapsed,
                onAutomationGroupCollapsedChange,
              }}
              isFirst={index === 0}
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
            onCollapsedChange={
              onAutomationGroupCollapsedChange
                ? (collapsed) => onAutomationGroupCollapsedChange(entry.group.id, collapsed)
                : undefined
            }
            indented={indented}
            matchMap={matchMap}
            sourceLabelMap={sourceLabelMap}
            sessionVariant={sessionVariant}
          />
        );
      })}
    </>
  );
}

export function SessionEntryList({
  sessions,
  notifications,
  scheduleSessionIndex,
  collapsible = false,
  collapseLimit,
  disableCollapse = false,
  sectionCollapsed = false,
  ...props
}: SessionEntryListProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useCollapsibleShowAll(sectionCollapsed);
  const entries = useMemo(
    () =>
      groupSessionFamilySidebarEntries(
        groupAutomationSidebarEntries(sessions, { notifications, scheduleSessionIndex }),
      ),
    [notifications, scheduleSessionIndex, sessions],
  );

  if (!collapsible) {
    return <SessionEntryRows entries={entries} notifications={notifications} {...props} />;
  }

  // 对话段与项目内会话共用这套折叠:默认前 N 条 + 永远保留 24h 内活动 /
  // 需关注 / 当前打开的会话;超出收起,底部「显示全部 N 个」一次展开。
  const { visibleEntries, isOverflowing, totalCount } = getSessionListCollapseView({
    entries,
    minVisibleCount: collapseLimit,
    showAll,
    disableCollapse,
    isFiltering: false,
    nowMs: Date.now(),
    getActivityMs: getEntryActivityMs,
    isActiveEntry: (entry) => entryIsActive(entry, props.activeSessionId),
    hasAttentionEntry: (entry) => entryHasAttention(entry, notifications),
  });

  return (
    <>
      <SessionEntryRows entries={visibleEntries} notifications={notifications} {...props} />
      {isOverflowing && (
        <button
          type="button"
          className={cn(
            'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
            'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
          )}
          onClick={() => setShowAll(true)}
        >
          {t('ccAgent.sidebar.showAllSessions', { count: totalCount })}
        </button>
      )}
    </>
  );
}
