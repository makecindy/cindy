/**
 * PinnedSection — Sidebar 顶部的 Pinned 段
 * ---------------------------------------------------------------------------
 * 顶部 Pinned 段视觉规格：
 *   - Section 容器：vertical layout, gap 2
 *   - Section Title：padding [0, 12, 0, 24], height 24
 *   - Title 文字："Pinned" Inter 14 / 600，#262626 (Light) / #f5f0e8 (Dark)
 *     （2026-04-20 修订对齐设计稿；prod_spec F-PJ-3 已同步回写）
 *   - Pinned Items 容器：padding [4, 12, 0, 12], gap 2
 *
 * 段标题右侧的 chevron（hover 时浮现）折叠/展开整段，与 DialogueSection 同款。
 * 段头另带"显示样式"弹层（ViewStyleMenu，文字版 / 卡片版）：卡片模式下挂在
 * 图钉 icon 上，列表模式下挂在 hover 浮现的 LayoutGrid 钮上——双向均可一键
 * 切换 sidebar.cardMode，与 Settings → 外观 的开关同源。
 * 置顶**不做"最多显示 N 条"折叠**——置顶是用户主动钉住的内容,三种模式都全部显示。
 *
 * 拖拽：文字 / list 模式通过 SortableList 整行可拖；card 模式由 CardMasonry 在多列时
 *   切到 DraggableCardColumns。落定后都通过父层注入的 `onReorder(newOrderIds)`
 *   回调写回 manualPinnedOrder。
 *
 * 受控组件——entries 为空时返回 null（不渲染段）。
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  AlignJustify,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  LayoutList,
  Check,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { SortableList } from '@/components/sidebar/SortableList';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useSidebarCardMode, type SidebarViewMode } from '@/hooks/useSidebarCardMode';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from '../menuStyles';
import { SectionCollapse } from '../SectionCollapse';
import { CardMasonry } from '../CardMasonry';
import { SessionItem } from '../SessionItem';
import type { SessionClickHandler } from '../SessionItem';
import { SessionCard } from '../SessionCard';
import type { ProjectNode as ProjectNodeData } from '../../lib/projectGrouping';
import { buildSessionSourceLabelMap } from '../../lib/sessionSourceLabel';
import type { Session } from '@/lib/ccAgent.types';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  // 鼠标点击触发的焦点不应在鼠标离开后仍然亮着 chevron；只有键盘 focus-visible 才常驻。
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  // 显示样式菜单打开期间鼠标可能移进 portal 里的菜单（离开 header），触发钮保持可见。
  'has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100',
);

/**
 * 每种模式配一个直观图标:文字=密排文本行(AlignJustify)、卡片=网格(LayoutGrid)、
 * 列表=带内容块的行(LayoutList)。三者视觉区分明显,一眼能对上。
 * 模块级常量:菜单项与段头 trigger 共用同一张表——trigger 显示**当前选中模式**的
 * 图标(2026-08-12 用户裁决,此前恒为 LayoutGrid,与实际选中项不符)。
 * 整理菜单(SidebarFilterPopover)的主列表显示模式复用同一套 text / list 字形。
 */
const VIEW_STYLE_OPTIONS: ReadonlyArray<{
  value: SidebarViewMode;
  labelKey: string;
  Icon: LucideIcon;
}> = [
  { value: 'text', labelKey: 'ccAgent.sidebar.viewStyleList', Icon: AlignJustify },
  { value: 'card', labelKey: 'ccAgent.sidebar.viewStyleCard', Icon: LayoutGrid },
  { value: 'list', labelKey: 'ccAgent.sidebar.viewStyleListWide', Icon: LayoutList },
];

/** 当前显示模式对应的图标(供段头 trigger 用);未知值兜底到文字版字形。 */
function viewStyleIcon(mode: SidebarViewMode): LucideIcon {
  return VIEW_STYLE_OPTIONS.find((opt) => opt.value === mode)?.Icon ?? AlignJustify;
}

