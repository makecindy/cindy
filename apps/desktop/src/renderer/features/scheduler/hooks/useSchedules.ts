/**
 * useSchedules — 订阅模块级 schedulesStore + 管理 ephemeral runningById
 * ---------------------------------------------------------------------------
 * 重构:数据所有权从本 hook 的 useState 搬到 `lib/schedulesStore.ts`。
 *   - schedules / loading / error 全部从 store 来,subscribe 由 useSyncExternalStore 管理
 *   - mount 时调 store.ensure();失败由 store.getError() 反映出来,hook 不再自己 try/catch
 *   - 'changed' / 'ready' 事件由 store 模块加载时全局监听,hook 不再订阅它们
 *   - 'fired' / 'completed' / 'failed' 属于本 hook 的 ephemeral state(runningById,
 *     只在 chip 短暂闪 'running' 用),仍由 hook 自己订阅
 *
 * 为什么这样拆:schedules 数据是全局共享(SchedulerPage 是单 hook 入口,但未来
 * 可能扩展);runningById 是 UI 即时态,跟具体 hook 实例的 visual feedback 绑定,
 * 不需要全局共享。
 *
 * Cold-start race 修复:见 `lib/schedulesStore.ts` 头部注释。两层兜底:
 *   1. main handler 已 awaitReady,IPC 自然 pending 而非 error
 *   2. store 切账号 logout listener 清 cache → relogin 后 'ready' 后台预热
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Schedule,
  SchedulerEvent,
  SchedulerRuntimeSnapshot,
} from '@cindy/maker-scheduler';

import {
  schedulesStore,
  useSchedulesSnapshot,
  useSchedulesError,
} from '../lib/schedulesStore';

export interface UseSchedulesResult {
  schedules: Schedule[];
  /** scheduleId → ephemeral runningRunId(用于 chip 短暂闪 'running')。 */
  runningById: Record<string, string | undefined>;
  /** 当前实例的并发占用与真实等待队列。 */
  runtimeSnapshot: SchedulerRuntimeSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSchedules(): UseSchedulesResult {
  const snapshot = useSchedulesSnapshot();
  const error = useSchedulesError();
  const [runningById, setRunningById] = useState<Record<string, string | undefined>>({});
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<SchedulerRuntimeSnapshot | null>(null);
  const runtimeRevisionRef = useRef(0);

  const refresh = useCallback(async () => {
    await schedulesStore.forceRefresh().catch(() => {
      /* 错误已经写到 store.lastError,UI 自动反映 */
    });
  }, []);

  useEffect(() => {
    // 命中 cache 时是 noop;cold-start 时进 main handler 内部 awaitReady。
    void schedulesStore.ensure().catch(() => {
      /* 同上 */
    });
    // 订阅 fired/completed/failed → runningById(ephemeral state,不进 store)
    const refreshRuntimeState = (): void => {
      const getRuntimeState = window.electronAPI.maker.schedule.getRuntimeState;
      if (!getRuntimeState) return;
      const revision = runtimeRevisionRef.current;
      void getRuntimeState()
        .then((snapshot) => {
          // 查询期间如果先收到了更新事件，不能让较旧响应覆盖新快照。
          if (runtimeRevisionRef.current === revision) {
            setRuntimeSnapshot(snapshot as SchedulerRuntimeSnapshot);
          }
        })
        .catch(() => {
          /* 瞬时诊断状态失败不影响任务列表主数据。 */
        });
    };
    const off = window.electronAPI.maker.schedule.onEvent((raw) => {
      const ev = raw as SchedulerEvent;
      if (ev.type === 'runtime-state') {
        runtimeRevisionRef.current += 1;
        setRuntimeSnapshot(ev.snapshot);
      } else if (ev.type === 'ready') {
        refreshRuntimeState();
      } else if (ev.type === 'fired') {
        setRunningById((m) => ({ ...m, [ev.scheduleId]: ev.runId }));
      } else if (
        ev.type === 'completed' ||
        ev.type === 'failed' ||
        ev.type === 'deferred' ||
        ev.type === 'skipped'
      ) {
        // 'deferred' 撞忙顺延:本轮没真跑、不留可见 run,但 'fired' 已把 chip 点亮,
        // 需在此清掉,否则卡在 running 直到下一次真 run 完成。匹配 runId 防误清新一轮。
        // 'skipped' 前置检查拦截:同样要清 running chip;run 记录保留为 'skipped'。
        setRunningById((m) => {
          if (m[ev.scheduleId] !== ev.runId) return m;
          const next = { ...m };
          delete next[ev.scheduleId];
          return next;
        });
      }
    });
    refreshRuntimeState();
    return off;
  }, []);

  return {
    schedules: snapshot ?? [],
    runningById,
    runtimeSnapshot,
    // loading 仅在"从未加载过 且 也没错误"时为 true;
    // 有错误时 SchedulerPage 走 error 分支显示文案,不应该再显示 loading。
    loading: snapshot === null && error === null,
    error,
    refresh,
  };
}
