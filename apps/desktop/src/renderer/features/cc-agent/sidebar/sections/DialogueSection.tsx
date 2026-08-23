/**
 * DialogueSection — 不属于项目的对话段(**已退出展开态主列表**)。
 *
 * 侧边栏重设计 D 期(2026-08-12):旧裁决「对话是 Projects 的同级固定段、固定显示
 * 在 Projects 之后」已被有意推翻——展开态主列表改由 ProjectsSection 按
 * mainListModel 混排(项目行与散排对话按同一口径排序,「对话归为一组」为可选开关)。
 * 本组件当前仅存两个消费面:
 *   1. compareDialogueSessions / DialogueSortBy——折叠 rail 的对话面板仍用它排序;
 *   2. 组件本体暂保留给 rail 面板体系(railPanelStore)复用行渲染,不再直接出现在
 *      CCAgentSidebarUpper 的展开态 JSX 中。
 * 这些 session 可以有 workingDir, 但该目录只是对话运行/文件目录, 不作为项目分组。
 */

import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, SlidersHorizontal, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { sessionActivityMs } from '../../lib/dateSessionGrouping';
import { SectionCollapse } from '../SectionCollapse';
import { getDialogueCollapseLimit } from '../../lib/sidebarCollapseConfig';
import { SessionEntryList } from '../SessionEntryList';
import type { SessionClickHandler } from '../SessionItem';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import type { Session } from '@/lib/ccAgent.types';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from '../menuStyles';

export type DialogueSortBy = 'recency' | 'time' | 'title';

const DIALOGUE_SORT_OPTIONS: ReadonlyArray<{
  value: DialogueSortBy;
  labelKey: string;
}> = [
  { value: 'recency', labelKey: 'ccAgent.sidebar.dialogueSort.recency' },
  { value: 'time', labelKey: 'ccAgent.sidebar.dialogueSort.time' },
  { value: 'title', labelKey: 'ccAgent.sidebar.dialogueSort.title' },
];

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  // Pointer click focus must not pin these hover-only actions after the mouse leaves.
  // Keyboard focus-visible still reveals them for tab navigation.
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
);

const HEADER_ACTIONS_CLASS = cn('flex items-center gap-0.5 -mt-px', HEADER_HOVER_ACTION_CLASS);

export interface DialogueSectionProps {
  sessions: Session[];
  /** 首次载入会话列表时避免把暂时的空数组误报成真正空态。 */
  isLoading: boolean;
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
  onCreateDialogue: () => void;
  createDisabled?: boolean;
  /** 排序受控化:状态提升到 ExpandedView,折叠 rail 的对话面板与本段共用同一
   *  排序(否则折叠后面板前 N 条与展开态刚排好的顺序不一致,codex review)。 */
  sortBy: DialogueSortBy;
  onSortByChange: (value: DialogueSortBy) => void;
}

function statusRank(session: Session): number {
  if (session.status === 'active') return 0;
  if (session.status === 'archived') return 1;
  return 2;
}

