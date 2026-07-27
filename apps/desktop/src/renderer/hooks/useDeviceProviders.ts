/**
 * useDeviceProviders — 拉取**被控端**(device-link)的模型供应商目录。
 *
 * 本机供应商走 `useProviders()`;远程会话(deviceId 非空)必须列**被控端**的供应商结构
 * (隧道 `maker:provider:list`,被控端 dispatch 已剥离 routing 等执行字段,仅回显示用字段)。
 *
 * 缓存按 deviceId 隔离 + 代际驱逐 —— 与 `useAgentCapabilities` 的 device-scoping 同范式:
 * 两台机器供应商配置可能不同,绝不能串;设备下线 / 断链后在途 fetch 的 `.then` 不得把陈旧
 * 供应商复活回缓存。deviceId 省略 = 不拉取(调用方改用本机 `useProviders`)。
 *
 * 优雅回退:被控端为旧版(allowlist 无 `maker:provider:list`)→ invoke reject → 暴露 error,
 * 调用方(ModelSelector)回退到基于 capabilities 的扁平列表(`selectVisibleModels`)。
 */
import { useEffect, useState } from 'react';

import { CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2 } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';

import { createLogger } from '@/lib/logger';

const log = createLogger('useDeviceProviders');

interface DeviceLinkShape {
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}

function getDeviceLink(): DeviceLinkShape | null {
  const dl = (
    window as unknown as {
      electronAPI?: { deviceLink?: DeviceLinkShape };
    }
  ).electronAPI?.deviceLink;
  return dl ?? null;
}

// 缓存按被控设备隔离;代际同 useAgentCapabilities(evict 时自增,作废在途 fetch 的回写)。
export interface DeviceProvidersPayload {
  providers: ProviderView[];
  /** 被控端「模型显示/隐藏」override 快照；undefined = 旧被控端，不过滤。 */
  modelVisibilityOverrides?: Record<string, boolean>;
}

const EMPTY_PAYLOAD: DeviceProvidersPayload = { providers: [] };
const cache = new Map<string, DeviceProvidersPayload>();
const inflight = new Map<string, Promise<DeviceProvidersPayload>>();
const deviceGen = new Map<string, number>();
export type DeviceProvidersEvent =
  | { status: 'loading' }
  | ({ status: 'ready' } & DeviceProvidersPayload)
  | { status: 'error'; error: string };
const listeners = new Map<string, Set<(event: DeviceProvidersEvent) => void>>();

function notifyDeviceProviders(deviceId: string, event: DeviceProvidersEvent): void {
  for (const listener of listeners.get(deviceId) ?? []) listener(event);
}

/** 订阅某设备缓存的新快照；live provider push 后已挂载 hook 也能无空白帧地更新。 */
export function subscribeDeviceProviders(
  deviceId: string,
  listener: (event: DeviceProvidersEvent) => void,
): () => void {
  const bucket = listeners.get(deviceId) ?? new Set<(event: DeviceProvidersEvent) => void>();
  bucket.add(listener);
  listeners.set(deviceId, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(deviceId);
  };
}

