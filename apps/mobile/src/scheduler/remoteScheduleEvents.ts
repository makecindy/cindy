import { useSyncExternalStore } from 'react';
import {
  projectScheduleEvent,
  type ScheduleEventProjection,
} from '@cindy/maker-shared/schedule-events';
import { invalidateScheduleIndexForDevice } from '@/session/scheduleIndex';

export interface RemoteScheduleEventSnapshot {
  lastProjection: ScheduleEventProjection | null;
  runsVersion: number;
  scheduleListVersion: number;
  sessionIndexVersion: number;
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
// 单调代次计数:不随 `clearDeviceMirrorInvalidation` 回绕,消费方(设备详情页)
// 据此区分「同一轮失效」与「清除后的新一轮失效」,离线 → 恢复 → 再离线时
// running 徽标不会被已消费的旧代次挡住。
const mirrorInvalidationGenerationCounter = new Map<string, number>();
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
    // Invalidate once before notifying all screens. Consumer-local force loads
    // otherwise launch competing scans for the same authoritative event.
    if (projection.refresh.sessionIndex || projection.refresh.scheduleList || clearsUnread) {
      invalidateScheduleIndexForDevice(deviceId);
    }
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
    // 幂等:marker 尚在且没有新事件快照时,重复的离线标记(presence 闪断、首页与
    // device-link 两层各标一次)不得再次 emit——否则挂载中的所有屏幕被反复拉进
    // 更新链,最终触发 React Maximum update depth(2026-09-10 Android 冷启动崩溃)。
    // 失效后有新事件写入快照时,快照重新上膛,这里照常清掉并广播一次。
    if (!snapshots.has(deviceId) && mirrorInvalidationVersions.has(deviceId)) return;
    snapshots.delete(deviceId);
    const generation = (mirrorInvalidationGenerationCounter.get(deviceId) ?? 0) + 1;
    mirrorInvalidationGenerationCounter.set(deviceId, generation);
    mirrorInvalidationVersions.set(deviceId, generation);
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  /**
   * 批量失效:同一波(如 presence 整批离线)只 emit 一次。逐台失效时每台各
   * notify 一轮,所有挂载屏被同步重渲染 N 次,设备数超过 React 嵌套更新上限
   * 即致命退出(2026-09-10 Android 冷启动,40/80 台隔离复现)。
   */
  invalidateDeviceMirrors(deviceIds: readonly string[]): void {
    let changed = false;
    for (const deviceId of deviceIds) {
      if (!deviceId) continue;
      snapshots.delete(deviceId);
      mirrorInvalidationVersions.set(
        deviceId,
        (mirrorInvalidationVersions.get(deviceId) ?? 0) + 1,
      );
      changed = true;
    }
    if (!changed) return;
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  clearDeviceMirrorInvalidation(deviceId: string): void {
    if (!mirrorInvalidationVersions.delete(deviceId)) return;
    // 计数器不清:代次跨清除单调,下一轮失效的 generation 继续前进。
    mirrorInvalidationSnapshot = new Map(mirrorInvalidationVersions);
    emit();
  },

  clearAll(): void {
    if (snapshots.size === 0 && mirrorInvalidationVersions.size === 0) return;
    snapshots.clear();
    mirrorInvalidationVersions.clear();
    mirrorInvalidationGenerationCounter.clear();
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
