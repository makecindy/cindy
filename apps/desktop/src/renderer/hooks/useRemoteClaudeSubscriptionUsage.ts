/**
 * useRemoteClaudeSubscriptionUsage — device-link 远程会话的被控端 Claude 订阅余量镜像。
 *
 * 与 useClaudeSubscriptionUsage(本机)的关系:数据语义与快照形状完全相同,但事实
 * 来源在**被控端**(turn 在被控端跑、消耗被控端订阅额度),所以:
 *   - warm-start 走 deviceLink.invoke(deviceId, 'maker:usage:claude-subscription')
 *     隧道读被控端 cached-first 快照(被控端 read() 自带节流的后台端点刷新);
 *   - 实时更新走 onRemotePush 的 'usage:claude-subscription-changed' 转发帧
 *     (被控端 broadcast tap → sessions topic,账号级、签名去抖);
 *   - 老被控端无此 channel → CHANNEL_NOT_ALLOWED → 返回 null,chip 保持原
 *     「仅会话金额」降级显示,不报错。
 *
 * 缓存按 deviceId 存 module-local Map(同设备的会话间切换不闪回占位态),并整体
 * 绑定 renderer 当前 data owner 代次:owner 变化(登出 / 换号)时任何路径首次触碰
 * 缓存都会先清空重建,invoke 回填还额外校验「发起时代次 == 应用时代次」——
 * 跨 owner 的迟到响应整帧丢弃,防止上一个账号读到的余量顶给新账号(push 路径
 * 的同款防护由 isDeviceLinkRemotePushCurrent 承担)。
 *
 * CHANNEL_NOT_ALLOWED 负缓存带 TTL:被控端可能升级后以同一 deviceId 重连,
 * 永久跳过会让 chip 停留在降级占位直到 renderer 重启;到期后的 mount / 催刷会
 * 重新探测,收到该设备的订阅 push(证明能力已具备)也会立即清除标记。
 */

import { useEffect, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';

import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';

const REMOTE_CLAUDE_SUBSCRIPTION_CHANNEL = 'maker:usage:claude-subscription';
const REMOTE_CLAUDE_SUBSCRIPTION_CHANGED = 'usage:claude-subscription-changed';
/** 老被控端负缓存有效期:到期后重新探测(被控端升级 / 重装后能力可能已具备)。 */
const UNSUPPORTED_RETRY_AFTER_MS = 15 * 60_000;

const snapshotByDevice = new Map<string, ClaudeSubscriptionUsageSnapshot | null>();
/** CHANNEL_NOT_ALLOWED 的老被控端:deviceId → 探测截止时间戳(TTL 负缓存)。 */
const unsupportedUntilByDevice = new Map<string, number>();
/** 挂载中的 hook 实例:invoke 回填 / push 到达时按 deviceId 通知重渲染。 */
const listenersByDevice = new Map<string, Set<(s: ClaudeSubscriptionUsageSnapshot | null) => void>>();
/** 缓存归属的 owner 代次:owner 变化时整体作废(不跨账号沿用任何镜像 / 负缓存)。 */
let cacheOwner = getDataOwnerGeneration();

function isSnapshot(v: unknown): v is ClaudeSubscriptionUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 任何路径触碰缓存前先调:owner 代次变了 → 清空快照与负缓存(保留挂载监听者)。 */
function ensureCacheOwnerCurrent(): void {
  if (isDataOwnerGenerationCurrent(cacheOwner)) return;
  cacheOwner = getDataOwnerGeneration();
  snapshotByDevice.clear();
  unsupportedUntilByDevice.clear();
}

function applySnapshot(deviceId: string, next: ClaudeSubscriptionUsageSnapshot | null): void {
  snapshotByDevice.set(deviceId, next);
  const listeners = listenersByDevice.get(deviceId);
  if (!listeners) return;
  for (const notify of listeners) notify(next);
}

/** 供单测重置 module 级缓存。 */
export function resetRemoteClaudeSubscriptionUsageCacheForTest(): void {
  snapshotByDevice.clear();
  unsupportedUntilByDevice.clear();
  listenersByDevice.clear();
  cacheOwner = getDataOwnerGeneration();
}

/** push payload → 下一个缓存值:null 清空,快照覆盖,异常形状保留现值。 */
export function reduceRemoteClaudeSubscriptionPush(
  current: ClaudeSubscriptionUsageSnapshot | null,
  payload: unknown,
): ClaudeSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  if (isSnapshot(payload)) return payload;
  return current;
}

