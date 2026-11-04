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
import { isProviderAccessDeniedError, parseProviderShareReceivedCatalogs, scrubSharedProvider,
  readProviderMetadataContinuity, MetadataSnapshotExpiry, PROVIDER_METADATA_TRUST_MS } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';

import {
  isDeviceProvidersUnsupportedError,
  orderDeviceProviders,
  type DeviceProvidersPayload,
} from './deviceProvidersCache';

/**
 * 一个别人分享给被控电脑的供应商(只含展示用字段,身份只有昵称)。不带分享者的电脑名:
 * 受邀者看不到它(provider-sharing.md §6)。
 */
export interface ProviderShareCatalogEntry {
  /** 任务记录里「Agent 在哪台电脑」的值:`share:<shareId>`。 */
  agentDeviceId: string;
  shareId: string;
  providerId: string;
  /** 分享的供应商名称(已去掉登录身份)。 */
  providerLabel: string;
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
    ...(readProviderMetadataContinuity(value) ? { providerContinuity: readProviderMetadataContinuity(value) } : {}),
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
    providerLabel: share.providerLabel,
    ownerName: share.owner.displayName,
    status: share.status,
    hostOnline: share.hostOnline,
    payload: parseProviderShareCatalogPayload(share.catalog, share.providerId),
  }));
}

/** The controlled host reports whether every region has answered. Only a
 * complete list may treat a missing share as removed. Older hosts omit it. */
export function parseProviderShareCatalogsResult(value: unknown): { entries: ProviderShareCatalogEntry[]; ready: boolean } {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as { ready?: unknown } : {};
  return { entries: parseProviderShareCatalogs(value), ready: row.ready !== false };
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
    if (share.status !== 'active') return { ...share, payload: null };
    if (share.payload) return share;
    const last = before.get(share.agentDeviceId);
    return last?.payload && last.providerId === share.providerId ? { ...share, payload: last.payload } : share;
  });
}

// 按被控设备隔离;代际同 deviceProvidersCache(驱逐时自增,作废在途回写)。
const cache = new Map<string, ProviderShareCatalogEntry[]>();
const expiry = new MetadataSnapshotExpiry();
const completeness = new Map<string, boolean>();
const retention = new Map<string, Retention>();
const payloadDeadlines = new Map<string, { wallUntil: number; monoUntil: number }>();
const observedAt = new Map<string, { wall: number; mono: number }>();
const pendingNotifications = new Set<string>();
const expiryKeys = new Map<string, Set<string>>();
const expiryKey = (deviceId: string, shareId: string) => JSON.stringify([deviceId, shareId]);
const inflight = new Map<string, Promise<ProviderShareCatalogEntry[]>>();
const generations = new Map<string, number>();
const listeners = new Map<string, Set<(entries: ProviderShareCatalogEntry[]) => void>>();

const generationOf = (deviceId: string): number => generations.get(deviceId) ?? 0;

