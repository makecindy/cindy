/**
 * Renderer 本地 provider 快照存储。
 *
 * 状态与 React hook 分离，供 localCatalogSnapshot 原子提交 providers 与两份
 * agent capabilities；这样 useProviders.refetch 可以复用联合刷新而不形成循环依赖。
 */
import type { ProviderView } from '@cindy/model-providers';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

interface ProvidersRefreshToken {
  generation: number;
  owner: DataOwnerGeneration;
}

export interface ProvidersSnapshot {
  dataOwnerId: string | null;
  /** Main app-session generation that leases owner-scoped provider writes. */
  ownerGeneration: number;
  providers: ProviderView[];
  providerOrder: string[];
}

let cachedProviders: ProvidersSnapshot | null = null;
let providersGeneration = 0;
const providerListeners = new Set<(snapshot: ProvidersSnapshot | null) => void>();

/** 返回当前 data owner 最近一次完整 provider 快照；未加载或归属不符时为 null。 */
export function getCachedProvidersSnapshot(): ProvidersSnapshot | null {
  const { dataOwnerId } = getDataOwnerGeneration();
  return cachedProviders?.dataOwnerId === dataOwnerId ? cachedProviders : null;
}

/** 订阅完整 provider 快照提交。 */
export function subscribeProvidersSnapshot(
  listener: (snapshot: ProvidersSnapshot | null) => void,
): () => void {
  providerListeners.add(listener);
  return () => providerListeners.delete(listener);
}

/** Owner 切换时同步清空旧快照，并通知已挂载的消费者立即隐藏旧 owner 数据。 */
export function invalidateProvidersSnapshot(): void {
  cachedProviders = null;
  providersGeneration += 1;
  for (const listener of providerListeners) listener(null);
}

/** 为一次 provider 快照读取分配代际；更早请求完成后不得再覆盖缓存。 */
export function beginProvidersRefresh(): ProvidersRefreshToken {
  providersGeneration += 1;
  return {
    generation: providersGeneration,
    owner: getDataOwnerGeneration(),
  };
}

/** 读取 provider 快照。失败向上抛，由联合刷新保留上一份有效缓存。 */
export async function loadProvidersSnapshot(): Promise<ProvidersSnapshot> {
  const result = await window.electronAPI.maker.listProviders();
  return {
    dataOwnerId: result.dataOwnerId,
    ownerGeneration: result.ownerGeneration,
    providers: result.providers,
    providerOrder: result.providerOrder,
  };
}

export function isProvidersRefreshCurrent(
  token: ProvidersRefreshToken,
  snapshot?: ProvidersSnapshot,
): boolean {
  return (
    providersGeneration === token.generation
    && isDataOwnerGenerationCurrent(token.owner)
    && (snapshot === undefined || snapshot.dataOwnerId === token.owner.dataOwnerId)
  );
}

/** 仅提交当前代际的完整快照，并一次通知所有 mounted hooks。 */
export function commitProvidersSnapshot(
  token: ProvidersRefreshToken,
  next: ProvidersSnapshot,
): boolean {
  if (!isProvidersRefreshCurrent(token, next)) return false;
  cachedProviders = next;
  for (const listener of providerListeners) listener(next);
  return true;
}

export const __testing = {
  reset(): void {
    cachedProviders = null;
    providersGeneration = 0;
  },
};
