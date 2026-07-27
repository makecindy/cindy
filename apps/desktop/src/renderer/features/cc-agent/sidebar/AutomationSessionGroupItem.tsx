import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, EllipsisVertical, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { VendorIcon } from '@/components/sidebar/VendorIcon';
import type { Session } from '@/lib/ccAgent.types';
import type { AutomationScheduleAction, AutomationSessionGroup } from '../lib/automationSidebarGrouping';
import {
  getAutomationGroupChildView,
  getAutomationGroupLatestSession,
} from '../lib/automationSidebarGrouping';
import { useAutomationGroupCollapsed } from '../hooks/useAutomationGroupCollapsed';
import { formatSidebarFutureTime, formatSidebarTime } from '../lib/formatSidebarTime';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import { hasSessionSelectionModifier, SessionItem } from './SessionItem';
import type { SessionClickHandler } from './SessionItem';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from './menuStyles';
import { useSessionAttentionUrgency } from '../contexts/SessionAttentionUrgencyContext';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { resolveSidebarRightStatus } from './sidebarRightStatus';
import { AutomationTimerIcon } from './AutomationTimerIcon';
import { SessionCard } from './SessionCard';

export interface AutomationSessionGroupItemProps {
  group: AutomationSessionGroup;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  indented?: boolean;
  /**
   * 展开的子 SessionItem 行 hover 时右侧浮层展示的"项目来源"标签映射(sessionId →
   * displayName / "对话" / basename)。父层 SessionEntryList 计算,穿透 group 组件
   * 传给子行,自动化 group 里的子会话也能显示来源。
   */
  sourceLabelMap?: ReadonlyMap<string, string>;
  /** 项目置顶列表模式下，展开的自动化运行也使用同一套列表行。 */
  sessionVariant?: 'text' | 'list';
}

interface FrozenGroupState {
  sessionId: string;
  originActiveSessionId: string | null;
  hasBeenActive: boolean;
  visibleSessionIds: string[];
}

