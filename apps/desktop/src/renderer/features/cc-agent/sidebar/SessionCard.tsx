/**
 * SessionCard — sidebar-card-mode 下的单条会话卡片（SessionItem 的瀑布流形态）
 * ---------------------------------------------------------------------------
 * 设计来源：用户 Claude design 稿（XDT-sidebar-redesign，xdtsb-card 系）。
 * 视觉：白底 Card + 1px Board 圆角 12；标题最多 2 行且保持纯文字，摘要 / 最近消息
 *   随内容最多 1~3 行；SessionStatusIcon（agent 标识 + running 呼吸 + attention
 *   状态点 + 草稿铅笔）、自动化 / 远程 / worktree 标识与时间统一放在底部 metadata 槽。
 *
 * 交互 100% 对齐 SessionItem（props 签名完全一致，sections 内按 cardMode 二选一渲染）：
 *   - 单击导航 / 双击重命名（标题原位变 input）
 *   - 右键 coordinate-anchored DropdownMenu（Pin/Rename/复制ID/新窗口/Archive/Delete，
 *     archived / draft 变体同款分支）
 *   - hover 右上角仅 More（⋮）快捷钮；存档收进 ⋮ / 右键展开菜单的 Archive 项
 *     （卡片不再出现独立的存档快捷钮）。已归档卡片保留"取消归档"快捷钮。
 *   - list 变体保留标题左侧 SessionStatusIcon / 自动化前缀；card 变体标题不带前缀，
 *     状态 / Agent / 自动化图标留在底部 meta 行
 *   - remote 会话标识复用 RemoteProjectIcon,继续区分 device-link / ssh
 *   - matchIndices 模糊搜索高亮沿用 highlightSegments
 *
 * 布局：CardMasonry 响应式分栏——单列走 SortableList,侧栏拉宽时 2/3 列走
 * DraggableCardColumns 错落瀑布(每列独立 SortableJS 实例 + 跨列 group,多列也可整卡拖拽)。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import { Archive, ChevronRight, EllipsisVertical, Undo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { WorktreeBadge } from '@/components/sidebar/WorktreeBadge';
import { SessionStatusIcon } from './SessionStatusIcon';
import { ScheduleBindingBadge } from './ScheduleBindingBadge';
import { AutomationTimerIcon } from './AutomationTimerIcon';
import { SessionOrdinalBadgeKbd, useSessionOrdinalBadge } from './sessionOrdinalBadges';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import { makerChatStore } from '@/lib/makerChatStore';
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
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from './menuStyles';
import { toast } from '@/lib/toast';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { createLogger } from '@/lib/logger';
import { formatSidebarTime, formatSidebarTimeAbsolute } from '../lib/formatSidebarTime';
import { highlightSegments } from '../lib/highlightSegments';
import { scrollIntoNearestView } from '../lib/scrollIntoNearestView';
import { isAutomationGeneratedSession } from '../lib/scheduledSessionGrouping';
import {
  canHighlightSessionDisplayTitle,
  getSessionDisplayTitle,
  isEmptyDraftSession,
} from '../lib/sessionDisplayTitle';
import { SessionProjectMoveSubmenu } from './SessionProjectMoveSubmenu';
import { SessionRenameInput } from '../SessionRenameInput';
import type { SessionItemProps } from './SessionItem';
import { RemoteProjectIcon } from './RemoteProjectIcon';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';
import { prefetchDirtyWorktreeForRemoval } from '@/lib/worktreeRemovalWarning';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { useSessionAttentionUrgency } from '../contexts/SessionAttentionUrgencyContext';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { useSessionBoundSchedules, scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import { loadScheduleSidebarIndexRuns } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import { resolveSidebarRightStatus } from './sidebarRightStatus';
import { SidebarRightStatusIndicator } from './SidebarRightStatusIndicator';

const log = createLogger('SessionCard');

const CARD_TITLE_STATUS_SLOT_CLASS = 'inline-flex h-[1em] w-3 items-center justify-center align-[-0.08em]';
const CARD_TITLE_META_SLOT_CLASS = 'ml-1 inline-flex h-[1em] w-3 items-center justify-center align-[-0.08em]';

/**
 * 平台中立的“待用户交互”判定:直接读 maker session 状态(makerChatStore),不依赖
 * 只在 macOS Sonoma+ 可用的 Agent Island。返回精确待交互类型,非待交互态返回
 * ''(基本类型,适配 useSyncExternalStore 的稳定比较)。
 */
function getNeutralAwaitingKind(
  sessionId: string,
): 'permission' | 'plan_review' | 'ask_user' | 'plugin_setup' | '' {
  const info = makerChatStore.getRunningSnapshot().get(sessionId);
  if (info?.hasPendingPermission) return 'permission';
  if (info?.hasPendingPlanReview) return 'plan_review';
  if (info?.hasPendingAskUser) return 'ask_user';
  if (info?.hasPendingPluginSetup) return 'plugin_setup';
  return '';
}

