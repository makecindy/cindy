/**
 * 供应商分享 · 被控电脑「收到的分享」目录缓存(**纯逻辑,零 react-native**,便于 node 单测)。
 *
 * 手机读不到另一个账号的电脑,所以由被控电脑经同账号 channel
 * `maker:provider-share:received-catalogs` 代读分享者电脑的 `maker:provider:list` 并转交
 * (见 packages/device-link/src/providerShareCatalog.ts)。目录来自另一个账号,在这里按桌面
 * `parseDeviceProvidersPayload` 同口径严格收窄后才交给模型选择器。
 *
 * 缓存语义对齐 deviceProvidersCache:按被控设备隔离、在途去重、代际作废(换账号 / 设备下线时
 * 驱逐,作废在途回写)。有缓存先显示,再在后台刷新;某个分享这次读不到目录时沿用上次读到的。
 * 旧版桌面没有该 channel(CHANNEL_NOT_ALLOWED)= 没有分享,静默处理。
 */
import { parseProviderShareReceivedCatalogs, scrubSharedProvider } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';

import {
  isDeviceProvidersUnsupportedError,
  orderDeviceProviders,
  type DeviceProvidersPayload,
} from './deviceProvidersCache';

/** 一个别人分享给被控电脑的供应商(只含展示用字段,身份只有昵称)。 */
export interface ProviderShareCatalogEntry {
  /** 任务记录里「Agent 在哪台电脑」的值:`share:<shareId>`。 */
  agentDeviceId: string;
  shareId: string;
  providerId: string;
  /** 分享者电脑的名字。 */
  deviceName: string;
  /** 分享者昵称。 */
  ownerName: string;
  status: 'active' | 'paused';
  hostOnline: boolean;
  /** 分享者电脑上该供应商的目录;从未读到过时为 null。 */
  payload: DeviceProvidersPayload | null;
}

const WIRE_PROTOCOLS = new Set([
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'google-generative-ai',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isProviderModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { efforts, defaultEffort, contextWindow } = value;
  return (
    typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.name === 'string'
    && typeof contextWindow === 'number'
    && Number.isFinite(contextWindow)
    && contextWindow > 0
    && isStringArray(efforts)
    && (defaultEffort === undefined || defaultEffort === null
      || (typeof defaultEffort === 'string' && efforts.includes(defaultEffort)))
    && isOptionalBoolean(value.disabled)
    && isOptionalBoolean(value.supportsFastMode)
    && isOptionalBoolean(value.defaultEnabled)
  );
}

function isProviderRoute(value: unknown): boolean {
  return (
    isRecord(value)
    && isOptionalBoolean(value.disabled)
    && (value.wireProtocol === undefined || WIRE_PROTOCOLS.has(value.wireProtocol as string))
  );
}

/** 同桌面 isProviderView,但不改写入参:非法模型丢弃,结构不对的供应商整条丢弃。 */
function parseProvider(value: unknown): ProviderView | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.name !== 'string') return null;
  if (!isStringArray(value.agents) || typeof value.connected !== 'boolean') return null;
  if (!isOptionalBoolean(value.suspended)) return null;
  if (!isRecord(value.models)) return null;
  const models: Record<string, unknown[]> = {};
  for (const [agent, entries] of Object.entries(value.models)) {
    if (!Array.isArray(entries)) return null;
    models[agent] = entries.filter(isProviderModel);
  }
  const rawRouting = value.routing;
  if (rawRouting !== undefined && (!isRecord(rawRouting) || !Object.values(rawRouting).every(isProviderRoute))) {
    return null;
  }
  // 只读展示投影可能省略 routing;connectedProvidersForAgent 要求每个声明的 agent 都有一条
  // routing entry。与桌面一样只在远程解析边界补空 entry,保留已有 disabled 标记。
  const routing: Record<string, unknown> = { ...(rawRouting ?? {}) };
  for (const agent of value.agents) {
    if (routing[agent] === undefined) routing[agent] = {};
  }
  // 另一个账号的目录：不保留分享者的账号身份(登录邮箱等)。
  return scrubSharedProvider({ ...value, models, routing }) as unknown as ProviderView;
}

/**
 * 分享者电脑 `maker:provider:list` 的结果(已由分享者电脑过滤到被分享的供应商)。只保留
 * 被分享的那个供应商(结构不对的丢弃)。null = 读不到(没有回包或回包结构不对);读到了但
 * 里面没有可用的分享供应商(例如对方关了「允许被远程调用」)时返回空目录,不沿用旧目录。
 */
