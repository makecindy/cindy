/**
 * RunHistoryCard — 单条 run 卡片
 * ---------------------------------------------------------------------------
 * 设计稿：12px 圆角，padding [14, 16]，gap 8。
 *   Row 1: 品牌 mark + 时间戳 + status chip（右对齐）
 *   Row 2: 'Took Xm Ys · Open session ↗'（running 走 'Started Xs ago'）
 *          interrupted/aborted 且 sessionId 为空时，把 'Open session' 位置换成
 *          'Restart' —— 此时没有可恢复的现场，点击等价于 schedule.runNow，
 *          重新 fire 一次；带 sessionId 的 interrupted run 仍走 Open session。
 *   Row 3: failed/aborted 且有 errorMsg → mono 错误摘要
 *
 * Card bg 走 --cmd-palette-bg 主题 token，与 dialog Card 层保持一致。
 * 状态 chip：success/running 实色 grayscale；failed/aborted 描边。
 */

import { ChevronDown, ExternalLink, MoreHorizontal, RotateCw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import type { AgentKind, RunStatus, ScheduleRun } from '@cindy/maker-scheduler';
import type { SessionReference } from '../../../../shared/sessionReference';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { AgentMark } from './AgentMark';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { formatDuration, formatRunTimestamp, formatStartedAgo } from '../lib/formatters';
import { formatTurnCostMoney } from '@/lib/usageFormat';
import {
  legacyUsdMoney,
  usdMoney,
} from '../../../../shared/regionalMoney';
import { isUnreadScheduleRun } from '../lib/runUnread';
import { markScheduleRunReadAndSync } from '../lib/scheduleRunReadSync';

const LEGACY_SESSION_RUN_ID_PREFIX = 'legacy-session:';

function StatusChip({ status }: { status: RunStatus }) {
  const { t } = useTranslation();
  const label = t(`scheduler.runs.status.${status}`);
  const filled = status === 'success' || status === 'running';
  return (
    <span
      className={cn(
        // 高度去掉固定值，由 py + 文字行高决定，避免 13px 字号被 18px 框压扁
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        'text-[12px] font-medium leading-none whitespace-nowrap',
        filled
          ? 'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]'
          : 'border border-[var(--cmd-palette-border)] bg-transparent text-[var(--cmd-palette-item-meta)]',
      )}
      aria-label={t('scheduler.runs.statusAria', { status: label })}
    >
      {status === 'running' && (
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--msg-assistant-text)]"
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}

/** 单轮前置检查摘要与完整诊断。异常/跳过默认展开，通过默认折叠。 */
function PreRunHookResultDetails({ result }: { result: NonNullable<ScheduleRun['preRunHookResult']> }) {
  const { t } = useTranslation();
  const defaultOpen = result.status !== 'passed';
  const outputSections = [
    { key: 'stdout', value: result.stdout, truncated: result.stdoutTruncated },
    { key: 'stderr', value: result.stderr, truncated: result.stderrTruncated },
  ].filter((section) => section.value.trim());

  return (
    <details
      open={defaultOpen}
      className="group/precheck rounded-[8px] bg-[hsl(var(--content-area))] text-[var(--settings-section-desc)]"
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5',
          'text-11 [&::-webkit-details-marker]:hidden',
        )}
      >
        <span className="min-w-0 truncate">
          {t(`scheduler.runs.preRun.status.${result.status}`)} ·{' '}
          {t(`scheduler.runs.preRun.decision.${result.decision}`)} ·{' '}
          {t('scheduler.runs.preRun.duration', { ms: result.durationMs })}
        </span>
        <ChevronDown
          size={13}
          className="shrink-0 transition-transform group-open/precheck:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="flex flex-col gap-2 border-t border-[var(--cmd-palette-border)] px-2 py-2 text-11">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span>{t('scheduler.runs.preRun.exitCode', { code: result.exitCode ?? '—' })}</span>
          {result.error && <span className="break-words">{result.error}</span>}
        </div>
        {outputSections.length === 0 ? (
          <span>{t('scheduler.runs.preRun.noOutput')}</span>
        ) : (
          outputSections.map((section) => (
            <section key={section.key} className="flex flex-col gap-1">
              <span className="font-medium">
                {t(`scheduler.runs.preRun.${section.key}`)}
                {section.truncated ? ` · ${t('scheduler.runs.preRun.truncated')}` : ''}
              </span>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--cmd-palette-border)] p-2 font-mono text-11">
                {section.value}
              </pre>
            </section>
          ))
        )}
      </div>
    </details>
  );
}

interface Props {
  run: ScheduleRun;
  agentKind: AgentKind;
  /** 删除单条历史 run 的回调；省略则不渲染删除按钮（向后兼容）。 */
  onDelete?: (run: ScheduleRun) => void | Promise<void>;
  /**
   * 重启回调：仅对"无 sessionId 的 interrupted/aborted run"渲染 Restart 链接。
   * 实现侧应直接调 schedule.runNow（再 fire 一次，不恢复旧 run 的现场）。
   */
  onRestart?: (run: ScheduleRun) => void | Promise<void>;
  /** main 层解析的 session 生命周期；undefined 表示仍在查询。 */
  sessionReference?: SessionReference;
}

