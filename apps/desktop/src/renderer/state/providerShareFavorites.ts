import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { ControlledModelFavoriteSource } from '../../shared/controlledModelCatalog';
import type { ProviderShareReceived } from '@cindy/device-link';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushStampCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { ProviderShareReceivedSnapshot } from '../../shared/providerShare';
import {
  accessHostModelFavorites,
  LOCAL_FAVORITE_PROVIDER_ID_MAX_LENGTH,
  type ModelFavoriteConfig,
  type ModelFavoriteItem,
} from './modelFavorites';
import type { FavoriteStore } from './useRemoteModelFavorites';

const PREFIX = 'provider-share-favorite:';
type Source = { shareId: string; memberId: string; providerId: string; region: ProviderShareReceived['owner']['region'] };

/**
 * 复用受邀者账号的收藏存储；远程同步保留既有长度约束。providerId 是带分享/成员身份的存储键，
 * 按对应分享的目录投影为真实 providerId（包括聚合收藏视图），绝不把存储键用于模型请求。
 * 老客户端不认识这个来源时不会把它误认成本机同名供应商。
 */
export function providerShareFavoriteSource(source: ControlledModelFavoriteSource): string {
  const key = PREFIX + JSON.stringify([source.shareId, source.memberId, source.providerId, source.owner.region]);
  if (!source.shareId || !source.memberId || !source.providerId || key.length > LOCAL_FAVORITE_PROVIDER_ID_MAX_LENGTH)
    throw new Error('Invalid shared favorite source');
  return key;
}

export function parseProviderShareFavoriteSource(value: string): Source | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const parts: unknown = JSON.parse(value.slice(PREFIX.length));
    if (!Array.isArray(parts) || parts.length !== 4 || !parts.every((part) => typeof part === 'string' && part.length > 0) ||
        (parts[3] !== 'cn' && parts[3] !== 'global'))
      return null;
    return { shareId: parts[0], memberId: parts[1], providerId: parts[2], region: parts[3] };
  } catch {
    return null;
  }
}

