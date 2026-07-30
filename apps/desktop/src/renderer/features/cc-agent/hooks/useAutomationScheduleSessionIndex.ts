import { useCallback, useEffect, useRef, useState } from 'react';
import type { SchedulerEvent } from '@cindy/maker-scheduler';

import { createLogger } from '@/lib/logger';
import {
  clearSessionAttention,
  hasSessionAttention,
} from '@/lib/sessionAttentionStore';
import type { RunLivenessStatus } from '@/lib/silencedSessionDoneStore';
import {
  clearSchedulerOwnedRun,
  clearSilencedRun,
  getScheduleRunSessionAttentionBaseline,
  getSilencedRunSessionId,
  getSilencedRunSessionIdForAttentionFallback,
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  hasAnyRunMarker,
  MARKER_TERMINAL_LINGER_MS,
  reconcileRunMarkers,
  rememberScheduleRunSessionAttentionBaseline,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
} from '@/lib/silencedSessionDoneStore';
import type { AutomationScheduleSessionInfo } from '../lib/automationSidebarGrouping';
import { isUnreadScheduleRun } from '../../scheduler/lib/runUnread';
import { loadScheduleSidebarIndexSnapshot } from '../../scheduler/lib/scheduleSidebarIndexRuns';
import { subscribeScheduleRunReadSync } from '../../scheduler/lib/scheduleRunReadSync';

const log = createLogger('AutomationScheduleSessionIndex');

/**
 * refresh 失败后的退避重试节奏。这次拉取同时承担抑制标记的对账(见 refresh 内注释),
 * 而失败路径原本只 log —— 于是「消费方卸载期间丢了终态事件 + 重新挂载时首次拉取又
 * 因 scheduler 未 ready / 临时 IPC 或 DB 错误 reject + 此后再没有任何 scheduler 或
 * read-sync 事件」这条链上,标记会永久残留,该 session 后续手动对话的完成通知会一直
 * 被静默。有限重试给自愈留出第二次机会;重试耗尽后仍靠后续事件兜。
 */
const REFRESH_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/**
 * 快照内部不一致时的重查延迟。见 `ReconcileRunMarkersResult.needsRecheck`:run 恰好在
 * DB 查询的 await 窗口内结束时,DB 行还是 running 而 controller 已注销,本轮只能保守保持
 * 标记;若该 run 的终态事件正是丢掉的那个,就要靠这次重查来清。与失败重试分开计时,也不
 * 占用它的退避配额 —— 这不是失败,只是需要一份更新的快照。
 */
const RECONCILE_RECHECK_DELAY_MS = 1_500;