async function fetchDeviceProviders(deviceId: string): Promise<DeviceProvidersPayload> {
  const cached = cache.get(deviceId);
  if (cached) return cached;
  const ip = inflight.get(deviceId);
  if (ip) return ip;

  // 捕获发起时代际;回调里若代际已变(被 evict)则认为本次请求作废,不回写 cache / 不动 inflight。
  const startGen = deviceGen.get(deviceId) ?? 0;
  const isCurrent = (): boolean => (deviceGen.get(deviceId) ?? 0) === startGen;

  const dl = getDeviceLink();
  if (!dl) throw new Error('device-link IPC not available');
  const p = (
    dl.invoke(deviceId, 'maker:provider:list', [{
      capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2],
    }]) as Promise<DeviceProvidersPayload>
  )
    .then((res) => {
      const payload: DeviceProvidersPayload = {
        providers: res?.providers ?? [],
        ...(res?.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: res.modelVisibilityOverrides }
          : {}),
      };
      if (isCurrent()) {
        cache.set(deviceId, payload);
        inflight.delete(deviceId);
        notifyDeviceProviders(deviceId, { status: 'ready', ...payload });
      }
      return payload;
    })
    .catch((e) => {
      if (isCurrent()) {
        inflight.delete(deviceId);
        notifyDeviceProviders(deviceId, {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
      throw e;
    });
  inflight.set(deviceId, p);
  return p;
}

export interface UseDeviceProvidersResult {
  providers: ProviderView[];
  /** 被控端「模型显示/隐藏」override 快照；undefined = 旧被控端，不过滤。 */
  modelVisibilityOverrides?: Record<string, boolean>;
  loading: boolean;
  /** 非 null = 拉取失败(典型:旧版被控端不识别通道);调用方据此回退扁平列表。 */
  error: string | null;
}

export function useDeviceProviders(deviceId?: string): UseDeviceProvidersResult {
  const [payload, setPayload] = useState<DeviceProvidersPayload>(
    deviceId ? (cache.get(deviceId) ?? EMPTY_PAYLOAD) : EMPTY_PAYLOAD,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) {
      setPayload(EMPTY_PAYLOAD);
      setError(null);
      return;
    }
    let cancelled = false;
    const unsubscribe = subscribeDeviceProviders(deviceId, (event) => {
      if (cancelled) return;
      if (event.status === 'loading') {
        // 保留上一份完整列表避免视觉跳变，但让模型选择逻辑等待同轮新快照。
        setLoading(true);
        setError(null);
        return;
      }
      if (event.status === 'error') {
        setLoading(false);
        setError(event.error);
        return;
      }
      setPayload({
        providers: event.providers,
        ...(event.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: event.modelVisibilityOverrides }
          : {}),
      });
      setError(null);
      setLoading(false);
    });
    const cached = cache.get(deviceId);
    if (cached) {
      setPayload(cached);
      setError(null);
      setLoading(false);
      return unsubscribe;
    }
    // cache miss:先清空,避免 fetch 解析前(失败则永远)残留上一设备的供应商。
    setPayload(EMPTY_PAYLOAD);
    setLoading(true);
    setError(null);
    const remoteGeneration = deviceGen.get(deviceId) ?? 0;
    fetchDeviceProviders(deviceId)
      .catch((e: unknown) => {
        if (cancelled) return;
        if ((deviceGen.get(deviceId) ?? 0) !== remoteGeneration) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled || (deviceGen.get(deviceId) ?? 0) !== remoteGeneration) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [deviceId]);

  return {
    providers: payload.providers,
    ...(payload.modelVisibilityOverrides !== undefined
      ? { modelVisibilityOverrides: payload.modelVisibilityOverrides }
      : {}),
    loading,
    error,
  };
}

/** device-link:订阅某被控设备时预取其供应商目录(与 prefetchDeviceCapabilities 并列调用)。 */
export async function prefetchDeviceProviders(deviceId: string): Promise<void> {
  try {
    await fetchDeviceProviders(deviceId);
  } catch (err) {
    // swallow:打开会话时 hook 会再取一次(旧版被控端不支持时回退扁平列表)。
    log.debug('prefetchDeviceProviders failed (non-fatal)', {
      deviceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** device-link:被控设备下线 / 断链时驱逐其供应商缓存(只清该设备的 key + 代际自增)。 */
export function getCachedDeviceProviders(deviceId: string): DeviceProvidersPayload | null {
  return cache.get(deviceId) ?? null;
}

export function evictDeviceProviders(deviceId: string): void {
  cache.delete(deviceId);
  inflight.delete(deviceId);
  deviceGen.set(deviceId, (deviceGen.get(deviceId) ?? 0) + 1);
  notifyDeviceProviders(deviceId, { status: 'loading' });
}