let snapshot: { membership: ProviderShareReceivedSnapshot | null; cleanupFailed: boolean } = {
  membership: null, cleanupFailed: false,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => snapshot;

export function providerShareFavoriteRegionsOf(items: readonly Pick<ModelFavoriteItem, 'providerId'>[]): Source['region'][] {
  return [...new Set(items.flatMap((item) => {
    const source = parseProviderShareFavoriteSource(item.providerId);
    return source ? [source.region] : [];
  }))];
}

/** 原收藏就是未完成清理的持久线索，不依赖另写一份可能同样失败的清理队列。 */
export function getProviderShareFavoriteRegions(ownerId: string | null): Source['region'][] {
  return providerShareFavoriteRegionsOf(accessHostModelFavorites(ownerId));
}

/** 可用来源立即发布；仅清理 Main 已确认完整名单的区域，未知区域的收藏保留。 */
export function reconcileProviderShareFavorites(next: ProviderShareReceivedSnapshot): boolean {
  if (!next || !isDataOwnerPushStampCurrent(next.ownerStamp)) return false;
  let cleanupFailed = false;
  try {
    const items = accessHostModelFavorites(next.ownerStamp.dataOwnerId);
    const sources = new Set(next.received.map(providerShareFavoriteSource));
    for (const item of items) {
      const source = parseProviderShareFavoriteSource(item.providerId);
      if (!source || !next.confirmedRegions.includes(source.region) || sources.has(item.providerId)) continue;
      accessHostModelFavorites(next.ownerStamp.dataOwnerId, { kind: 'remove', expected: item });
    }
  } catch {
    cleanupFailed = true;
  }
  snapshot = { membership: next, cleanupFailed };
  for (const listener of listeners) listener();
  return !cleanupFailed;
}

export function useProviderShareFavoriteCleanupFailed(): boolean {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return !!state.membership && isDataOwnerPushStampCurrent(state.membership.ownerStamp) && state.cleanupFailed;
}

/** 聚合收藏只解析当前账号仍可用的原授权；同名供应商或重新申请的分享不能接管旧副本。 */
export function useProviderShareFavoriteSources(routed?: ReadonlyMap<string, ControlledModelFavoriteSource>): ReadonlyMap<string, string> {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const current = state.membership && isDataOwnerPushStampCurrent(state.membership.ownerStamp)
    ? state.membership : null;
  return useMemo(() => routed ? new Map([...routed].map(([deviceId, share]) => [providerShareFavoriteSource(share), deviceId])) : new Map(
    (current?.received ?? [])
      .filter((share) => share.status === 'active' && share.hostOnline && share.hostCapable)
      .map((share) => [providerShareFavoriteSource(share), `share:${share.shareId}`]),
  ), [current, routed]);
}

export function useProviderShareFavorites(
  deviceId: string | undefined,
  localItems: readonly ModelFavoriteItem[],
  home?: { items: readonly ModelFavoriteItem[]; store: FavoriteStore },
  routed?: ReadonlyMap<string, ControlledModelFavoriteSource>,
): { items: readonly ModelFavoriteItem[]; store: FavoriteStore } {
  const stored = home?.items ?? localItems;
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const owner = getDataOwnerGeneration();
  const membership = state.membership && isDataOwnerPushStampCurrent(state.membership.ownerStamp)
    ? state.membership : null;
  const routedRef = useRef(routed);
  routedRef.current = routed;
  const share = routed ? routed.get(deviceId ?? '') : membership?.received.find((item) => `share:${item.shareId}` === deviceId);
  const source = share ? providerShareFavoriteSource(share) : null;
  const project = (item: ModelFavoriteItem): ModelFavoriteItem => ({ ...item, providerId: share!.providerId });
  const assertCurrent = () => {
    if (routed) {
      const current = routedRef.current?.get(deviceId ?? '');
      if (!home || !source || !current || !isDataOwnerGenerationCurrent(owner)
        || providerShareFavoriteSource(current) !== source) throw new Error('Shared favorite source unavailable');
      return;
    }
    const current = snapshot.membership;
    if (!source || !share || !current || !isDataOwnerGenerationCurrent(owner) || !isDataOwnerPushStampCurrent(current.ownerStamp) ||
        current.ownerStamp.dataOwnerId !== owner.dataOwnerId ||
        !current.received.some((item) => providerShareFavoriteSource(item) === source))
      throw new Error('Shared favorite source unavailable');
  };
  const expected = (uid: string) => {
    assertCurrent();
    const item = home
      ? home.store.get(uid)
      : accessHostModelFavorites(owner.dataOwnerId).find((item) => item.uid === uid);
    if (!item || item.providerId !== source) throw new Error('Shared favorite unavailable');
    return item;
  };
  const store: FavoriteStore = {
    get: (uid) => {
      const item = stored.find((item) => item.uid === uid && item.providerId === source);
      return item ? project(item) : undefined;
    },
    add: (config: ModelFavoriteConfig) => {
      assertCurrent();
      if (config.providerId !== share!.providerId) throw new Error('Shared provider changed');
      if (home) return home.store.add({ ...config, providerId: source! });
      accessHostModelFavorites(owner.dataOwnerId, { kind: 'add', item: { ...config, providerId: source! } });
    },
    update: (uid, patch) => {
      const before = expected(uid);
      if (home) return home.store.update(uid, patch);
      const item = { ...before, ...patch };
      accessHostModelFavorites(owner.dataOwnerId, {
        kind: 'update', expected: before,
        item: { ...item, effort: item.effort ?? undefined, fast: item.fast ? true : undefined },
      });
    },
    remove: (uid) => {
      const before = expected(uid);
      if (home) return home.store.remove(uid);
      accessHostModelFavorites(owner.dataOwnerId, { kind: 'remove', expected: before });
    },
  };
  const items = useMemo(() => source && share
    ? stored.filter((item) => item.providerId === source).map((item) => ({ ...item, providerId: share.providerId }))
    : [], [stored, source, share?.providerId]);
  return { items, store };
}
