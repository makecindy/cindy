import { useSyncExternalStore } from 'react';
import {
  isPatchableSkippedScheduleEvent,
  projectScheduleEvent,
  type ScheduleEventProjection,
} from '@cindy/maker-shared/schedule-events';
import {
  deviceHasFailedScheduleInIndexCache,
  hasCurrentScheduleIndexRecord,
  noteScheduleEventInIndexCache,
} from '@/session/scheduleIndex';

export interface RemoteScheduleTimingPatch {
  scheduleId: string;
  lastFiredAt?: number;
  lastFinishedAt?: number;
  nextFireAt?: number;
}

export interface RemoteScheduleEventSnapshot {
  lastProjection: ScheduleEventProjection | null;
  runsVersion: number;
  scheduleListVersion: number;
  /** 新主机 skipped 事件携带的原位排期时间戳补丁,供列表与详情无需整表重拉即可获知最新下次时间。 */
  scheduleTimings: ReadonlyMap<string, RemoteScheduleTimingPatch>;
  sessionIndexVersion: number;
  /** 仅在事件可能新增或变更远端会话行(带非空 sessionId / ready / unknown)时递增,避免纯排期事件拉整张 sessions:list。 */
  sessionListVersion: number;
  /**
   * 未读清除类事件(unreadImpact = may-clear-schedule / clear-all,即 read / all-read)
   * 的专用计数:事件先使共享索引失效,消费方据此读取同一轮新索引。
   * 单列一个 version 而不让消费方依赖 lastProjection 引用——后者每个事件都换新,
   * 进 effect deps 会让 fired / deferred 等无关事件也触发昂贵的全量拉取。
   */
  unreadClearVersion: number;
  unreadVersion: number;
  version: number;
}

const emptyTimings: ReadonlyMap<string, RemoteScheduleTimingPatch> = new Map();

const emptySnapshot: RemoteScheduleEventSnapshot = Object.freeze({
  lastProjection: null,
  runsVersion: 0,
  scheduleListVersion: 0,
  scheduleTimings: emptyTimings,
  sessionIndexVersion: 0,
  sessionListVersion: 0,
  unreadClearVersion: 0,
  unreadVersion: 0,
  version: 0,
});

const snapshots = new Map<string, RemoteScheduleEventSnapshot>();
const patchedSkippedRunIds = new Map<string, Map<string, string>>();
// Per-device mirror invalidation generation. Unlike event `version`, this survives
// `clearDevice()` so mounted screens can observe a presence-offline cleanup even when
// that device had not emitted a schedule event in the current process.
const mirrorInvalidationVersions = new Map<string, number>();
// Keep generations monotonic across recovery/clear without retaining per-device counters.
let nextMirrorInvalidationGeneration = 0;
let mirrorInvalidationSnapshot: ReadonlyMap<string, number> = new Map();
const subs = new Set<() => void>();

function emit(): void {
  for (const sub of subs) sub();
}

