/**
 * RunHistoryPane — 右侧执行历史面板
 * ---------------------------------------------------------------------------
 * 右侧执行历史面板的视觉规格：
 *   - Pane header: 任务名 + 副行 'cron · agent · destination' + [Run now pill] + [Edit]
 *   - 'RECENT RUNS · count' 小灰标签
 *   - 滚动 run 卡片列表（最多 50 条）
 *
 * 设计稿没画 pause/delete 入口，但功能不能丢 ——
 * 在 [Edit] 旁边加一个 [⋯] 溢出菜单收纳这些动作（最小偏离设计的折中方案）。
 *
 * useRuns(s.id) 在切任务时**不清空**旧 runs，新数据落地再原子替换 ——
 * 父级也不再用 key={s.id} 强制 remount，避免空白帧闪烁。
 * 用 runsScheduleId === s.id 区分"展示的是当前任务的数据"还是"过渡期的旧数据"，
 * 只有匹配时才允许走 empty / error 分支（否则就是旧数据，自然继续显示）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Pencil, Play, Pause, Trash2, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { AgentKind, Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useCCSessions } from '@/hooks/useCCSessions';
import { clearSessionAttentionMany } from '@/lib/sessionAttentionStore';

import { useRuns } from '../hooks/useRuns';
import { useSessionReferences } from '../hooks/useSessionReferences';
import { cronToConfig, summarizeConfig } from '../lib/cronCodexPreset';
import { basenameOf, describeDestination, humanizeAgentKind } from '../lib/formatters';
import { groupRunsForHistory } from '../lib/runHistoryGrouping';

import { RunHistoryCard } from './RunHistoryCard';

const PERSISTENT_SESSION_PREVIEW_LIMIT = 3;

interface Props {
  schedule: Schedule;
  onRunNow: (s: Schedule) => void | Promise<void>;
  onTogglePause: (s: Schedule) => void | Promise<void>;
  onEdit: (s: Schedule) => void;
  onDelete: (s: Schedule) => void | Promise<void>;
  /**
   * 页面级 runNow busy 守卫（由 SchedulerPage 传入）。
   * true 表示同一 schedule 已在 TaskListCell 行按钮处触发了 runNow 且 IPC 未回执，
   * 此时 detail pane 的 Run Now 按钮也应禁用，防止双发。
   */
  runNowBusy?: boolean;
}