/** SessionCard 与 SessionItem 共用同一份 props 契约（indented 在卡片流中无意义，忽略）。
 *  variant:
 *    - 'card'(默认):白底描边卡片(瀑布流),标题 1 行 + 正文 2 行 + 右下角时间。
 *    - 'list':满宽扁平行(类 Telegram / 对话列表),无卡片描边底色;标题 + 右上角
 *      时间(hover 让位给操作按钮,逻辑同对话列表)+ 下方 2 行预览,更素雅。 */
export type SessionCardProps = SessionItemProps & {
  variant?: 'card' | 'list';
  /** list 变体:是否为列表首行——首行额外补一条顶部分割线(列表顶)。 */
  isFirst?: boolean;
  /** list 变体:下一行处于高亮(active/选中)时为 true——隐藏本行底部分割线,
   *  避免高亮圆角方块正上方露出这条线(它 = 高亮行的上沿)。 */
  hideBottomDivider?: boolean;
};

export function SessionCard({
  session,
  isActive,
  isRunning,
  isAttached = false,
  hasAttentionNotification,
  isSelected = false,
  onClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions = [],
  matchIndices,
  variant = 'card',
  isFirst = false,
  hideBottomDivider = false,
}: SessionCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // mod+1..9 序号徽标:模块 store 按 sessionId 精准订阅,非按住态恒为 null。
  const ordinalBadgeLabel = useSessionOrdinalBadge(session.id);
  // 灵动岛同源的 per-session 实时活动(执行中逐步活动 + 等待交互态)。
  const islandActivity = useAgentIslandActivity(session.id);
  // list 变体与文字模式共用右侧状态优先级:
  // error > awaiting > running > done > time。远程会话由被控端活动镜像覆盖
  // 本地 attention 链路，与 SessionItem 完全一致。
  const attentionKind = useSessionAttentionKind(session.id);
  const isUrgentFromContext = useSessionAttentionUrgency(session.id);
  const remoteActivity = useRemoteSessionActivity(session.id);
  const remoteRightStatus =
    remoteActivity == null
      ? null
      : remoteActivity.phase === 'error'
        ? ('error' as const)
        : remoteActivity.phase === 'needs-interaction'
          ? ('awaiting' as const)
          : remoteActivity.phase === 'running'
            ? ('running' as const)
            : ('done' as const);
  const rightStatusKind = remoteRightStatus ?? resolveSidebarRightStatus({
    attentionKind,
    isUrgentFromContext,
    isRunning,
    hasAttentionNotification,
  });
  const isPinned = session.pinnedAt != null;
  const isEmpty = isEmptyDraftSession(session);
  const activityIso = session.updatedAt;
  const remoteIconKind = session.deviceLinkDeviceId ? 'device-link' : session.remoteHostId ? 'ssh' : null;
  const remoteIconConnectionStatus = session.deviceLinkDeviceId
    ? session.deviceLinkConnectionStatus ?? 'connected'
    : null;
  const remoteWritesBlocked = isRemoteSessionWriteBlocked(session);
  const isAutomationGenerated = isAutomationGeneratedSession(session);
  const boundSchedules = useSessionBoundSchedules(session.id);
  const showScheduleBindingBadge = boundSchedules.length > 0;
  const showAutomationTimer = !showScheduleBindingBadge && isAutomationGenerated;
  const displayTitle = getSessionDisplayTitle(session, t('ccAgent.common.unnamedSession'));
  const canHighlightDisplayTitle = canHighlightSessionDisplayTitle(session);
  const isArchived = session.status === 'archived';
  const canQuickArchive = !isArchived && !isEmpty && !remoteWritesBlocked;
  // 卡片/列表的正文固定给预览区域。list 保留 main 既有实时执行文案;
  // card 模式不跟随 runningDetail 跳动,只显示稳定任务摘要 / 最近消息,完成后由 summary 更新。
  const summaryPreview = session.summary ?? session.preview ?? null;

  // awaiting 角标数据源:优先 Agent Island 的实时活动(mac);但 Agent Island 仅在
  // macOS Sonoma+ 可用(service 在其它平台 return null),故非 mac / 旧系统平台中立兜底
  // —— 直接读 maker session 的待交互态(makerChatStore,全平台同源),保证 awaiting
  // 角标不再只在 mac 显示(PR #246 review)。两边都给精确三态,沿用同一组 i18n。
  const neutralAwaitingKind = useSyncExternalStore(makerChatStore.subscribeAll, () =>
    getNeutralAwaitingKind(session.id),
  );
  const awaitingKind =
    (islandActivity?.phase === 'needs-interaction' ? islandActivity.interactionKind : null) ??
    (neutralAwaitingKind || null);
  const awaitingText =
    awaitingKind == null
      ? null
      : awaitingKind === 'permission'
        ? t('ccAgent.sidebar.card.awaitingPermission')
        : awaitingKind === 'plan_review'
          ? t('ccAgent.sidebar.card.awaitingPlan')
          : awaitingKind === 'plugin_setup'
            ? t('ccAgent.sidebar.card.awaitingPluginSetup')
          : t('ccAgent.sidebar.card.awaitingQuestion');
  const runningDetail =
    islandActivity?.phase === 'running' && islandActivity.compactDetail
      ? islandActivity.compactDetail
      : null;
  const listPreview = awaitingText ?? runningDetail ?? summaryPreview;
  const cardPreview = awaitingText ?? summaryPreview;
  const cardPreviewLineClamp = session.summary ? 3 : isRunning ? 2 : isAutomationGenerated ? 1 : 2;
  const cardTimeText = formatSidebarTime(activityIso, t);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const confirmPillRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // 归档/删除前那次 dirty-worktree 预检要在 main 侧跑 git status,是"点了归档、
  // 卡片还没消失"里剩下的最大一块等待。亮出 Confirm 胶囊 / 打开菜单到用户点下去
  // 之间隔着一次反应时间,足够它跑完 —— 那一刻先发,执行时命中缓存。
  // 包在 setter 上而不是逐个 onClick:本卡片与下面的 compact 变体共用这个 setter。
  const prefetchRemovalPreflight = useCallback(() => {
    prefetchDirtyWorktreeForRemoval(session.id, session.deviceLinkDeviceId);
  }, [session.id, session.deviceLinkDeviceId]);
  const beginArchivePending = useCallback(
    (pending: boolean) => {
      if (pending) prefetchRemovalPreflight();
      setArchivePending(pending);
    },
    [prefetchRemovalPreflight],
  );

  // 运行结束:仅做一次卡片底色 settle 闪动作为完成提示。运行中的活动感由标题左侧
  // SessionStatusIcon 呼吸 + 底部短扫动进度条表达;完成提醒继续走 SessionStatusIcon 状态点(绿/蓝/红)。
  const prevRunningRef = useRef(isRunning);
  const [isSettling, setIsSettling] = useState(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isRunning;
    if (isRunning) {
      setIsSettling(false);
      return;
    }
    if (!wasRunning) return; // 本就空闲(初次挂载/未跑过)→ 不触发
    setIsSettling(true);
    const timer = setTimeout(() => setIsSettling(false), 900);
    return () => clearTimeout(timer);
  }, [isRunning]);
  // ── rename（与 SessionItem 同款防重复提交 ref） ──
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayTitle);
  const committedRef = useRef(false);

  // raw 由 SessionRenameInput 传入:输入框当前文本(Magic 生成的标题也先填入输入框,用户 Enter 确认后才走到这里)。
  const commitTitle = useCallback(
    (raw: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      const trimmed = raw.trim();
      setIsEditing(false);
      if (remoteWritesBlocked) {
        if (trimmed && trimmed !== displayTitle) {
          toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        }
        return;
      }
      if (trimmed && trimmed !== displayTitle) {
        onRename(session.id, trimmed);
      }
    },
    [displayTitle, remoteWritesBlocked, session.id, onRename, t],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) return;
      // 多选(与列表 SessionItem 同口径):透传 shift/⌘/ctrl 修饰键,支持卡片区
      // 范围/加减选;无修饰键即普通导航。
      onClick(session.id, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
    },
    [isEditing, onClick, session.id],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // 已在编辑态时不重复进入:编辑器内部元素漏拦的 dblclick 冒泡到这里会
      // setEditValue 重置草稿(与 handleClick 的 isEditing 守卫对称)。
      if (isEditing) return;
      e.stopPropagation();
      e.preventDefault();
      if (remoteWritesBlocked) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      setEditValue(displayTitle);
      committedRef.current = false;
      setIsEditing(true);
    },
    [displayTitle, isEditing, remoteWritesBlocked, t],
  );

  useEffect(() => {
    if (isActive) scrollIntoNearestView(cardRef.current);
  }, [isActive]);


  // archive 两步确认生命周期（redesign 稿：3s 超时 + 点外面撤回）
  useEffect(() => {
    if (!archivePending) return;
    const dismiss = () => setArchivePending(false);
    const timer = setTimeout(dismiss, 3000);
    const onDocMouseDown = (e: MouseEvent) => {
      const pill = confirmPillRef.current;
      if (pill && e.target instanceof Node && pill.contains(e.target)) return;
      dismiss();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDocMouseDown, true);
    };
  }, [archivePending]);

  useEffect(() => {
    if (isEditing) setArchivePending(false);
  }, [isEditing]);

  // ── menu handlers（与 SessionItem 等价） ──
  const handleRenameSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    setEditValue(displayTitle);
    committedRef.current = false;
    setIsEditing(true);
  }, [displayTitle, remoteWritesBlocked, t]);
  const handleArchiveSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    onAction(session.id, 'archive');
  }, [remoteWritesBlocked, session.id, onAction, t]);
  const handleUnarchiveSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    onAction(session.id, 'unarchive');
  }, [remoteWritesBlocked, session.id, onAction, t]);
  const handleDeleteSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    onAction(session.id, 'delete');
  }, [remoteWritesBlocked, session.id, onAction, t]);
  const handlePinSelect = useCallback(
    () => {
      if (remoteWritesBlocked) {
        toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        return;
      }
      onTogglePin(session.id, isPinned);
    },
    [remoteWritesBlocked, session.id, isPinned, onTogglePin, t],
  );
  const handleMoveToProjectSelect = useCallback(
    (workingDir: string) => {
      onMoveSession?.(session.id, { kind: 'project', workingDir });
    },
    [onMoveSession, session.id],
  );
  const handleMoveToProjectBrowse = useCallback(() => {
    onMoveSession?.(session.id, { kind: 'browseProject' });
  }, [onMoveSession, session.id]);
  const handleMoveToDialogue = useCallback(() => {
    onMoveSession?.(session.id, { kind: 'dialogue' });
  }, [onMoveSession, session.id]);
  const handleOpenInNewWindowSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    void window.electronAPI.maker.openSessionInNewWindow(session.id);
  }, [remoteWritesBlocked, session.id, t]);

  const handleAutomationIconClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const runs = await loadScheduleSidebarIndexRuns();
      const hit = runs.find((r) => r.sessionId === session.id);
      navigate(hit ? scheduleFocusPath(hit.scheduleId) : '/cc-agent/scheduled');
    } catch {
      navigate('/cc-agent/scheduled');
    }
  }, [session.id, navigate]);

  // 远程会话把归属设备冻进 `?device=`:发送时的引用解析不再依赖被控端此刻在线。
  const handleCopyDeepLinkSelect = useCallback(async () => {
    const link = buildSessionDeepLink(session.id, { deviceId: session.deviceLinkDeviceId });
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('ccAgent.sidebar.deepLink.copied'));
    } catch (err) {
      log.warn('clipboard write failed', err);
      toast.warning(t('ccAgent.sidebar.deepLink.copyFailed'));
    }
  }, [session.deviceLinkDeviceId, session.id, t]);

  // 单项「复制任务链接」:直接复制 cindy://session/<id> 深链。原「复制会话 ID」
  // 二级菜单(深度链接 / 仅 ID / Agent)已按产品决策收敛为这一项;不自带分隔线,
  // 分组由各使用点决定,避免菜单被切得过碎。
  const copySessionIdSubmenu = (
    <DropdownMenuItem onSelect={() => void handleCopyDeepLinkSelect()} className={MENU_ITEM_CLASS}>
      {t('ccAgent.sidebar.sessionMenu.copySessionLink')}
    </DropdownMenuItem>
  );

  // 「移动到项目」子菜单(main 既有功能;本次侧栏重设保留)。
  const canMoveToProject =
    Boolean(onMoveSession) &&
    !isEmpty &&
    !session.remoteHostId &&
    !session.deviceLinkDeviceId &&
    session.status !== 'archived';

  const moveToProjectSubmenu = canMoveToProject ? (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <span className="flex-1">{t('ccAgent.sidebar.sessionMenu.moveToProject')}</span>
        <ChevronRight size={14} className="ml-2 shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={4}
        className={cn(MENU_SUB_CONTENT_CLASS, 'w-[320px] overflow-hidden')}
      >
        <SessionProjectMoveSubmenu
          projectOptions={projectOptions}
          currentWorkingDir={session.workspaceKind === 'project' ? session.workingDir : null}
          isDialogue={session.workspaceKind === 'dialogue'}
          onSelectProject={handleMoveToProjectSelect}
          onBrowseProject={handleMoveToProjectBrowse}
          onMoveToDialogue={handleMoveToDialogue}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  ) : null;

  const statusIconNode = (
    <span className={CARD_TITLE_STATUS_SLOT_CLASS} aria-hidden>
      <SessionStatusIcon
        session={session}
        isRunning={isRunning}
        isAttached={isAttached}
        hasAttentionNotification={hasAttentionNotification}
        isActive={isActive}
        showAttentionDot={false}
      />
    </span>
  );

  // 自动化标识统一为 Timer；schedule 绑定态额外承载暂停等状态。card 变体移到
  // 底部 meta 行，list 变体沿用标题前缀。图标尺寸随所在行统一。
  const renderAutomationMeta = (iconSize: number) =>
    showScheduleBindingBadge ? (
      <ScheduleBindingBadge
        schedules={boundSchedules}
        size={iconSize}
        activeForeground={isActive}
      />
    ) : showAutomationTimer ? (
      <button
        type="button"
        className="inline-flex shrink-0 cursor-pointer items-center justify-center focus:outline-none"
        aria-label={t('ccAgent.sidebar.scheduleBinding.viewTask')}
        title={t('ccAgent.sidebar.automationGenerated')}
        onClick={(e) => void handleAutomationIconClick(e)}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <AutomationTimerIcon size={iconSize} activeForeground={isActive} />
      </button>
    ) : null;

  // list 变体标题前缀:状态图标 + 自动化徽章 + 间隔(保持 main 既有行为不变)。
  const titlePrefixNode = (
    <>
      {statusIconNode}
      {showScheduleBindingBadge || showAutomationTimer ? (
        <span className={CARD_TITLE_META_SLOT_CLASS}>{renderAutomationMeta(10)}</span>
      ) : null}
      <span
        className="inline-block"
        style={{ width: showScheduleBindingBadge || showAutomationTimer ? 7 : 6 }}
        aria-hidden
      />
    </>
  );

  return (
    <div
      ref={cardRef}
      data-session-id={session.id}
      // 多选范围选取靠 getVisibleSidebarSessionIds 扫 [data-sidebar-session-row][data-session-id];
      // 卡片也打这个标记,shift 范围选才能把卡片纳入"可见行"。
      data-sidebar-session-row="true"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        if (!isEditing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick(session.id);
        }
      }}
      onContextMenu={(e) => {
        if (isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        prefetchRemovalPreflight();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      className={cn(
        'group/card relative w-full overflow-hidden text-left cursor-pointer',
        variant === 'list'
          ? cn(
              // 扁平行(类 Telegram / 对话列表):无描边、无卡片底色,仅 hover/active 行底色。
              'rounded-lg',
              isActive ? 'bg-sidebar-item-active text-sidebar-item-active-foreground border border-[var(--sidebar-item-active-border)]' : 'hover:bg-sidebar-item-hover',
            )
          : cn(
              // 卡片:白底 + 描边 + 圆角。多列瀑布由 CardMasonry/DraggableCardColumns
              // 负责分配列;卡片高度随标题/摘要自然变化。
              'rounded-xl bg-[var(--surface-elevated)] border',
              isActive
                ? 'border-[var(--sidebar-item-active-border)] !bg-sidebar-item-active text-sidebar-item-active-foreground'
                : 'border-sidebar-border hover:!bg-sidebar-item-hover',
            ),
        // 多选选中态(与列表 SessionItem 同款):内描边软高亮,不与 active 互斥。
        isSelected && 'ring-1 ring-inset ring-[var(--focus-ring-soft)]',
        isSettling && !isActive && 'session-card--settle',
      )}
      aria-current={isActive ? 'page' : undefined}
      aria-selected={isSelected || undefined}
    >
      {variant === 'list' ? (
        // ── list 变体:扁平 Telegram 风行 ── 第 1 行标题 + 右上角时间(hover 让位
        // 给 More/Archive 操作钮,逻辑同对话列表);下方最多 2 行预览。无卡片描边底色。
        <div className="relative px-2.5 py-2">
          {/* 浅分割线:左右内缩(inset-x-2.5,短于圆角高亮方块、不触其圆角)。每行底部
              一条 → 覆盖"行间分割 + 列表底";首行额外补一条顶线 → 列表顶。本行高亮
              (active/选中/hover)时整条隐藏——不在圆角方块上/下方露出横线。 */}
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-2.5 bottom-0 h-px bg-[color-mix(in_srgb,hsl(var(--sidebar-border))_50%,transparent)] transition-opacity',
              isActive || isSelected || hideBottomDivider ? 'opacity-0' : 'group-hover/card:opacity-0',
            )}
          />
          {isFirst && (
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-x-2.5 top-0 h-px bg-[color-mix(in_srgb,hsl(var(--sidebar-border))_50%,transparent)] transition-opacity',
                isActive || isSelected ? 'opacity-0' : 'group-hover/card:opacity-0',
              )}
            />
          )}
          <div className="flex items-center gap-1.5">
            {/* 标题槽固定沿用常态时间槽的 20px 高度。改名框本身是 24px，编辑时
                绝对定位居中覆盖文字槽位，不参与布局计算，避免整条置顶任务被撑高。
                状态 / Agent / 自动化图标始终留在文字槽左侧，编辑态也不改变标题起点。 */}
            <div className="relative flex h-5 min-w-0 flex-1 items-center gap-0">
              <span className="flex shrink-0 items-center">{titlePrefixNode}</span>
              {isEditing ? (
                <SessionRenameInput
                  sessionId={session.id}
                  value={editValue}
                  onValueChange={setEditValue}
                  onCommit={commitTitle}
                  onCancel={() => {
                    // Esc 取消视为终态:置 committedRef 拦掉 input 卸载触发的 blur 提交
                    // 与生成中迟到的 AI 结果(Codex review P2:取消后不应再被 AI 改名)。
                    committedRef.current = true;
                    setIsEditing(false);
                  }}
                  containerClassName="relative min-w-0 flex-1 self-stretch"
                  inputClassName="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 text-13 font-semibold text-foreground"
                  activeForeground={isActive}
                />
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      'text-13 font-semibold leading-[1.3] tracking-[-0.005em]',
                      isActive ? 'text-sidebar-item-active-foreground' : 'text-foreground',
                    )}
                  >
                    {matchIndices && matchIndices.length > 0 && canHighlightDisplayTitle
                      ? highlightSegments(session.title, matchIndices, {
                          highlightClassName: cn(
                            'bg-transparent font-semibold',
                            isActive
                              ? 'text-[var(--sidebar-item-active-foreground)]'
                              : 'text-[var(--msg-assistant-text)]',
                          ),
                        })
                      : displayTitle}
                  </span>
                  {remoteIconKind && (
                    <RemoteProjectIcon
                      kind={remoteIconKind}
                      size={11}
                      strokeWidth={1.8}
                      connectionStatus={remoteIconConnectionStatus}
                      className={isActive ? 'text-sidebar-item-active-foreground' : 'text-[var(--text-tertiary)]'}
                    />
                  )}
                </div>
              )}
            </div>

            {/* 时间槽位:hover/菜单打开让位给 More/Archive(逻辑同对话列表)。
                Agent 身份图标留在标题左侧，状态指示器改由下方右下角承担。 */}
            {!isEditing && (
              <TimeActionsSlot
                sessionId={session.id}
                activityIso={activityIso}
                isActive={isActive}
                isArchived={isArchived}
                canQuickArchive={canQuickArchive}
                archivePending={archivePending}
                setArchivePending={beginArchivePending}
                confirmPillRef={confirmPillRef}
                menuOpen={menuPos !== null}
                onOpenMenu={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  prefetchRemovalPreflight();
                  setMenuPos({ x: rect.left, y: rect.bottom + 2 });
                }}
                onArchiveNow={() => onAction(session.id, 'archive-now')}
                canUnarchive={!remoteWritesBlocked}
                onUnarchive={handleUnarchiveSelect}
                yieldToOrdinalBadge={ordinalBadgeLabel != null}
              />
            )}
          </div>

          {/* 预览区——固定 1 行高度(标题 1 行 + 此 1 行 = 列表行统一两行高;运行 /
              非运行、内容长短都不变,始终渲染占位)。等待交互 TapTap 蓝高亮
              (--card-status-awaiting),其余状态统一走次级色。 */}
          <p
            className={cn(
              'mt-1 overflow-hidden text-11 leading-[1.45]',
              '[display:-webkit-box] [-webkit-line-clamp:1] [-webkit-box-orient:vertical]',
              rightStatusKind !== 'time' && 'pr-5',
              awaitingText
                ? isActive
                  ? 'text-[var(--sidebar-item-active-foreground)] font-medium'
                  : 'text-[var(--card-status-awaiting)] font-medium'
                : 'text-[var(--text-secondary)]',
            )}
            style={{ height: '1.45em' }}
          >
            {listPreview}
          </p>
          {rightStatusKind !== 'time' && (
            <SidebarRightStatusIndicator
              kind={rightStatusKind}
              isActive={isActive}
              className="absolute right-2.5 bottom-2"
            />
          )}
        </div>
      ) : (
      <div className="relative flex h-full flex-col px-[10px] pt-[8px] pb-[8px]">
        {/* 右上角 hover 操作钮(More + Archive/Undo);archivePending 时换成红色确认胶囊。
            时间在右下角(见下),操作钮放右上角空位、不和时间挤在一起。 */}
        {!isEditing && !archivePending && (
          <div
            className={cn(
              'absolute right-[6px] top-[6px] z-10 flex items-center gap-0.5',
              menuPos !== null ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100 focus-within:opacity-100',
            )}
          >
            <CardAction
              label={t('ccAgent.sidebar.sessionMenu.moreActions')}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                prefetchRemovalPreflight();
                setMenuPos({ x: rect.left, y: rect.bottom + 2 });
              }}
            >
              <EllipsisVertical size={13} strokeWidth={2} />
            </CardAction>
            {isArchived && !remoteWritesBlocked ? (
              <CardAction
                label={t('ccAgent.sidebar.sessionMenu.unarchive')}
                onClick={() => handleUnarchiveSelect()}
              >
                <Undo size={13} strokeWidth={2} />
              </CardAction>
            ) : canQuickArchive ? (
              <CardAction
                label={t('ccAgent.sidebar.sessionMenu.archived')}
                onClick={() => beginArchivePending(true)}
              >
                <Archive size={13} strokeWidth={2} />
              </CardAction>
            ) : null}
          </div>
        )}
        {canQuickArchive && archivePending && (
          <button
            ref={confirmPillRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setArchivePending(false);
              onAction(session.id, 'archive-now');
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cn(
              'absolute right-[6px] top-[6px] z-20 flex h-[22px] w-max min-w-14 items-center justify-center rounded-full px-[9px]',
              'whitespace-nowrap text-11 font-semibold',
              'bg-[color-mix(in_srgb,hsl(var(--destructive))_15%,var(--surface-elevated))] text-[hsl(var(--destructive))]',
              'hover:bg-[color-mix(in_srgb,hsl(var(--destructive))_25%,var(--surface-elevated))]',
              'transition-colors focus:outline-none',
            )}
            aria-label={t('ccAgent.sidebar.sessionMenu.archived')}
          >
            {t('ccAgent.sidebar.sessionMenu.archived')}
          </button>
        )}

        {/* 卡片标题始终保留原来的流式盒子；编辑时只把原标题隐藏，并以绝对定位的
            24px 输入框覆盖。这样一行 / 两行标题都维持原高度，也不会凭空多出状态图标。 */}
        <div className="relative">
          <div
            className={cn(
              'min-w-0 text-[12.5px] font-bold leading-[1.22] tracking-[-0.005em]',
              '[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden',
              isActive ? 'text-sidebar-item-active-foreground' : 'text-foreground',
              isEditing && 'invisible',
            )}
            style={{ textIndent: 0, paddingLeft: 0 }}
          >
            {matchIndices && matchIndices.length > 0 && canHighlightDisplayTitle
              ? highlightSegments(session.title, matchIndices, {
                  highlightClassName: cn(
                    'bg-transparent font-semibold',
                    isActive
                      ? 'text-[var(--sidebar-item-active-foreground)]'
                      : 'text-[var(--msg-assistant-text)]',
                  ),
                })
              : displayTitle}
          </div>
          {isEditing && (
            <SessionRenameInput
              sessionId={session.id}
              value={editValue}
              onValueChange={setEditValue}
              onCommit={commitTitle}
              onCancel={() => {
                // Esc 取消视为终态:置 committedRef 拦掉 input 卸载触发的 blur 提交
                // 与生成中迟到的 AI 结果(Codex review P2:取消后不应再被 AI 改名)。
                committedRef.current = true;
                setIsEditing(false);
              }}
              containerClassName="absolute inset-x-0 top-1/2 -translate-y-1/2"
              inputClassName="h-6 text-[12.5px] font-bold text-foreground"
              activeForeground={isActive}
            />
          )}
        </div>

        {/* 预览:等待交互文案优先,否则显示稳定任务总结 / 最近消息。图标全部下沉到底部 meta 行,
            此处只放正文文字。 */}
        {cardPreview && (
          <p
            className={cn(
              'mt-[4px] text-11 leading-[1.4]',
              '[display:-webkit-box] [-webkit-box-orient:vertical] overflow-hidden',
              'text-[var(--text-secondary)]',
            )}
            style={{ WebkitLineClamp: cardPreviewLineClamp }}
          >
            {cardPreview}
          </p>
        )}

        {/* 底部 meta 行(评审定稿):标题 / 正文之后另起整整一行。
            左侧图标簇——状态/agent 图标(含运行呼吸 + 需关注红点 + 草稿)、定时任务标识、
            远程业务标识、worktree;右下角业务时间。中间空位自然由图标簇与时间撑开。 */}
        <div
          className={cn(
            'mt-[6px] flex items-center gap-1.5',
            'text-11 font-medium leading-none tabular-nums',
            isActive ? 'text-sidebar-item-active-foreground' : 'text-[var(--text-tertiary)]',
          )}
        >
          <SessionStatusIcon
            session={session}
            isRunning={isRunning}
            isAttached={isAttached}
            hasAttentionNotification={hasAttentionNotification}
            isActive={isActive}
            size={11}
          />
          {renderAutomationMeta(11)}
          {remoteIconKind && (
            <RemoteProjectIcon
              kind={remoteIconKind}
              size={11}
              strokeWidth={1.8}
              connectionStatus={remoteIconConnectionStatus}
              className={isActive ? 'text-sidebar-item-active-foreground' : 'text-[var(--text-tertiary)]'}
            />
          )}
          <WorktreeBadge sessionId={session.id} size={11} className="size-3.5" />
          <time
            dateTime={activityIso}
            title={formatSidebarTimeAbsolute(activityIso)}
            className={cn('ml-auto shrink-0', isActive ? 'text-sidebar-item-active-foreground' : 'text-[var(--cmd-palette-item-meta)]')}
          >
            {cardTimeText}
          </time>
        </div>
      </div>
      )}

      {/* mod+1..9 序号徽标(按住修饰键浮现,见 sessionOrdinalBadges):贴右上
          时间槽位置(TimeActionsSlot 同步让位),卡片多行故不垂直居中;z-20
          压过 hover 操作钮,pointer-events-none 不挡点击。前景色与时间同色系,
          kbd 内 text-current + currentColor 底自动跟随。编辑态让位给重命名
          输入框。 */}
      {!isEditing && !archivePending && ordinalBadgeLabel != null && (
        <span
          className={cn(
            'pointer-events-none absolute right-2 top-2 z-20 flex',
            isActive
              ? 'text-sidebar-item-active-foreground'
              : 'text-[var(--text-tertiary)]',
          )}
        >
          <SessionOrdinalBadgeKbd label={ordinalBadgeLabel} />
        </span>
      )}

      {/* 右键菜单——与 SessionItem 同款 coordinate-anchored DropdownMenu */}
      {!isEditing && (
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
            onClick={(e) => e.stopPropagation()}
            className={cn(MENU_CONTENT_CLASS, 'min-w-32 overflow-hidden')}
          >
            {isArchived ? (
              <>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleRenameSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleUnarchiveSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.unarchive')}
                </DropdownMenuItem>
                {copySessionIdSubmenu}
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleDeleteSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.delete')}
                </DropdownMenuItem>
              </>
            ) : isEmpty ? (
              <>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleRenameSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.rename')}
                </DropdownMenuItem>
                {copySessionIdSubmenu}
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleDeleteSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.delete')}
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handlePinSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {isPinned ? t('ccAgent.sidebar.sessionMenu.unpin') : t('ccAgent.sidebar.sessionMenu.pin')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleRenameSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.rename')}
                </DropdownMenuItem>
                {moveToProjectSubmenu}
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                {copySessionIdSubmenu}
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleOpenInNewWindowSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.openInNewWindow')}
                </DropdownMenuItem>
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleArchiveSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.archived')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleDeleteSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** 右上角时间槽位——card / list 变体共用。默认显示 [worktree + 时间];hover/菜单打开
 *  时整组让位给操作按钮(More + Archive/Undo),archivePending 时显示红色二次确认胶囊。
 *  交互逻辑与对话列表(SessionItem)一致。Agent 身份 / 草稿由左侧 SessionStatusIcon 承担；
 *  list 的右下状态指示器由 SidebarRightStatusIndicator 单独承担。 */
function TimeActionsSlot({
  sessionId,
  activityIso,
  isActive,
  isArchived,
  canQuickArchive,
  canUnarchive,
  archivePending,
  setArchivePending,
  confirmPillRef,
  menuOpen,
  onOpenMenu,
  onArchiveNow,
  onUnarchive,
  yieldToOrdinalBadge = false,
}: {
  sessionId: string;
  activityIso: string;
  isActive: boolean;
  isArchived: boolean;
  canQuickArchive: boolean;
  canUnarchive: boolean;
  archivePending: boolean;
  setArchivePending: (v: boolean) => void;
  confirmPillRef: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onOpenMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onArchiveNow: () => void;
  onUnarchive: () => void;
  /** mod+1..9 序号徽标出现时让位:徽标独占右缘,不与时间/badge 并排。 */
  yieldToOrdinalBadge?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="group/slot relative ml-auto flex h-5 shrink-0 items-center justify-end">
      {/* 默认内容:worktree + 时间;hover / 菜单打开 / archivePending 时淡出让位给操作钮。 */}
      <div
        className={cn(
          // duration 与操作钮的渐显同拍(120ms),让位/回归一进一出同步。
          'flex items-center gap-1 transition-opacity duration-[120ms]',
          !archivePending && 'group-hover/card:opacity-0 group-focus-within/slot:opacity-0',
          (menuOpen || yieldToOrdinalBadge) && 'opacity-0',
          // 确认胶囊覆盖同一槽位时立即隐藏日期，避免 120ms 淡出期间文字叠在一起。
          archivePending && 'invisible opacity-0',
        )}
      >
        <WorktreeBadge sessionId={sessionId} size={11} className="size-3.5" />
        <time
          dateTime={activityIso}
          title={formatSidebarTimeAbsolute(activityIso)}
          className={cn(
            'text-[10.5px] font-medium leading-none tabular-nums',
            isActive ? 'text-sidebar-item-active-foreground' : 'text-[var(--text-tertiary)]',
          )}
        >
          {formatSidebarTime(activityIso, t)}
        </time>
      </div>

      {canQuickArchive && archivePending && (
        <button
          ref={confirmPillRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setArchivePending(false);
            onArchiveNow();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute right-0 top-1/2 z-20 flex h-[22px] w-max min-w-14 -translate-y-1/2 items-center justify-center rounded-full px-[9px]',
            'whitespace-nowrap text-11 font-semibold',
            'bg-[color-mix(in_srgb,hsl(var(--destructive))_15%,var(--surface-elevated))] text-[hsl(var(--destructive))]',
            'hover:bg-[color-mix(in_srgb,hsl(var(--destructive))_25%,var(--surface-elevated))]',
            'transition-colors focus:outline-none',
          )}
          aria-label={t('ccAgent.sidebar.sessionMenu.archived')}
        >
          {t('ccAgent.sidebar.sessionMenu.archived')}
        </button>
      )}

      {!archivePending && (
        <div
          // 渐显(120ms)配 pointer-events 守卫:淡出期间按钮不占鼠标位置,
          // 不会拦下卡片点击;键盘焦点不受 pointer-events 影响。
          className={cn(
            'absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5',
            'transition-opacity duration-[120ms]',
            menuOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-focus-within/slot:pointer-events-auto group-focus-within/slot:opacity-100',
          )}
        >
          <CardAction
            variant="list"
            isActive={isActive}
            label={t('ccAgent.sidebar.sessionMenu.moreActions')}
            onClick={onOpenMenu}
          >
            <EllipsisVertical size={14} strokeWidth={2} />
          </CardAction>
          {isArchived && canUnarchive ? (
            <CardAction
              variant="list"
              isActive={isActive}
              label={t('ccAgent.sidebar.sessionMenu.unarchive')}
              onClick={() => onUnarchive()}
            >
              <Undo size={14} strokeWidth={2} />
            </CardAction>
          ) : canQuickArchive ? (
            <CardAction
              variant="list"
              isActive={isActive}
              label={t('ccAgent.sidebar.sessionMenu.archived')}
              onClick={() => setArchivePending(true)}
            >
              <Archive size={14} strokeWidth={2} />
            </CardAction>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 卡片右上角 hover action 钮；list 变体复用文字模式的轻量行内按钮。 */
function CardAction({
  variant = 'card',
  isActive = false,
  label,
  onClick,
  children,
}: {
  variant?: 'card' | 'list';
  isActive?: boolean;
  label: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        variant === 'list'
          ? cn(
              'shrink-0 size-5 flex items-center justify-center rounded-md',
              'focus:outline-none',
              isActive
                ? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
                : 'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground',
            )
          : cn(
              'flex size-6 items-center justify-center rounded-[7px]',
              'bg-[var(--cmd-palette-bg)] text-[var(--text-tertiary)]',
              'border border-sidebar-border',
              'hover:bg-sidebar-item-hover hover:text-foreground focus:outline-none',
            ),
      )}
    >
      {children}
    </button>
  );
}
