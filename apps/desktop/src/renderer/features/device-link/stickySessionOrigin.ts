/**
 * stickySessionOrigin —— 「最后已知会话归属」模块级缓存。
 *
 * remoteProjectsStore 的 sessionId→deviceId 注册表在 relay 瞬时重连时会被 clear()
 * (镜像随链路重建),而消费方(goal/learn 传输层、useGoalStatus/useLearnRun、
 * CCAgentSessionView 粘滞逻辑)需要在这个窗口内继续把远程会话当远程处理 ——
 * 把远程会话的操作降级回本机(如 learn:apply 落到控制端)比隧道失败严重得多。
 *
 * 语义:查询时先读 store 现值;有值则记入缓存并返回;无值时返回最后已知值。
 * 同一账号重连保留结果。记录归属是否由业务记录或镜像确认，便于导航校验
 * 纠正旧线索时保留已确认的远端归属。
 *
 * 各传输层 / hooks 统一走这里,粘滞状态跨适配器重建、effect 重跑存活
 * (Codex review #548:per-resolver 粘滞在 effect 重建时会丢)。
 */

import { getSessionDeviceId } from './remoteProjectsStore';
import { getDataOwnerGeneration, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

let ownerId = getDataOwnerGeneration().dataOwnerId;
const lastKnown = new Map<string, { deviceId: string; verifiedDeviceId?: string }>();

function ensureCurrentOwner(): void {
  const currentOwnerId = getDataOwnerGeneration().dataOwnerId;
  if (currentOwnerId === ownerId) return;
  ownerId = currentOwnerId;
  lastKnown.clear();
}
subscribeDataOwnerGeneration(ensureCurrentOwner);

/** 解析会话归属设备:store 现值优先,清空窗口内回退最后已知值。 */
export function getStickySessionDeviceId(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined;
  ensureCurrentOwner();
  const previous = lastKnown.get(sessionId);
  const fresh = getSessionDeviceId(sessionId);
  if (fresh !== undefined) {
    const verifiedDeviceId = getSessionDeviceId(sessionId, true) ?? previous?.verifiedDeviceId;
    if (fresh !== previous?.deviceId || verifiedDeviceId !== previous.verifiedDeviceId) {
      lastKnown.set(sessionId, { deviceId: fresh, verifiedDeviceId });
    }
    return fresh;
  }
  return previous?.deviceId;
}

export function getLastVerifiedSessionDeviceId(sessionId: string): string | undefined {
  ensureCurrentOwner();
  return lastKnown.get(sessionId)?.verifiedDeviceId;
}

export function forgetUnverifiedStickySessionOrigin(sessionId: string): void {
  ensureCurrentOwner();
  if (!lastKnown.get(sessionId)?.verifiedDeviceId) lastKnown.delete(sessionId);
}

/** 测试专用:清空粘滞缓存。 */
export function __resetStickySessionOriginForTest(): void {
  lastKnown.clear();
}