export function RunHistoryCard({
  run,
  agentKind,
  onDelete,
  onRestart,
  sessionReference,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isLegacySessionRun = run.id.startsWith(LEGACY_SESSION_RUN_ID_PREFIX);
  const showError =
    (run.status === 'failed' || run.status === 'aborted' || run.status === 'interrupted') &&
    !!run.errorMsg;

  const metaText =
    run.status === 'running'
      ? formatStartedAgo(run.firedAt)
      : t('scheduler.runs.took', { duration: formatDuration(run.firedAt, run.finishedAt) });
  const costText = run.status === 'running'
    ? null
    : run.costAttribution === 'legacy'
      ? t('scheduler.runs.legacyCostUnavailable')
      : run.costAttribution === 'unavailable'
        ? t('scheduler.runs.costUnavailable')
        : run.costAttribution === 'exact' ||
            run.costAttribution === 'direct' ||
            run.costAttribution === 'mixed' ||
            run.costAttribution === 'zero'
          ? (() => {
          const costMoney =
            run.costMoney ??
            legacyUsdMoney(run.costUsd ?? 0);
          const valueMoney =
            run.estimatedValueMoney ??
            usdMoney(run.estimatedValueUsd ?? 0, 'value-estimate', 'legacy-usd');
          return [
          costMoney.amount > 0
            ? t('scheduler.runs.runCost', { cost: formatTurnCostMoney(costMoney) })
            : null,
          valueMoney.amount > 0
            ? t('scheduler.runs.runValue', { value: formatTurnCostMoney(valueMoney) })
            : null,
        ]
          .filter(Boolean)
          .join(' · ') ||
            t('scheduler.runs.runCost', {
              cost: formatTurnCostMoney(costMoney),
            });
            })()
          : null;

  // 终态且未读 → 在 agent 图标右上角点一个状态点(全端统一色表:失败结局红 / 成功绿)。
  // running 不算未读（结果还没出来，没什么"漏看"）。
  const isUnread = isUnreadScheduleRun(run);
  const unreadTone =
    run.status === 'failed' || run.status === 'aborted' || run.status === 'interrupted'
      ? 'error'
      : 'done';

  // 未读 run:点击卡片本体即标记已读。这是"无 sessionId 的失败 run"唯一的
  // 单条清红点通道 —— 那类 run(session 创建前就失败)没有 Open session 可点,
  // 此前红点只能靠 pause/delete 整个任务清掉。有 session 的卡片同样生效,
  // Open session 链接自带的 markRead 与此幂等(main 端重复标记是 no-op)。
  const canMarkRead = isUnread && !isLegacySessionRun;
  const handleCardClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!canMarkRead) return;
    // 点击来自卡片内交互元素(Open session / Restart / 菜单按钮)时不处理 ——
    // Open session 自带 markRead(避免重复 IPC),打开菜单等动作不应隐式标已读。
    if ((e.target as HTMLElement).closest('button, a, [role="menu"], [role="menuitem"]')) {
      return;
    }
    // …AndSync:settle 后无条件触发 renderer 本地刷新,main no-op 不广播时红点也能自愈。
    void markScheduleRunReadAndSync(run.id);
  };

  const referenceUnavailable =
    sessionReference?.state === 'deleted' || sessionReference?.state === 'missing';
  const handleOpenSession = async () => {
    if (!run.sessionId) return;
    try {
      // 展示状态与远程删除可能竞态；跳转前再查一次，避免进入已删除会话路由。
      const [reference] = await sessionService.resolveReferences([run.sessionId]);
      if (reference?.state !== 'available') {
        toast.error(t('scheduler.runs.sessionDeleted'));
        return;
      }
    } catch {
      toast.error(t('scheduler.runs.sessionUnavailable'));
      return;
    }
    // 先打 markRead 异步火(main 自己判断重复;no-op 不广播时由 …AndSync 的本地
    // 通道兜底刷新)→ navigate 切页
    if (!isLegacySessionRun) {
      void markScheduleRunReadAndSync(run.id);
    }
    // state.from 让目标页（TitleBar）判断要不要显示返回按钮；只在本次跳转生效，
    // 用户后续点别的 session 不会带上 state，按钮自然消失。
    navigate(`/cc-agent/${run.sessionId}`, { state: { from: 'automations' } });
  };

  // Restart 仅在没现场可恢复（sessionId 为空）且终态是 interrupted/aborted 时给：
  // - interrupted: app 重启时丢的 run，最常见
  // - aborted: 极少数在 session 创出来前就被取消的情况
  // 其他终态（success / failed-with-error）不给 Restart —— 前者没必要，后者
  // 通常是配置/代码问题，重跑会立刻再失败，让用户去 schedule header 的 Run now
  // 显式触发更安全。
  const canRestart =
    !!onRestart && !run.sessionId && (run.status === 'interrupted' || run.status === 'aborted');

  return (
    <article
      onClick={handleCardClick}
      title={canMarkRead ? t('scheduler.runs.markReadTitle') : undefined}
      className={cn(
        'group flex flex-col gap-2 rounded-xl border p-[14px_16px]',
        'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        canMarkRead && 'cursor-pointer',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative inline-flex shrink-0 items-center justify-center">
            <AgentMark
              agentKind={agentKind}
              size={16}
              className={cn(
                // running 时呼吸闪烁 + 强调橙（与 SessionItem 同套 .session-status-breathing 动画）
                run.status === 'running'
                  ? 'text-[var(--status-bar-accent)] session-status-breathing'
                  : 'text-[var(--cmd-palette-item-meta)]',
              )}
            />
            {isUnread && (
              <AttentionDot size={6} tone={unreadTone} className="absolute -top-0.5 -right-0.5" />
            )}
          </span>
          <span className="truncate text-14 font-medium text-[var(--msg-assistant-text)]">
            {formatRunTimestamp(run.firedAt)}
          </span>
        </div>
        <StatusChip status={run.status} />
      </header>

      {/* Meta 行：左侧 took/started + Open session，右侧已确定状态的 run hover 出 ⋯ 菜单。
          running 不显示删除（fireOne 还要 updateRun，此时删行会出 NOT_FOUND）。 */}
      <div className="flex items-center justify-between gap-2 text-12 text-[var(--cmd-palette-item-meta)]">
        <div className="flex min-w-0 items-center gap-1.5">
          <span>{metaText}</span>
          {run.sessionId && referenceUnavailable ? (
            <>
              <span aria-hidden>·</span>
              <span>{t('scheduler.runs.sessionDeleted')}</span>
            </>
          ) : run.sessionId ? (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => void handleOpenSession()}
                className={cn(
                  'inline-flex items-center gap-1 text-12',
                  'text-[var(--settings-section-desc)] hover:underline',
                  'transition-colors',
                )}
              >
                {t('scheduler.runs.openSession')}
                <ExternalLink size={12} strokeWidth={2.25} />
              </button>
            </>
          ) : canRestart ? (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => void onRestart!(run)}
                className={cn(
                  'inline-flex items-center gap-1 text-12',
                  'text-[var(--settings-section-desc)] hover:underline',
                  'transition-colors',
                )}
              >
                {t('scheduler.runs.restart')}
                <RotateCw size={12} strokeWidth={2.25} />
              </button>
            </>
          ) : null}
        </div>
        {(costText || (onDelete && !isLegacySessionRun && run.status !== 'running')) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {costText && (
              <span className="text-12 text-[var(--settings-section-desc)]">{costText}</span>
            )}
            {onDelete && !isLegacySessionRun && run.status !== 'running' && (
              // hover 才显示 ⋯ 按钮（对齐 SessionItem 模式），点击展开菜单 → Delete →
              // RunHistoryPane.handleDeleteRun 走 useConfirmDialog 二次确认。
              // data-[state=open] 让菜单展开期间按钮保持可见。
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('scheduler.runs.moreAria')}
                    className={cn(
                      'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      'text-[var(--cmd-palette-item-meta)] transition-opacity',
                      'opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100',
                      'hover:bg-[var(--chat-input-chip-bg)] hover:text-[var(--msg-assistant-text)]',
                      'focus:outline-none',
                    )}
                  >
                    <MoreHorizontal size={14} strokeWidth={2} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className={cn(
                    'min-w-[140px] rounded-xl p-1',
                    'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)]',
                  )}
                >
                  <DropdownMenuItem
                    onSelect={() => void onDelete(run)}
                    className={cn(
                      'cursor-pointer h-8 px-3 rounded-md text-sm',
                      'text-[hsl(var(--destructive))] focus:bg-[var(--cmd-palette-item-hover)]',
                    )}
                  >
                    <Trash2 size={13} strokeWidth={2} className="mr-2" />
                    {t('scheduler.runs.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {showError && (
        <p
          className={cn(
            'rounded-[8px] border px-2 py-1.5 font-mono text-11 break-words',
            'border-[var(--cmd-palette-border)] bg-[hsl(var(--content-area))] text-[var(--settings-section-desc)]',
          )}
        >
          {run.errorMsg}
        </p>
      )}

      {/* skipped:展示前置检查摘要(exit code / 耗时 / stdout 首行),灰阶弱化 —— 让
          "为什么这轮没跑"在历史里可追溯,与调度器故障区分。 */}
      {run.preRunHookResult && <PreRunHookResultDetails result={run.preRunHookResult} />}

      {run.status === 'skipped' && !run.preRunHookResult && run.resultText && (
        <p
          className={cn(
            'rounded-[8px] px-2 py-1.5 font-mono text-11 break-words',
            'bg-[hsl(var(--content-area))] text-[var(--cmd-palette-item-meta)]',
          )}
        >
          {run.resultText}
        </p>
      )}
    </article>
  );
}
