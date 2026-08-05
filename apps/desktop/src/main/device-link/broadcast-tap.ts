/**
 * broadcast-tap —— 被控端把本机 renderer 广播「旁路」一份给 device-link 控制端。
 *
 * 设计:在各 broadcastToAllWindows 调用点各加一行 tapWindowBroadcast(channel, payload),
 * 本模块内按 PUSH_FORWARD_ALLOWLIST 过滤后,仅在「存在 active 控制链路」时打包成
 * push 帧转发给控制端。无监听者时是 O(1) no-op,不进 maker-core 热路径成本(规则 10)。
 *
 * 监听者由 dispatch.ts(被控端隧道层)在有 active link 时注册;无 link 时 listener 为 null。
 */

import { PUSH_FORWARD_ALLOWLIST } from '@cindy/device-link';

/** 转发回调:(channel, payload) → 投递给所有 active 控制端 */
export type BroadcastTapListener = (channel: string, payload: unknown) => void;

let listener: BroadcastTapListener | null = null;

/**
 * 旁路一份 renderer 广播给 device-link。无 listener(无控制链路)时立即返回,
 * 不做任何字符串比较以外的工作——保证对本地广播热路径零额外开销。
 */
export function tapWindowBroadcast(channel: string, payload: unknown): void {
  if (listener === null) return;
  if (!PUSH_FORWARD_ALLOWLIST.has(channel)) return;
  listener(channel, payload);
}

/** dispatch.ts 在首个控制链路建立时注册;最后一个链路关闭时传 null 注销。 */
export function setBroadcastTapListener(next: BroadcastTapListener | null): void {
  listener = next;
}

export function hasBroadcastTapListener(): boolean {
  return listener !== null;
}