export function parseProviderShareCatalogPayload(
  value: unknown,
  providerId: string,
): DeviceProvidersPayload | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null;
  const providers = value.providers
    .map(parseProvider)
    .filter((provider): provider is ProviderView => provider !== null && provider.id === providerId);
  const overrides = isRecord(value.modelVisibilityOverrides)
    ? Object.fromEntries(
        Object.entries(value.modelVisibilityOverrides).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
        ),
      )
    : undefined;
  return orderDeviceProviders({
    providers,
    ...(isStringArray(value.providerOrder) ? { providerOrder: value.providerOrder } : {}),
    ...(overrides !== undefined ? { modelVisibilityOverrides: overrides } : {}),
  });
}

/** 严格解析 received-catalogs 回包;单条不合法时丢弃这一条。 */
export function parseProviderShareCatalogs(value: unknown): ProviderShareCatalogEntry[] {
  return parseProviderShareReceivedCatalogs(value).map((share) => ({
    agentDeviceId: share.agentDeviceId,
    shareId: share.shareId,
    providerId: share.providerId,
    deviceName: share.deviceName,
    ownerName: share.owner.displayName,
    status: share.status,
    hostOnline: share.hostOnline,
    payload: parseProviderShareCatalogPayload(share.catalog, share.providerId),
  }));
}

/**
 * 这次读不到目录(payload = null)的分享沿用上次读到的(同一个分享、同一个供应商);
 * 读到了空目录就用空目录;消失的分享直接丢掉。
 */
export function mergeProviderShareCatalogs(
  previous: readonly ProviderShareCatalogEntry[],
  next: readonly ProviderShareCatalogEntry[],
): ProviderShareCatalogEntry[] {
  const before = new Map(previous.map((share) => [share.agentDeviceId, share]));
  return next.map((share) => {
    if (share.payload) return share;
    const last = before.get(share.agentDeviceId);
    return last?.payload && last.providerId === share.providerId ? { ...share, payload: last.payload } : share;
  });
}

// 按被控设备隔离;代际同 deviceProvidersCache(驱逐时自增,作废在途回写)。
const cache = new Map<string, ProviderShareCatalogEntry[]>();
const inflight = new Map<string, Promise<ProviderShareCatalogEntry[]>>();
const generations = new Map<string, number>();
const listeners = new Map<string, Set<(entries: ProviderShareCatalogEntry[]) => void>>();

const generationOf = (deviceId: string): number => generations.get(deviceId) ?? 0;

/** 读缓存(同步);undefined = 这台被控电脑还没读到过。 */
export function getCachedProviderShareCatalogs(deviceId: string): ProviderShareCatalogEntry[] | undefined {
  return cache.get(deviceId);
}

/** 订阅某台被控电脑的新快照。 */
export function subscribeProviderShareCatalogs(
  deviceId: string,
  listener: (entries: ProviderShareCatalogEntry[]) => void,
): () => void {
  const bucket = listeners.get(deviceId) ?? new Set<(entries: ProviderShareCatalogEntry[]) => void>();
  bucket.add(listener);
  listeners.set(deviceId, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(deviceId);
  };
}

/**
 * 向被控电脑重新读一次(同一台在途时复用)。成功后写缓存并通知订阅者;旧版桌面没有该
 * channel 时按「没有分享」处理;其他失败保留旧缓存并把错误抛给调用方。
 */
export function refreshProviderShareCatalogs(
  deviceId: string,
  fetcher: () => Promise<unknown>,
): Promise<ProviderShareCatalogEntry[]> {
  const pending = inflight.get(deviceId);
  if (pending) return pending;
  const startGeneration = generationOf(deviceId);
  const request = Promise.resolve()
    .then(fetcher)
    .then(parseProviderShareCatalogs, (error: unknown) => {
      if (isDeviceProvidersUnsupportedError(error)) return [];
      throw error;
    })
    .then((parsed) => {
      if (generationOf(deviceId) !== startGeneration) return parsed;
      const merged = mergeProviderShareCatalogs(cache.get(deviceId) ?? [], parsed);
      cache.set(deviceId, merged);
      for (const listener of listeners.get(deviceId) ?? []) listener(merged);
      return merged;
    });
  inflight.set(deviceId, request);
  void request
    .finally(() => {
      if (inflight.get(deviceId) === request) inflight.delete(deviceId);
    })
    .catch(() => undefined);
  return request;
}

/** 被控设备下线 / 撤权时驱逐(只清该设备,并作废在途回写)。 */
export function evictProviderShareCatalogs(deviceId: string): void {
  cache.delete(deviceId);
  inflight.delete(deviceId);
  generations.set(deviceId, generationOf(deviceId) + 1);
}

/** 登出 / 切号时清空全部,防止下一个账号看到上一个账号收到的分享。 */
export function clearAllProviderShareCatalogs(): void {
  const ids = new Set([...cache.keys(), ...inflight.keys(), ...generations.keys()]);
  cache.clear();
  inflight.clear();
  for (const id of ids) generations.set(id, generationOf(id) + 1);
}