export const remoteScheduleEventStore = {
  apply(deviceId: string, payload?: unknown): void {
    if (!deviceId) return;
    let projection = projectScheduleEvent(payload);
    if (
      projection.event.type === 'changed'
      && projection.event.skippedRunId
      && hasCurrentScheduleIndexRecord(deviceId)
      && patchedSkippedRunIds.get(deviceId)?.get(projection.event.scheduleId) === projection.event.skippedRunId
    ) {
      return;
    }
    if (isPatchableSkippedScheduleEvent(projection.event)) {
      const indexReady = hasCurrentScheduleIndexRecord(deviceId);
      const needsFailureRecovery =
        projection.event.preRunCheckSucceeded === true
        && deviceHasFailedScheduleInIndexCache(deviceId, projection.event.scheduleId);
      if (!indexReady || needsFailureRecovery) {
        projection = {
          ...projection,
          refresh: {
            ...projection.refresh,
            sessionIndex: true,
            unreadSummary: needsFailureRecovery,
          },
        };
      }
    }
    const clearsUnread = projection.unreadImpact === 'may-clear-schedule'
      || projection.unreadImpact === 'clear-all';
    // 不要求任何刷新、也不带 run 状态的事件(runtime-state 高频诊断)不换快照:否则挂载屏
    // 每次都重渲染,且会覆盖上一个可操作事件(如 completed)的 lastProjection。
    if (
      projection.refresh.runRefresh.mode === 'none'
      && !projection.refresh.scheduleList
      && !projection.refresh.sessionIndex
      && !projection.refresh.unreadSummary
      && projection.unreadImpact === 'none'
      && projection.runPatch.status === 'unknown'
    ) return;
    const prev = snapshots.get(deviceId) ?? emptySnapshot;
    let scheduleTimings = prev.scheduleTimings;
    if (projection.event.type === 'ready' || projection.event.type === 'unknown') {
      if (scheduleTimings.size > 0) scheduleTimings = emptyTimings;
      patchedSkippedRunIds.delete(deviceId);
    } else if (
      projection.event.type === 'changed'
      || projection.event.type === 'fired'
      || projection.event.type === 'completed'
      || projection.event.type === 'failed'
      || projection.event.type === 'deferred'
    ) {
      patchedSkippedRunIds.get(deviceId)?.delete(projection.event.scheduleId);
      if (scheduleTimings.has(projection.event.scheduleId)) {
        const nextTimings = new Map(scheduleTimings);
        nextTimings.delete(projection.event.scheduleId);
        scheduleTimings = nextTimings;
      }
    } else if (
      projection.event.type === 'skipped'
      && (projection.event.lastFiredAt !== undefined
        || projection.event.lastFinishedAt !== undefined
        || projection.event.nextFireAt !== undefined)
    ) {
      const nextTimings = new Map(scheduleTimings);
      nextTimings.set(projection.event.scheduleId, {
        scheduleId: projection.event.scheduleId,
        ...(projection.event.lastFiredAt !== undefined ? { lastFiredAt: projection.event.lastFiredAt } : {}),
        ...(projection.event.lastFinishedAt !== undefined ? { lastFinishedAt: projection.event.lastFinishedAt } : {}),
        ...(projection.event.nextFireAt !== undefined ? { nextFireAt: projection.event.nextFireAt } : {}),
      });
      scheduleTimings = nextTimings;
      if (!projection.refresh.sessionIndex && hasCurrentScheduleIndexRecord(deviceId)) {
        let perSchedule = patchedSkippedRunIds.get(deviceId);
        if (!perSchedule) {
          perSchedule = new Map();
          patchedSkippedRunIds.set(deviceId, perSchedule);
        }
        perSchedule.set(projection.event.scheduleId, projection.event.runId);
      } else {
        patchedSkippedRunIds.get(deviceId)?.delete(projection.event.scheduleId);
      }
    }
    const touchesSessionList =
      projection.event.type === 'ready'
      || projection.event.type === 'unknown'
      || projection.runPatch.sessionId !== null;
    // Invalidate once before notifying all screens. Consumer-local force loads
    // otherwise launch competing scans for the same authoritative event.
    noteScheduleEventInIndexCache(deviceId, {
      invalidate: projection.refresh.sessionIndex || projection.refresh.scheduleList || clearsUnread,
      sessionId: projection.runPatch.sessionId,
      scheduleListChanged: projection.refresh.scheduleList,
    });
    snapshots.set(deviceId, {
      lastProjection: projection,
      runsVersion: prev.runsVersion + (projection.refresh.runRefresh.mode === 'none' ? 0 : 1),
      scheduleListVersion: prev.scheduleListVersion + (projection.refresh.scheduleList ? 1 : 0),
      scheduleTimings,
      sessionIndexVersion: prev.sessionIndexVersion + (projection.refresh.sessionIndex ? 1 : 0),
      sessionListVersion: prev.sessionListVersion + (touchesSessionList ? 1 : 0),
      unreadClearVersion: prev.unreadClearVersion + (clearsUnread ? 1 : 0),
      unreadVersion: prev.unreadVersion + (projection.refresh.unreadSummary ? 1 : 0),
      version: prev.version + 1,
    });
    emit();
  },

  clearDevice(deviceId: string): void {
    patchedSkippedRunIds.delete(deviceId);
    if (!snapshots.delete(deviceId)) return;
    emit();
  },

  invalidateDeviceMirror(deviceId: string): void {
    remoteScheduleEventStore.invalidateDeviceMirrors([deviceId]);
  },

  /**
   * 批量失效:同一波(如 presence 整批离线)只 emit 一次。逐台失效时每台各
   * notify 一轮,所有挂载屏被同步重渲染 N 次,设备数超过 React 嵌套更新上限
   * 即致命退出(2026-09-10 Android 冷启动,40/80 台隔离复现)。
   */
  invalidateDeviceMirrors(deviceIds: readonly string[]): void {
    let changed = false;
    for (const deviceId of new Set(deviceIds)) {
      if (!deviceId) continue;
      // Presence and Home may report the same offline state independently. Only
      // publish again after recovery clears the marker or a fresh event arrives.
      if (mirrorInvalidationVersions.has(deviceId) && !snapshots.has(deviceId)) continue;
      snapshots.delete(deviceId);
      patchedSkippedRunIds.delete(deviceId);
      mirrorInvalidationVersions.set(
        deviceId,
        ++nextMirrorInvalidationGeneration,
      );
      changed = true;
    }
    if (!changed) return;
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  clearDeviceMirrorInvalidation(deviceId: string): void {
    if (!mirrorInvalidationVersions.delete(deviceId)) return;
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  clearAll(): void {
    patchedSkippedRunIds.clear();
    if (snapshots.size === 0 && mirrorInvalidationVersions.size === 0) return;
    snapshots.clear();
    mirrorInvalidationVersions.clear();
    mirrorInvalidationSnapshot = new Map();
    emit();
  },

  getSnapshot(deviceId: string): RemoteScheduleEventSnapshot {
    return snapshots.get(deviceId) ?? emptySnapshot;
  },

  getVersion(deviceId: string): number {
    return this.getSnapshot(deviceId).version;
  },

  getMirrorInvalidationSnapshot(): ReadonlyMap<string, number> {
    return mirrorInvalidationSnapshot;
  },

  subscribe(cb: () => void): () => void {
    subs.add(cb);
    return () => subs.delete(cb);
  },
};

export function useRemoteScheduleMirrorInvalidations(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    remoteScheduleEventStore.getMirrorInvalidationSnapshot,
  );
}

export function useRemoteScheduleEventSnapshot(deviceId: string): RemoteScheduleEventSnapshot {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    () => remoteScheduleEventStore.getSnapshot(deviceId),
  );
}