/** 导出给折叠 rail 的对话面板共用:面板行序必须与展开态该排序完全一致(codex review)。 */
export function compareDialogueSessions(a: Session, b: Session, sortBy: DialogueSortBy): number {
  const status = statusRank(a) - statusRank(b);
  if (status !== 0) return status;
  if (sortBy === 'time') return sessionActivityMs(a) - sessionActivityMs(b);
  if (sortBy === 'title') {
    const title = a.title.localeCompare(b.title, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (title !== 0) return title;
  } else {
    const recency = sessionActivityMs(b) - sessionActivityMs(a);
    if (recency !== 0) return recency;
  }
  return a.id.localeCompare(b.id);
}

export function DialogueSection({
  sessions,
  isLoading,
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
  onCreateDialogue,
  createDisabled = false,
  sortBy,
  onSortByChange,
}: DialogueSectionProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  // 主列表显示形态(B 期):与项目段同一份设置。
  const { mode: mainViewMode } = useSidebarMainViewMode();
  const sortedSessions = useMemo(
    () => sessions.slice().sort((a, b) => compareDialogueSessions(a, b, sortBy)),
    [sessions, sortBy],
  );
  const sortByLabel = t(
    DIALOGUE_SORT_OPTIONS.find((option) => option.value === sortBy)?.labelKey ??
      'ccAgent.sidebar.dialogueSort.recency',
  );
  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const toggleLabel = collapsed
    ? t('ccAgent.sidebar.dialoguesToggleExpand')
    : t('ccAgent.sidebar.dialoguesToggleCollapse');

  return (
    <div className="flex flex-col gap-0.5 w-full">
      <div className="group/sidebar-header flex h-6 items-center justify-between pr-0 pl-6">
        <div className="flex min-w-0 items-center gap-1">
          {/* 段标题:淡灰 + 可点击收起/展开(与 ProjectsSection 同款,2026-07 用户定稿)。 */}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            className="text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
          >
            {t('ccAgent.sidebar.dialogues')}
          </button>
          <div className={HEADER_HOVER_ACTION_CLASS}>
            <Tip text={toggleLabel} side="bottom">
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  // 无灰底 hover(2026-07 用户定稿):纯色加深反馈,与段标题一致。
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <ToggleIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
        <div className={HEADER_ACTIONS_CLASS}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tip text={t('ccAgent.sidebar.dialogueSettings')} side="bottom">
                <button
                  type="button"
                  aria-label={t('ccAgent.sidebar.dialogueSettingsAria', { sortBy: sortByLabel })}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md',
                    'text-[var(--sidebar-list-muted)]',
                    'transition-colors hover:text-[var(--sidebar-nav-text)]',
                  )}
                >
                  <SlidersHorizontal size={14} strokeWidth={2} />
                </button>
              </Tip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="start"
              sideOffset={8}
              className={cn(MENU_CONTENT_CLASS, 'w-[196px]')}
            >
              <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
                {t('ccAgent.sidebar.dialogueSettings')}
              </div>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
                  <span className="truncate">{t('ccAgent.sidebar.dialogueSortHeading')}</span>
                  <span className="ml-auto max-w-[80px] truncate text-right text-[var(--cmd-palette-item-meta)]">
                    {sortByLabel}
                  </span>
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-[var(--cmd-palette-item-meta)]"
                  />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  sideOffset={8}
                  className={cn(MENU_SUB_CONTENT_CLASS, 'w-[180px]')}
                >
                  {DIALOGUE_SORT_OPTIONS.map((option) => (
                    <DropdownMenuItem
                      key={option.value}
                      onSelect={() => onSortByChange(option.value)}
                      className={MENU_ITEM_CLASS}
                    >
                      <span className="truncate">{t(option.labelKey)}</span>
                      {sortBy === option.value && (
                        <Check
                          size={15}
                          className="ml-auto shrink-0 text-[var(--msg-assistant-text)]"
                        />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tip text={t('ccAgent.sidebar.newDialogue')} side="bottom">
            <button
              type="button"
              onClick={onCreateDialogue}
              disabled={createDisabled}
              aria-label={t('ccAgent.sidebar.newDialogue')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md',
                'text-[var(--text-tertiary)]',
                'transition-colors hover:text-[var(--text-secondary)]',
              )}
            >
              <SquarePen size={14} strokeWidth={2} />
            </button>
          </Tip>
        </div>
      </div>
      {/* 段级收起走 SectionCollapse 高度动画；「显示全部」在收起动画结束后复位。 */}
      <SectionCollapse collapsed={collapsed}>
        <div className="flex flex-col gap-0.5 pt-1 pr-0 pl-3">
          <SessionEntryList
            sessions={sortedSessions}
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
            collapsible
            collapseLimit={getDialogueCollapseLimit()}
            sectionCollapsed={collapsed}
            sessionVariant={mainViewMode === 'list' ? 'list' : 'text'}
          />
          {sortedSessions.length === 0 && (
            <div className="flex h-7 items-center rounded-full px-3 text-xs text-sidebar-muted">
              {t(isLoading ? 'ccAgent.sidebar.loadingDialogues' : 'ccAgent.sidebar.noDialogues')}
            </div>
          )}
        </div>
      </SectionCollapse>
    </div>
  );
}