export function useAutomationScheduleSessionIndex(): ReadonlyMap<string, AutomationScheduleSessionInfo> {
  const [index, setIndex] = useState<ReadonlyMap<string, AutomationScheduleSessionInfo>>(
    () => new Map(),
  );
  const refreshSeqRef = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 已卸载标记。cleanup 只能清掉「那一刻已存在」的定时器,但卸载时若拉取仍 pending,
   * 它之后 reject(例如撞上 scheduler readiness 的 30s 超时)会走 catch 再排一个新定时器
   * —— 于是退避耗尽后每 30s 无限重试,把已卸载的 hook 一直留着、持续发无用 IPC/DB 读,
   * 重挂载后还会叠加出多条轮询。所有排定时器的地方都必须先看这个标记。
   * StrictMode 下 mount→unmount→mount,所以在 effect 开头重置。
   */
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    try {
      const { runs, inflightRunIds } = await loadScheduleSidebarIndexSnapshot();
      if (refreshSeqRef.current !== seq || cancelledRef.current) return;

      // 抑制标记的事件丢失自愈:这份列表是 scheduler 落库的权威 run 状态(且包含所有
      // 带 sessionId 的 run,没有 history limit),据它清掉「已终态」和「已不存在」的
      // 标记。RunStatus 里只有 'running' 不是终态。刻意不用定时器猜 run 还在不在飞行
      // —— 见 silencedSessionDoneStore 的文件头与 reconcileRunMarkers 注释。
      const dbRunStatus = new Map<string, RunLivenessStatus>();
      for (const run of runs) {
        dbRunStatus.set(run.runId, run.status === 'running' ? 'running' : 'terminal');
      }
      // 两份数据分别传进去 —— 对账内部让 in-flight 优先(自删除场景下 run 行已消失却仍
      // 在跑),并识别「DB 说 running、引擎说没在跑」的不一致,交由下面的重查收口。
      const { needsRecheck } = reconcileRunMarkers(dbRunStatus, new Set(inflightRunIds));
      if (needsRecheck && recheckTimerRef.current === null) {
        recheckTimerRef.current = setTimeout(() => {
          recheckTimerRef.current = null;
          void refreshRef.current();
        }, RECONCILE_RECHECK_DELAY_MS);
      }

      const next = new Map<string, AutomationScheduleSessionInfo>();
      for (const run of runs) {
        if (!run.sessionId) continue;
        const existing = next.get(run.sessionId);
        const unreadRunIds = existing?.unreadRunIds ? [...existing.unreadRunIds] : [];
        // 只对未读 run 累加(与 isUnreadScheduleRun 对齐)。failed/aborted/interrupted
        // 三种未读 run 视为"未成功",拉高本 session 的 urgency 让侧栏涂红而不是涂绿。
        const isRunUnread = isUnreadScheduleRun(run);
        if (isRunUnread) unreadRunIds.push(run.runId);
        const runFailedUnread =
          isRunUnread &&
          (run.status === 'failed' || run.status === 'aborted' || run.status === 'interrupted');
        const hasUnreadFailedRun = (existing?.hasUnreadFailedRun ?? false) || runFailedUnread;
        next.set(run.sessionId, {
          scheduleId: run.scheduleId,
          scheduleName: run.scheduleName,
          scheduleStatus: run.scheduleStatus,
          scheduleSource: run.scheduleSource,
          nextFireAt: run.nextFireAt,
          workingDir: run.workingDir,
          projectConfigId: run.projectConfigId,
          unreadRunIds,
          hasUnreadRun: unreadRunIds.length > 0,
          hasUnreadFailedRun,
        });
      }
      setIndex(next);
      retryAttemptRef.current = 0;
    } catch (error) {
      log.warn('failed to build automation schedule session index', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 卸载后到达的 rejection 不再排新定时器,见 cancelledRef。
      if (cancelledRef.current) return;
      // 见 REFRESH_RETRY_DELAYS_MS:这次拉取也是标记对账的载体,失败不能只 log。
      // 退避档位用尽后:仍有标记待对账就按最后一档持续重试(否则 scheduler / IPC / DB
      // 连续不可用超过三档窗口、且此后再无事件时,标记会永久残留);没有标记则停手,
      // 侧栏索引本身是 best-effort,交给后续事件。
      const attempt = retryAttemptRef.current;
      const delayMs =
        REFRESH_RETRY_DELAYS_MS[attempt] ??
        (hasAnyRunMarker()
          ? REFRESH_RETRY_DELAYS_MS[REFRESH_RETRY_DELAYS_MS.length - 1]
          : undefined);
      if (delayMs === undefined) return;

      retryAttemptRef.current = attempt + 1;
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void refreshRef.current();
      }, delayMs);
    }
  }, []);

  refreshRef.current = refresh;

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    const off = window.electronAPI.maker.schedule.onEvent((raw) => {
      const event = raw as SchedulerEvent;
      if (event.type === 'session-bound') {
        // Scheduler notifier 是 schedule.notify 的唯一外发通知 owner；普通 session
        // transition 仍负责 attention，但不能再发第二条桌面 / 飞书通知。
        markNextSessionTerminalNotificationOwnedByScheduler(event.runId, event.sessionId);
        rememberScheduleRunSessionAttentionBaseline(
          event.runId,
          event.sessionId,
          hasSessionAttention(event.sessionId),
        );
      }
      if (event.type === 'silenced') {
        const baseline = getScheduleRunSessionAttentionBaseline(event.runId);
        markNextSessionDoneSilenced(
          event.runId,
          event.sessionId,
          baseline?.sessionId === event.sessionId
            ? baseline.hadSessionAttention
            : hasSessionAttention(event.sessionId),
        );
        return;
      }
      if (event.type === 'notified') {
        clearSilencedRun(event.runId);
        return;
      }
      if (event.type === 'completed' && event.silenced) {
        let sessionId = getSilencedRunSessionIdForAttentionFallback(event.runId);
        if (!getSilencedRunSessionId(event.runId) && event.sessionId) {
          const baseline = getScheduleRunSessionAttentionBaseline(event.runId);
          markNextSessionDoneSilenced(
            event.runId,
            event.sessionId,
            baseline?.sessionId === event.sessionId
              ? baseline.hadSessionAttention
              : hasSessionAttention(event.sessionId),
          );
          sessionId = getSilencedRunSessionIdForAttentionFallback(event.runId);
        }
        if (sessionId) clearSessionAttention(sessionId);
        scheduleClearSilencedRun(event.runId, MARKER_TERMINAL_LINGER_MS);
      } else if (event.type === 'completed') {
        clearSilencedRun(event.runId);
      } else if (event.type === 'failed' || event.type === 'deferred') {
        clearSilencedRun(event.runId);
      }
      // completed / failed 可能早于 React transition effect 消费终态，延迟清理；
      // deferred / skipped 没有可接管的 session 终态，立即释放，避免误伤后续 turn。
      if (event.type === 'completed' || event.type === 'failed') {
        scheduleClearSchedulerOwnedRun(event.runId, MARKER_TERMINAL_LINGER_MS);
      } else if (event.type === 'deferred' || event.type === 'skipped') {
        clearSchedulerOwnedRun(event.runId);
      }
      if (
        event.type === 'changed' ||
        event.type === 'completed' ||
        event.type === 'failed' ||
        event.type === 'session-bound' ||
        event.type === 'read' ||
        event.type === 'all-read'
      ) {
        void refresh();
      }
    });
    // 本地标记已读动作后的无条件刷新:main 对"DB 已是已读"的标记是 no-op 且不
    // 广播,跨实例过期的未读快照等不到上面的事件,必须靠这条本地通道自愈
    // (见 scheduleRunReadSync 模块注释)。
    const offReadSync = subscribeScheduleRunReadSync(() => void refresh());
    return () => {
      cancelledRef.current = true;
      off();
      offReadSync();
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (recheckTimerRef.current !== null) {
        clearTimeout(recheckTimerRef.current);
        recheckTimerRef.current = null;
      }
    };
  }, [refresh]);

  return index;
}