/**
 * ViewStyleMenu — Pinned 段头的"显示样式"切换弹层(文字版 / 卡片版 / 列表)。
 * trigger 由调用方提供(段头右侧 hover 出现、图标随当前模式变化),菜单写回全局
 * sidebar 显示模式(useSidebarCardMode 的 mode),与 Settings → 外观 同源。
 */
function ViewStyleMenu({
  mode,
  setMode,
  children,
}: {
  mode: SidebarViewMode;
  setMode: (next: SidebarViewMode) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const OPTIONS = VIEW_STYLE_OPTIONS;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        className={cn(MENU_CONTENT_CLASS, 'min-w-[128px]')}
      >
        {OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onSelect={() => setMode(opt.value)}
            className={MENU_ITEM_CLASS}
          >
            <opt.Icon
              size={15}
              strokeWidth={1.75}
              className="shrink-0 text-[var(--cmd-palette-item-meta)]"
            />
            <span className="truncate">{t(opt.labelKey)}</span>
            {mode === opt.value && <Check size={15} className="ml-auto shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type PinnedSidebarEntry =
  | { kind: 'session'; id: string; session: Session }
  | {
      kind: 'project';
      id: string;
      project: ProjectNodeData;
      displaySessions: ProjectNodeData['sessions'];
    };

export interface PinnedSectionProps {
  /** 已按筛选和持久化顺序排好的置顶对话与项目。 */
  entries: PinnedSidebarEntry[];
  /**
   * 已知项目全集,用于把 pinned session 映射到项目 displayName(与
   * ProjectNode 表头同口径消歧)。文字 / 列表模式画在标题旁;卡片模式不消费。
   */
  allKnownProjects: readonly ProjectNodeData[];
  /** 复用 ProjectNode 渲染项目，确保展开/收起和项目操作与普通项目段一致。 */
  renderProject: (
    project: ProjectNodeData,
    displaySessions: ProjectNodeData['sessions'],
    parentSectionCollapsed: boolean,
    sessionVariant: 'text' | 'list',
  ) => ReactNode;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  /** /ctr 接管中的 sessionIds — SessionItem 用来切换左侧 icon */
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  /** 用户手动拖动 pinned 顺序后写回；id 列表是当前 visible 段的新顺序。 */
  onReorder: (newOrderIds: string[]) => void;
}

export function PinnedSection({
  entries,
  allKnownProjects,
  renderProject,
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
  onReorder,
}: PinnedSectionProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { mode, setMode } = useSidebarCardMode();
  // 段头 trigger 的图标 = 当前选中的显示模式(用户一眼看出现在是哪种)。
  const ViewStyleTriggerIcon = viewStyleIcon(mode);
  // 卡片视觉(card 瀑布流 / list 单列满宽)统称"卡片态";text 为紧凑行。
  const isCardLike = mode !== 'text';
  const [collapsed, setCollapsed] = useState(false);

  const visibleEntries = entries;
  const visibleSessions = useMemo(
    () => visibleEntries.flatMap((entry) => (entry.kind === 'session' ? [entry.session] : [])),
    [visibleEntries],
  );

  // 置顶不做"最多显示 N 条"折叠——置顶是用户主动钉住的,全部显示(三种模式一致)。
  const slicedEntries = visibleEntries;

  // 平铺时标题旁的"项目来源"标签(口径见 buildSessionSourceLabelMap)。
  // 置顶视图传 visibleSessions;文字 / 列表都画,card 变体不画这个标签。
  const sourceLabelMap = useMemo(
    () =>
      buildSessionSourceLabelMap(visibleSessions, allKnownProjects, t('ccAgent.sidebar.dialogues')),
    [visibleSessions, allKnownProjects, t],
  );

  const getEntryId = useCallback((entry: PinnedSidebarEntry) => entry.id, []);

  // 卡片渲染——card(瀑布流,白底描边卡)与 list(单列满宽,扁平 Telegram 风行)
  // 共用同一张 SessionCard,靠 variant 切换视觉。index 用于 list 变体首行补一条
  // 列表顶部分割线(其余分割线由各行底部自带)。
  // hideBottomDivider:下一行高亮(active/选中)时隐藏本行底部分割线——否则高亮圆角
  // 方块的"正上方"会露出上一行的底线(本行的底线 = 高亮行的上沿)。配合行自身高亮时
  // 隐藏自己的底线,高亮方块上下两条线都不再露出。
  const renderCard = useCallback(
    (entry: PinnedSidebarEntry, index: number) => {
      if (entry.kind === 'project') {
        return (
          <div
            className={cn(
              mode === 'card' &&
                'rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--surface-elevated)] p-1',
              mode === 'list' && 'border-b border-[var(--cmd-palette-border)] py-0.5',
            )}
          >
            {renderProject(
              entry.project,
              entry.displaySessions,
              collapsed,
              mode === 'list' ? 'list' : 'text',
            )}
          </div>
        );
      }
      const session = entry.session;
      const next = slicedEntries[index + 1];
      const nextHighlighted =
        next?.kind === 'session' &&
        (next.session.id === activeSessionId ||
          (selectedSessionIds?.has(next.session.id) ?? false));
      return (
        <SessionCard
          session={session}
          variant={mode === 'list' ? 'list' : 'card'}
          isFirst={index === 0}
          hideBottomDivider={nextHighlighted}
          isActive={session.id === activeSessionId}
          isRunning={runningSessionIds.has(session.id)}
          isAttached={attachedSessionIds.has(session.id)}
          hasAttentionNotification={notifications.has(session.id)}
          isSelected={selectedSessionIds?.has(session.id) ?? false}
          onClick={onSessionClick}
          onAction={onAction}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onMoveSession={onMoveSession}
          projectOptions={projectOptions}
          sourceLabel={sourceLabelMap.get(session.id)}
        />
      );
    },
    [
      mode,
      slicedEntries,
      renderProject,
      collapsed,
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
      sourceLabelMap,
    ],
  );

  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const toggleLabel = collapsed
    ? t('ccAgent.sidebar.pinnedToggleExpand')
    : t('ccAgent.sidebar.pinnedToggleCollapse');

  if (visibleEntries.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5 w-full">
      {/* Section Title — height 24, padding [0,12,0,24]
          颜色规格（2026-04-20 二次确认对标设计稿 ZVIpx/WazkW）：
            Light #262626 / Dark #f5f0e8（深色文本，非 Stone 灰）
          prod_spec F-PJ-3 原文写 #737373 / #a8a29e (Stone)，2026-04-20 修订对齐
          设计稿；spec 已同步回写。ProjectsSection 段标题同色，保持视觉一致。*/}
      {/* 段头在文字版 / 卡片版之间保持完全一致:左侧"置顶"标签 + hover 折叠箭头;
          右侧固定的"显示样式"切换钮(justify-between 推到最右,与 DialogueSection
          等对话列表段头的右侧动作同款 hover 行为)。cardMode 只影响菜单里的勾选项,
          不改变段头文字样式或按钮位置。 */}
      <div className="group/sidebar-header flex h-6 items-center justify-between pr-3 pl-6">
        <div className="flex min-w-0 items-center gap-1">
          {/* 段标题:与 项目/对话 段头同款,2026-07 用户定稿。 */}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            className="text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
          >
            {t('ccAgent.sidebar.pinned')}
          </button>
          <div className={cn(HEADER_HOVER_ACTION_CLASS, 'flex items-center gap-0.5')}>
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
        {/* 显示样式切换:固定最右,hover 浮现(菜单打开时保持可见)。
            图标 = 当前选中的显示模式(2026-08-12 用户裁决),不再恒为网格。 */}
        <div className={cn(HEADER_HOVER_ACTION_CLASS, 'flex items-center gap-0.5')}>
          <ViewStyleMenu mode={mode} setMode={setMode}>
            <Tip text={t('ccAgent.sidebar.viewStyle')} side="bottom">
              <button
                type="button"
                aria-label={t('ccAgent.sidebar.viewStyle')}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <ViewStyleTriggerIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </ViewStyleMenu>
        </div>
      </div>

      {/* Pinned Items — gap 2
          卡片/列表统一用 pl-3 + pr-0:左 12px 内边距,右侧 0 内边距靠 scroll body 的
          scrollbar-gutter:stable 预留的 12px(= pl-3,与全局 12px 滚动条等宽)补齐,
          两侧视觉对称。卡片模式原先用 px-[11px],右侧在 gutter 之外又叠了 11px padding,
          导致右留白(~23px)明显宽于左(11px)——改为 pr-0 后两侧都≈12px 且更窄。 */}
      {/* 段级收起走 SectionCollapse 高度动画,播完卸载子树。 */}
      <SectionCollapse collapsed={collapsed}>
        <div className={cn('flex flex-col gap-0.5', isCardLike ? 'pr-0 pl-3' : 'pt-1 pr-0 pl-3')}>
          {/* 三种显示模式:
              - card:CardMasonry 响应式分栏(侧栏 ~258px 起 2 列、~424px 起 3 列,错落瀑布);
              - list:卡片视觉但**单列满宽**(不分栏、铺满左侧,类灵动岛),走单列 SortableList;
              - text:紧凑行 SessionItem。card/list 都整卡可拖,回写同一份 manualPinnedOrder。 */}
          {mode === 'card' ? (
            <CardMasonry
              items={slicedEntries}
              getId={getEntryId}
              onReorder={onReorder}
              reducedMotion={reducedMotion}
              forceFallback={false}
              renderItem={renderCard}
            />
          ) : mode === 'list' ? (
            // list:扁平 Telegram 风行。行间留 gap-0.5(同正常对话列表)——相邻高亮
            // 圆角方块(如 active + hover)之间有一点点呼吸,不贴死。浅分割线由每行自带
            // (内缩短线,见 SessionCard list 变体):行底一条覆盖"行间 + 列表底",首行补
            // 一条顶线覆盖"列表顶";高亮(active/选中/hover)行及其相邻行的线隐藏。
            <SortableList
              items={slicedEntries}
              getId={getEntryId}
              onReorder={onReorder}
              reducedMotion={reducedMotion}
              forceFallback={false}
              className="flex flex-col gap-0.5"
              renderItem={renderCard}
            />
          ) : (
            <SortableList
              items={slicedEntries}
              getId={getEntryId}
              onReorder={onReorder}
              reducedMotion={reducedMotion}
              forceFallback={false}
              className="flex flex-col gap-0.5"
              renderItem={(entry) =>
                entry.kind === 'project' ? (
                  renderProject(entry.project, entry.displaySessions, collapsed, 'text')
                ) : (
                  <SessionItem
                    session={entry.session}
                    isActive={entry.session.id === activeSessionId}
                    isRunning={runningSessionIds.has(entry.session.id)}
                    isAttached={attachedSessionIds.has(entry.session.id)}
                    hasAttentionNotification={notifications.has(entry.session.id)}
                    isSelected={selectedSessionIds?.has(entry.session.id) ?? false}
                    onClick={onSessionClick}
                    onAction={onAction}
                    onRename={onRename}
                    onTogglePin={onTogglePin}
                    onMoveSession={onMoveSession}
                    projectOptions={projectOptions}
                    sourceLabel={sourceLabelMap.get(entry.session.id)}
                  />
                )
              }
            />
          )}
        </div>
      </SectionCollapse>
    </div>
  );
}
