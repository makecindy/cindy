/**
 * 离线镜像清理的通知合并队列。
 *
 * presence 整批离线时,每台设备各有一个 5s 宽限定时器;RN 的定时器队列会把同一
 * task 内到期的回调连续投递。若逐台执行清理并通知,每台各触发一轮 React 同步
 * 重渲染,设备数超过嵌套更新上限即致命退出(2026-09-10 Android 冷启动,40/80
 * 台隔离复现;同批处理仅 3 次渲染则正常)。这里把同一 task 内到期的设备收拢成
 * 一次 flush,由调用方一次性更新两个 store 并各 notify 一次。
 *
 * 只合并「通知」,不合并「清理」:flush 时每台设备的离线清理语义原样执行。
 */
export interface OfflineMirrorWipeQueue {
  enqueue(deviceId: string): void;
  pendingCount(): number;
}

export function createOfflineMirrorWipeQueue(
  flush: (deviceIds: string[]) => void,
  schedule: (callback: () => void) => void = (callback) => queueMicrotask(callback),
): OfflineMirrorWipeQueue {
  let pending: Set<string> | null = null;
  return {
    enqueue(deviceId: string): void {
      if (!deviceId) return;
      if (pending === null) {
        // 首台:登记并预约 flush。同 task 内后续设备只入队,不再预约。
        pending = new Set([deviceId]);
        schedule(() => {
          const deviceIds = [...(pending ?? [])];
          pending = null;
          if (deviceIds.length > 0) flush(deviceIds);
        });
        return;
      }
      pending.add(deviceId);
    },
    pendingCount(): number {
      return pending?.size ?? 0;
    },
  };
}
