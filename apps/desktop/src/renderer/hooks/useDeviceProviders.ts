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
import { extractIpcError } from '@/utils/ipcError';

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
  | { status: 'error'; error: string; unsupported: boolean };
const listeners = new Map<string, Set<(event: DeviceProvidersEvent) => void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isProviderWireProtocol(value: unknown): boolean {
  return (
    value === undefined ||
    value === 'anthropic-messages' ||
    value === 'openai-responses' ||
    value === 'openai-chat'
  );
}

function isProviderModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const efforts = value.efforts;
  const defaultEffort = value.defaultEffort;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.contextWindow === 'number' &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow > 0 &&
    Array.isArray(efforts) &&
    efforts.every((effort) => typeof effort === 'string') &&
    (defaultEffort === null ||
      (typeof defaultEffort === 'string' && efforts.includes(defaultEffort))) &&
    isOptionalBoolean(value.disabled) &&
    isOptionalBoolean(value.supportsFastMode) &&
    isOptionalBoolean(value.defaultEnabled)
  );
}

function isProviderRoute(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOptionalBoolean(value.disabled) &&
    isProviderWireProtocol(value.wireProtocol)
  );
}

function sanitizeProviderModels(
  models: unknown,
): Record<string, unknown[]> | null {
  if (!isRecord(models)) return null;
  const sanitized: Record<string, unknown[]> = {};
  for (const [agent, entries] of Object.entries(models)) {
    if (!Array.isArray(entries)) return null;
    sanitized[agent] = entries.filter(isProviderModel);
  }
  return sanitized;
}

function isProviderView(value: unknown): value is ProviderView {
  if (!isRecord(value)) return false;
  const routing = value.routing;
  const models = sanitizeProviderModels(value.models);
  if (!models) return false;
  value.models = models;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    Array.isArray(value.agents) &&
    value.agents.every((agent) => typeof agent === 'string') &&
    (routing === undefined ||
      (isRecord(routing) && Object.values(routing).every(isProviderRoute))) &&
    typeof value.connected === 'boolean' &&
    isOptionalBoolean(value.suspended)
  );
}

export function parseDeviceProvidersPayload(value: unknown): DeviceProvidersPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid provider list response');
  }
  if (!Array.isArray(value.providers)) {
    throw new Error('Invalid provider list response');
  }
  const rawProviders = value.providers;
  const providersIn = rawProviders.filter(isProviderView);
  if (providersIn.length === 0 && rawProviders.length > 0) {
    throw new Error('Invalid provider list response');
  }
  const overrides = value.modelVisibilityOverrides;
  if (
    overrides !== undefined &&
    (!isRecord(overrides) ||
      Object.values(overrides).some((visible) => typeof visible !== 'boolean'))
  ) {
    throw new Error('Invalid provider visibility response');
  }
  // device-link 的 provider:list 是只读展示投影；旧/部分被控端可能省略 routing，
  // 但 model-providers 的 connectedProvidersForAgent 需要每个声明的 agent 有一个
  // routing entry 才会把供应商视为可用。只在远程解析边界补齐空 entry，不改变本机
  // registry 对缺失 route 的严格语义，也保留已有 disabled 标记。
  const providers = providersIn.map((provider) => {
    const routing = { ...(provider.routing ?? {}) } as ProviderView['routing'];
    for (const agent of provider.agents) {
      if (routing[agent as keyof ProviderView['routing']] === undefined) {
        Object.assign(routing, { [agent]: {} });
      }
    }
    return { ...provider, routing };
  });
  return {
    providers,
    ...(overrides !== undefined
      ? { modelVisibilityOverrides: overrides as Record<string, boolean> }
      : {}),
  };
}

/** 旧被控端没有 provider:list 时允许退化到 capabilities flat 列表；其它错误都是真失败。 */
export function isDeviceProvidersUnsupportedError(error: unknown): boolean {
  return extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
}

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
    dl.invoke(deviceId, 'maker:provider:list', [
      {
        capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2],
      },
    ]) as Promise<DeviceProvidersPayload>
  )
    .then((res) => {
      const payload = parseDeviceProvidersPayload(res);
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
          unsupported: isDeviceProvidersUnsupportedError(e),
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
  /** true 仅表示老被控端没有 provider:list，可安全回退 capabilities-only 列表。 */
  unsupported: boolean;
}

export function useDeviceProviders(deviceId?: string): UseDeviceProvidersResult {
  const initialPayload = deviceId ? cache.get(deviceId) : undefined;
  const [ownerDeviceId, setOwnerDeviceId] = useState<string | null>(
    initialPayload ? (deviceId ?? null) : null,
  );
  const [payload, setPayload] = useState<DeviceProvidersPayload>(initialPayload ?? EMPTY_PAYLOAD);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!deviceId) {
      setOwnerDeviceId(null);
      setPayload(EMPTY_PAYLOAD);
      setLoading(false);
      setError(null);
      setUnsupported(false);
      return;
    }
    let cancelled = false;
    const unsubscribe = subscribeDeviceProviders(deviceId, (event) => {
      if (cancelled) return;
      if (event.status === 'loading') {
        // 保留上一份完整列表避免视觉跳变，但让模型选择逻辑等待同轮新快照。
        setOwnerDeviceId(deviceId);
        setLoading(true);
        setError(null);
        setUnsupported(false);
        return;
      }
      if (event.status === 'error') {
        setOwnerDeviceId(deviceId);
        if (event.unsupported) setPayload(EMPTY_PAYLOAD);
        setLoading(false);
        setError(event.error);
        setUnsupported(event.unsupported);
        return;
      }
      setOwnerDeviceId(deviceId);
      setPayload({
        providers: event.providers,
        ...(event.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: event.modelVisibilityOverrides }
          : {}),
      });
      setError(null);
      setUnsupported(false);
      setLoading(false);
    });
    const cached = cache.get(deviceId);
    if (cached) {
      setOwnerDeviceId(deviceId);
      setPayload(cached);
      setError(null);
      setUnsupported(false);
      setLoading(false);
      return unsubscribe;
    }
    // cache miss:先清空,避免 fetch 解析前(失败则永远)残留上一设备的供应商。
    setOwnerDeviceId(deviceId);
    setPayload(EMPTY_PAYLOAD);
    setLoading(true);
    setError(null);
    setUnsupported(false);
    const remoteGeneration = deviceGen.get(deviceId) ?? 0;
    fetchDeviceProviders(deviceId)
      .catch((e: unknown) => {
        if (cancelled) return;
        if ((deviceGen.get(deviceId) ?? 0) !== remoteGeneration) return;
        const nextUnsupported = isDeviceProvidersUnsupportedError(e);
        if (nextUnsupported) setPayload(EMPTY_PAYLOAD);
        setError(e instanceof Error ? e.message : String(e));
        setUnsupported(nextUnsupported);
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

  const ownsSelectedDevice = ownerDeviceId === (deviceId ?? null);
  const selectedError = ownsSelectedDevice ? error : null;
  const selectedUnsupported = ownsSelectedDevice ? unsupported : false;
  const selectedPayload =
    ownsSelectedDevice && !(selectedError && selectedUnsupported) ? payload : EMPTY_PAYLOAD;

  return {
    providers: selectedPayload.providers,
    ...(selectedPayload.modelVisibilityOverrides !== undefined
      ? { modelVisibilityOverrides: selectedPayload.modelVisibilityOverrides }
      : {}),
    loading: !!deviceId && (!ownsSelectedDevice || loading),
    error: selectedError,
    unsupported: selectedUnsupported,
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
