import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Schedule, SchedulerEvent } from '@cindy/maker-scheduler';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { activeScheduleFailures, isUnreadScheduleRun } from '@cindy/maker-shared/schedule-model';
import { loadScheduleSidebarIndexRuns, type ScheduleSidebarIndexRun } from '../lib/scheduleSidebarIndexRuns';
import { subscribeScheduleRunReadSync } from '../lib/scheduleRunReadSync';

const log = createLogger('ScheduleRunAttention');

/** 任务列表的点:红 = 未恢复的未读失败,绿 = 有未读成功结果。 */
export type ScheduleAttentionKind = 'error' | 'done';

/**
 * 运行记录给出的点:有未读且未恢复的失败 → 红;否则有未读成功 → 绿。读过即消失。
 * 「未恢复」沿用 activeScheduleFailures,与任务内失败提示同一口径。
 *
 * 维护者裁决(#10492, dash-s-cindy): AttentionDot 语义仅限 done/awaiting/error/info,
 * 不为 paused/绑定失效等静态状态额外造点 —— paused 已用降饱和 + 「已暂停」副标题
 * 表达,绑定失效下任务失败反而要提示用户介入。所以这里只返回 error / done。
 */
export function scheduleRunAttention(
  runs: readonly ScheduleSidebarIndexRun[],
): Map<string, ScheduleAttentionKind> {
  const failures = activeScheduleFailures(runs.map((run) => ({ ...run, id: run.runId })));
  const out = new Map<string, ScheduleAttentionKind>();
  for (const run of runs) {
    if (!isUnreadScheduleRun(run)) continue;
    if (failures.has(run.runId)) out.set(run.scheduleId, 'error');
    else if (run.status === 'success' && !out.has(run.scheduleId)) out.set(run.scheduleId, 'done');
  }
  return out;
}

export function useScheduleRunAttention(
  schedules: readonly Schedule[],
): ReadonlyMap<string, ScheduleAttentionKind> {
  const scheduleIdsKey = useMemo(
    () => schedules.map((schedule) => schedule.id).join('\u0000'),
    [schedules],
  );
  const [attention, setAttention] = useState<ReadonlyMap<string, ScheduleAttentionKind>>(() => new Map());
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const scheduleIds = scheduleIdsKey ? scheduleIdsKey.split('\u0000') : [];
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    if (scheduleIds.length === 0) {
      setAttention(new Map());
      return;
    }

    try {
      const visibleScheduleIds = new Set(scheduleIds);
      const runs = await loadScheduleSidebarIndexRuns();
      if (refreshSeqRef.current !== seq) return;
      setAttention(scheduleRunAttention(runs.filter((run) => visibleScheduleIds.has(run.scheduleId))));
    } catch (error) {
      log.warn('failed to refresh schedule run attention', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [scheduleIdsKey]);

  useEffect(() => {
    void refresh();
    const off = window.electronAPI.maker.schedule.onEvent((raw, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      const event = raw as SchedulerEvent;
      if (
        event.type === 'fired' ||
        event.type === 'completed' ||
        event.type === 'failed' ||
        // skipped 的前置检查通过时也算恢复(checkSucceeded),不刷新红点会滞留;
        // deferred 撤销了一条预置 running run,顺带刷新。
        event.type === 'skipped' ||
        event.type === 'deferred' ||
        event.type === 'session-bound' ||
        event.type === 'changed' ||
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
      off();
      offReadSync();
    };
  }, [refresh]);

  return attention;
}
