/**
 * agentCapabilitiesCache —— 远程 agent 能力表的 (deviceId, agentKind) 内存缓存。
 * ---------------------------------------------------------------------------
 * capabilities 是模型 / 权限 / effort 选择器的唯一数据源,旧行为每次进会话页 /
 * 新建页都重新走一次 device-link 往返,期间面板显示「正在读取远程运行能力」+
 * 空模型列表,返回后选项弹入(可见跳变)。能力表按 (设备, agent) 基本不变,
 * 这里对照 deviceProvidersCache 的先例做内存缓存:命中先画,后台静默刷新覆盖
 * (规则 7:先有内容再刷新)。纯逻辑零 react-native,node 可单测。
 */
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';

const cache = new Map<string, MobileAgentCapabilities>();
const deviceGen = new Map<string, number>();
const listeners = new Map<string, Set<(value: MobileAgentCapabilities) => void>>();
const inflight = new Map<string, { generation: number; promise: Promise<unknown> }>();

/** Share page and push-triggered reads. A newer generation waits for the old
 * physical read to settle, but never adopts its result or revives an old owner. */
export function fetchAgentCapabilities(
  deviceId: string,
  agentKind: string,
  fetcher: () => Promise<unknown>,
): Promise<unknown> {
  const key = buildAgentCapabilitiesCacheKey(deviceId, agentKind);
  const generation = getAgentCapabilitiesGeneration(deviceId);
  deviceGen.set(deviceId, generation);
  const pending = inflight.get(key);
  if (pending) {
    if (pending.generation === generation) return pending.promise;
    return pending.promise.catch(() => undefined).then(() => {
      if (!isAgentCapabilitiesGenerationCurrent(deviceId, generation)) throw new Error('Capabilities read superseded');
      return fetchAgentCapabilities(deviceId, agentKind, fetcher);
    });
  }
  const promise = Promise.resolve().then(fetcher);
  inflight.set(key, { generation, promise });
  void promise.finally(() => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  }).catch(() => undefined);
  return promise;
}

export function buildAgentCapabilitiesCacheKey(deviceId: string, agentKind: string): string {
  return `${deviceId} ${agentKind}`;
}

export function getCachedAgentCapabilities(key: string): MobileAgentCapabilities | null {
  return cache.get(key) ?? null;
}

/** 捕获设备当前能力代际；请求完成时必须带回同一代际才能提交。 */
export function getAgentCapabilitiesGeneration(deviceId: string): number {
  return deviceGen.get(deviceId) ?? 0;
}

export function isAgentCapabilitiesGenerationCurrent(
  deviceId: string,
  generation: number,
): boolean {
  return getAgentCapabilitiesGeneration(deviceId) === generation;
}

/** 订阅某设备某 agent 的当前代能力快照。 */
export function subscribeAgentCapabilities(
  deviceId: string,
  agentKind: string,
  listener: (value: MobileAgentCapabilities) => void,
): () => void {
  const key = buildAgentCapabilitiesCacheKey(deviceId, agentKind);
  const bucket = listeners.get(key) ?? new Set<(value: MobileAgentCapabilities) => void>();
  bucket.add(listener);
  listeners.set(key, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(key);
  };
}

/** 只提交当前设备代际的结果；成功后通知已挂载页面一次性换入完整快照。 */
export function commitAgentCapabilities(
  deviceId: string,
  agentKind: string,
  generation: number,
  value: MobileAgentCapabilities,
): boolean {
  if (!isAgentCapabilitiesGenerationCurrent(deviceId, generation)) return false;
  const key = buildAgentCapabilitiesCacheKey(deviceId, agentKind);
  cache.set(key, value);
  for (const listener of listeners.get(key) ?? []) listener(value);
  return true;
}

/** device-link:设备下线 / 切换时按 deviceId 前缀驱逐(与 providers 缓存同时机由调用方触发)。 */
export function evictAgentCapabilitiesForDevice(deviceId: string): void {
  const prefix = `${deviceId} `;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  deviceGen.set(deviceId, getAgentCapabilitiesGeneration(deviceId) + 1);
}

/** 清空缓存(登出账号隔离用;测试亦复用)。 */
export function resetAgentCapabilitiesCache(): void {
  const deviceIds = new Set(deviceGen.keys());
  for (const key of [...cache.keys(), ...listeners.keys()]) {
    const separator = key.lastIndexOf(' ');
    if (separator > 0) deviceIds.add(key.slice(0, separator));
  }
  for (const deviceId of deviceIds) {
    deviceGen.set(deviceId, getAgentCapabilitiesGeneration(deviceId) + 1);
  }
  cache.clear();
}
