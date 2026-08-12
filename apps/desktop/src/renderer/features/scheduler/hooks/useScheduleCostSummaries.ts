import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Schedule, SchedulerEvent } from '@cindy/maker-scheduler';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import type { RegionalMoney } from '../../../../shared/regionalMoney';

const log = createLogger('ScheduleCostSummaries');

/** 单个自动化任务按自动化触发的 turn 汇总出的累计开销。 */
export interface ScheduleCostSummary {
  scheduleId: string;
  totalMoney: RegionalMoney;
  totalEstimatedValueMoney: RegionalMoney;
  totalCostUsd?: number;
  totalEstimatedValueUsd?: number;
  /** 至少一轮自动化无法取得可靠费用。 */
  hasUnavailableCost?: boolean;
  /** 产生过自动化 turn cost 的去重 session 数；legacy 会话兜底同样计入。 */
  sessionCount: number;
  sessions?: readonly ScheduleSessionCostSummary[];
}

export interface ScheduleSessionCostSummary {
  sessionId: string;
  totalMoney: RegionalMoney;
  totalEstimatedValueMoney: RegionalMoney;
  totalCostUsd?: number;
  totalEstimatedValueUsd?: number;
}

/** Automation 任务列表的 cost summary 状态；loaded=false 时 UI 不显示占位金额。 */
export interface UseScheduleCostSummariesResult {
  summaries: ReadonlyMap<string, ScheduleCostSummary>;
  loaded: boolean;
}

export function useScheduleCostSummaries(
  schedules: readonly Schedule[],
): UseScheduleCostSummariesResult {
  const scheduleIdsKey = useMemo(
    () => schedules.map((schedule) => schedule.id).join('\u0000'),
    [schedules],
  );
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ScheduleCostSummary>>(
    () => new Map(),
  );
  const [loaded, setLoaded] = useState(false);
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const scheduleIds = scheduleIdsKey ? scheduleIdsKey.split('\u0000') : [];
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    if (scheduleIds.length === 0) {
      setSummaries(new Map());
      setLoaded(true);
      return;
    }

    try {
      const visibleScheduleIds = new Set(scheduleIds);
      const rows =
        (await window.electronAPI.maker.schedule.listCostSummaries()) as ScheduleCostSummary[];
      if (refreshSeqRef.current !== seq) return;

      const next = new Map<string, ScheduleCostSummary>();
      for (const row of rows) {
        if (!visibleScheduleIds.has(row.scheduleId)) continue;
        next.set(row.scheduleId, row);
      }
      setSummaries(next);
      setLoaded(true);
    } catch (error) {
      log.warn('failed to refresh schedule cost summaries', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [scheduleIdsKey]);

  useEffect(() => {
    void refresh();
    const offSchedule = window.electronAPI.maker.schedule.onEvent((raw, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      const event = raw as SchedulerEvent;
      if (
        event.type === 'fired' ||
        event.type === 'completed' ||
        event.type === 'failed' ||
        event.type === 'session-bound' ||
        event.type === 'changed' ||
        event.type === 'ready'
      ) {
        void refresh();
      }
    });
    const offSpend = window.electronAPI.onUsageSessionSpendChanged((_payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      void refresh();
    });
    const offTurnCost = window.electronAPI.onUsageMessageTurnCost?.((_payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      void refresh();
    });
    return () => {
      offSchedule();
      offSpend();
      offTurnCost?.();
    };
  }, [refresh]);

  return { summaries, loaded };
}
