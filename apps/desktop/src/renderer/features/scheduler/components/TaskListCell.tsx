/**
 * TaskListCell — 左侧任务列表单元格
 * ---------------------------------------------------------------------------
 * 任务列表单元格的视觉规格：
 *   - cornerRadius 10，padding [12, 14]，gap 5
 *   - 标题 14/500 + 副标题 'Last X ago' 11/normal
 *   - 选中态：bg #e5e5e5 (light) / #3c3c3a (dark)（与 nav-pill 选中色对齐）
 *   - 未选 hover：低对比度叠加
 *   - Paused 整体降饱和（标题 #737373，副标题 #a3a3a3）
 *   - 一次性任务（recurring=false）标题旁带 "Once" 椭圆 chip
 *
 * 只负责渲染 + 把 click/Enter/Space 转成 onSelect。
 * 其他动作（pause/edit/delete）走右侧 pane header 的 ⋯ 菜单。
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUpToLine,
  Copy,
  FolderGit2,
  FolderMinus,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import type { Schedule } from '@cindy/maker-scheduler';
import type { RegionalMoney } from '../../../../shared/regionalMoney';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { formatLastRun, formatNextRun } from '../lib/formatters';
import { formatTurnCostMoney } from '@/lib/usageFormat';

interface Props {
  schedule: Schedule;
  selected: boolean;
  unreadCount?: number;
  totalMoney?: RegionalMoney;
  totalEstimatedValueMoney?: RegionalMoney;
  hasUnavailableCost?: boolean;
  onSelect: (s: Schedule) => void;
  /** 右键菜单的 Pause/Resume 动作；与 RunHistoryPane ⋯ 菜单同行为。 */
  onTogglePause?: (s: Schedule) => void | Promise<void>;
  /** 右键菜单的 Delete 动作；调用方负责弹二次确认。 */
  onDelete?: (s: Schedule) => void | Promise<void>;
  /**
   * 双击 / 右键 Rename 提交的新名字；trim 后非空且与原名不同才会调用。
   * 与 SessionItem 同款：调用方负责乐观更新 + 失败回滚。
   */
  onRename?: (s: Schedule, newName: string) => void | Promise<void>;
  /** User schedule context menu: promote to project automation. */
  onPromoteToProject?: (s: Schedule) => void | Promise<void>;
  /** Project schedule context menu: edit schedules.json config. */
  onEditProjectSchedule?: (s: Schedule) => void | Promise<void>;
  /** Project schedule context menu: clone to a personal user schedule. */
  onCloneToUser?: (s: Schedule) => void | Promise<void>;
  /** Project schedule context menu: remove from schedules.json. */
  onRemoveProjectSchedule?: (s: Schedule) => void | Promise<void>;
  /** 行悬浮时露出的「立即运行」按钮:runNow 是 force-fire,paused/expired 也允许。 */
  onRunNow?: (s: Schedule) => void | Promise<void>;
  /**
   * 页面级 runNow busy 守卫（由父级传入）。
   * true 时按钮禁用；与 detail pane 的 busyScheduleIds 共享同一来源，
   * 确保两个入口任一触发后对方也立即禁用，防止同一 schedule 双发 runNow。
   */
  runBusy?: boolean;
  /** 仅在 Scheduler 明确把本任务列入并发等待队列时传入。 */
  waitingForResources?: { inFlight: number; maxConcurrentRuns: number };
}

