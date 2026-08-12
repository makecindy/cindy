import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Schedule, SchedulerEvent } from '@cindy/maker-scheduler';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { isUnreadScheduleRun } from '../lib/runUnread';
import { loadScheduleSidebarIndexRuns } from '../lib/scheduleSidebarIndexRuns';
import { subscribeScheduleRunReadSync } from '../lib/scheduleRunReadSync';

const log = createLogger('ScheduleUnreadRunCounts');

export function useScheduleUnreadRunCounts(
  schedules: readonly Schedule[],
): ReadonlyMap<string, number> {
  const scheduleIdsKey = useMemo(
    () => schedules.map((schedule) => schedule.id).join('\u0000'),
    [schedules],
  );
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const scheduleIds = scheduleIdsKey ? scheduleIdsKey.split('\u0000') : [];
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    if (scheduleIds.length === 0) {
      setCounts(new Map());
      return;
    }

    try {
      const visibleScheduleIds = new Set(scheduleIds);
      const runs = await loadScheduleSidebarIndexRuns();
      if (refreshSeqRef.current !== seq) return;

      const next = new Map<string, number>();
      for (const run of runs) {
        if (!visibleScheduleIds.has(run.scheduleId)) continue;
        if (!isUnreadScheduleRun(run)) continue;
        next.set(run.scheduleId, (next.get(run.scheduleId) ?? 0) + 1);
      }
      setCounts(next);
    } catch (error) {
      log.warn('failed to refresh schedule unread run counts', {
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

  return counts;
}
