/**
 * SessionItem — 单条 CCS 会话行
 * ---------------------------------------------------------------------------
 * 从 CCAgentSidebarUpper 抽出，行为 100% 复用：
 *   - 200ms 防抖区分单击导航 / 双击重命名
 *   - 双击或 Pencil 图标进入重命名；Enter 提交、Escape 取消、Blur 提交
 *   - 左侧 status zone 直接渲染 vendor mark（Claude=AA / Codex=六瓣）—— 同一 icon
 *     承担 vendor 标识 + 运行状态：idle 灰、running 切 Thinking Orange + 呼吸、
 *     需关注时叠右上红点、archived 改 Archive icon。**Pin 入口走右键菜单**
 *     （避免与会话菜单内 Pin/Unpin 重复）
 *   - 右键(contextmenu) 弹出 DropdownMenu —— 与 ProjectNode 同款 coordinate-anchored
 *     pattern（fixed-position 隐形 trigger 锚定到鼠标坐标）。
 *     菜单内容按状态分支（F-PJ-9：标准 Pin/Rename/Archived；Pinned Unpin/Rename/Archived；
 *     Draft Rename/Delete；Archived Rename/Unarchive/Delete）
 *   - hover 时右侧显示 Archive 图标按钮（archive 快捷入口），采用 Codex 风的"行内两步
 *     确认"模式：第一次点击 → 按钮就地变成红色 Confirm 胶囊（pending 态，无弹窗）；
 *     第二次点击 → 通过 onAction(id, 'archive-now') 走父层的"跳过 ConfirmDialog 直接执行"
 *     分支；4 秒不操作 / 在 pending 期间点击别处任意位置 → 自动撤回到 Archive 图标。
 *     仅对"可归档"的 session 显示（非 archived、非空 draft）；其它两种状态隐藏按钮，
 *     用户走右键菜单（Unarchive / Delete，仍保留原 ConfirmDialog 弹窗）。
 *   - 选中态 bg-sidebar-item-active + font-semibold
 *
 * 关于 indented prop（缩进控制）：
 *   - indented=true（ProjectNode 内子 session）：`pl-[22px]`(2026-07 用户定稿,
 *     tech_spec ADR 原 18px 基础上 +4px 加深层级)。
 *   - indented=false（Pinned / Unclassified / Dialogue 顶层 session）：`pl-3`。
 *   2026-07 用户定稿的文字列对齐:状态图标包在 15px 定宽槽内;普通会话行使用
 *   gap-2.5(10px),与顶部导航行 / 项目行同构。自动任务行因中间还有 Timer,
 *   Agent → Timer 沿用原 Clock 的 gap-1.5(6px),Timer → 标题同为 6px。
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Archive, ChevronRight, EllipsisVertical, Play, Undo } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import { WorktreeBadge } from '@/components/sidebar/WorktreeBadge';
import { SessionStatusIcon } from './SessionStatusIcon';
import { SessionRenameInput } from '../SessionRenameInput';
import { usePrRefsForSession } from '@/contexts/PrRefsContext';
import { SessionTooltip } from './SessionTooltip';
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
import { useSessionBoundSchedules } from '@/features/scheduler/lib/scheduleSessionBinding';
import { loadScheduleSidebarIndexRuns, type ScheduleSidebarIndexRun } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import { useSchedulesSnapshot } from '@/features/scheduler/lib/schedulesStore';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import { ScheduleBindingBadge } from './ScheduleBindingBadge';
import { SessionOrdinalBadgeKbd, useSessionOrdinalBadge } from './sessionOrdinalBadges';
import { SessionProjectMoveSubmenu } from './SessionProjectMoveSubmenu';
import type { SessionMoveTarget } from './sessionMoveTarget';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import { RemoteProjectIcon } from './RemoteProjectIcon';
import { SessionShareExportDialog } from './SessionShareExportDialog';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';
import { prefetchDirtyWorktreeForRemoval } from '@/lib/worktreeRemovalWarning';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { useSessionAttentionUrgency } from '../contexts/SessionAttentionUrgencyContext';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { resolveSidebarRightStatus } from './sidebarRightStatus';
import { AutomationTimerIcon } from './AutomationTimerIcon';
import { SidebarRightStatusIndicator } from './SidebarRightStatusIndicator';
import { shouldPrefetchSessionOnPointerDown } from './sessionSwitchPrefetch';

// Module-level dedup cache for loadScheduleSidebarIndexRuns.
// When many ungrouped automation rows mount simultaneously they all need the
// same IPC+DB query. Share the in-flight Promise so N mounts → 1 query;
// the cache is cleared after 1 second so a subsequent sidebar change (new
// run recorded, schedule deleted, …) gets fresh data on the next effect run.
let _scheduleIndexPromise: Promise<ScheduleSidebarIndexRun[]> | null = null;
function loadScheduleSidebarIndexRunsCached(): Promise<ScheduleSidebarIndexRun[]> {
  if (!_scheduleIndexPromise) {
    _scheduleIndexPromise = loadScheduleSidebarIndexRuns().finally(() => {
      setTimeout(() => {
        _scheduleIndexPromise = null;
      }, 1000);
    });
  }
  return _scheduleIndexPromise;
}

const log = createLogger('SessionItem');

interface SidebarTitleMarqueeProps {
  children: ReactNode;
  className?: string;
  title: string;
}

/**
 * 标题保持原生省略号，只有实际溢出且鼠标停留在标题区域时才播放一次横向滚动。
 * 通过 DOM 属性和 CSS 变量驱动，避免给高密度侧栏行增加 React 状态订阅。
 */