export function applyRemoteScheduleTimingsToIndex<
  T extends {
    scheduleId: string;
    running: boolean;
    nextFireAt?: number;
    latestRunAt?: number;
    scheduleStatus?: string;
    latestFailedRun?: { nextFireAt?: number };
  },
>(
  index: Map<string, T>,
  timings: ReadonlyMap<string, RemoteScheduleTimingPatch>,
  allowedSessionIds?: ReadonlySet<string>,
): Map<string, T> {
  if (index.size === 0 || timings.size === 0) return index;
  let next: Map<string, T> | null = null;
  for (const [sessionId, info] of index) {
    if (allowedSessionIds && !allowedSessionIds.has(sessionId)) continue;
    const patch = timings.get(info.scheduleId);
    if (!patch) continue;
    if (
      info.latestRunAt !== undefined
      && patch.lastFinishedAt !== undefined
      && info.latestRunAt > patch.lastFinishedAt
    ) {
      continue;
    }
    const nextRunning = patch.lastFinishedAt !== undefined ? false : info.running;
    const nextFireAt = patch.nextFireAt !== undefined ? patch.nextFireAt : info.nextFireAt;
    const nextLatestRunAt = Math.max(
      info.latestRunAt ?? 0,
      patch.lastFinishedAt ?? patch.lastFiredAt ?? 0,
    ) || info.latestRunAt;
    const nextFailedRun =
      info.latestFailedRun
      && info.scheduleStatus === 'active'
      && patch.nextFireAt !== undefined
      && info.latestFailedRun.nextFireAt !== patch.nextFireAt
        ? { ...info.latestFailedRun, nextFireAt: patch.nextFireAt }
        : info.latestFailedRun;
    if (
      nextRunning === info.running
      && nextFireAt === info.nextFireAt
      && nextLatestRunAt === info.latestRunAt
      && nextFailedRun === info.latestFailedRun
    ) {
      continue;
    }
    next ??= new Map(index);
    next.set(sessionId, {
      ...info,
      running: nextRunning,
      nextFireAt,
      ...(nextLatestRunAt !== undefined ? { latestRunAt: nextLatestRunAt } : {}),
      ...(nextFailedRun !== info.latestFailedRun ? { latestFailedRun: nextFailedRun } : {}),
    });
  }
  return next ?? index;
}
