/**
 * unresponsiveDevicesStore.ts — 「目标设备无响应」熔断的 per-device 状态镜像 + 接线。
 * ---------------------------------------------------------------------------
 * 结构照 revokedDevicesStore 模板:module 级 Set + subscribe/getSnapshot +
 * useSyncExternalStore hook,供 UI(首页设备行 failed 态、ConnectionBanner)订阅。
 * 状态机本体在 deviceResponsivenessBreaker.ts(纯逻辑,可单测);本文件持有
 * module 级单例并暴露 DeviceLinkContext 发送路径用的门禁 / 收尾 helper。
 */
import { useSyncExternalStore } from 'react';
import { DeviceLinkError, type DeviceLinkErrorCode } from '@cindy/device-link';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import {
  createDeviceResponsivenessBreaker,
  type BreakerSendSlot,
  type BreakerSettleOutcome,
} from '@/device-link/deviceResponsivenessBreaker';

const unresponsive = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = new Set(unresponsive);
  for (const listener of listeners) listener();
}

/**
 * 熔断 open 的目标设备集合(控制端本地判定)。真实回包(探测成功或任意业务
 * 请求得到应答)即移除;被控端始终权威,这里只是「暂时别再压请求上去」的镜像。
 */
export const unresponsiveDevicesStore = {
  markUnresponsive(deviceId: string): void {
    if (!deviceId || unresponsive.has(deviceId)) return;
    unresponsive.add(deviceId);
    emit();
  },

  clearUnresponsive(deviceId: string): void {
    if (!unresponsive.delete(deviceId)) return;
    emit();
  },

  clearAll(): void {
    if (unresponsive.size === 0) return;
    unresponsive.clear();
    emit();
  },

  has(deviceId: string): boolean {
    return unresponsive.has(deviceId);
  },

  getSnapshot(): ReadonlySet<string> {
    return snapshot;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useUnresponsiveDevices(): ReadonlySet<string> {
  return useSyncExternalStore(unresponsiveDevicesStore.subscribe, unresponsiveDevicesStore.getSnapshot);
}

/**
 * DEVICE_UNRESPONSIVE 尚未收编进 @cindy/device-link 的 DeviceLinkErrorCode 联合
 * (本改动零接触共享协议包,收编留 follow-up)。所有下游分类都按字符串匹配
 * (maker-shared 的 PERMANENT 标记 / describeRemoteError / isDeviceUnresponsiveRemoteError),
 * 不依赖联合类型,这里以 DeviceLinkError 形态抛出保持 code 字段惯例一致。
 */
const DEVICE_UNRESPONSIVE_ERROR_CODE: string = 'DEVICE_UNRESPONSIVE';

export function createDeviceUnresponsiveError(deviceId: string): DeviceLinkError {
  return new DeviceLinkError(
    DEVICE_UNRESPONSIVE_ERROR_CODE as DeviceLinkErrorCode,
    `target device ${deviceId} is unresponsive (circuit open)`,
  );
}

const breaker = createDeviceResponsivenessBreaker({
  onOpenChanged: (deviceId, open) => {
    if (open) unresponsiveDevicesStore.markUnresponsive(deviceId);
    else unresponsiveDevicesStore.clearUnresponsive(deviceId);
  },
});

/**
 * 只读:该设备当前是否「探测已到窗口」——rehydrate 等自动恢复路径据此决定
 * 是否对熔断 open 的设备发起显式代表性探测。
 */
export function isDeviceProbeDue(deviceId: string): boolean {
  return breaker.probeDue(deviceId);
}

/**
 * 代表性探测请求(review P1 多轮收敛):half-open 探测必须穿过被控端
 * runInvoke → dispatchLocalInvoke → local-db 读路径才算数——link-accept 与
 * subscribe/unsubscribe 都在 dispatch 里于 runInvoke **之前**特判应答,
 * IPC/DB 子系统卡死时它们照常回包,不能作为恢复证据。sessions:list limit=1
 * 是最便宜的真实 DB 读,恰好就是事故里被卡死的那类请求;args 形状与
 * devices 页的正常拉取一致([limit, statusFilter, opts])。
 */
export const DEVICE_RESPONSIVENESS_PROBE_CHANNEL = 'local-db:sessions:list';

export function buildDeviceResponsivenessProbeArgs(): unknown[] {
  return [1, 'all', { includePinned: true }];
}

/**
 * 发送门禁(DeviceLinkContext 四条 send* 路径的第一步):熔断 open 且无探测
 * 窗口时抛 DEVICE_UNRESPONSIVE 快速失败(不等重连、不上管道);返回的席位票据
 * (含探测标记与设备代数)必须原样回传给 settleDeviceSend——代数不匹配的
 * 旧请求结果会被忽略(review P1:恢复前派出的长超时请求不再污染新一代计数)。
 */
export function acquireDeviceSendSlot(deviceId: string): BreakerSendSlot {
  const slot = breaker.acquire(deviceId);
  if (slot.decision === 'reject') throw createDeviceUnresponsiveError(deviceId);
  return slot;
}

export function settleDeviceSend(
  deviceId: string,
  slot: BreakerSendSlot,
  outcome: BreakerSettleOutcome,
): void {
  // 撤权竞态防护(review P1):撤权时桌面端发 link-close(revoked) 但不 resolve
  // 在途请求,它们随后超时——这不是"设备无响应",是访问被收回。已撤权设备的
  // 超时一律降级为不定论,不再计入熔断,避免 unresponsive 状态与撤权状态并存。
  const effective = outcome === 'timeout' && revokedDevicesStore.has(deviceId)
    ? 'inconclusive'
    : outcome;
  breaker.settle(deviceId, slot, effective);
}

/**
 * 清除单个设备的熔断状态与 UI 镜像。撤权时调用:设备的「响应性」已无意义,
 * 且撤权有自己的专属 UI,不应再叠加「电脑端未响应」降级态。
 */
export function clearDeviceResponsivenessTrackingFor(deviceId: string): void {
  breaker.clear(deviceId);
}

/**
 * 发送失败 → 熔断信号分类:仅 INVOKE_TIMEOUT(等满超时无回包)计失败;其余
 * (NOT_CONNECTED / relay 层错误 / 断连批量 reject)是本机链路问题,不定论。
 * 注意:invoke-result 携带的业务错误(ok:false)不会走到这里——收到 result
 * 帧本身就是真实回包,发送路径在 unwrap 前已按 responded 上报。
 */
export function classifyDeviceSendFailure(error: unknown): BreakerSettleOutcome {
  return error instanceof DeviceLinkError && error.code === 'INVOKE_TIMEOUT'
    ? 'timeout'
    : 'inconclusive';
}

/** 登出 / 进程内切号:清空熔断状态与 UI 镜像,避免串到下一个账号。 */
export function resetDeviceResponsivenessTracking(): void {
  breaker.resetAll();
  unresponsiveDevicesStore.clearAll();
}
