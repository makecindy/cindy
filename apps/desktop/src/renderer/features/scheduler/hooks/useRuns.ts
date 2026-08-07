/**
 * useRuns — 单条 schedule 的 run 历史
 * ---------------------------------------------------------------------------
 * 切换 scheduleId 时**不清空** runs / error：先发起 fetch，新数据到达后再原子替换。
 * 这样 RunHistoryPane 在切任务时持续显示旧列表，避免 hasLoaded=false 的空白帧。
 *
 * 暴露的 runsScheduleId = "当前 runs 实际属于哪条 schedule"；调用方据此判断
 * "新任务是否已经有自己的数据"。runsScheduleId === 当前 scheduleId 才算 ready。
 *
 * 同时订阅 onEvent，只在事件 scheduleId 匹配当前 scheduleId 时才 refetch。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleRun, SchedulerEvent } from '@cindy/maker-scheduler';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { subscribeScheduleRunReadSync } from '../lib/scheduleRunReadSync';

export interface UseRunsResult {
  runs: ScheduleRun[];
  loading: boolean;
  /**
   * runs 数组实际归属的 scheduleId。切任务还没拿到新数据时，等于上一个 scheduleId；
   * 新数据落地后变成 props 里的当前 scheduleId。null = 还没拿到过任何数据。
   */
  runsScheduleId: string | null;
  /** 任意 scheduleId 至少完成过一次 fetch（用于首次渲染时区分 "从没拉过" vs "刚换任务"）。 */
  hasLoaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRuns(scheduleId: string | null, limit = 50): UseRunsResult {
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsScheduleId, setRunsScheduleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 防止 race：同一 schedule 的连续刷新可能并发返回，旧快照不能覆盖新费用。
  // 用递增序号记录最近发起的 fetch，回调里只接受最新请求的结果。
  const latestFetchIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const fetchId = latestFetchIdRef.current + 1;
    latestFetchIdRef.current = fetchId;
    if (!scheduleId) {
      // 完全没有选中：清空展示。其他场景（切任务）保留旧数据等新数据替换。
      setRuns([]);
      setRunsScheduleId(null);
      setLoading(false);
      setError(null);
      setHasLoaded(false);
      return;
    }
    setLoading(true);
    try {
      const list = (await window.electronAPI.maker.schedule.listRuns(scheduleId, limit)) as ScheduleRun[];
      // 过期请求直接丢弃，不写 state
      if (latestFetchIdRef.current !== fetchId) return;
      setRuns(list);
      setRunsScheduleId(scheduleId);
      setError(null);
    } catch (e) {
      if (latestFetchIdRef.current !== fetchId) return;
      setError(e instanceof Error ? e.message : String(e));
      // 失败也算"这条 scheduleId 有结论"，让 caller 走 error 分支
      setRunsScheduleId(scheduleId);
    } finally {
      if (latestFetchIdRef.current === fetchId) {
        setLoading(false);
        setHasLoaded(true);
      }
    }
  }, [scheduleId, limit]);

  useEffect(() => {
    if (!scheduleId) {
      void refresh();
      return;
    }
    void refresh();
    const off = window.electronAPI.maker.schedule.onEvent((raw, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      const ev = raw as SchedulerEvent;
      if (ev.type === 'all-read') {
        void refresh();
        return;
      }
      // 全局事件没有 scheduleId，也跟"某条 schedule 的 run 列表"无关。
      if (ev.type === 'ready' || ev.type === 'runtime-state') return;
      if (ev.scheduleId !== scheduleId) return;
      if (
        ev.type === 'fired' ||
        ev.type === 'completed' ||
        ev.type === 'failed' ||
        ev.type === 'session-bound' ||
        ev.type === 'changed' ||
        ev.type === 'read'
      ) {
        void refresh();
      }
    });
    // 本地标记已读动作后的无条件刷新:main 对"DB 已是已读"的标记是 no-op 且不
    // 广播,跨实例过期的未读快照等不到上面的事件,必须靠这条本地通道自愈
    // (见 scheduleRunReadSync 模块注释)。
    const offReadSync = subscribeScheduleRunReadSync(() => void refresh());
    // Codex 费用在 done 后异步查价并落 message/run 账本，可能晚于 completed 事件。
    // 监听费用广播，避免历史卡永久保留 completed 时读到的旧快照。
    const offTurnCost = window.electronAPI.onUsageMessageTurnCost?.((_payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      void refresh();
    });
    return () => {
      off();
      offReadSync();
      offTurnCost?.();
    };
  }, [scheduleId, refresh]);

  return { runs, loading, runsScheduleId, hasLoaded, error, refresh };
}
