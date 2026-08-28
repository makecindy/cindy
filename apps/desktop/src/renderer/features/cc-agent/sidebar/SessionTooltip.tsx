/**
 * SessionTooltip — sidebar 会话行的统一 hover 浮层。
 *
 * 按优先级二选一渲染同一浮层,避免同一行套多层 tooltip:
 *   1. **PR 引用**(session-git-pr-context):有 PR 引用时显示 owner/repo#N +
 *      状态 + 未解决评论 + 标题;状态按需加载(首次悬停打开触发
 *      fetchStatusesForSession,共享缓存 + main 60s TTL,规则 7 不做 loading 态)。
 *   2. **项目来源**(sourceLabel):无 PR 时展示"Cindy""对话"等来源标签,
 *      与工作空间左下角同口径,orca-lead / 罕见来源走 workingDir basename 回退
 *      (规则见 lib/sessionSourceLabel.ts)。
 *   3. 两者都无 → 直接透传 children,保持"密集列表少挂 Tip"的既有取舍。
 *
 * 视觉:覆盖 Radix 默认的 --tooltip-bg 深黑背景,改用主题 surface-elevated +
 * border-default + shadow-sm 的浅色胶囊,与侧栏融进同一套调色板(规则 16)。
 */

import { GitPullRequest, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import type { PrStatusResult, SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey, MAX_STATUS_QUERIES } from '@/lib/prStatus';
import { usePrStatuses } from '@/contexts/PrRefsContext';
import { PR_STATUS_COLOR, PR_STATUS_ICON } from '../gitContextPrVisuals';
import { formatSidebarFutureTime } from '../lib/formatSidebarTime';
import {
  findLatestSidebarIndexRunForSession,
  loadScheduleSidebarIndexRuns,
  type ScheduleSidebarIndexRun,
} from '@/features/scheduler/lib/scheduleSidebarIndexRuns';

const CONTENT_SURFACE_CLASS = cn(
  'bg-[var(--surface-elevated)] text-[var(--text-primary)]',
  // base Tooltip.Content 默认 border-transparent（深底气泡不要浅描边）。
  // tailwind-merge 不会被无 variant 的 border-[...] 单独覆盖 dark 态，需要显式
  // dark: override 才能让这个浅色浮层在两模式下都看得到边框。
  'border-[var(--border-default)] dark:border-[var(--border-default)] shadow-sm',
);

export interface SessionTooltipProps {
  sessionId: string;
  /** 该 session 关联的 PR 引用列表;非空时浮层内容切到 PR 视图。 */
  prRefs: readonly SessionPrRef[];
  /** 项目来源标签(项目 displayName / "对话" / workingDir basename),无 PR 时使用。 */
  sourceLabel?: string;
  /**
   * 单独渲染的 automation-generated 会话(未被 AutomationSessionGroupItem 吸走)
   * 需要展示下次运行或停止状态浮层。
   * 优先级:PR > automation > sourceLabel(PR 承载工程上下文最重,automation 承载
   * 计划信息次之,sourceLabel 只是「来自哪个项目」的静态标签)。
   */
  isAutomationSession?: boolean;
  /**
   * 受控开关。普通任务行在指针进入内嵌动作时传 false，避免行级详情与动作 Tip 重叠。
   * 未提供时保持各变体原有的 Radix 非受控行为。
   */
  controlledOpen?: boolean;
  children: ReactNode;
}

export function SessionTooltip({
  sessionId,
  prRefs,
  sourceLabel,
  isAutomationSession,
  controlledOpen,
  children,
}: SessionTooltipProps) {
  if (prRefs.length > 0) {
    return (
      <PrTooltip sessionId={sessionId} prRefs={prRefs} controlledOpen={controlledOpen}>
        {children}
      </PrTooltip>
    );
  }
  if (isAutomationSession) {
    return (
      <AutomationTooltip sessionId={sessionId} controlledOpen={controlledOpen}>
        {children}
      </AutomationTooltip>
    );
  }
  if (sourceLabel) {
    return (
      <SourceTooltip sourceLabel={sourceLabel} controlledOpen={controlledOpen}>
        {children}
      </SourceTooltip>
    );
  }
  return <>{children}</>;
}

function PrTooltip({
  sessionId,
  prRefs,
  controlledOpen,
  children,
}: {
  sessionId: string;
  prRefs: readonly SessionPrRef[];
  controlledOpen?: boolean;
  children: ReactNode;
}) {
  const { statuses, fetchStatusesForSession } = usePrStatuses();

  useEffect(() => {
    if (controlledOpen) fetchStatusesForSession(sessionId);
  }, [controlledOpen, fetchStatusesForSession, sessionId]);

  return (
    // 独立 Provider + delayDuration=0:hover 立即弹出,不吃 sidebar 顶层 Provider
    // 的 500ms 默认延迟。skipDelayDuration 也归零,行间移动同样无跳变。
    <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
      <Tooltip.Root
        open={controlledOpen}
        onOpenChange={(open) => {
          if (open && controlledOpen === undefined) fetchStatusesForSession(sessionId);
        }}
      >
        <Tooltip.Trigger
          asChild
          // PR tip 是 sidebar 密集列表里的 hover-only 信息。SessionItem 本身可聚焦,
          // 窗口重新 focus 时浏览器会把焦点还给它;阻止 Radix 的 focus-open,避免无 hover 复活。
          onFocus={(event) => event.preventDefault()}
        >
          {children}
        </Tooltip.Trigger>
        <Tooltip.Content
          side="right"
          align="start"
          sideOffset={8}
          variant="mono"
          className={CONTENT_SURFACE_CLASS}
        >
          <div className="flex flex-col gap-1">
            {prRefs.slice(0, MAX_STATUS_QUERIES).map((ref) => (
              <PrLine key={ref.id} prRef={ref} status={statuses.get(prStatusKey(ref))} />
            ))}
          </div>
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/**
 * 单独 automation-generated 会话行的 hover 浮层 —— 显示下次运行剩余时间或停止状态。
 * 数据源和 Timer chip 点击复用同一套 loadScheduleSidebarIndexRuns；tooltip 打开时才发起一次拉取
 * (与 PrTooltip 的 fetchStatusesForSession 同风格,不在密集渲染路径上常驻拉数据);
 * 拉到的 nextFireAt 用一次性 formatSidebarFutureTime 转成 "N 分钟后运行",不做秒级 tick
 * (tooltip 通常只停留几秒,静态文案够用)。
 */
function AutomationTooltip({
  sessionId,
  controlledOpen,
  children,
}: {
  sessionId: string;
  controlledOpen?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const effectiveOpen = controlledOpen ?? open;
  const [runs, setRuns] = useState<ScheduleSidebarIndexRun[] | null>(null);
  useEffect(() => {
    if (!effectiveOpen || runs !== null) return;
    let cancelled = false;
    loadScheduleSidebarIndexRuns()
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveOpen, runs]);

  const hit = runs ? (findLatestSidebarIndexRunForSession(runs, sessionId) ?? null) : null;
  const countdownText =
    hit && hit.scheduleStatus === 'active' && typeof hit.nextFireAt === 'number'
      ? formatSidebarFutureTime(hit.nextFireAt, t)
      : '';
  const isStopped = hit?.scheduleStatus === 'paused' || hit?.scheduleStatus === 'expired';
  const stoppedText = isStopped ? t('ccAgent.sidebar.automationGroup.stopped') : '';
  const hasContent = countdownText || stoppedText;

  return (
    <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
      <Tooltip.Root open={controlledOpen} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild onFocus={(event) => event.preventDefault()}>
          {children}
        </Tooltip.Trigger>
        {hasContent && (
          <Tooltip.Content side="right" className={CONTENT_SURFACE_CLASS}>
            <div className="flex flex-col gap-0.5">
              {countdownText && <span>{countdownText}</span>}
              {stoppedText && <span>{stoppedText}</span>}
            </div>
          </Tooltip.Content>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function SourceTooltip({
  sourceLabel,
  controlledOpen,
  children,
}: {
  sourceLabel: string;
  controlledOpen?: boolean;
  children: ReactNode;
}) {
  return (
    // 独立 Provider + delayDuration=0:与 PrTooltip 同规,hover 立即弹出。
    <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
      <Tooltip.Root open={controlledOpen}>
        <Tooltip.Trigger asChild onFocus={(event) => event.preventDefault()}>
          {children}
        </Tooltip.Trigger>
        <Tooltip.Content side="right" className={CONTENT_SURFACE_CLASS}>
          {sourceLabel}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function PrLine({ prRef, status }: { prRef: SessionPrRef; status: PrStatusResult | undefined }) {
  const { t } = useTranslation();
  const kind = status?.ok ? status.status : null;
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  const color = kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)';
  const unresolved = status?.ok && status.unresolvedCount ? status.unresolvedCount : 0;

  return (
    <div className="flex min-w-0 max-w-80 items-center gap-1.5">
      <Icon size={12} strokeWidth={1.75} className="shrink-0" style={{ color }} />
      <span className="min-w-0 truncate">
        {prRef.owner}/{prRef.repo}#{prRef.prNumber}
      </span>
      {kind && (
        <span className="shrink-0 whitespace-nowrap">
          · {t(`ccAgent.gitContext.pr.status.${kind}`)}
        </span>
      )}
      {unresolved > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5"
          style={{ color: 'var(--status-bar-accent)' }}
        >
          <MessageSquare size={10} strokeWidth={2} />
          {unresolved > 99 ? '99+' : unresolved}
        </span>
      )}
      {status?.ok && <span className="min-w-0 truncate">· {status.title}</span>}
    </div>
  );
}