function SidebarTitleMarquee({ children, className, title }: SidebarTitleMarqueeProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const isHoveredRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const stopMarquee = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    delete container.dataset.titleOverflowing;
    container.style.removeProperty('--sidebar-title-marquee-shift');
    container.style.removeProperty('--sidebar-title-marquee-duration');
  }, []);

  const startMarquee = useCallback(() => {
    const container = containerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;

    delete container.dataset.titleOverflowing;
    container.style.removeProperty('--sidebar-title-marquee-shift');
    container.style.removeProperty('--sidebar-title-marquee-duration');
    if (track.scrollWidth <= container.clientWidth + 1) return;

    const viewportCount = Math.max(
      1,
      Math.ceil(track.scrollWidth / Math.max(container.clientWidth, 1)),
    );
    container.style.setProperty(
      '--sidebar-title-marquee-shift',
      `${container.clientWidth - track.scrollWidth}px`,
    );
    container.style.setProperty(
      '--sidebar-title-marquee-duration',
      `calc(var(--motion-sidebar-title-marquee-per-viewport) * ${viewportCount})`,
    );
    container.dataset.titleOverflowing = 'true';
  }, []);

  const stopObserving = useCallback(() => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
  }, []);

  const startObserving = useCallback(() => {
    stopObserving();
    const container = containerRef.current;
    const track = trackRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (isHoveredRef.current) startMarquee();
    });
    observer.observe(container);
    if (track) observer.observe(track);
    resizeObserverRef.current = observer;
  }, [startMarquee, stopObserving]);

  useLayoutEffect(() => {
    if (isHoveredRef.current) startMarquee();
  }, [startMarquee, title]);

  useEffect(() => () => stopObserving(), [stopObserving]);

  return (
    <span
      ref={containerRef}
      className="sidebar-title-marquee min-w-0 max-w-full shrink overflow-hidden"
      title={title}
      onMouseEnter={() => {
        isHoveredRef.current = true;
        startMarquee();
        startObserving();
      }}
      onMouseLeave={() => {
        isHoveredRef.current = false;
        stopObserving();
        stopMarquee();
      }}
    >
      <span className={cn('sidebar-title-marquee__ellipsis', className)}>{children}</span>
      <span
        ref={trackRef}
        aria-hidden="true"
        className={cn('sidebar-title-marquee__track', className)}
      >
        {children}
      </span>
    </span>
  );
}