export function RunHistoryPane({
  schedule: s,
  onRunNow,
  onTogglePause,
  onEdit,
  onDelete,
  runNowBusy = false,
}: Props) {
  const { t } = useTranslation();
  // 展示策略（避免切任务闪烁）：
  // - hasLoaded=false（应用启动后第一次都没拉过）→ 整块 run 区域不挂载
  // - hasLoaded=true 但 runsScheduleId !== s.id → 切任务过渡期，runs 还是上一个
  //   schedule 的数据，照常展示（含 RECENT RUNS 计数和卡片），等新数据原子替换
  // - runsScheduleId === s.id → 已经是当前任务的真数据，可以走 error / empty 分支
  const { runs, runsScheduleId, hasLoaded, error } = useRuns(s.id);
  const isCurrent = runsScheduleId === s.id;
  const busyScheduleIdsRef = useRef<Set<string>>(new Set());
  const [busyScheduleIds, setBusyScheduleIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedSessionIds, setExpandedSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { confirm } = useConfirmDialog();

  // 历史 cell 上的 agent icon 应反映"这次 run 实际用的 agent"，而不是 schedule 当前选的。
  // ScheduleRun 没存 agentKind，但每条 run 关联一个 session（run.sessionId），
  // session 上有 agentKind。这里拉 'all' 桶（含 archived）建 sessionId → AgentKind 映射，
  // session 已被删 / 桶未加载完 时 fallback 到 schedule 当前 agentKind。
  // Session.agentKind 是 'cc'|'codex'，scheduler 侧是 'claude-code'|'codex'，需要映射。
  const { sessions: allSessions } = useCCSessions({ includeArchived: 'all' });
  const runSessionIds = useMemo(
    () => runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])),
    [runs],
  );
  const sessionReferences = useSessionReferences(runSessionIds);
  const sessionAgentMap = useMemo(() => {
    const m = new Map<string, AgentKind>();
    for (const sess of allSessions) {
      m.set(sess.id, sess.agentKind === 'cc' ? 'claude-code' : 'codex');
    }
    return m;
  }, [allSessions]);
  const resolveRunAgent = useCallback(
    (run: ScheduleRun): AgentKind => {
      if (!run.sessionId) return s.agentKind;
      const referenceAgent = sessionReferences.get(run.sessionId)?.agentKind;
      return (
        sessionAgentMap.get(run.sessionId) ||
        (referenceAgent === 'cc' ? 'claude-code' : referenceAgent) ||
        s.agentKind
      );
    },
    [sessionAgentMap, sessionReferences, s.agentKind],
  );
  const displayEntries = useMemo(
    () => groupRunsForHistory(
      runs,
      isCurrent && (s.persistentSession === true || Boolean(s.targetSessionId)),
    ),
    [isCurrent, runs, s.persistentSession, s.targetSessionId],
  );
  const currentPersistentSessionId = useMemo(
    () => displayEntries.find((entry) => entry.kind === 'session')?.sessionId,
    [displayEntries],
  );
  useEffect(() => {
    setExpandedSessionIds(new Set());
  }, [s.id]);
  const toggleSessionGroup = useCallback((sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!isCurrent) return;
    const sessionIds = runs
      .map((r) => r.sessionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (sessionIds.length === 0) return;
    // 面板把每条 run 的成败状态展示给用户,done / awaiting 算已读。
    // 但**不清 error**(passive,store 对 error 免疫):看到"这次 run 失败了"不等于
    // 处置了会话里那条报错横幅 —— 红点跟随告警是否被处理,不跟随是否被看到
    // (2026-07 统一)。run 自身的未读由 read_at 落库单独收敛,不受影响;要批量
    // 消掉会话告警走自动化分组的「全部标为已读」(它会真正 dismiss 横幅)。
    clearSessionAttentionMany(sessionIds);
  }, [isCurrent, runs]);

  // 删单条 run：二次确认 → IPC → 'changed' 事件触发 useRuns refresh，UI 自动同步。
  // running 状态在 RunHistoryCard 已禁用按钮，这里不重复防御。
  const handleDeleteRun = useCallback(
    async (run: ScheduleRun) => {
      const ok = await confirm({
        title: t('scheduler.confirm.deleteRun.title'),
        description: t('scheduler.confirm.deleteRun.description'),
        confirmText: t('scheduler.confirm.deleteRun.confirm'),
        cancelText: t('scheduler.confirm.deleteRun.cancel'),
      });
      if (!ok) return;
      try {
        await window.electronAPI.maker.schedule.deleteRun(run.id);
        toast.success(t('scheduler.toast.runDeleted'));
      } catch (e) {
        toast.error(
          t('scheduler.toast.deleteFailed', { error: e instanceof Error ? e.message : String(e) }),
        );
      }
    },
    [confirm, t],
  );

  // Restart 单条 run：仅对"sessionId 为空 + interrupted/aborted"的 run 可用
  // （由 RunHistoryCard 内部判定后才回调）。语义上不是恢复旧 run，而是在父
  // schedule 上 force-fire 一次新 run；旧的 interrupted 行不动，让用户保留
  // 失败的现场记录。
  const handleRestartRun = useCallback(
    (run: ScheduleRun) => {
      if (run.scheduleId !== s.id) return;
      // runNowBusy 为 true 表示 Run Now 派发窗口尚未完成，阻止 Restart 双发
      if (runNowBusy) return;
      void wrap(run.scheduleId, async () => {
        try {
          await window.electronAPI.maker.schedule.runNow(s.id);
          toast.success(t('scheduler.toast.restarted'));
        } catch (e) {
          toast.error(
            t('scheduler.toast.restartFailed', {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      });
    },
    [s, t, runNowBusy],
  );

  const wrap = async (scheduleId: string, fn: () => void | Promise<void>) => {
    if (busyScheduleIdsRef.current.has(scheduleId)) return;
    busyScheduleIdsRef.current.add(scheduleId);
    setBusyScheduleIds(new Set(busyScheduleIdsRef.current));
    try {
      await fn();
    } finally {
      busyScheduleIdsRef.current.delete(scheduleId);
      setBusyScheduleIds(new Set(busyScheduleIdsRef.current));
    }
  };

  const busy = busyScheduleIds.has(s.id);
  const isPaused = s.status === 'paused';
  const isExpired = s.status === 'expired';
  const isProjectSchedule = s.source === 'project';
  // 用 summarizeConfig 复用创建对话框那套语义化摘要（"Daily at 09:00" / "Hourly" / "Weekly on Mon, Wed at 14:30" ...），
  // 跟 chip 文案 100% 对齐；不再用 cronToHuman 的 "At 09:00" 风格。
  // manual schedule 不参与 cron，cron 字段是占位 → header 显示 "Manual trigger"。
  const cronText = s.manual
    ? t('scheduler.detail.manualTrigger')
    : summarizeConfig(cronToConfig(s.cronExpr));
  const agentText = humanizeAgentKind(s.agentKind);
  const dest = describeDestination(s);
  // title 兜底显示完整路径，悬浮即可看到 — basename 视觉简洁，hover/title 看全量
  const titleText = `${cronText} · ${agentText} · ${dest.prefix}${dest.workingDir ?? ''}`;

  // 点击 workingDir → 系统文件管理器打开（参考 CCAgentSessionView 的 handleOpenWorkingDir）
  const handleOpenWorkingDir = useCallback(async () => {
    if (!dest.workingDir) return;
    try {
      const result = await window.electronAPI.openPath(dest.workingDir);
      if (!result.success) toast.error(result.error || t('scheduler.detail.openWorkdirFailed'));
    } catch {
      toast.error(t('scheduler.detail.openWorkdirFailed'));
    }
  }, [dest.workingDir, t]);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {/* Pane header */}
      <header className="flex shrink-0 items-start justify-between gap-3 px-6 pt-[18px]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="truncate text-lg font-medium text-[var(--msg-assistant-text)]">
            {s.name}
          </h2>
          <p className="truncate text-xs text-[var(--cmd-palette-item-meta)]" title={titleText}>
            {cronText} · {agentText} ·{' '}
            {dest.workingDir ? (
              <button
                type="button"
                onClick={() => void handleOpenWorkingDir()}
                title={dest.workingDir}
                className={cn(
                  'rounded text-[var(--cmd-palette-item-meta)] underline-offset-2 transition-colors',
                  'hover:text-[var(--msg-assistant-text)] hover:underline',
                )}
              >
                {dest.prefix}
                {basenameOf(dest.workingDir)}
              </button>
            ) : (
              dest.prefix
            )}
          </p>
        </div>
        {/* 动作区：从「Run now pill + Edit 图标 + ⋯ 溢出菜单」改为一排带图标+文字的 pill，
            语义直达（运行 / 编辑 / 启用·禁用 / 删除），少一次点击、不用猜图标含义。 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <PillButton
            // 直接调 onRunNow(=SchedulerPage.handleRunNow)——它自带同步防双击守卫,且 busy
            // 释放走 'fired' 事件。不再包 wrap:wrap 会 await 整个 run 跑完才解 busy,
            // 让本 pill(及同排其它 pill)在 run 期间一直卡在 disabled(同"行按钮卡死"根因)。
            onClick={() => void onRunNow(s)}
            // expired (含一次性已触发) 仍允许 Run now —— 引擎层 runNow 是 force-fire，
            // 不修改 schedule 的 status/lastFiredAt/nextFireAt，跟 Once 语义不冲突。
            // runNowBusy：派发窗口内(点击→'fired')由页面级传入禁用,防止双发;run 真正
            // 开跑后即释放。busy 仍覆盖本 pane 的 pause/delete 等在途操作。
            disabled={busy || runNowBusy}
            icon={<Play size={12} strokeWidth={2.25} />}
            label={t('scheduler.button.runNow')}
          />
          <PillButton
            onClick={() => onEdit(s)}
            disabled={busy}
            icon={<Pencil size={12} strokeWidth={2} />}
            label={t('scheduler.button.edit')}
          />
          <PillButton
            onClick={() => void wrap(s.id, () => onTogglePause(s))}
            disabled={busy || isExpired}
            icon={
              isPaused ? <Play size={12} strokeWidth={2} /> : <Pause size={12} strokeWidth={2} />
            }
            label={isPaused ? t('scheduler.button.enable') : t('scheduler.button.disable')}
          />
          {!isProjectSchedule && (
            <PillButton
              onClick={() => void wrap(s.id, () => onDelete(s))}
              disabled={busy}
              icon={<Trash2 size={12} strokeWidth={2} />}
              label={t('scheduler.button.delete')}
            />
          )}
        </div>
      </header>

      {/* Recent runs label —— 跟下面的列表区一起挂载/卸载，避免数字 0→N 跳变。
          count 与逐 run 卡片数量一致；持续会话也不再按 sessionId 折叠。 */}
      {hasLoaded && (
        <div className="px-6 pb-2 pt-4 text-10 font-medium tracking-[0.6px] text-[var(--cmd-palette-item-meta)]">
          {t('scheduler.detail.recentRuns', { count: runs.length })}
        </div>
      )}

      {/* Run list 容器：始终挂载占位（保持滚动区高度），内容仅在 hasLoaded 后渲染 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {hasLoaded &&
          (isCurrent && error ? (
            <p className="text-xs text-[var(--cmd-palette-item-meta)]">
              {t('scheduler.detail.runsLoadFailed', { error })}
            </p>
          ) : isCurrent && runs.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <History
                  size={28}
                  strokeWidth={1.5}
                  className="text-[var(--settings-section-desc)]"
                />
                <p className="text-sm text-[var(--cmd-palette-item-meta)]">
                  {t('scheduler.detail.noRunsHeading')}
                </p>
                <p className="max-w-[260px] text-xs text-[var(--settings-section-desc)]">
                  {t('scheduler.detail.noRunsHint')}
                </p>
              </div>
            </div>
          ) : runs.length > 0 ? (
            // isCurrent=false 时这里仍渲染上一条 schedule 的 runs，等新数据到达原子替换。
            // resolveRunAgent 用 sessionAgentMap fallback 当前 schedule.agentKind，过渡期
            // 短暂不一致可忽略；新数据落地后立刻矫正。
            <ul className="flex flex-col gap-3">
              {displayEntries.map((entry) => {
                if (entry.kind === 'run') {
                  const r = entry.run;
                  return (
                    <li key={entry.key}>
                      <RunHistoryCard
                        run={r}
                        agentKind={resolveRunAgent(r)}
                        sessionReference={r.sessionId ? sessionReferences.get(r.sessionId) : undefined}
                        onDelete={handleDeleteRun}
                        onRestart={handleRestartRun}
                      />
                    </li>
                  );
                }

                const isCurrentSession = entry.sessionId === currentPersistentSessionId;
                const isExpanded = expandedSessionIds.has(entry.sessionId);
                const visibleRuns = isExpanded
                  ? entry.runs
                  : isCurrentSession
                    ? entry.runs.slice(0, PERSISTENT_SESSION_PREVIEW_LIMIT)
                    : [];
                const hiddenCount = entry.runs.length - visibleRuns.length;
                const canToggle = !isCurrentSession || entry.runs.length > PERSISTENT_SESSION_PREVIEW_LIMIT;
                const toggleLabel = isExpanded
                  ? t('scheduler.runs.collapseSessionRuns')
                  : isCurrentSession
                    ? t('scheduler.runs.expandRemainingRuns', { count: hiddenCount })
                    : t('scheduler.runs.expandSessionRuns', { count: entry.runs.length });

                return (
                  <li key={entry.key}>
                    <section className="flex flex-col gap-3">
                      <button
                        type="button"
                        onClick={() => toggleSessionGroup(entry.sessionId)}
                        disabled={!canToggle}
                        aria-expanded={isExpanded || (isCurrentSession && hiddenCount === 0)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--cmd-palette-border)]',
                          'bg-[hsl(var(--content-area))] px-4 py-2.5 text-left',
                          'text-xs text-[var(--cmd-palette-item-meta)]',
                          'enabled:hover:text-[var(--msg-assistant-text)]',
                          'disabled:cursor-default',
                        )}
                      >
                        <span className="truncate font-medium text-[var(--msg-assistant-text)]">
                          {t('scheduler.runs.persistentSessionGroup', {
                            session: entry.sessionId.slice(0, 8),
                            count: entry.runs.length,
                          })}
                        </span>
                        {canToggle && (
                          <span className="inline-flex shrink-0 items-center gap-1.5">
                            {toggleLabel}
                            <ChevronDown
                              size={14}
                              className={cn('transition-transform', isExpanded && 'rotate-180')}
                              aria-hidden
                            />
                          </span>
                        )}
                      </button>
                      {visibleRuns.length > 0 && (
                        <ul className="ml-3 flex flex-col gap-3 border-l border-[var(--cmd-palette-border)] pl-3">
                          {visibleRuns.map((r) => (
                            <li key={r.id}>
                              <RunHistoryCard
                                run={r}
                                agentKind={resolveRunAgent(r)}
                                sessionReference={r.sessionId ? sessionReferences.get(r.sessionId) : undefined}
                                onDelete={handleDeleteRun}
                                onRestart={handleRestartRun}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </li>
                );
              })}
            </ul>
          ) : null)}
      </div>
    </section>
  );
}

/**
 * Pane header 的动作 pill：图标 + 两字文字标签，统一外观（运行 / 编辑 / 启用·禁用 / 删除）。
 * 采用与原 Run now 一致的圆角 chip 底色，避免纯图标按钮语义不清。
 */
function PillButton({
  icon,
  label,
  onClick,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-[30px] items-center gap-1.5 rounded-full px-3 text-xs font-medium',
        'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] hover:bg-[var(--settings-btn-secondary-hover-bg)]',
        // hover 上浮 1px + 图标轻微放大；按下回弹；disabled 不参与位移
        'transition-all hover:-translate-y-px active:translate-y-0',
        '[&_svg]:transition-transform hover:[&_svg]:scale-110',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:[&_svg]:scale-100',
      )}
      {...rest}
    >
      {icon}
      {label}
    </button>
  );
}