/**
 * 隧道读被控端 cached-first 快照并回填缓存。应用前校验发起时的 owner 代次仍是
 * 当前代次 —— owner A 发起、切到 owner B 后才 resolve 的迟到响应整帧丢弃
 * (module 缓存跨路由重挂载存活,不校验会把 A 的余量顶给 B 看)。
 */
function fetchRemoteSnapshot(deviceId: string): void {
  ensureCacheOwnerCurrent();
  const until = unsupportedUntilByDevice.get(deviceId);
  if (until !== undefined && Date.now() < until) return;
  const requestOwner = getDataOwnerGeneration();
  void window.electronAPI.deviceLink
    .invoke(deviceId, REMOTE_CLAUDE_SUBSCRIPTION_CHANNEL, [])
    .then((persisted) => {
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      ensureCacheOwnerCurrent();
      if (persisted === null || isSnapshot(persisted)) {
        applySnapshot(deviceId, persisted);
      }
      // 异常形状:保留现值,等 push 纠正。
    })
    .catch((err: unknown) => {
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      // 老被控端:CHANNEL_NOT_ALLOWED 属预期降级,TTL 内不再探测(到期重试,
      // 覆盖被控端升级后同 deviceId 重连的场景);其余错误(断链 / 超时)保留
      // 现值,等重连后的 push / 下次 mount 重试。
      const unsupported =
        extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
        || (err instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(err.message));
      if (unsupported) {
        ensureCacheOwnerCurrent();
        unsupportedUntilByDevice.set(deviceId, Date.now() + UNSUPPORTED_RETRY_AFTER_MS);
      }
    });
}

export function useRemoteClaudeSubscriptionUsage(
  deviceId: string | null,
): ClaudeSubscriptionUsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<ClaudeSubscriptionUsageSnapshot | null>(() => {
    if (!deviceId) return null;
    ensureCacheOwnerCurrent();
    return snapshotByDevice.get(deviceId) ?? null;
  });

  // 注册通知 + warm-start。deviceId 变化时先同步切到新设备的缓存值。
  useEffect(() => {
    if (!deviceId) {
      setSnapshot(null);
      return;
    }
    ensureCacheOwnerCurrent();
    setSnapshot(snapshotByDevice.get(deviceId) ?? null);
    let listeners = listenersByDevice.get(deviceId);
    if (!listeners) {
      listeners = new Set();
      listenersByDevice.set(deviceId, listeners);
    }
    listeners.add(setSnapshot);
    fetchRemoteSnapshot(deviceId);
    return () => {
      listeners.delete(setSnapshot);
      if (listeners.size === 0) listenersByDevice.delete(deviceId);
    };
  }, [deviceId]);

  // 实时镜像:被控端 broadcast tap 转发的账号级 push(sessions topic,常开订阅)。
  useEffect(() => {
    if (!deviceId) return;
    const off = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (push.channel !== REMOTE_CLAUDE_SUBSCRIPTION_CHANGED) return;
      if (push.deviceId !== deviceId) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      ensureCacheOwnerCurrent();
      // 能收到该设备的订阅 push = 被控端已具备能力(典型:老被控端升级后重连),
      // 立即解除负缓存,下次 mount / 催刷恢复隧道读。
      unsupportedUntilByDevice.delete(deviceId);
      applySnapshot(
        deviceId,
        reduceRemoteClaudeSubscriptionPush(snapshotByDevice.get(deviceId) ?? null, push.payload),
      );
    });
    return off;
  }, [deviceId]);

  return snapshot;
}

/**
 * 主动催一次被控端余量刷新(chip 悬念期用:倒计时归零等新快照)。被控端 read()
 * 自带 180s 节流 + 退避,重复调用安全;结果经缓存通知 + push 通道双路回流。
 */
export function requestRemoteClaudeSubscriptionRefresh(deviceId: string): void {
  fetchRemoteSnapshot(deviceId);
}
