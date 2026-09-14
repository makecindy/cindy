/**
 * unresponsiveDevicesStore.ts — 「目标设备无响应」熔断的 per-device 状态镜像 + 接线。
 * ---------------------------------------------------------------------------
 * 结构照 revokedDevicesStore 模板:module 级 Set + subscribe/getSnapshot +
 * useSyncExternalStore hook,供 UI(首页设备行 failed 态、ConnectionBanner)订阅。
 * 状态机本体在 @cindy/maker-shared/device-responsiveness(纯逻辑,可单测,
 * desktop / mobile 控制端共享);本文件持有 module 级单例并暴露 DeviceLinkContext
 * 发送路径用的门禁 / 收尾 helper。
 */
import { useSyncExternalStore } from 'react';
import { DeviceLinkError, type DeviceLinkErrorCode } from '@cindy/device-link';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import {
  createDeviceResponsivenessBreaker,
  type BreakerSendSlot,
  type BreakerSettleOutcome,
} from '@cindy/maker-shared/device-responsiveness';

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
 * 是最便宜的真实 DB 读,恰好就是事故里被卡死的那类请求;探测刻意不加载全部置顶
 * 会话,只验证远端 DB / IPC 是否恢复;args 形状与 devices 页的正常拉取一致
 * ([limit, statusFilter, opts])。
 */
export const DEVICE_RESPONSIVENESS_PROBE_CHANNEL = 'local-db:sessions:list';

export function buildDeviceResponsivenessProbeArgs(): unknown[] {
  return [1, 'all', { includePinned: false }];
}

/**
 * 发送门禁(DeviceLinkContext 四条 send* 路径的第一步):熔断 open 且无探测
 * 窗口时抛 DEVICE_UNRESPONSIVE 快速失败(不等重连、不上管道);返回的席位票据
 * (含探测标记与设备代数)必须原样回传给 settleDeviceSend——代数不匹配的
 * 旧请求结果会被忽略(review P1:恢复前派出的长超时请求不再污染新一代计数)。
 */
export function createDeviceSendCohort(deviceId: string): number {
  return breaker.createCohort(deviceId);
}

export function acquireDeviceSendSlot(
  deviceId: string,
  cohort?: number,
  options?: { allowProbe?: boolean },
): BreakerSendSlot {
  const slot = breaker.acquire(deviceId, cohort, options);
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
 * 清除单个设备的熔断状态与 UI 镜像。撤权或权威 presence 不可用时调用:
 * 设备的「响应性」已无意义,且对应状态有自己的专属 UI,不应再叠加
 * 「电脑端未响应」降级态。clear 会翻代,此前在途请求的晚到超时不再重建计数。
 */
export function clearDeviceResponsivenessTrackingFor(deviceId: string): void {
  breaker.clear(deviceId);
}

/**
 * 发送失败 → 熔断信号分类:仅 INVOKE_TIMEOUT(等满超时无回包)计失败;其余
 * (NOT_CONNECTED / relay 层错误 / 断连批量 reject)是本机链路问题,不定论。
 * 注意:invoke-result 携带的业务错误(ok:false)不会走到这里——收到 result
 * 帧本身就是真实回包,发送路径在 unwrap 前已按成功分类上报。
 */
export function classifyDeviceSendFailure(error: unknown): BreakerSettleOutcome {
  return error instanceof DeviceLinkError && error.code === 'INVOKE_TIMEOUT'
    ? 'timeout'
    : 'inconclusive';
}

/**
 * 被控端 dispatch 在 runInvoke 里、进入 dispatchLocalInvoke(IPC/DB 路径)之前
 * 特判应答的 invoke 通道(dispatch.ts:media:fetch / voice:* 三条,credential-sync
 * 已下线但保留匹配):它们的成功只证明桌面进程与 device-link 服务活着,不证明
 * 打开熔断的 IPC/DB 子系统已恢复。half-open 时这类请求可能抢到探测席位,若按
 * responded 收尾会误关熔断、放进新一轮 DB 请求突发(review P1 第七轮)——与
 * 控制帧(subscribe/unsubscribe/link-accept)同语义,成功一律按不定论收尾。
 * 走 dispatchLocalInvoke 的其余通道(含代表性探测与全部业务 DB 读写)的回包
 * 仍是有效恢复证据。超时分类不受影响(classifyDeviceSendFailure)。
 */
export const BREAKER_NEUTRAL_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  'device-link:media:fetch',
  'device-link:voice:credential-sync',
  'device-link:voice:dictionary-learning',
  'device-link:voice:transcribe',
]);

/**
 * 发送成功 → 熔断信号分类:dispatch 特判通道不定论,其余为真实恢复证据。
 * wasProbe(review P1 收敛):持有 half-open 探测席位时,只有指定探测通道
 * (穿过 local-db 读路径)的回包才允许关熔断——普通 IPC handler 里还有大量
 * 纯内存实现(如 maker:list-agent-commands 的同步列表),DB 子系统卡死时它们
 * 照常应答,凑巧抢到探测席位的成功不能作恢复证据。闭合态(非探测)的回包
 * 仍按通道分类:重置连续计数只是计数语义,不触发恢复突发。
 */
export function classifyDeviceSendSuccess(channel: string, wasProbe = false): BreakerSettleOutcome {
  if (wasProbe && channel !== DEVICE_RESPONSIVENESS_PROBE_CHANNEL) return 'inconclusive';
  return BREAKER_NEUTRAL_INVOKE_CHANNELS.has(channel) ? 'inconclusive' : 'responded';
}

/**
 * openLink 专用的终态 relay 应答码(review P1):relay 明确回答了目标设备的
 * 状态(开关关闭 / 不在线 / 版本不符)——「响应性」判定就此失去意义,继续
 * 保持 unresponsive 会让设备被永远探测,横幅还压着更可操作的真实状态
 * (如「已关闭允许远程控制」)。按真实应答关熔断,把 UI 让给对应的错误态;
 * 开关重开 / 设备上线后的首次请求若再超时,熔断照常重新累计。
 * NOT_CONNECTED / LINK_NOT_OPEN 等传输层失败仍不定论,超时仍计失败。
 */
const TERMINAL_LINK_OPEN_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEVICE_OFFLINE',
  'REMOTE_DISABLED',
  'VERSION_MISMATCH',
]);

export function classifyLinkOpenFailure(error: unknown): BreakerSettleOutcome {
  if (error instanceof DeviceLinkError && TERMINAL_LINK_OPEN_ERROR_CODES.has(error.code)) {
    return 'responded';
  }
  return classifyDeviceSendFailure(error);
}

/** 登出 / 进程内切号:清空熔断状态与 UI 镜像,避免串到下一个账号。 */
export function resetDeviceResponsivenessTracking(): void {
  breaker.resetAll();
  unresponsiveDevicesStore.clearAll();
}