interface Retention {
  deviceId: string;
  shareId: string;
  key: string;
  wallUntil: number;
  monoUntil: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function notifyCatalogs(deviceId: string, entries: ProviderShareCatalogEntry[]): void {
  pendingNotifications.delete(deviceId);
  for (const listener of listeners.get(deviceId) ?? []) listener(entries);
}

/** A synchronous getter can retire an entry before its timer runs. Notify from
 * a microtask so the subscriber still sees the row removal, without updating
 * React state during render and without scheduling another read. */
function scheduleCatalogNotification(deviceId: string): void {
  if (pendingNotifications.has(deviceId)) return;
  pendingNotifications.add(deviceId);
  queueMicrotask(() => {
    if (!pendingNotifications.delete(deviceId)) return;
    const entries = cache.get(deviceId);
    if (entries) notifyCatalogs(deviceId, entries);
  });
}

function clearRetention(key: string): void {
  const row = retention.get(key);
  if (!row) return;
  if (row.timer !== undefined) clearTimeout(row.timer);
  retention.delete(key);
}

function clearDeviceRetention(deviceId: string): void {
  for (const [key, row] of retention) if (row.deviceId === deviceId) clearRetention(key);
}

function clearAllRetention(): void {
  for (const row of retention.values()) if (row.timer !== undefined) clearTimeout(row.timer);
  retention.clear();
}

function removeCatalogEntry(deviceId: string, shareId: string, notify: boolean): boolean {
  const entries = cache.get(deviceId);
  if (!entries) return false;
  const next = entries.filter(entry => entry.shareId !== shareId);
  if (next.length === entries.length) return false;
  cache.set(deviceId, next);
  const key = expiryKey(deviceId, shareId);
  expiry.forget(key);
  expiryKeys.get(deviceId)?.delete(key);
  payloadDeadlines.delete(key);
  observedAt.delete(key);
  clearRetention(key);
  if (notify) notifyCatalogs(deviceId, next);
  return true;
}

function armRetention(row: Retention): void {
  const delay = Math.max(0, Math.min(row.wallUntil - Date.now(), row.monoUntil - performance.now()));
  row.timer = setTimeout(() => {
    if (retention.get(row.key) !== row) return;
    if (Date.now() < row.wallUntil && performance.now() < row.monoUntil) {
      armRetention(row);
      return;
    }
    removeCatalogEntry(row.deviceId, row.shareId, true);
  }, delay);
  (row.timer as { unref?: () => void }).unref?.();
}

/** Keep a missing entry only within the directory/trust budget it already had.
 * Repeated partial reads must not extend this deadline. */
function retainMissing(deviceId: string, share: ProviderShareCatalogEntry): boolean {
  const key = expiryKey(deviceId, share.shareId);
  const existing = retention.get(key);
  if (existing) {
    if (Date.now() < existing.wallUntil && performance.now() < existing.monoUntil) return true;
    clearRetention(key);
    return false;
  }
  const wallNow = Date.now(), monoNow = performance.now();
  const payload = payloadDeadlines.get(key);
  const observed = observedAt.get(key);
  const baseWall = observed?.wall ?? wallNow;
  const baseMono = observed?.mono ?? monoNow;
  const wallUntil = Math.min(baseWall + PROVIDER_METADATA_TRUST_MS, payload?.wallUntil ?? Number.POSITIVE_INFINITY);
  const monoUntil = Math.min(baseMono + PROVIDER_METADATA_TRUST_MS, payload?.monoUntil ?? Number.POSITIVE_INFINITY);
  if (wallUntil <= wallNow || monoUntil <= monoNow) return false;
  const row: Retention = { deviceId, shareId: share.shareId, key, wallUntil, monoUntil, timer: undefined };
  retention.set(key, row);
  armRetention(row);
  return true;
}

function pruneExpiredRetention(deviceId: string): boolean {
  let removed = false;
  for (const [key, row] of retention) {
    if (row.deviceId !== deviceId) continue;
    if (Date.now() < row.wallUntil && performance.now() < row.monoUntil) continue;
    removed = removeCatalogEntry(deviceId, row.shareId, false) || removed;
  }
  return removed;
}

/** false = the host returned only loaded regions; missing shares are not proved removed.
 * undefined = no read in this runtime. */
export function isProviderShareCatalogComplete(deviceId: string): boolean | undefined {
  return completeness.get(deviceId);
}

/** 读缓存(同步);undefined = 这台被控电脑还没读到过。 */
export function getCachedProviderShareCatalogs(deviceId: string): ProviderShareCatalogEntry[] | undefined {
  if (pruneExpiredRetention(deviceId)) scheduleCatalogNotification(deviceId);
  const entries = cache.get(deviceId);
  if (!entries) return undefined;
  // Evaluate each deadline once. valid() retires an expired entry and returns
  // false; a second call would see the removed entry as "no deadline" and
  // hand the payload back for this synchronous read.
  const checked = entries.map(share => ({ share, valid: expiry.valid(expiryKey(deviceId, share.shareId)) }));
  if (checked.every(row => row.valid)) return entries;
  return checked.map(row => row.valid ? row.share : { ...row.share, payload: null });
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
  const requestedAt = { wall: Date.now(), mono: performance.now() };
  const request = Promise.resolve()
    .then(fetcher)
    .then(parseProviderShareCatalogsResult, (error: unknown) => {
      if (isDeviceProvidersUnsupportedError(error)) return { entries: [], ready: true };
      if (isProviderAccessDeniedError(error) && generationOf(deviceId) === startGeneration) {
        evictProviderShareCatalogs(deviceId);
      }
      throw error;
    })
    .then((result) => {
      const parsed = result.entries;
      if (generationOf(deviceId) !== startGeneration) return parsed;
      completeness.set(deviceId, result.ready);
      const invalid = new Set<string>();
      for (const share of parsed) {
        const key = expiryKey(deviceId, share.shareId);
        clearRetention(key);
        observedAt.set(key, { wall: requestedAt.wall, mono: requestedAt.mono });
        if (share.status !== 'active') {
          expiry.forget(key);
          payloadDeadlines.delete(key);
          invalid.add(share.shareId);
        }
        else if (share.payload) {
          const keys = expiryKeys.get(deviceId) ?? new Set<string>(); keys.add(key); expiryKeys.set(deviceId, keys);
          if (!expiry.remember(key, share.payload, requestedAt, () => {
            const entries = cache.get(deviceId);
            if (!entries) return;
            const next = entries.map(entry => entry.shareId === share.shareId ? { ...entry, payload: null } : entry);
            cache.set(deviceId, next);
            // A suspended timer can make the synchronous getter discover the
            // expiry during render. Clear the cache now, but notify from a
            // microtask so a mounted picker is not updated while rendering.
            scheduleCatalogNotification(deviceId);
          })) {
            payloadDeadlines.delete(key);
            invalid.add(share.shareId);
          } else {
            const remaining = readProviderMetadataContinuity(share.payload)?.remainingMs;
            if (remaining !== undefined) payloadDeadlines.set(key, {
              wallUntil: requestedAt.wall + remaining, monoUntil: requestedAt.mono + remaining });
            else payloadDeadlines.delete(key);
          }
        }
      }
      const previous = (getCachedProviderShareCatalogs(deviceId) ?? []).map(share => invalid.has(share.shareId) ? { ...share, payload: null } : share);
      const previousById = new Map(previous.map(share => [share.shareId, share]));
      const next = parsed.map(share => invalid.has(share.shareId) ? { ...share, payload: null } : share);
      for (const share of next) {
        if (share.payload || share.status !== 'active') continue;
        // A present entry with no catalog is still a fresh metadata observation.
        // Only keep the old payload deadline when merge can reuse that payload.
        if (!previousById.get(share.shareId)?.payload) payloadDeadlines.delete(expiryKey(deviceId, share.shareId));
      }
      if (!result.ready) {
        // A host that has not loaded every region cannot prove a missing share
        // was removed. Keep the last bounded entry only for its existing
        // directory/trust deadline; repeated partial reads never renew it.
        const present = new Set(next.map(share => share.agentDeviceId));
        for (const share of previous) {
          if (present.has(share.agentDeviceId)) continue;
          if (retainMissing(deviceId, share)) next.push(share);
        }
      } else {
        // A complete list is authoritative: missing shares are removed now.
        clearDeviceRetention(deviceId);
      }
      const merged = mergeProviderShareCatalogs(previous, next);
      const kept = new Set(merged.map(share => expiryKey(deviceId, share.shareId)));
      for (const [key, row] of retention) if (row.deviceId === deviceId && !kept.has(key)) clearRetention(key);
      for (const key of [...observedAt.keys()]) {
        if (JSON.parse(key)[0] === deviceId && !kept.has(key)) observedAt.delete(key);
      }
      for (const key of [...payloadDeadlines.keys()]) {
        if (JSON.parse(key)[0] === deviceId && !kept.has(key)) payloadDeadlines.delete(key);
      }
      const deviceExpiryKeys = expiryKeys.get(deviceId);
      if (deviceExpiryKeys) {
        for (const key of [...deviceExpiryKeys]) {
          if (kept.has(key)) continue;
          expiry.forget(key);
          deviceExpiryKeys.delete(key);
        }
      }
      cache.set(deviceId, merged);
      notifyCatalogs(deviceId, merged);
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
  clearDeviceRetention(deviceId);
  pendingNotifications.delete(deviceId);
  for (const key of [...observedAt.keys()]) if (JSON.parse(key)[0] === deviceId) observedAt.delete(key);
  for (const key of [...payloadDeadlines.keys()]) if (JSON.parse(key)[0] === deviceId) payloadDeadlines.delete(key);
  for (const key of expiryKeys.get(deviceId) ?? []) expiry.forget(key);
  expiryKeys.delete(deviceId);
  completeness.delete(deviceId);
  cache.delete(deviceId);
  inflight.delete(deviceId);
  generations.set(deviceId, generationOf(deviceId) + 1);
  // The cache and its expiry timers are gone; any mounted picker must stop
  // showing rows immediately instead of retaining an unbounded stale list.
  for (const listener of listeners.get(deviceId) ?? []) listener([]);
}

/** 登出 / 切号时清空全部,防止下一个账号看到上一个账号收到的分享。 */
export function clearAllProviderShareCatalogs(): void {
  const ids = new Set([...cache.keys(), ...inflight.keys(), ...generations.keys()]);
  cache.clear();
  completeness.clear();
  clearAllRetention();
  observedAt.clear();
  pendingNotifications.clear();
  payloadDeadlines.clear();
  expiry.clear(); expiryKeys.clear();
  inflight.clear();
  for (const id of ids) generations.set(id, generationOf(id) + 1);
}