export interface SessionItemProps {
  session: Session;
  isActive: boolean;
  /** F-SB-7: Whether this session's agent is currently running. */
  isRunning: boolean;
  /** /ctr 接管中: 左侧 vendor icon 切换为 RadioTower 表"被远程接管"。 */
  isAttached?: boolean;
  /** F-SB-7: Whether this session has an attention notification badge. */
  hasAttentionNotification: boolean;
  /** Multi-select visual state in the sidebar. */
  isSelected?: boolean;
  onClick: SessionClickHandler;
  onAction: (sessionId: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (sessionId: string, newTitle: string) => void;
  onTogglePin: (sessionId: string, currentlyPinned: boolean) => void;
  onMoveSession?: (sessionId: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  /** 在 ProjectNode 内部渲染时为 true，行不再额外缩进（缩进由父容器 padding 承担）。 */
  indented?: boolean;
  /**
   * 模糊搜索命中字符在 title 中的下标数组(严格升序)。
   * 来自 useSessionSearch.matchMap;不传 / undefined → 走原 `<span>` 渲染路径,零成本。
   * 传空数组 [] → 同 undefined(没有命中字符,无需高亮)。
   */
  matchIndices?: readonly number[];
  /**
   * hover 时右侧展示的"项目来源"标签(项目 displayName 或"对话")。
   * 仅在时间排序视图下由父层注入 —— 项目分组视图里项目名已由 ProjectNode 表头承载,
   * 无需再在会话行重复显示,因此不传。
   */
  sourceLabel?: string;
  /**
   * 是否渲染在 AutomationSessionGroupItem 分组内。true 时不再在行级 hover slot
   * 挂 [Run] 自动化按钮 —— 组头已经承载了同链路的操作,子行再重复一份
   * 属于视觉噪音;仅顶层散落的 automation-generated 会话(未被 group 吸走的)才在
   * 自己行上展示立即运行入口。
   */
  insideAutomationGroup?: boolean;
}

export interface SessionClickModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export type SessionClickHandler = (id: string, modifiers?: SessionClickModifiers) => void;

export function hasSessionSelectionModifier(modifiers?: SessionClickModifiers): boolean {
  return modifiers?.shiftKey === true || modifiers?.metaKey === true || modifiers?.ctrlKey === true;
}

/**
 * ⚠️ 性能不变量(sessionRowRenderIsolation.test 钉住,改动前先读):
 * 侧边栏可能渲染几百个 SessionItem,父层(CCAgentSidebarUpper)一有状态变化就整树
 * 重渲染,本组件靠 memo 兜底 —— 只有自己 props 变的行才真正重画。要维持这个保证:
 *   1. 本组件必须保持 memo 包裹,不要拆掉;
 *   2. 行内新增数据订阅时,禁止订阅"整张表"快照(useSessionAttentionKinds /
 *      useSessionAttentionSnapshot / 整个 Set 的 context 等每次广播都换引用,会让
 *      所有行一起醒)。必须用按 sessionId 取 primitive/稳定引用的精准订阅,
 *      参考 useSessionAttentionKind / useSessionAttentionUrgency 的写法;
 *   3. 上游给本组件传新 props 时保持引用稳定(handler 用 useCallback,集合查询
 *      在父层降成 boolean 再传),否则 memo 直接失效。
 * 背景:2026-07 切换会话卡顿,实测整栏重画单次 80-96ms、每次切换连跑 3 遍,
 * 根源就是行内全表订阅 + 无 memo。
 */
export const SessionItem = memo(function SessionItem({
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
  indented = false,
  matchIndices,
  sourceLabel,
  insideAutomationGroup = false,
}: SessionItemProps) {
  const { t } = useTranslation();
  const prRefs = usePrRefsForSession(session.id);
  // mod+1..9 序号徽标:模块 store 按 sessionId 精准订阅(性能不变量第 2 条),
  // 非按住态恒为 null,不惊动 memo。
  const ordinalBadgeLabel = useSessionOrdinalBadge(session.id);
  const isPinned = session.pinnedAt != null;
  const isEmpty = isEmptyDraftSession(session);
  // 取 userSendAt 与 updatedAt 中较新的值，兼容存量 DB 行（旧版只写 userSendAt），
  // 与 projectGrouping/dateSessionGrouping 的排序时间轴保持一致。
  const activityIso =
    session.userSendAt && session.userSendAt > session.updatedAt
      ? session.userSendAt
      : session.updatedAt;
  // 右侧状态指示器五档优先级(高→低),色表全端统一(侧栏 / 卡片 / 灵动岛同一张表):
  //   1. error(出错终止 / 定时任务失败未读)→ 红点   —— 红专职表示"坏了"
  //   2. awaiting(等待回复/权限/计划审阅)→ TapTap 蓝点 —— "在等你",邀请而非告警
  //   3. isRunning → spinner(中性灰,running 的橙色语义由左侧 vendor mark 呼吸表达,
  //      右槽 spinner 保持低调不抢色 —— 2026-07 产品决策不染橙)
  //   4. attention 完成未读(done / 未读定时任务)→ 绿点
  //   5. else → 时间文字
  //
  // 为什么 error / awaiting 最高:用户要一眼看到"哪些会话在等我处理"。running + awaiting
  // 共存(agent 跑到一半弹 ask-user)时,蓝点比 spinner 更重要 —— 用户看到 spinner 只以为
  // "还在跑,不管它",但实际它已停在 ask-user 处等待。
  //
  // 为什么 running 高于完成未读:agent 还在跑就一定要显 spinner,不能被
  // "查看后 attention 清零"落到 time 分支 —— 否则会出现"仍然在跑但看起来已完成"的错觉。
  // error / awaiting 被查看清零后,自然让位给 spinner(而不是 time),流程一致。
  //
  // hasAttentionNotification 有两个来源:
  //   1. useSessionRunningStatus.notifications(有 attentionKind:'done'/'awaiting'/'error')
  //   2. unreadScheduleSessionIds(定时任务未读完成,attentionKind 缺失 —— 语义等同 'done')
  // 因此 attentionKind 缺失时按"完成"处理走绿点,不当作错误。
  //
  // 额外 error 来源:定时任务未读且非成功(failed / aborted / interrupted)结局的 session ——
  // 通过 SessionAttentionUrgencyContext 由上游注入,避免误把失败的 automation 涂成 Completed。
  const attentionKind = useSessionAttentionKind(session.id);
  const isUrgentFromContext = useSessionAttentionUrgency(session.id);
  // device-link 远程会话行:本地 attention/running 链路对被控端后台会话是盲区,状态改由
  // 被控端灵动岛 relay 的活动镜像驱动(remoteSessionActivityStore,按行精准订阅;本地
  // 会话恒 undefined 零开销)。镜像只保留活跃态与未读终态,映射与本地五档同一张色表。
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
  const showRightStatus = rightStatusKind !== 'time';
  const remoteIconKind = session.deviceLinkDeviceId ? 'device-link' : session.remoteHostId ? 'ssh' : null;
  const remoteIconConnectionStatus = session.deviceLinkDeviceId
    ? session.deviceLinkConnectionStatus ?? 'connected'
    : null;
  const remoteWritesBlocked = isRemoteSessionWriteBlocked(session);
  const isAutomationGenerated = isAutomationGeneratedSession(session);
  // heartbeat schedule 绑定标识(targetSessionId 指向本会话);schedule 删除/过期后
  // schedulesStore 'changed' 刷新 → 列表为空 → 徽章消失。
  const boundSchedules = useSessionBoundSchedules(session.id);
  const hasAutomationMeta = boundSchedules.length > 0 || isAutomationGenerated;
  const navigate = useNavigate();
  // 自动化创建(非绑定)会话的 Timer 点击:scheduleId 不在 Session 上,点击时查
  // sidebar index runs(sessionId → scheduleId)再跳;查不到(run 已删等)退化为
  // 直接打开自动化页。一次性点击查询,不在渲染路径上常驻拉数据。
  const handleAutomationIconClick = useCallback(async () => {
    try {
      const runs = await loadScheduleSidebarIndexRuns();
      const hit = runs.find((r) => r.sessionId === session.id);
      navigate(hit ? scheduleFocusPath(hit.scheduleId) : '/cc-agent/scheduled');
    } catch {
      navigate('/cc-agent/scheduled');
    }
  }, [session.id, navigate]);
  // 单个 automation-generated 会话行的「schedule 反查」:sessionId → scheduleId 走
  // sidebar-index-runs(Session 上没有 scheduleId 字段)。用于两处:
  //   1. 门控 Run 按钮的可见性 —— schedule 已被删除但会话保留(disposition
  //      keep-sessions)的孤儿 run 上,`isAutomationGenerated` 仍为 true,但 Run 会
  //      直接 toast「not found」,索性别显示。
  //   2. Run 按钮点击时直接用 state 里的 scheduleId,免得再查一遍。
  // mount-once + isAutomationGenerated 才启用,普通会话零开销。cancelled guard 防止
  // 组件卸载后 setState。null 明确表示「查过但没映射」,undefined 表示「还没查」——
  // 两者都不显示按钮,避免闪现。
  const shouldResolveSchedule = isAutomationGenerated && !insideAutomationGroup;
  const [resolvedScheduleId, setResolvedScheduleId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!shouldResolveSchedule) return;
    let cancelled = false;
    loadScheduleSidebarIndexRunsCached()
      .then((runs) => {
        if (cancelled) return;
        const hit = runs.find((r) => r.sessionId === session.id);
        setResolvedScheduleId(hit?.scheduleId ?? null);
      })
      .catch(() => {
        if (!cancelled) setResolvedScheduleId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, shouldResolveSchedule]);
  // 实时校验:resolvedScheduleId 是 mount 时的一次性反查,如果之后 schedule 被删除
  // (keep-sessions disposition),这里静默失效。schedulesStore 是 authoritative 列表,
  // 拿它的 live snapshot 校验一遍 —— snapshot 未 load(null)时假设仍存在,一旦 load
  // 完发现 resolvedScheduleId 不在列表里,effectiveScheduleId 归 null,按钮门控立即
  // 收回。SessionItem 已通过 useSessionBoundSchedules 订阅 schedulesStore 快照,新增
  // 这次订阅零边际成本(同一 hook 的多次调用会合并到一次 useSyncExternalStore)。
  const schedulesSnapshot = useSchedulesSnapshot();
  const scheduleStillExists =
    resolvedScheduleId != null &&
    (schedulesSnapshot == null ||
      schedulesSnapshot.some((s) => s.id === resolvedScheduleId));
  const effectiveScheduleId = scheduleStillExists ? resolvedScheduleId : null;
  const handleAutomationRunClick = useCallback(async () => {
    if (!effectiveScheduleId) {
      toast.warning(t('scheduler.toast.runFailed', { error: 'schedule not found' }));
      return;
    }
    try {
      await window.electronAPI.maker.schedule.runNow(effectiveScheduleId);
    } catch (e) {
      toast.error(
        t('scheduler.toast.runFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [effectiveScheduleId, t]);
  const displayTitle = getSessionDisplayTitle(session, t('ccAgent.common.unnamedSession'));
  const canHighlightDisplayTitle = canHighlightSessionDisplayTitle(session);
  const titleContent =
    matchIndices && matchIndices.length > 0 && canHighlightDisplayTitle
      ? highlightSegments(session.title, matchIndices, {
          highlightClassName: cn(
            'bg-transparent font-semibold',
            isActive
              ? 'text-[var(--sidebar-item-active-foreground)]'
              : 'text-[var(--msg-assistant-text)]',
          ),
        })
      : displayTitle;
  // F-PJ-10：archived 视图下的 session 走特殊视觉/菜单分支
  //   - 左侧 status icon 由 CircleDashed 换成 Archive
  //   - 右侧 ⋮ 菜单只显示 Rename + Unarchive（屏蔽 Pin/Delete/Archive 等无意义项）
  const isArchived = session.status === 'archived';
  const canQuickArchive = !isArchived && !isEmpty && !remoteWritesBlocked;

  // 右键菜单弹出位置：null = 关闭；{x,y} = 在该屏幕坐标处弹出（fixed 定位的
  // 隐形 trigger 锚定到这里）。与 ProjectNode 同款 coordinate-anchored 模式。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Codex 风行内 archive 确认：archivePending=true 时右侧图标按钮被一个红色
  // "Confirm" 胶囊替换；4s 不动 or 点别处 → 自动撤回。第二次点击 Confirm 才真正
  // 触发 onAction(id, 'archive-now') 跳过 ConfirmDialog 直接归档。
  const [archivePending, setArchivePending] = useState(false);
  // confirm 胶囊 DOM 引用——outside-mousedown 用它判断点击是否落在自己身上。
  const confirmPillRef = useRef<HTMLButtonElement>(null);

  // 归档/删除前那次 dirty-worktree 预检要在 main 侧跑 git status,是"点了归档、
  // 行还没消失"里剩下的最大一块等待。每个入口真正执行前都隔着一次人类操作
  // (亮出 Confirm 胶囊后再点一下 / 打开菜单后再点条目),在那一刻先发出去,
  // 执行时命中缓存即可。TTL 与去重都在 worktreeRemovalWarning 里。
  const prefetchRemovalPreflight = useCallback(() => {
    prefetchDirtyWorktreeForRemoval(session.id, session.deviceLinkDeviceId);
  }, [session.id, session.deviceLinkDeviceId]);

  // 行容器 ref:在 isActive 切到 true 时把当前行滚进 viewport。
  //
  // 覆盖范围:SessionItem 已挂载在 DOM 中、但当前 viewport 外的场景
  // (项目内 sessions 数量超过可视区域,active session 不在视野内)。
  //
  // 不覆盖范围:
  //   1. project 处于 collapsed 态 —— SessionItem 由条件渲染整段移出 DOM,
  //      根本不 mount,本 useEffect 也不会触发。需要调用方先 ensure 展开
  //      (如 ProjectNode 的搜索点击 handler 在 close 前会调 onToggle)
  //   2. 用户重复点击已 active 的 session —— isActive 不变,本 useEffect
  //      也不会触发。这种"用户明确想再看一眼"的语义由调用方通过
  //      imperative 路径(querySelector + scrollIntoNearestView)补一刀
  const rowRef = useRef<HTMLDivElement>(null);

  // ── Double-click rename ──
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayTitle);
  // Guard: Enter fires commitTitle, then input unmounts → onBlur fires it
  // again. The ref prevents the second call from re-sending the API request.
  const committedRef = useRef(false);

  // raw 由 SessionRenameInput 传入:输入框当前文本(Magic 生成的标题也先填入输入框,用户 Enter 确认后才走到这里)。
  const commitTitle = useCallback(
    (raw: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      const trimmed = raw.trim();
      setIsEditing(false);
      if (trimmed && trimmed !== displayTitle) {
        onRename(session.id, trimmed);
      }
    },
    [displayTitle, session.id, onRename],
  );

  // 单击 → 立即导航,无延迟。双击 → 浏览器在两次 click 之后再发 dblclick,
  // 进入重命名;首击 navigate 到本 session,第二击因 id===activeSessionId 在
  // handleSessionClick 早 return(参见 CCAgentSidebarUpper handleSessionClick),
  // 不会重复导航。两路并存,无需 200ms 防抖。
  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (isEditing) return;
      onClick(session.id, {
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
      });
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

  // isActive 由 false → true(或初次 mount 时即为 true)→ 把行滚进 viewport。
  // 同 active 重渲染 / 其它字段更新不触发(useEffect deps 只有 isActive)。
  useEffect(() => {
    if (isActive) scrollIntoNearestView(rowRef.current);
  }, [isActive]);


  // archivePending 生命周期：进入 pending → 起 4s 自动撤回 timer + document mousedown
  // 监听（点击不在 confirm 胶囊上就立刻撤回）。退出 pending → 全部清理。这两条退路确保
  // 用户不会因为忘了取消而误归档，也不会让 pending 态滞留把行的 hover 行为锁死。
  useEffect(() => {
    if (!archivePending) return;
    const dismiss = () => {
      setArchivePending(false);
    };
    const timer = setTimeout(dismiss, 4000);
    const onDocMouseDown = (e: MouseEvent) => {
      const pill = confirmPillRef.current;
      if (pill && e.target instanceof Node && pill.contains(e.target)) return;
      dismiss();
    };
    // capture 阶段 —— 早于行自身的 onClick（避免点击行本身触发导航）
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDocMouseDown, true);
    };
  }, [archivePending]);

  // 编辑态 / 切换 session 时一并撤回 pending，避免脏状态泄漏到下一次
  useEffect(() => {
    if (isEditing) setArchivePending(false);
  }, [isEditing]);

  // F-PJ-9 menu handlers — Radix DropdownMenu 在 onSelect 后自动关闭菜单
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

  const handlePinSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    onTogglePin(session.id, isPinned);
  }, [remoteWritesBlocked, session.id, isPinned, onTogglePin, t]);

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

  // 「导出会话…」—— 打成 .cshare 分享给同事(弹敏感内容确认 + 可选密码,
  // 保存对话框与编排全在 main)。remote / orca / draft 会话不显示此入口
  // (转录在远端或协同关系不可移植,main 侧同样有双保险拒绝)。
  const [shareExportOpen, setShareExportOpen] = useState(false);
  const handleExportShareSelect = useCallback(() => {
    setShareExportOpen(true);
  }, []);

  // 「在新窗口打开」—— 把该会话在一个完整的新窗口里打开(对标 Codex 多开),便于
  // 四角各钉一个会话同时盯。窗口生命周期由 main/secondary-windows.ts 负责。
  const handleOpenInNewWindowSelect = useCallback(() => {
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    void window.electronAPI.maker.openSessionInNewWindow(session.id);
  }, [remoteWritesBlocked, session.id, t]);

  // 复制 cindy://session/<id> 深度链接到剪贴板。三个变体(标准/Pinned/Archived/Draft)
  // 共用此 handler — sessionId 始终存在(draft 也是 DB-backed 的 Session row)。
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

  // 单项「复制任务链接」:直接复制 cindy://session/<id> 深链(可粘贴到聊天里
  // 渲染成会话 chip)。原「复制会话 ID」二级菜单(深度链接 / 仅 ID / Agent)已按
  // 产品决策收敛为这一项;不自带分隔线,分组由各使用点决定,避免菜单被切得过碎。
  const copySessionIdSubmenu = (
    <DropdownMenuItem
      onSelect={() => void handleCopyDeepLinkSelect()}
      className={MENU_ITEM_CLASS}
    >
      {t('ccAgent.sidebar.sessionMenu.copySessionLink')}
    </DropdownMenuItem>
  );

  const canMoveToProject =
    Boolean(onMoveSession) &&
    !isEmpty &&
    !session.remoteHostId &&
    !session.deviceLinkDeviceId &&
    session.status !== 'archived';

  // 导出 .cshare 的可见性:draft 无内容、remote 转录在远端、orca 协同关系
  // 不可移植、device-link 数据在被控端 —— 全部隐藏入口。
  const canExportShare =
    !isEmpty && !session.remoteHostId && !session.orcaRole && !session.deviceLinkDeviceId;

  const exportShareMenuItem = canExportShare ? (
    <DropdownMenuItem onSelect={handleExportShareSelect} className={MENU_ITEM_CLASS}>
      {t('ccAgent.sidebar.sessionMenu.exportShare')}
    </DropdownMenuItem>
  ) : null;

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

  const row = (
    // biome-ignore lint/a11y/useSemanticElements: 行内包含菜单和快捷操作按钮，不能改成原生 button。
    <div
      ref={rowRef}
      data-session-id={session.id}
      data-sidebar-session-row="true"
      role="button"
      tabIndex={0}
      onPointerDown={(e) => {
        if (shouldPrefetchSessionOnPointerDown(e, { isActive, isEditing })) {
          makerChatStore.ensureInitialMessages(session.id);
        }
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        // target 守卫:内部按钮(More/Archive/Undo/Edit/Run 等)的 Enter/Space
        // keydown 会冒泡到行级 onKeyDown,而这些按钮的 onClick 只 stopPropagation
        // click 不 stop keydown —— 不加守卫会造成「Tab 到按钮按 Enter 触发按钮动作
        // + 同时进入会话」的双触发。SessionItem 早期只有 More/Archive 时未暴露,
        // PR #658 给 automation 会话行加 Edit/Run 后 P2 review 显性化。
        if (e.target !== e.currentTarget) return;
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
        // 基础几何：高 32 / 圆角 8。普通会话的 Agent → 标题保持 10px;
        // 自动任务行 Agent → Timer 延续原 Clock 的 6px,Timer → 标题也为 6px。
        // rounded-full:hover/active 底与顶部导航行、项目行同款药丸形。
        'group relative flex h-8 w-full items-center rounded-full',
        !isEditing && hasAutomationMeta ? 'gap-1.5' : 'gap-2.5',
        'select-none',
        // 缩进 + padding(见文件头注释的文字列对齐口径):
        //   indented=true → 左 22px（Project Sessions 缩进,比顶层深一档;
        //     2026-07 用户定稿在 18px 基础上再 +4px 加深层级)
        //   indented=false → 左 12px（Pinned / Unclassified / Dialogue 段）
        // 右侧固定槽位显示最近活动时间；hover 时 archive 快捷按钮覆盖同一槽位。
        indented ? 'pl-[22px] pr-2' : 'pl-3 pr-2',
        // 注意:不加 transition-colors —— 行 bg 的 hover/active 变化要瞬时,
        // 否则归档/取消归档后 DOM 列表重排,原 hover bg 在前一个屏幕位置上要
        // 跑完 150ms 渐变才褪掉,视觉上像是"旧行仍然选中,延迟才切到新行"。
        // 用 ProjectAction 同款瞬时反馈,跟 Cursor / Codex sidebar 的体感一致。
        'text-sm font-medium text-left cursor-pointer',
        // active 描边必须画在盒内且不参与布局。真实 border 会让固定宽高的
        // border-box 内容区四边各缩 1px,导致选中行的左侧 icon / 标题整体右移。
        isActive
          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)]'
          : isSelected
            ? 'bg-[var(--chat-input-chip-bg)] text-foreground'
            : 'text-foreground hover:bg-sidebar-item-hover',
        isSelected && 'ring-1 ring-inset ring-[var(--focus-ring-soft)]',
      )}
      aria-current={isActive ? 'page' : undefined}
      aria-pressed={isSelected || undefined}
    >
      {/* 左侧状态图标(vendor mark + 运行/需关注/草稿)——与置顶卡片共用 SessionStatusIcon,
          保证两处完全一致。
          外包 15px 定宽槽:状态图标本体 12px,槽宽与顶部导航/文件夹图标(15)一致,
          让会话标题与其它行落在同一文字列(见文件头注释)。 */}
      <span className="flex w-[15px] shrink-0 items-center justify-center">
        <SessionStatusIcon
          session={session}
          isRunning={isRunning}
          isAttached={isAttached}
          hasAttentionNotification={hasAttentionNotification}
          isActive={isActive}
          showAttentionDot={false}
        />
      </span>

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
          containerClassName="min-w-0 flex-1"
          inputClassName="h-6 text-sm font-medium text-foreground"
          activeForeground={isActive}
        />
      ) : (
        //   matchIndices 由父层(useSessionSearch)注入时,渲染高亮 segments;否则
        //   走原 `<span>` 路径,无开销。highlightSegments 在 indices.length===0 时
        //   也会直接返回原 string,所以两路渲染最终都走 truncate 容器。
        // 远程项目 icon 跟项目标题同口径:直接贴在标题右侧。标题过长时标题截断,
        // icon shrink-0 保持可见;右侧槽位只保留 worktree + 时间 + hover action。
        <span className="min-w-0 flex flex-1 items-center gap-1.5">
          {/* 绑定徽章优先于普通自动化 Timer:persistentSession 会话两者皆真,
              主图标统一为 Timer，绑定态额外承载频率/暂停信息。 */}
          {boundSchedules.length > 0 ? (
            <ScheduleBindingBadge schedules={boundSchedules} activeForeground={isActive} />
          ) : isAutomationGenerated ? (
            <button
              type="button"
              className="inline-flex shrink-0 cursor-pointer focus:outline-none"
              aria-label={t('ccAgent.sidebar.scheduleBinding.viewTask')}
              title={t('ccAgent.sidebar.automationGenerated')}
              onClick={(e) => {
                e.stopPropagation();
                void handleAutomationIconClick();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <AutomationTimerIcon size={10} activeForeground={isActive} />
            </button>
          ) : null}
          <SidebarTitleMarquee
            title={displayTitle}
            className={isActive ? 'text-sidebar-item-active-foreground' : 'text-foreground'}
          >
            {titleContent}
          </SidebarTitleMarquee>
          {remoteIconKind && (
            <RemoteProjectIcon
              kind={remoteIconKind}
              size={12}
              strokeWidth={1.8}
              connectionStatus={remoteIconConnectionStatus}
              className={cn(isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon')}
            />
          )}
        </span>
      )}

      {/* 右侧 WorktreeBadge + 最近活动时间 + Archive 快捷按钮。
          时间使用 sidebar 排序同一时间轴 session.updatedAt(scheduler 自动 fire
          也会 bump,不用 userSendAt 避免被绑定给定时任务的会话时间冻结)。
          WorktreeBadge 紧贴时间左侧(仅在 WorktreeContext map 中存在 sessionId 时
          渲染), 与时间同步 hover-fade 让位给 action buttons —— 让右侧只看到一组
          视觉元素, 不和 action buttons 共存。
          archive 快捷按钮 hover/focus 时覆盖整个槽位,避免右侧拥挤;完整菜单仍走右键。
          min-w-14 保证无 worktree 时仍保留原 56px 槽位(action buttons 锚点),有
          worktree 时槽位自然撑开以容纳 16px 图标 + 时间。 */}
      {!isEditing && (
        <div className="group/slot relative ml-auto flex h-6 shrink-0 items-center justify-end min-w-14">
          {/* WorktreeBadge + time 同步 fade-out:hover/菜单打开/archivePending 时
              一起让位,确保只有 action buttons 占住右侧。fade 容器复用同一份条件,
              避免两个元素 fade 时机不一致产生闪烁。
              focus 隐藏条件用命名 group(/slot) 收窄到本槽位:行本身是
              role="button" tabIndex=0,点击选中后焦点常驻行内,若用整行的
              group-focus-within,选中态(非 hover)时间会被永久隐藏而 action
              buttons 又不显示,右侧变空白。 */}
          <div
            className={cn(
              'flex items-center gap-1',
              // duration 与 action 按钮组的渐显同拍(120ms),让位/回归一进一出同步。
              'transition-opacity duration-[120ms]',
              !archivePending && 'group-hover:opacity-0 group-focus-within/slot:opacity-0',
              menuPos !== null && 'opacity-0',
              archivePending && 'opacity-0',
              // mod+1..9 序号徽标出现时同样让位:徽标独占行尾,不与时间/badge 并排。
              ordinalBadgeLabel != null && 'opacity-0',
            )}
          >
            <WorktreeBadge sessionId={session.id} size={12} className="size-4" />
            {showRightStatus ? (
              <SidebarRightStatusIndicator kind={rightStatusKind} isActive={isActive} />
            ) : (
              <time
                dateTime={activityIso}
                title={formatSidebarTimeAbsolute(activityIso)}
                className={cn(
                  'min-w-0 truncate text-right text-xs font-medium tabular-nums',
                  isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
                )}
              >
                {formatSidebarTime(activityIso, t)}
              </time>
            )}
          </div>

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
                'absolute right-0 top-0 flex h-6 w-14 items-center justify-center rounded-md text-xs font-medium',
                'bg-[color-mix(in_srgb,hsl(var(--destructive))_15%,transparent)] text-[hsl(var(--destructive))] hover:bg-[color-mix(in_srgb,hsl(var(--destructive))_25%,transparent)]',
                'transition-colors focus:outline-none',
              )}
              aria-label={t('ccAgent.sidebar.sessionMenu.archived')}
            >
              {t('ccAgent.sidebar.sessionMenu.archived')}
            </button>
          )}
          {/* Action 按钮组（hover/menu open 时浮现，archivePending 期间整组让位给红色 pill）。
              尺寸/视觉与 Project Header 的 ProjectAction 同套（size-5 / icon 14 /
              strokeWidth 2 / gap-0.5）；普通行 hover 走 sidebar-item-hover，选中行
              则用 active foreground 的半透明叠色保持红色胶囊内的反色体系。唯一差异
              是 session 行的三个按钮**故意不挂 Tip 浮层** —— 图标语义已足够直观,
              tooltip 在密集 sidebar 列表里反而干扰视觉。
              组装顺序固定为 [Run(automation only), More, Archive | Undo]：
                - 非 archived：More + Archive；Archive pill 撤回(超时/点外面)后
                  按钮立即还原,符合用户对 "撤回 = 回到点击前" 的直觉预期。
                - archived：More + Undo（lucide Undo），单击直接走 unarchive，
                  不像 Archive 那样需要二次确认 pill（unarchive 非破坏性）。 */}
          {!archivePending && (
            <div
              // 渐显(120ms)配 pointer-events 守卫:淡出期间按钮不再占据鼠标位置,
              // 解决了旧注释"渐变让按钮在 fade 期间仍占着鼠标位置、Radix Tooltip
              // 收不到 pointerleave 导致 tip 挂着"的问题(当年因此禁用了
              // transition-opacity);键盘焦点不受 pointer-events 影响,focus 路径不变。
              className={cn(
                'absolute right-0 top-0 flex h-6 items-center gap-0.5',
                'transition-opacity duration-[120ms]',
                menuPos !== null
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
              )}
            >
              {/* 自动化会话专属 Run 直点按钮:仅顶层散落(insideAutomationGroup
                  为 false)的 automation-generated 会话可见 —— 分组内 (SessionEntryList
                  展开的子行) 组头已经暴露过同链路操作,再挂一份纯属视觉噪音。其它硬边界:
                  未归档 + 非 draft + 非远程只读。Edit 与左侧 Timer chip 同链路,不再重复
                  暴露;Run 走 main.maker.schedule.runNow,与 AutomationSessionGroupItem
                  组头 [Run ▶️][More ⋮] 保持高频直点、低频收纳的同构。 */}
              {isAutomationGenerated && !insideAutomationGroup && !isArchived && !isEmpty && !remoteWritesBlocked && effectiveScheduleId && (
                <SessionAction
                  label={t('ccAgent.sidebar.automationGroup.menu.runNow')}
                  onClick={() => void handleAutomationRunClick()}
                  isActive={isActive}
                >
                  <Play size={14} strokeWidth={2} />
                </SessionAction>
              )}
              <SessionAction
                label={t('ccAgent.sidebar.sessionMenu.moreActions')}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  prefetchRemovalPreflight();
                  setMenuPos({ x: rect.left, y: rect.bottom + 2 });
                }}
                isActive={isActive}
              >
                <EllipsisVertical size={14} strokeWidth={2} />
              </SessionAction>
              {isArchived && !remoteWritesBlocked ? (
                <SessionAction
                  label={t('ccAgent.sidebar.sessionMenu.unarchive')}
                  onClick={() => handleUnarchiveSelect()}
                  isActive={isActive}
                >
                  <Undo size={14} strokeWidth={2} />
                </SessionAction>
              ) : canQuickArchive ? (
                <SessionAction
                  label={t('ccAgent.sidebar.sessionMenu.archived')}
                  onClick={() => {
                    // 第一步:亮出 Confirm 胶囊,同时把 dirty 预检发出去。用户抬手
                    // 再点第二下的间隔足够那次 git status 跑完 → 归档零等待。
                    prefetchRemovalPreflight();
                    setArchivePending(true);
                  }}
                  isActive={isActive}
                >
                  <Archive size={14} strokeWidth={2} />
                </SessionAction>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* mod+1..9 序号徽标(按住修饰键浮现,见 sessionOrdinalBadges):绝对定位
          在右侧时间槽位置(与行 pr-2 对齐),时间/badge 容器同步让位淡出;
          z-20 压过 hover 操作钮,pointer-events-none 不挡点击。前景色给到
          容器:普通行次级灰、active 反色行用 active foreground,kbd 内
          text-current + currentColor 底自动跟随。编辑态让位给重命名输入框。 */}
      {!isEditing && ordinalBadgeLabel != null && (
        <span
          className={cn(
            'pointer-events-none absolute inset-y-0 right-2 z-20 flex items-center',
            isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
          )}
        >
          <SessionOrdinalBadgeKbd label={ordinalBadgeLabel} />
        </span>
      )}

      {/* 右键菜单：与 ProjectNode 同款 coordinate-anchored DropdownMenu —
          隐形 fixed-position trigger 锚定到 onContextMenu 捕获的鼠标坐标，
          Radix 自动处理打开/关闭、ESC、点外面关闭等行为。 */}
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
            // 统一菜单 surface(menuStyles)。min-w-32:基线 128px,长 label
            // (如「复制 SDK Session ID」)按 Radix 内容自适应,避免被截断。
            className={cn(MENU_CONTENT_CLASS, 'min-w-32 overflow-hidden')}
          >
            {isArchived ? (
              <>
                {/* Archived 变体：Rename / Unarchive / [Copy Session ID submenu] / Delete */}
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
                {exportShareMenuItem}
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
                {/* Draft 变体：Rename / [Copy Session ID submenu] / Delete */}
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
                {/* 标准 / Pinned 变体：Pin↔Unpin / Rename / [Copy Session ID submenu] / Archived / Delete */}
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handlePinSelect}
                  className={MENU_ITEM_CLASS}
                >
                  {isPinned
                    ? t('ccAgent.sidebar.sessionMenu.unpin')
                    : t('ccAgent.sidebar.sessionMenu.pin')}
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
                {exportShareMenuItem}
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

      {/* 导出 .cshare 弹窗:仅打开时挂载,避免侧栏每行常驻 Dialog 实例。 */}
      {shareExportOpen && (
        <SessionShareExportDialog
          open={shareExportOpen}
          sessionId={session.id}
          onOpenChange={setShareExportOpen}
        />
      )}
    </div>
  );

  // PR tips(session-git-pr-context):仅当会话有关联 PR 时整行包零延迟
  // Tooltip——鼠标一到列表项立即显示该对话的 PR 与实时状态(产品要求,
  // 不等全局 500ms 悬停延迟)。无 PR 的行原样返回,保持本文件"密集列表
  // 少挂 Tip"的既有取舍。
  // 统一 hover 浮层:PR 优先 / 无 PR 时回落到 sourceLabel / 都没有则透传 row。
  // 具体优先级、配色和 orca-lead 回退详见 SessionTooltip.tsx。
  // 单独 automation-generated 会话(未被 AutomationSessionGroupItem 吸走)在 hover 时
  // 显示「下次运行倒计时 + 累计运行次数」,与分组头 rowTooltip 同语义。分组内子行
  // (insideAutomationGroup=true)由组头承担,这里不再挂 automation 浮层。
  const showAutomationTooltip = isAutomationGenerated && !insideAutomationGroup;
  return (
    <SessionTooltip
      sessionId={session.id}
      prRefs={prRefs}
      sourceLabel={sourceLabel}
      isAutomationSession={showAutomationTooltip}
    >
      {row}
    </SessionTooltip>
  );
});

/** SessionItem 右侧 hover action 图标按钮 —— 尺寸/视觉与 Project Header 的
 *  ProjectAction 基本一致(size-5 / icon 14×14 / strokeWidth 2 / 圆角 md /
 *  普通行 hover 用 sidebar-item-hover + foreground；选中行保持 active foreground,
 *  hover 只叠一层同色半透明高光),区别是这里
 *  **不挂 Tip 浮层**,图标语义已经够直观,sidebar 密集列表里少干扰为先。 */
function SessionAction({
  label,
  onClick,
  isActive,
  children,
}: {
  label: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  isActive: boolean;
  children: ReactNode;
}) {
  // 这里**故意不挂 Tip 浮层** —— 三个按钮(More/Archive/Undo)的图标语义都足够
  // 直观,加 tooltip 反而让 sidebar 视觉更乱。aria-label 保留给屏幕阅读器。
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
        'shrink-0 size-5 flex items-center justify-center rounded-md',
        'focus:outline-none',
        isActive
          ? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
          : 'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
