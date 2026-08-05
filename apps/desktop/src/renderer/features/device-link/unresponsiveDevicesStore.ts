/**
 * unresponsiveDevicesStore —— 控制端内存镜像:哪些目标设备被熔断判定为「无响应」。
 * ---------------------------------------------------------------------------
 * 真相源在 main 的 responsivenessTracker(连续 invoke 超时熔断,探测恢复):renderer
 * 只镜像 getState().unresponsiveDeviceIds 初值 + RESPONSIVENESS_CHANGED push 增量,
 * 由 useDeviceLinkRemoteProjects 统一接线(每窗口一份,与 remoteProjectsStore 同生命期)。
 * 消费方:
 *  - useRemoteSessionConnection:presence 在线但设备无响应 → 'degraded'(弱网降级 banner);
 *  - useDeviceLinkRemoteProjects:恢复(unresponsive=false)时重跑 subscribe + bootstrap。
 *
 * getSnapshot 返回稳定引用(仅内容变化时换新),契合 useSyncExternalStore(无 tearing)。
 */

const unresponsive = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function recompute(): void {
  snapshot = new Set(unresponsive);
  for (const l of listeners) l();
}

export const unresponsiveDevicesStore = {
  /** 用 main 的权威快照整体替换(getState 初值 / 重连对齐)。 */
  replaceAll(deviceIds: readonly string[]): void {
    if (deviceIds.length === unresponsive.size && deviceIds.every((id) => unresponsive.has(id))) {
      return;
    }
    unresponsive.clear();
    for (const id of deviceIds) unresponsive.add(id);
    recompute();
  },
  /** 应用一条 RESPONSIVENESS_CHANGED push(幂等)。 */
  apply(deviceId: string, isUnresponsive: boolean): void {
    if (isUnresponsive ? unresponsive.has(deviceId) : !unresponsive.has(deviceId)) return;
    if (isUnresponsive) unresponsive.add(deviceId);
    else unresponsive.delete(deviceId);
    recompute();
  },
  /** 全清(登出 / 卸载;重挂载时由 getState 初值重建)。 */
  clearAll(): void {
    if (unresponsive.size === 0) return;
    unresponsive.clear();
    recompute();
  },
  has(deviceId: string): boolean {
    return unresponsive.has(deviceId);
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): ReadonlySet<string> {
    return snapshot;
  },
};
