/**
 * 离线镜像清理的通知合并队列。
 *
 * RN 可以在每个到期 timer 回调后清空微任务,queueMicrotask 因而无法合并
 * 集中离线的设备。使用固定 16ms 窗口跨回调收拢,不随新设备入队延长等待。
 * 恢复、撤权或 Provider 清理必须取消尚未执行的项,避免晚到的清理覆盖新状态。
 *
 * 只合并「通知」,不合并「清理」:flush 时每台设备的离线清理语义原样执行。
 */
export interface OfflineMirrorWipeQueue {
  enqueue(deviceId: string, claim?: () => boolean): void;
  cancel(deviceId: string): void;
  clear(): void;
  pendingCount(): number;
}

export function createOfflineMirrorWipeQueue(
  flush: (deviceIds: string[]) => void,
  schedule: (callback: () => void) => () => void = (callback) => {
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  },
): OfflineMirrorWipeQueue {
  let pending: Map<string, (() => boolean) | undefined> | null = null;
  let cancelFlush: (() => void) | null = null;
  const clear = () => {
    pending = null;
    cancelFlush?.();
    cancelFlush = null;
  };
  return {
    enqueue(deviceId: string, claim?: () => boolean): void {
      if (!deviceId) return;
      if (pending === null) {
        const wave = new Map([[deviceId, claim]]);
        pending = wave;
        cancelFlush = schedule(() => {
          if (pending !== wave) return;
          pending = null;
          cancelFlush = null;
          // Claim at execution time: reconnect may have extended or cancelled
          // the original presence timer while this batch was waiting.
          const deviceIds = [...wave].filter(([, claim]) => !claim || claim()).map(([id]) => id);
          if (deviceIds.length > 0) flush(deviceIds);
        });
        return;
      }
      pending.set(deviceId, claim);
    },
    cancel(deviceId: string): void {
      pending?.delete(deviceId);
      if (pending?.size === 0) clear();
    },
    clear,
    pendingCount(): number {
      return pending?.size ?? 0;
    },
  };
}
