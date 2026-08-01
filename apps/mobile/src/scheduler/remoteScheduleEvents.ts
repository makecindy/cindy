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
// Per-device mirror invalidation generation. Unlike event `version`, this survives
// `clearDevice()` so mounted screens can observe a presence-offline cleanup even when
// that device had not emitted a schedule event in the current process.
const mirrorInvalidationVersions = new Map<string, number>();
let mirrorInvalidationSnapshot: ReadonlyMap<string, number> = new Map();
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

  invalidateDeviceMirror(deviceId: string): void {
    if (!deviceId) return;
    snapshots.delete(deviceId);
    mirrorInvalidationVersions.set(
      deviceId,
      (mirrorInvalidationVersions.get(deviceId) ?? 0) + 1,
    );
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  clearDeviceMirrorInvalidation(deviceId: string): void {
    if (!mirrorInvalidationVersions.delete(deviceId)) return;
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  clearAll(): void {
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

export function useRemoteScheduleEventVersion(deviceId: string): number {
  return useSyncExternalStore(
    remoteScheduleEventStore.subscribe,
    () => remoteScheduleEventStore.getVersion(deviceId),
  );
}
