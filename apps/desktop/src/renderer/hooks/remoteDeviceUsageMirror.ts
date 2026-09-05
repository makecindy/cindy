/**
 * remoteDeviceUsageMirror — device-link 远程会话账号级用量镜像的共享装配。
 *
 * useRemoteClaudeSubscriptionUsage 模式的通用化(该 hook 先落地已过 review,保持
 * 原样不迁移):被控端的账号级用量广播都是**权威全量 payload**(usageBroadcaster
 * 各 record 路径重建完整状态后广播),所以镜像语义统一为「invoke warm-start +
 * push 整帧替换,null = 被控端清除」。本模块为每个 channel 对生成一个镜像:
 *   - 缓存按 deviceId 存 module-local Map,整体绑定 renderer 当前 data owner 代次
 *     (owner 变化首次触碰即清空;invoke 回填还校验发起时代次,迟到跨号响应整帧丢弃);
 *   - CHANNEL_NOT_ALLOWED 负缓存带 TTL(被控端升级后同 deviceId 重连要能重探测),
 *     收到该设备同 channel push 即视为能力已具备,立即解除;
 *   - invokeChannel 为 null 的镜像是 push-only(如 xai 限流头:被控端无拉取端点,
 *     本机 renderer 同样只有推送缓存 —— 远程与本机同语义降级)。
 *
 * 快照内容一律按被控端数据对待:只做形状守卫(非数组 object),不解释语义。
 */

import { useEffect, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';

/** 老被控端负缓存有效期:到期后重新探测(被控端升级 / 重装后能力可能已具备)。 */
const UNSUPPORTED_RETRY_AFTER_MS = 15 * 60_000;

function isSnapshotShape(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isChannelNotAllowed(err: unknown): boolean {
  return (
    extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
    || (err instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(err.message))
  );
}

export interface RemoteDeviceUsageMirror<T> {
  /** 挂载读镜像值;deviceId 为 null 时恒 null(hook 常挂,Rules of Hooks)。 */
  useMirror(deviceId: string | null): T | null;
  /** 主动催一次隧道读(悬念期用);push-only 镜像是 no-op。 */
  request(deviceId: string): void;
  /** 供单测重置 module 级缓存。 */
  resetForTest(): void;
}

export function createRemoteDeviceUsageMirror<T extends object>(cfg: {
  /** null = push-only 镜像(被控端无拉取端点,与本机同语义)。 */
  invokeChannel: string | null;
  /** invoke 附带参数(如 maker:usage:account 的 agentKind);默认无参。 */
  invokeArgs?: unknown[];
  pushChannel: string;
}): RemoteDeviceUsageMirror<T> {
  const snapshotByDevice = new Map<string, T | null>();
  const unsupportedUntilByDevice = new Map<string, number>();
  const listenersByDevice = new Map<string, Set<(s: T | null) => void>>();
  let cacheOwner = getDataOwnerGeneration();

  function ensureCacheOwnerCurrent(): void {
    if (isDataOwnerGenerationCurrent(cacheOwner)) return;
    cacheOwner = getDataOwnerGeneration();
    snapshotByDevice.clear();
    unsupportedUntilByDevice.clear();
  }

  function applySnapshot(deviceId: string, next: T | null): void {
    snapshotByDevice.set(deviceId, next);
    const listeners = listenersByDevice.get(deviceId);
    if (!listeners) return;
    for (const notify of listeners) notify(next);
  }

  function fetchSnapshot(deviceId: string): void {
    if (!cfg.invokeChannel) return;
    ensureCacheOwnerCurrent();
    const until = unsupportedUntilByDevice.get(deviceId);
    if (until !== undefined && Date.now() < until) return;
    const requestOwner = getDataOwnerGeneration();
    void window.electronAPI.deviceLink
      .invoke(deviceId, cfg.invokeChannel, cfg.invokeArgs ?? [])
      .then((persisted) => {
        // owner A 发起、切到 B 后 resolve 的迟到响应整帧丢弃(缓存跨重挂载存活)。
        if (!isDataOwnerGenerationCurrent(requestOwner)) return;
        ensureCacheOwnerCurrent();
        if (persisted === null || isSnapshotShape(persisted)) {
          applySnapshot(deviceId, persisted as T | null);
        }
        // 异常形状:保留现值,等 push 纠正。
      })
      .catch((err: unknown) => {
        if (!isDataOwnerGenerationCurrent(requestOwner)) return;
        if (isChannelNotAllowed(err)) {
          ensureCacheOwnerCurrent();
          unsupportedUntilByDevice.set(deviceId, Date.now() + UNSUPPORTED_RETRY_AFTER_MS);
        }
        // 其余错误(断链 / 超时):保留现值,等重连 push / 下次 mount 重试。
      });
  }

  function useMirror(deviceId: string | null): T | null {
    const [snapshot, setSnapshot] = useState<T | null>(() => {
      if (!deviceId) return null;
      ensureCacheOwnerCurrent();
      return snapshotByDevice.get(deviceId) ?? null;
    });

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
      fetchSnapshot(deviceId);
      return () => {
        listeners.delete(setSnapshot);
        if (listeners.size === 0) listenersByDevice.delete(deviceId);
      };
    }, [deviceId]);

    useEffect(() => {
      if (!deviceId) return;
      const off = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
        if (push.channel !== cfg.pushChannel) return;
        if (push.deviceId !== deviceId) return;
        if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
        ensureCacheOwnerCurrent();
        // 能收到该设备的 push = 能力已具备(老被控端升级后重连),解除负缓存。
        unsupportedUntilByDevice.delete(deviceId);
        // 广播恒为权威全量:null 清空,快照整帧替换,异常形状保留现值。
        if (push.payload === null) applySnapshot(deviceId, null);
        else if (isSnapshotShape(push.payload)) applySnapshot(deviceId, push.payload as T);
      });
      return off;
    }, [deviceId]);

    return snapshot;
  }

  return {
    useMirror,
    request(deviceId: string): void {
      fetchSnapshot(deviceId);
    },
    resetForTest(): void {
      snapshotByDevice.clear();
      unsupportedUntilByDevice.clear();
      listenersByDevice.clear();
      cacheOwner = getDataOwnerGeneration();
    },
  };
}