export function AutomationSessionGroupItem({
  group,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onScheduleAction,
  indented = false,
  sourceLabelMap,
  sessionVariant = 'text',
}: AutomationSessionGroupItemProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // 轴 1:文件夹开/关,持久化、记忆上次(默认展开),像项目分组一样。
  const [collapsed, toggleCollapsed] = useAutomationGroupCollapsed(group.id);
  // 轴 2:展开后运行列表内部的「前 5 条 / 显示全部」临时态,离开自动收回。
  const [showAll, setShowAll] = useState(false);
  const [frozen, setFrozen] = useState<FrozenGroupState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [countdownNowMs, setCountdownNowMs] = useState(() => Date.now());
  // 组头 = 组内「最新一条」运行的代理:状态、running/loading、点击打开目标都跟这条一致。
  // 用 group.sessions 派生(仅活动时间排序,不掺 running/notifications),引用随组内成员
  // 变化才变,天然稳定,无需再靠 frozen 快照固定"代表会话"。
  const latestSession = useMemo(() => getAutomationGroupLatestSession(group), [group]);
  const latestSessionId = latestSession?.id;
  // childView 的 24h 豁免依赖实时 now,必须每次渲染直接算,不能进 useMemo —— 否则依赖项
  // 不变时时间窗口会被冻结,跨过 24h 阈值的运行不会及时移出豁免。与普通对话列表
  // SessionEntryList 一致(它也是 render 内直接算 getSessionListCollapseView、不 memo);
  // 计算本身是 O(组内运行数) 的轻量过滤,无需 memo。
  const childView = getAutomationGroupChildView(group, {
    notifications,
    runningSessionIds,
    showAll,
    activeSessionId,
    frozenVisibleSessionIds: frozen?.visibleSessionIds ?? null,
    // 实时 now:启用「最近 24h 内有活动不折叠」豁免,和普通对话列表一致。
    nowMs: Date.now(),
  });
  // 轴 1 收起时藏掉全部子运行(只留组头);展开时才交给轴 2 的「前 5 / 显示全部」。
  const visibleSessions = collapsed ? [] : childView.visibleSessions;
  const attentionCount = group.attentionSessionIds.filter((id) => notifications.has(id)).length;
  // 组头右侧状态图标来源(全端统一 5 档色表:error 红 > awaiting TapTap 蓝 >
  // running spinner > 完成未读绿 > time),两路信号都只看「最新一条」运行:
  //   1. SessionAttentionUrgencyContext:该 run 是失败 schedule run(attentionKind 缺失
  //      但语义等同 error)→ 红
  //   2. sessionAttentionStore kind:该 run 有 chat 侧 urgent attention
  //      (错误终止 → 红;pending ask-user / 权限 → 蓝)
  // 组头状态 = 组内「最新一条」运行的状态(不再跨组聚合):折叠态下组头只代表最新那条,
  // 点击也打开它,状态/loading 与其保持一致。两个 hook 都按 latestSessionId 精准订阅
  // (boolean / kind primitive 快照),只有最新那条的 attention/urgency 翻转才唤醒本组件
  // (性能不变量,别退回整组 / 整张表订阅)。
  const latestUrgentFromSchedule = useSessionAttentionUrgency(latestSessionId ?? '');
  const latestChatKind = useSessionAttentionKind(latestSessionId ?? '');
  const scheduleId = group.scheduleId;
  // 「已停止」= paused(用户主动暂停)+ expired(计划到期不再触发);两者对用户体验
  // 而言都是「不会再自动跑」,视觉上都在 Timer chip 上叠 Pause 徽标,并在 tooltip
  // 里显示「已停止」文案,避免用户误判为普通空闲态。
  const isScheduleStopped =
    group.scheduleStatus === 'paused' || group.scheduleStatus === 'expired';
  const hasVisibleChildren = visibleSessions.length > 0;
  // running / loading 也只看最新那条:组头 vendor mark 呼吸 + Timer chip 呼吸 + 右侧
  // spinner 都据此,与最新 session 子行一致(需求:「loading 状态和最新的 session 保持一致」)。
  const isRunning = latestSessionId != null && runningSessionIds.has(latestSessionId);
  const primaryActivityIso = latestSession?.updatedAt;
  const hasActiveHidden =
    activeSessionId != null &&
    group.sessions.some((session) => session.id === activeSessionId) &&
    !visibleSessions.some((session) => session.id === activeSessionId);
  const shouldTickCountdown =
    group.scheduleStatus === 'active' &&
    typeof group.nextFireAt === 'number' &&
    Number.isFinite(group.nextFireAt) &&
    group.nextFireAt > countdownNowMs;
  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  // 组头右侧状态槽复用 SessionItem 的 5 档色表(error 红 / awaiting 蓝 / running spinner /
  // done 绿 / time 文字):四个 input 全部取「最新一条」运行,送进同一 resolveSidebarRightStatus,
  // 于是组头右侧状态与最新 session 子行像素级一致(色号 / 图标尺寸 / 判定完全同源)。
  const latestHasNotification = latestSessionId != null && notifications.has(latestSessionId);
  const groupRightStatusKind = resolveSidebarRightStatus({
    attentionKind: latestChatKind,
    isUrgentFromContext: latestUrgentFromSchedule,
    isRunning,
    hasAttentionNotification: latestHasNotification,
  });
  const showRightStatus = groupRightStatusKind !== 'time';
  const actionButtonToneClassName = hasActiveHidden
    ? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
    : 'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground';

  const freezeCurrentLayout = (sessionId: string): void => {
    setFrozen({
      sessionId,
      originActiveSessionId: activeSessionId ?? null,
      hasBeenActive: false,
      visibleSessionIds: visibleSessions.map((session) => session.id),
    });
  };

  // 子行 onClick 必须引用稳定,否则 SessionItem 的 memo 每次组头重渲染都被击穿。
  // 但 freeze 需要读"点击瞬间"的最新布局(activeSessionId / visibleSessions 等),
  // 依赖全塞进 useCallback 会让引用照样天天变 —— 用 latest-ref 模式:render 时同步
  // 刷 ref,handler 本体只依赖 onSessionClick(上游 useCallback,稳定)。
  const freezeCurrentLayoutRef = useRef(freezeCurrentLayout);
  freezeCurrentLayoutRef.current = freezeCurrentLayout;
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;
  const handleChildSessionClick = useCallback<SessionClickHandler>(
    (id, modifiers) => {
      if (!showAllRef.current && !hasSessionSelectionModifier(modifiers)) {
        freezeCurrentLayoutRef.current(id);
      }
      onSessionClick(id, modifiers);
    },
    [onSessionClick],
  );

  useEffect(() => {
    if (!frozen) return;
    const stillInGroup = group.sessions.some((session) => session.id === frozen.sessionId);
    if (!stillInGroup) {
      setFrozen(null);
      return;
    }
    if (activeSessionId === frozen.sessionId) {
      if (!frozen.hasBeenActive) {
        setFrozen({ ...frozen, hasBeenActive: true });
      }
      return;
    }
    if (
      frozen.hasBeenActive ||
      (activeSessionId ?? null) !== frozen.originActiveSessionId
    ) {
      setFrozen(null);
    }
  }, [activeSessionId, frozen, group.sessions]);

  // 手动展开(showAll)后,焦点一旦离开本组就自动收回 —— 让自动化分组和普通对话一样
  // 不会越用越长。沿用 frozen 的「曾锚定 → 离开」判定:展开瞬间记下当时的 active 会话,
  // 之后 active 落到组内即视为锚定;锚定过(或 active 已不是展开时那个会话)再离开组时收回。
  const prevShowAllRef = useRef(false);
  const expandAnchorRef = useRef<{
    originActiveSessionId: string | null;
    hasFocusedGroup: boolean;
  } | null>(null);
  useEffect(() => {
    if (showAll && !prevShowAllRef.current) {
      expandAnchorRef.current = {
        originActiveSessionId: activeSessionId ?? null,
        hasFocusedGroup: false,
      };
    } else if (!showAll) {
      expandAnchorRef.current = null;
    }
    prevShowAllRef.current = showAll;

    const anchor = expandAnchorRef.current;
    if (!showAll || !anchor) return;
    const activeInGroup =
      activeSessionId != null && group.sessions.some((session) => session.id === activeSessionId);
    if (activeInGroup) {
      anchor.hasFocusedGroup = true;
      return;
    }
    if (anchor.hasFocusedGroup || (activeSessionId ?? null) !== anchor.originActiveSessionId) {
      setShowAll(false);
      expandAnchorRef.current = null;
    }
  }, [activeSessionId, group.sessions, showAll]);

  useEffect(() => {
    if (!shouldTickCountdown) return;
    setCountdownNowMs(Date.now());
    const timer = window.setInterval(() => {
      setCountdownNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [group.nextFireAt, shouldTickCountdown]);

  // meta = 「time」分支才用的最近活动相对时间。error / awaiting / running / done 四档
  // 状态改由右侧状态图标(showRightStatus)统一表达,不再走文字。仅当 groupRightStatusKind
  // === 'time' 时 meta 才会被读到。
  const meta = useMemo(() => {
    const lastRunText = formatSidebarTime(primaryActivityIso, t);
    if (lastRunText) return lastRunText;
    return t('ccAgent.sidebar.automationGroup.runCount', { count: group.sessions.length });
  }, [group.sessions.length, primaryActivityIso, t]);

  // 行 hover tooltip 内容:active 状态下的下次运行倒计时(如「5分钟后」)/ paused|expired
  // 时的「已停止」+ 累计运行次数(取 group.sessions.length,一次调度产生一条会话)。全为
  // 空时返回 null,Tip 会在 text 为空时直接透传 children,不挂 tooltip。
  // useMemo:countdownNowMs 每秒 tick,内联 JSX 会每秒重建 element ref,Radix Tooltip
  // 可能因此重挂内容;memo 后仅在文案实际变化时才刷新。
  const countdownText = shouldTickCountdown
    ? formatSidebarFutureTime(group.nextFireAt, t, new Date(countdownNowMs))
    : '';
  const stoppedText = isScheduleStopped
    ? t('ccAgent.sidebar.automationGroup.stopped')
    : '';
  const runCountText = group.sessions.length > 0
    ? t('ccAgent.sidebar.automationGroup.runCount', { count: group.sessions.length })
    : '';
  const rowTooltip = useMemo(
    () =>
      countdownText || stoppedText || runCountText ? (
        <div className="flex flex-col gap-0.5">
          {countdownText && <span>{countdownText}</span>}
          {stoppedText && <span>{stoppedText}</span>}
          {runCountText && <span>{runCountText}</span>}
        </div>
      ) : null,
    [countdownText, runCountText, stoppedText],
  );

  // 点击空白行区域 = 点击标题,统一打开组内「最新一条」运行(需求:「点击这条自动化
  // 折叠也打开最新的 session」)。行内可交互控件(chevron toggle / Timer logo / Run /
  // More)在自己的 handler 里 stopPropagation,不会误触发。
  const openLatestSession = () => {
    if (!latestSession) return;
    // 仅在展开 + 前 5 条态下冻结当前布局;收起态无子项可冻结。
    if (!collapsed && !showAll) freezeCurrentLayout(latestSession.id);
    onSessionClick(latestSession.id);
  };

  return (
    <div className="flex w-full flex-col gap-0.5">
      {/* 行 hover 浮层视觉与 SessionTooltip(PR 引用)对齐:右侧 align=start 弹出、
          浅色 surface(--surface-elevated + --border-default + shadow-sm)、立即出现,
          和侧栏其它 hover 卡片在同一套调色板下(规则 16)。 */}
      <Tip
        text={rowTooltip}
        side="right"
        delay={0}
        contentClassName={cn(
          'bg-[var(--surface-elevated)] text-[var(--text-primary)]',
          'border-[var(--border-default)] dark:border-[var(--border-default)] shadow-sm',
        )}>
        {/* 行 onClick 只承担鼠标点击空白 = 点击标题的转发;不加 role="button" / tabIndex /
            onKeyDown —— ARIA 不允许 role=button widget 内嵌可交互 <button>,且键盘 keydown
            会冒泡穿过内部按钮的 stopPropagation(click 语义)造成双触发。键盘可达性由内部
            标题 <button>(Tab focus + Enter/Space)天然提供。 */}
        <div
          onClick={openLatestSession}
          className={cn(
            // rounded-full + 22px 缩进:与同列表的 SessionItem 行同款药丸形/缩进
            // (2026-07 侧栏视觉统一)。
            'group relative flex h-8 w-full items-center gap-1.5 rounded-full',
            indented ? 'pl-[22px] pr-2' : 'pl-3 pr-2',
            'text-left text-sm font-medium',
            hasActiveHidden
              ? 'bg-sidebar-item-active text-[var(--sidebar-item-active-foreground)]'
              : 'text-foreground hover:bg-sidebar-item-hover',
            latestSession && 'cursor-pointer',
          )}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openLatestSession();
            }}
            disabled={!latestSession}
            className="flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"
          >
            {/* 引擎 logo(vendor mark)——复用 SessionItem 左侧 15px 定宽槽与尺寸规则,
                保证自动任务组头和普通会话的首图标落在同一列。分组 agentKind 取
                最新一条 run(同一 schedule 所有 run 走同一 agent),缺失时退化为
                'cc'。isRunning 只看最新那条,与其子行一致。 */}
            <span className="flex w-[15px] shrink-0 items-center justify-center">
              <VendorIcon
                vendor={latestSession?.agentKind === 'codex' ? 'codex' : 'cc'}
                size={latestSession?.agentKind === 'codex' ? 12 : 13}
                running={isRunning}
                colorClassName={hasActiveHidden ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}
              />
            </span>
            {/* 延续原 Clock 的紧凑节奏:vendor → Timer 与 Timer → 标题均留 6px。 */}
            <span className="flex min-w-0 items-center gap-1.5">
              {/* Timer 点击跳自动化页对应条目。宿主已是 title <button>,不能嵌套
                  button,用 span role="button" + stopPropagation 拦下行点击。 */}
              <span
                role="button"
                tabIndex={-1}
                aria-label={t('ccAgent.sidebar.scheduleBinding.viewTask')}
                title={t('ccAgent.sidebar.scheduleBinding.viewTask')}
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(
                    group.scheduleId
                      ? scheduleFocusPath(group.scheduleId)
                      : '/cc-agent/scheduled',
                  );
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="relative inline-flex size-3 shrink-0 cursor-pointer items-center justify-center"
              >
                {/* Timer 始终占同一个 12px 槽；暂停/过期只叠状态角标，不替换主图标。 */}
                <AutomationTimerIcon
                  size={10}
                  paused={isScheduleStopped}
                  activeForeground={hasActiveHidden}
                  running={isRunning}
                />
              </span>
              <span className="min-w-0 truncate">{group.title}</span>
            </span>
          </button>
          {/* 展开箭头挪到标题后,视觉上属于「标题右侧的次要控件」,和右侧 meta/操作
              槽用 ml-auto 分开;shrink-0 保证长标题挤压时不会先把 chevron 挤没。 */}
          <button
            type="button"
            onClick={(event) => {
              // 阻止冒泡到行级 onClick(否则一次点击既切展开又打开会话)。
              event.stopPropagation();
              setFrozen(null);
              // 收起文件夹时顺手复位轴 2,下次展开从「前 5 条」开始,而不是停在「显示全部」。
              if (!collapsed) setShowAll(false);
              toggleCollapsed();
            }}
            aria-expanded={!collapsed}
            aria-label={t('ccAgent.sidebar.automationGroup.aria', {
              title: group.title,
              count: group.sessions.length,
              attention: attentionCount,
            })}
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-md',
              hasActiveHidden
                ? 'hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
                : 'hover:bg-sidebar-item-hover',
            )}
          >
            <ToggleIcon
              size={12}
              strokeWidth={2}
              className={hasActiveHidden ? 'text-[var(--sidebar-item-active-foreground)]' : 'text-[var(--cmd-palette-item-meta)]'}
            />
          </button>
          {/* focus 隐藏条件用命名 group(/slot) 收窄到本槽位:行内 toggle/title
              button 点击后焦点常驻行内,整行 group-focus-within 会让选中态
              (非 hover)的 meta 文本被永久隐藏,与 SessionItem 同款修法。 */}
          <div className="group/slot relative ml-auto flex h-6 min-w-14 max-w-[96px] shrink-0 items-center justify-end">
            {/* 右侧状态槽 —— 与 SessionItem 同款五档色表 / 图标尺寸(size-4 wrapper +
                size-2 dot / size-12 spinner),让分组头和普通任务行状态语义视觉可比。
                showRightStatus=true 时渲染状态图标(error/awaiting/done 圆点 + running
                spinner),false 时回落到 meta 相对时间文字。scheduleId 存在时统一 hover
                fade 出让位给 [Run][More] 按钮组。 */}
            <div
              className={cn(
                'flex items-center gap-1 text-xs font-medium',
                hasActiveHidden ? 'text-[var(--sidebar-item-active-foreground)]' : 'text-sidebar-action-icon',
                scheduleId && !menuOpen && 'group-hover:opacity-0 group-focus-within/slot:opacity-0',
                menuOpen && 'opacity-0',
              )}
            >
              {showRightStatus ? (
                groupRightStatusKind === 'error' ? (
                  <span
                    role="img"
                    className="inline-flex size-4 items-center justify-center"
                    aria-label={t('ccAgent.sidebar.status.error', 'Failed — click to view')}
                    title={t('ccAgent.sidebar.status.error', 'Failed — click to view')}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: hasActiveHidden ? 'var(--sidebar-item-active-foreground)' : 'var(--card-status-error)' }}
                      aria-hidden
                    />
                  </span>
                ) : groupRightStatusKind === 'awaiting' ? (
                  <span
                    role="img"
                    className="inline-flex size-4 items-center justify-center"
                    aria-label={t('ccAgent.sidebar.status.needsAttention', 'Awaiting your input')}
                    title={t('ccAgent.sidebar.status.needsAttention', 'Awaiting your input')}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: hasActiveHidden ? 'var(--sidebar-item-active-foreground)' : 'var(--card-status-awaiting)' }}
                      aria-hidden
                    />
                  </span>
                ) : groupRightStatusKind === 'running' ? (
                  <Spinner
                    role="img"
                    size={12}
                    strokeWidth={2}
                    className={cn(
                      'size-4',
                      hasActiveHidden ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
                    )}
                    aria-label={t('ccAgent.sidebar.status.running', 'Running')}
                    title={t('ccAgent.sidebar.status.running', 'Running')}
                  />
                ) : (
                  <span
                    role="img"
                    className="inline-flex size-4 items-center justify-center"
                    aria-label={t('ccAgent.sidebar.status.done', 'Completed — click to view')}
                    title={t('ccAgent.sidebar.status.done', 'Completed — click to view')}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: hasActiveHidden ? 'var(--sidebar-item-active-foreground)' : 'var(--card-status-done)' }}
                      aria-hidden
                    />
                  </span>
                )
              ) : (
                <span className="min-w-0 truncate text-right">{meta}</span>
              )}
            </div>
            {scheduleId && (
              <div
                className={cn(
                  'absolute right-0 top-0 flex h-6 items-center gap-0.5',
                  'opacity-0 transition-opacity',
                  menuOpen
                    ? 'opacity-100'
                    : 'group-hover:opacity-100 group-focus-within/slot:opacity-100',
                )}
              >
                {/* 高频 Run 继续直点;Edit/Pause/Resume/Delete 收进 More 菜单,避免 Edit
                    和左侧 Timer chip 形成重复入口,同时保留原来菜单里的低频操作空间。 */}
                <Tip text={t('ccAgent.sidebar.automationGroup.menu.runNow')} side="bottom">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      // 点击后主动 blur:group/slot 的 focus-within 会让操作按钮
                      // 常驻可见 + meta 常隐,鼠标移开也不恢复;显式失焦让 hover 语义
                      // 重新接管。
                      event.currentTarget.blur();
                      onScheduleAction(group, 'run');
                    }}
                    aria-label={t('ccAgent.sidebar.automationGroup.menu.runNow')}
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-md',
                      'transition-colors',
                      actionButtonToneClassName,
                    )}
                  >
                    <Play size={14} strokeWidth={2} />
                  </button>
                </Tip>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        event.currentTarget.blur();
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      aria-label={t('ccAgent.sidebar.automationGroup.menu.more')}
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-md',
                        'transition-colors',
                        actionButtonToneClassName,
                      )}
                    >
                      <EllipsisVertical size={14} strokeWidth={2} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={2}
                    onClick={(event) => event.stopPropagation()}
                    className={cn(MENU_CONTENT_CLASS, 'min-w-36 overflow-hidden')}
                  >
                    <DropdownMenuItem
                      onSelect={() => onScheduleAction(group, 'edit')}
                      className={MENU_ITEM_CLASS}
                    >
                      {t('ccAgent.sidebar.automationGroup.menu.edit')}
                    </DropdownMenuItem>
                    {group.scheduleStatus !== 'expired' && (
                      <DropdownMenuItem
                        onSelect={() => onScheduleAction(group, 'toggle-pause')}
                        className={MENU_ITEM_CLASS}
                      >
                        {group.scheduleStatus === 'paused'
                          ? t('ccAgent.sidebar.automationGroup.menu.resume')
                          : t('ccAgent.sidebar.automationGroup.menu.pause')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                    <DropdownMenuItem
                      onSelect={() => onScheduleAction(group, 'delete')}
                      disabled={group.scheduleSource === 'project' && (!group.workingDir || !group.projectConfigId)}
                      className={cn(MENU_ITEM_CLASS, 'text-[hsl(var(--destructive))]')}
                    >
                      {t('ccAgent.sidebar.automationGroup.menu.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </div>
      </Tip>
      {hasVisibleChildren && (
        <div className="flex flex-col gap-0.5 pl-3">
          {visibleSessions.map((session: Session, index) => {
            const nextSession = visibleSessions[index + 1];
            const nextHighlighted =
              nextSession != null &&
              (nextSession.id === activeSessionId ||
                (selectedSessionIds?.has(nextSession.id) ?? false));
            const commonProps = {
              session,
              isActive: session.id === activeSessionId,
              isRunning: runningSessionIds.has(session.id),
              isAttached: attachedSessionIds.has(session.id),
              hasAttentionNotification: notifications.has(session.id),
              isSelected: selectedSessionIds?.has(session.id) ?? false,
              onClick: handleChildSessionClick,
              onAction,
              onRename,
              onTogglePin,
              indented,
            };

            return sessionVariant === 'list' ? (
              <SessionCard
                key={session.id}
                {...commonProps}
                variant="list"
                isFirst={index === 0}
                hideBottomDivider={nextHighlighted}
              />
            ) : (
              <SessionItem
                key={session.id}
                {...commonProps}
                sourceLabel={sourceLabelMap?.get(session.id)}
                insideAutomationGroup
              />
            );
          })}
          {!showAll && childView.isOverflowing && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={cn(
                'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
                'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              {t('ccAgent.sidebar.showAllSessions', { count: childView.totalCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
