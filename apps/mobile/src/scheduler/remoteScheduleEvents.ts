import { useSyncExternalStore } from 'react';
import {
  projectScheduleEvent,
  type ScheduleEventProjection,
} from '@cindy/maker-shared/schedule-events';

export interface RemoteScheduleEventSnapshot {
  lastProjection: ScheduleEventProjection | null;
  runsVersion: number;
  scheduleListVersion: number;
  sessionIndexVersion: number;
  /**
   * 未读清除类事件(unreadImpact = may-clear-schedule / clear-all,即 read / all-read)
   * 的专用计数:消费方据此对 schedule-index 节流做 force 穿透(见 scheduleIndex 节流注释)。
   * 单列一个 version 而不让消费方依赖 lastProjection 引用——后者每个事件都换新,
   * 进 effect deps 会让 fired / deferred 等无关事件也触发昂贵的全量拉取。
   */
  unreadClearVersion: number;
  unreadVersion: number;
  version: number;
}

const emptySnapshot: RemoteScheduleEventSnapshot = Object.freeze({
  lastProjection: null,
  runsVersion: 0,
  scheduleListVersion: 0,
  sessionIndexVersion: 0,
  unreadClearVersion: 0,
  unreadVersion: 0,
  version: 0,
});

const snapshots = new Map<string, RemoteScheduleEventSnapshot>();
const subs = new Set<() => void>();

function emit(): void {
  for (const sub of subs) sub();
}

export const remoteScheduleEventStore = {
  apply(deviceId: string, payload?: unknown): void {
    if (!deviceId) return;
    const projection = projectScheduleEvent(payload);
    const prev = snapshots.get(deviceId) ?? emptySnapshot;
    const clearsUnread = projection.unreadImpact === 'may-clear-schedule'
      || projection.unreadImpact === 'clear-all';
    snapshots.set(deviceId, {
      lastProjection: projection,
      runsVersion: prev.runsVersion + (projection.refresh.runRefresh.mode === 'none' ? 0 : 1),
      scheduleListVersion: prev.scheduleListVersion + (projection.refresh.scheduleList ? 1 : 0),
      sessionIndexVersion: prev.sessionIndexVersion + (projection.refresh.sessionIndex ? 1 : 0),
      unreadClearVersion: prev.unreadClearVersion + (clearsUnread ? 1 : 0),
      unreadVersion: prev.unreadVersion + (projection.refresh.unreadSummary ? 1 : 0),
      version: prev.version + 1,
    });
    emit();
  },

  clearDevice(deviceId: string): void {
    if (!snapshots.delete(deviceId)) return;
    emit();
  },

  clearAll(): void {
    if (snapshots.size === 0) return;
    snapshots.clear();
    emit();
  },

  getSnapshot(deviceId: string): RemoteScheduleEventSnapshot {
    return snapshots.get(deviceId) ?? emptySnapshot;
  },

  getVersion(deviceId: string): number {
    return this.getSnapshot(deviceId).version;
  },

  subscribe(cb: () => void): () => void {
    subs.add(cb);
    return () => subs.delete(cb);
  },
};

export function useRemoteScheduleEventSnapshot(deviceId: string): RemoteScheduleEventSnapshot {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    () => remoteScheduleEventStore.getSnapshot(deviceId),
  );
}

export function useRemoteScheduleEventVersion(deviceId: string): number {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    () => remoteScheduleEventStore.getVersion(deviceId),
  );
}
