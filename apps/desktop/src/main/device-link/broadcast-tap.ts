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
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

/** Snapshot carried by async main-side work across an owner boundary. */
export interface DataOwnerBroadcastScope {
  readonly ownerScopeKey?: string;
  readonly ownerStamp?: DataOwnerPushStamp;
}

/** 转发回调:(channel, payload, ownerStamp) → 投递给所有 active 控制端 */
export type BroadcastTapListener = (
  channel: string,
  payload: unknown,
  ownerStamp?: DataOwnerPushStamp,
) => void;

let listener: BroadcastTapListener | null = null;

/** Read the main owner stamp without making small Electron-free tests boot app storage. */
export function getSafeDataOwnerPushStamp(): DataOwnerPushStamp | undefined {
  try {
    const stamp = getActiveDataOwnerPushStamp();
    // Keep the pre-auth/test bootstrap path wire-compatible. Once the main
    // process has crossed its first owner boundary, even signed-out frames
    // carry the generation so a late old-owner frame cannot be relabeled.
    if (stamp.dataOwnerId === null && stamp.ownerGeneration === 0) return undefined;
    return stamp;
  } catch {
    return undefined;
  }
}

/** Capture both the renderer/device-link stamp and the stronger main owner key. */
export function captureDataOwnerBroadcastScope(): DataOwnerBroadcastScope {
  let ownerScopeKey: string | undefined;
  try {
    ownerScopeKey = activeOwnerScopeKey();
  } catch {
    // Electron-free unit tests and pre-bootstrap callers have no app storage yet.
  }
  return {
    ...(ownerScopeKey !== undefined ? { ownerScopeKey } : {}),
    ownerStamp: getSafeDataOwnerPushStamp(),
  };
}

/** Fail closed when async work settles after an owner switch or teardown began. */
export function isDataOwnerBroadcastScopeCurrent(scope: DataOwnerBroadcastScope): boolean {
  if (scope.ownerScopeKey !== undefined) {
    try {
      return !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scope.ownerScopeKey;
    } catch {
      return false;
    }
  }
  // Legacy/bootstrap callers have no scope key. Preserve their old behavior while
  // still rejecting a late stamped frame if the owner boundary became observable.
  const current = getSafeDataOwnerPushStamp();
  return (
    current?.dataOwnerId === scope.ownerStamp?.dataOwnerId &&
    current?.ownerGeneration === scope.ownerStamp?.ownerGeneration
  );
}

/**
 * 旁路一份 renderer 广播给 device-link。无 listener(无控制链路)时立即返回,
 * 不做任何字符串比较以外的工作——保证对本地广播热路径零额外开销。
 */
export function tapWindowBroadcast(
  channel: string,
  payload: unknown,
  ownerStamp?: DataOwnerPushStamp,
): void {
  if (listener === null) return;
  if (!PUSH_FORWARD_ALLOWLIST.has(channel)) return;
  // `undefined` is a valid captured value during bootstrap/tests.  Preserve
  // the distinction between an omitted third argument (legacy call sites,
  // read the current stamp) and an explicitly captured `undefined` (do not
  // relabel an async event with a newer owner).  Callers carrying an owner
  // scope should always pass the third argument, even when it is undefined.
  const hasCapturedStamp = arguments.length >= 3;
  let stamp = ownerStamp;
  if (!hasCapturedStamp) {
    // Keep the pure device-link dispatch tests (which intentionally mock only a
    // small Electron surface) independent from app-session storage. Production
    // always has a loaded app session here; the fallback is only a compatibility
    // stamp for legacy/test callers and is rejected by a stamped peer boundary.
    stamp = getSafeDataOwnerPushStamp();
  }
  if (stamp === undefined) listener(channel, payload);
  else listener(channel, payload, stamp);
}

/** dispatch.ts 在首个控制链路建立时注册;最后一个链路关闭时传 null 注销。 */
export function setBroadcastTapListener(next: BroadcastTapListener | null): void {
  listener = next;
}

export function hasBroadcastTapListener(): boolean {
  return listener !== null;
}
