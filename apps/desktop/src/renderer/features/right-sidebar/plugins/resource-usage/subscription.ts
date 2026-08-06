/**
 * 采样订阅的 renderer 侧引用计数。
 *
 * main 按 webContents 记订阅(同一窗口只有一份),但同一窗口里可能有多个
 * resource-usage Body 同时挂载(不同 session 的 tab 各一个实例,Body 常驻不
 * 卸载)。若每个 Body 直接调 subscribe/unsubscribe,后卸载的会把先到的订阅
 * 一并掐掉 —— 这里聚合成"本窗口是否还有人要数据"的单一事实。
 */

let refCount = 0;

export function acquireProcessMonitorSubscription(): void {
  refCount += 1;
  if (refCount === 1) {
    void window.electronAPI.processMonitor.subscribe().catch(() => undefined);
  }
}

export function releaseProcessMonitorSubscription(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    void window.electronAPI.processMonitor.unsubscribe().catch(() => undefined);
  }
}
