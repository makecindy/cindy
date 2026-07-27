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
import {
  createDeviceResponsivenessBreaker,
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
 * 发送门禁(DeviceLinkContext 四条 send* 路径的第一步):熔断 open 且无探测
 * 窗口时抛 DEVICE_UNRESPONSIVE 快速失败(不等重连、不上管道);返回值 = 本次
 * 请求是否为探测(单飞),必须原样回传给 settleDeviceSend。
 */
export function acquireDeviceSendSlot(deviceId: string): boolean {
  const decision = breaker.acquire(deviceId);
  if (decision === 'reject') throw createDeviceUnresponsiveError(deviceId);
  return decision === 'probe';
}

export function settleDeviceSend(
  deviceId: string,
  wasProbe: boolean,
  outcome: BreakerSettleOutcome,
): void {
  breaker.settle(deviceId, wasProbe, outcome);
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