export function TaskListCell({
  schedule: s,
  selected,
  unreadCount = 0,
  totalMoney,
  totalEstimatedValueMoney,
  hasUnavailableCost = false,
  onSelect,
  onTogglePause,
  onDelete,
  onRename,
  onPromoteToProject,
  onEditProjectSchedule,
  onCloneToUser,
  onRemoveProjectSchedule,
  onRunNow,
  runBusy = false,
  waitingForResources,
}: Props) {
  const { t } = useTranslation();
  // 右键菜单：复用 ProjectNode 的"controlled DropdownMenu + 不可见 trigger 跟 click 坐标"模式。
  // 不在 onContextMenu 里 setSelected，避免右键时强制切换详情 pane（用户也许只是想删 / pause 某条）。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const isPausedSch = s.status === 'paused';
  const isExpiredSch = s.status === 'expired';
  const isProjectSchedule = s.source === 'project';
  const canRename = !!onRename && !isProjectSchedule;
  const canDelete = !!onDelete && !isProjectSchedule;
  const canPromote = !!onPromoteToProject && !isProjectSchedule;
  const canEditProject = !!onEditProjectSchedule && isProjectSchedule;
  const canCloneToUser = !!onCloneToUser && isProjectSchedule;
  const canRemoveProject = !!onRemoveProjectSchedule && isProjectSchedule;
  const hasUnreadRuns = unreadCount > 0;
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // 任一动作回调都没传就不弹菜单（外层未启用右键功能时直接走默认浏览器菜单）
      if (
        !onTogglePause &&
        !canDelete &&
        !canRename &&
        !canPromote &&
        !canEditProject &&
        !canCloneToUser &&
        !canRemoveProject
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      setMenuPos({ x: e.clientX, y: e.clientY });
    },
    [
      onTogglePause,
      canDelete,
      canRename,
      canPromote,
      canEditProject,
      canCloneToUser,
      canRemoveProject,
    ],
  );
  const isPaused = s.status === 'paused';
  // 副标题取值优先级：
  //   - paused：统一显示 "Paused"（不 fallback 到 lastText —— 暂停态比"上次什么时候跑"更要紧，
  //             用户在 All 筛选混排时也能一眼分辨）
  //   - manual：永不自动 fire → "Last X ago"（跑过）/ "Manual"（没跑过）
  //   - 一次性（Once）：仅 "Last X ago"（跑过）/ "Once"（未跑）
  //   - 周期任务：同时显示 "Last X ago · Next in Y"
  //     · 没跑过 → "Next in Y"  · 没下一次 → "Last X ago"
  // 用 lastFiredAt（上一次开始时间）而不是 lastFinishedAt：用户更关心"任务上次什么时候被触发"，
  // 而不是"上次跑完是什么时候"。长跑任务在 running 中也能立刻看到 "Last HH:mm"。
  const lastText = formatLastRun(s.lastFiredAt);
  const nextText = s.status === 'active' ? formatNextRun(s.nextFireAt) : null;
  let subtitle: string | null;
  if (waitingForResources) {
    subtitle = t('scheduler.cell.subtitleWaitingForResources', {
      inFlight: waitingForResources.inFlight,
      max: waitingForResources.maxConcurrentRuns,
    });
  } else if (s.status === 'paused') {
    subtitle = t('scheduler.cell.subtitlePaused');
  } else if (s.manual) {
    subtitle = lastText ?? t('scheduler.cell.subtitleManual');
  } else if (!s.recurring) {
    subtitle = lastText ?? t('scheduler.cell.subtitleOnce');
  } else if (lastText && nextText) {
    subtitle = `${lastText} · ${nextText}`;
  } else {
    subtitle = lastText ?? nextText;
  }
  const costText =
    totalMoney == null && !hasUnavailableCost
      ? null
      : [
          totalMoney && totalMoney.amount > 0
            ? t('scheduler.cell.totalCost', {
                cost: formatTurnCostMoney(totalMoney),
              })
            : null,
          (totalEstimatedValueMoney?.amount ?? 0) > 0
            ? t('scheduler.cell.totalValue', {
                value: formatTurnCostMoney(totalEstimatedValueMoney!),
              })
            : null,
          hasUnavailableCost ? t('scheduler.cell.costUnavailable') : null,
        ]
          .filter(Boolean)
          .join(' · ') ||
            (totalMoney
              ? t('scheduler.cell.totalCost', {
                  cost: formatTurnCostMoney(totalMoney),
                })
              : t('scheduler.cell.costUnavailable'));
  // 副标题行是否渲染:决定右下角 Run 按钮的"预留位"落在哪一行(见下方两处 pr-3.5)。
  const hasMetaRow = Boolean(subtitle || costText);

  // ── Double-click rename（与 SessionItem 完全同款）──
  // - 单击立即选择；双击只额外进入重命名（仅在 onRename 传入时启用）
  // - Enter 提交、Escape 取消、Blur 提交；committedRef 防 Enter→Blur 双发
  const renameEnabled = canRename;
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(s.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const enterEdit = useCallback(() => {
    setEditValue(s.name);
    committedRef.current = false;
    setIsEditing(true);
  }, [s.name]);

  const commitRename = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = editValue.trim();
    setIsEditing(false);
    if (onRename && trimmed && trimmed !== s.name) {
      void onRename(s, trimmed);
    }
  }, [editValue, onRename, s]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) return;
      if (e.detail > 1) return;
      onSelect(s);
    },
    [isEditing, s, onSelect],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!renameEnabled) return;
      e.stopPropagation();
      e.preventDefault();
      enterEdit();
    },
    [renameEnabled, enterEdit],
  );

  const handleKeyDown = useCallback(
    (ev: KeyboardEvent) => {
      if (isEditing) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onSelect(s);
      }
    },
    [isEditing, s, onSelect],
  );

  // 立即运行按钮：busy 守卫由页面级 runNowBusyIds 统一管理（通过 runBusy prop 传入），
  // 确保 TaskListCell 行按钮与 RunHistoryPane detail 按钮共享同一 per-schedule 禁用状态，
  // 防止两侧并发点击对同一 schedule 双发 runNow。
  const handleRunNowClick = useCallback(
    async (e: React.MouseEvent) => {
      // 阻断冒泡:避免这次点击又被外层行的 onClick 当成普通选中处理(会走 e.detail
      // 判定等逻辑)。改为在这里显式选中,让"运行"与"选中"两个动作都确定发生、且顺序可控。
      e.stopPropagation();
      e.preventDefault();
      // busy(按钮 disabled)时整体 no-op:不选中也不 fire。守卫放在最前,确保"禁用态
      // 的点击"什么都不做(真实浏览器 disabled 本就不触发 click,这里再兜一层)。
      if (!onRunNow || runBusy) return;
      // 点运行的同时选中该任务 —— 右侧详情(运行历史列表)随即打开,用户点完立刻看到
      // 本次运行进入该任务的历史。选中先于 fire:详情面板先挂载,新 run 到达即可见。
      onSelect(s);
      await onRunNow(s);
    },
    [onSelect, onRunNow, runBusy, s],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-[5px] rounded-[10px] px-[14px] py-3',
        'outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        selected
          ? 'bg-[var(--chat-input-chip-bg)]'
          : 'hover:bg-[var(--surface-hover)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)]',
      )}
    >
      {/* 悬浮/选中时露出的「立即运行」按钮:runNow 是 force-fire,paused/expired 也可用,不做 status 门控;
          键盘可达(button 天然 focusable),focus 时同样保持可见。 */}
      {onRunNow && !isEditing && (
        <button
          type="button"
          onClick={(e) => void handleRunNowClick(e)}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={runBusy}
          title={t('scheduler.button.runNow')}
          aria-label={t('scheduler.button.runNow')}
          className={cn(
            // 固定在 cell 右下角(与副标题行对齐):不再垂直居中压在两行内容上,
            // 标题行的 chip 无需让位;悬浮时原位替换右下角的 cost 文本(无 cost 的行
            // 由副标题行 pr 常驻预留按钮位),无重叠也无跳变。
            'absolute right-2 bottom-2.5 z-[1]',
            // 与侧栏对话列表的悬浮 Run 按钮完全同款(AutomationSessionGroupItem):
            // size-5 幽灵按钮 + Silver 图标 + hover 浅灰底,连 token 都复用同一组,
            // 两处"运行"入口视觉与后续调整保持同步。零阴影(docs/design-rules/cindy-design-system.md §6)、
            // 零缩放位移(§14.4),只保留 ≤150ms 的 opacity/颜色功能性过渡。
            'flex size-5 items-center justify-center rounded-md',
            'text-sidebar-action-icon',
            // 只在行 hover / 按钮 focus 时露出。
            'opacity-0 transition-[opacity,background-color,color] duration-150',
            'group-hover:opacity-100 focus-visible:opacity-100',
            'hover:bg-sidebar-item-hover hover:text-foreground',
            // disabled 的半透明必须继续受 hover/focus 门控:裸 disabled:opacity-50 的特异性
            // 高于基础 opacity-0,会让 busy 中的按钮在行未 hover 时也停在 50%,表现为
            // "点击运行后按钮变半透明、不可点、且再也不消失"。改成只在 hover/focus 时才 dim,
            // 行未 hover 时按钮仍回到 opacity-0 隐藏。
            'disabled:cursor-not-allowed',
            'disabled:group-hover:opacity-50 disabled:focus-visible:opacity-50',
          )}
        >
          <Play size={14} strokeWidth={2} />
        </button>
      )}
      <div
        className={cn(
          'flex min-w-0 items-center gap-2',
          // 无副标题行的 cell 是单行布局,右下角的 Run 按钮会与标题行重叠——
          // 此时预留位落在标题行,防止按钮压住长标题 / chip(review 反馈)。
          // 预留量:按钮占 cell 右缘 8..28px,内容盒右缘在 14px(px-[14px]),
          // pr-5(20px)= 补齐 14px 侵入 + 6px 呼吸间隙。
          onRunNow && !hasMetaRow && 'pr-5',
        )}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitRename();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                committedRef.current = true; // 防 blur 紧接着提交
                setIsEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cn(
              // 高度 / 内边距对齐外面那个 <span>（text-sm 自然 line-height = 20px），
              // 用 h-5 + py-0 + -mx-1 让 input 在视觉上"原地"覆盖标题，
              // 避免双击进入编辑时 cell 整体被撑高 4px 的跳变。
              'min-w-0 flex-1 h-5 px-1 -mx-1 py-0 rounded',
              'text-sm font-medium text-[var(--msg-assistant-text)]',
              'bg-transparent outline-none',
              'border-[1.5px] border-[var(--focus-ring)]',
            )}
          />
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* 未读点走全端统一"完成未读=绿"(失败结局的红色语义由运行历史卡与
                侧栏组头表达,本 cell 只有未读计数,不做失败聚合)。 */}
            {hasUnreadRuns && <AttentionDot size={6} className="shrink-0" />}
            <span className="min-w-0 truncate text-sm font-medium text-[var(--msg-assistant-text)]">
              {s.name}
            </span>
          </span>
        )}
        {/* 一次性任务标识：recurring=false 即标 Once；manual 优先标 Manual（更准确）。
            视觉规格：椭圆描边 + 11px 灰字。
            编辑态下隐藏 chip 给输入框留满宽度。 */}
        {!isEditing && isProjectSchedule && (
          <span
            className={cn(
              'shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px] font-medium leading-none',
              'border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-meta)]',
            )}
            title={t('scheduler.projectAutomation.cell.tooltip')}
          >
            <FolderGit2 size={10} strokeWidth={1.8} />
            {t('scheduler.projectAutomation.cell.tag')}
          </span>
        )}
        {!isEditing && (s.manual || !s.recurring) && (
          <span
            className={cn(
              'shrink-0 translate-x-[2px] rounded-full border px-2 py-[2px] text-[11px] font-medium leading-none',
              'border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-meta)]',
            )}
          >
            {s.manual ? t('scheduler.cell.tagManual') : t('scheduler.cell.tagOnce')}
          </span>
        )}
      </div>
      {hasMetaRow && (
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            // 无 cost 的行,右下角 Run 按钮没有可替换的对象,给副标题常驻预留按钮位,
            // 避免悬浮时压住文字;预留量与标题行同款(pr-5 = 补齐 14px 侵入 + 6px 间隙)。
            // 有 cost 的行不预留——按钮悬浮时原位替换 cost(见下方 costText 的淡出)。
            onRunNow && !costText && 'pr-5',
          )}
        >
          {subtitle && (
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-11',
                isPaused
                  ? 'text-[var(--settings-section-desc)] dark:text-[var(--cmd-palette-item-meta)]'
                  : selected
                    ? 'text-[var(--settings-section-desc)]'
                    : 'text-[var(--cmd-palette-item-meta)]',
              )}
            >
              {subtitle}
            </span>
          )}
          {costText && (
            <span
              className={cn(
                'ml-auto shrink-0 text-[11px]',
                selected
                  ? 'text-[var(--settings-section-desc)]'
                  : 'text-[var(--cmd-palette-item-meta)]',
                // 行悬浮时淡出,让右下角的 Run 按钮原位替换 cost(与侧栏"meta 让位给
                // 操作按钮"的手法一致);仅 opacity 过渡,宽度保留,副标题不回流。
                // 键盘可达性:按钮经 Tab 聚焦(focus-visible)显示时 cost 同样让位。
                // 精确匹配"按钮自身 focus-visible"而非 group-focus-within——行本身也
                // focusable,点选/Tab 到行时按钮并不显示,不应误藏 cost。
                onRunNow &&
                  'transition-opacity group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0',
              )}
            >
              {costText}
            </span>
          )}
        </div>
      )}
      {/* 右键菜单：复用 ProjectNode 的 controlled DropdownMenu + 不可见 trigger 模式，
          trigger 跟着 click 坐标定位。菜单项与 RunHistoryPane ⋯ 菜单保持一致。 */}
      <DropdownMenu
        open={menuPos !== null}
        onOpenChange={(open) => {
          if (!open) setMenuPos(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: 'fixed',
              left: menuPos?.x ?? 0,
              top: menuPos?.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          className={cn(
            'min-w-[180px] rounded-xl p-1 overflow-hidden',
            'bg-[var(--cmd-palette-bg)]',
            'border border-[var(--cmd-palette-border)]',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          {canRename && (
            <DropdownMenuItem
              onSelect={enterEdit}
              className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
            >
              <Pencil size={13} strokeWidth={2} className="mr-2" />
              {t('scheduler.cell.menu.rename')}
            </DropdownMenuItem>
          )}
          {onTogglePause && (
            <DropdownMenuItem
              onSelect={() => void onTogglePause(s)}
              disabled={isExpiredSch}
              className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
            >
              {isPausedSch ? (
                <Play size={13} strokeWidth={2} className="mr-2" />
              ) : (
                <Pause size={13} strokeWidth={2} className="mr-2" />
              )}
              {isPausedSch ? t('scheduler.cell.menu.resume') : t('scheduler.cell.menu.pause')}
            </DropdownMenuItem>
          )}
          {canPromote && (
            <>
              <DropdownMenuSeparator className="bg-[var(--cmd-palette-border)]" />
              <DropdownMenuItem
                onSelect={() => void onPromoteToProject(s)}
                className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
              >
                <ArrowUpToLine size={13} strokeWidth={2} className="mr-2" />
                {t('scheduler.list.promote.menu')}
              </DropdownMenuItem>
            </>
          )}
          {canEditProject && (
            <DropdownMenuItem
              onSelect={() => void onEditProjectSchedule(s)}
              className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
            >
              <Pencil size={13} strokeWidth={2} className="mr-2" />
              {t('scheduler.list.editProject.menu')}
            </DropdownMenuItem>
          )}
          {canCloneToUser && (
            <DropdownMenuItem
              onSelect={() => void onCloneToUser(s)}
              className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
            >
              <Copy size={13} strokeWidth={2} className="mr-2" />
              {t('scheduler.list.cloneToUser.menu')}
            </DropdownMenuItem>
          )}
          {canRemoveProject && (
            <>
              <DropdownMenuSeparator className="bg-[var(--cmd-palette-border)]" />
              <DropdownMenuItem
                onSelect={() => void onRemoveProjectSchedule(s)}
                className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
              >
                <FolderMinus size={13} strokeWidth={2} className="mr-2" />
                {t('scheduler.list.removeProject.menu')}
              </DropdownMenuItem>
            </>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator className="bg-[var(--cmd-palette-border)]" />
              <DropdownMenuItem
                onSelect={() => void onDelete(s)}
                className="cursor-pointer text-sm hover:bg-[var(--cmd-palette-item-hover)]"
              >
                <Trash2 size={13} strokeWidth={2} className="mr-2" />
                {t('scheduler.cell.menu.deleteAutomation')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
