/**
 * useRemoteClaudeSessionRoute — device-link 远程 cc 默认路由会话的生效计费路由镜像。
 *
 * 与 useClaudeSessionRoute(本机)同语义:'gateway' | 'subscription' | null(会话尚未
 * 发过请求)。路由真值在**被控端** proxy 的按请求观察 registry 里 —— 控制端拿本机
 * 凭证 / 网关 key 状态替被控端做启发式必然张冠李戴,所以:
 *   - warm-start 隧道读 'maker:claude-session-route:get'(sessionId);
 *   - 变化走 'maker:claude-session-route-changed' push(payload 顶层 sessionId →
 *     session:<id> topic,打开该会话即已订阅;每会话生命周期通常仅一次);
 *   - 观察值为 null(会话没跑过请求)或老被控端 CHANNEL_NOT_ALLOWED → 返回 null,
 *     chip 对该会话维持「仅会话金额」占位(与旧行为一致,不做本机猜测)。
 *
 * 缓存按 deviceId+sessionId 存,整体绑定 owner 代次;负缓存(老被控端)按 deviceId
 * 记且带 TTL,语义与其它远程用量镜像一致。
 */

import { useEffect, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';

export type RemoteClaudeSessionRoute = 'gateway' | 'subscription';

const ROUTE_GET_CHANNEL = 'maker:claude-session-route:get';
const ROUTE_CHANGED_CHANNEL = 'maker:claude-session-route-changed';
const UNSUPPORTED_RETRY_AFTER_MS = 15 * 60_000;

const routeByKey = new Map<string, RemoteClaudeSessionRoute | null>();
// 与 remoteDeviceUsageMirror 的 entry.revision 同口径:每次 applyRoute 递增;warm-start
// GET 发起时捕获,返回时 revision 已变(期间来过 push)则丢弃迟到结果,不覆盖更新的值。
const revisionByKey = new Map<string, number>();
const unsupportedUntilByDevice = new Map<string, number>();
const listenersByKey = new Map<string, Set<(r: RemoteClaudeSessionRoute | null) => void>>();
let cacheOwner = getDataOwnerGeneration();

function cacheKey(deviceId: string, sessionId: string): string {
  return `${deviceId}\u0000${sessionId}`;
}

function isRoute(v: unknown): v is RemoteClaudeSessionRoute {
  return v === 'gateway' || v === 'subscription';
}

function ensureCacheOwnerCurrent(): void {
  if (isDataOwnerGenerationCurrent(cacheOwner)) return;
  cacheOwner = getDataOwnerGeneration();
  routeByKey.clear();
  revisionByKey.clear();
  unsupportedUntilByDevice.clear();
}

function applyRoute(key: string, next: RemoteClaudeSessionRoute | null): void {
  revisionByKey.set(key, (revisionByKey.get(key) ?? 0) + 1);
  routeByKey.set(key, next);
  const listeners = listenersByKey.get(key);
  if (!listeners) return;
  for (const notify of listeners) notify(next);
}

/** 供单测重置 module 级缓存。 */
export function resetRemoteClaudeSessionRouteCacheForTest(): void {
  routeByKey.clear();
  revisionByKey.clear();
  unsupportedUntilByDevice.clear();
  listenersByKey.clear();
  cacheOwner = getDataOwnerGeneration();
}

function fetchRoute(deviceId: string, sessionId: string): void {
  ensureCacheOwnerCurrent();
  const until = unsupportedUntilByDevice.get(deviceId);
  if (until !== undefined && Date.now() < until) return;
  const requestOwner = getDataOwnerGeneration();
  const key = cacheKey(deviceId, sessionId);
  const requestRevision = revisionByKey.get(key) ?? 0;
  void window.electronAPI.deviceLink
    .invoke(deviceId, ROUTE_GET_CHANNEL, [sessionId])
    .then((persisted) => {
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      ensureCacheOwnerCurrent();
      // A push (or a newer read) landed while this GET was in flight: it is newer than
      // whatever the GET observed, so the late result must not overwrite it.
      if ((revisionByKey.get(key) ?? 0) !== requestRevision) return;
      applyRoute(key, isRoute(persisted) ? persisted : null);
    })
    .catch((err: unknown) => {
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      const unsupported =
        extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
        || (err instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(err.message));
      if (unsupported) {
        ensureCacheOwnerCurrent();
        unsupportedUntilByDevice.set(deviceId, Date.now() + UNSUPPORTED_RETRY_AFTER_MS);
      }
    });
}

export function useRemoteClaudeSessionRoute(
  deviceId: string | null,
  sessionId: string | undefined,
): RemoteClaudeSessionRoute | null {
  const key = deviceId && sessionId ? cacheKey(deviceId, sessionId) : null;
  const [route, setRoute] = useState<RemoteClaudeSessionRoute | null>(() => {
    if (!key) return null;
    ensureCacheOwnerCurrent();
    return routeByKey.get(key) ?? null;
  });

  useEffect(() => {
    if (!key || !deviceId || !sessionId) {
      setRoute(null);
      return;
    }
    ensureCacheOwnerCurrent();
    setRoute(routeByKey.get(key) ?? null);
    let listeners = listenersByKey.get(key);
    if (!listeners) {
      listeners = new Set();
      listenersByKey.set(key, listeners);
    }
    listeners.add(setRoute);
    fetchRoute(deviceId, sessionId);
    return () => {
      listeners.delete(setRoute);
      if (listeners.size === 0) listenersByKey.delete(key);
    };
  }, [key, deviceId, sessionId]);

  useEffect(() => {
    if (!key || !deviceId || !sessionId) return;
    const off = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (push.channel !== ROUTE_CHANGED_CHANNEL) return;
      if (push.deviceId !== deviceId) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      const payload = push.payload as { sessionId?: unknown; route?: unknown } | null;
      if (!payload || payload.sessionId !== sessionId) return;
      ensureCacheOwnerCurrent();
      unsupportedUntilByDevice.delete(deviceId);
      applyRoute(key, isRoute(payload.route) ? payload.route : null);
    });
    return off;
  }, [key, deviceId, sessionId]);

  return route;
}
