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

let cachedProviders: { dataOwnerId: string | null; providers: ProviderView[] } | null = null;
let providersGeneration = 0;
const providerListeners = new Set<(providers: ProviderView[]) => void>();

/** 返回当前 data owner 最近一次完整 provider 快照；未加载或归属不符时为 null。 */
export function getCachedProvidersSnapshot(): ProviderView[] | null {
  const { dataOwnerId } = getDataOwnerGeneration();
  return cachedProviders?.dataOwnerId === dataOwnerId ? cachedProviders.providers : null;
}

/** 订阅完整 provider 快照提交。 */
export function subscribeProvidersSnapshot(
  listener: (providers: ProviderView[]) => void,
): () => void {
  providerListeners.add(listener);
  return () => providerListeners.delete(listener);
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
export async function loadProvidersSnapshot(): Promise<ProviderView[]> {
  const result = await window.electronAPI.maker.listProviders();
  return result.providers;
}

export function isProvidersRefreshCurrent(token: ProvidersRefreshToken): boolean {
  return (
    providersGeneration === token.generation
    && isDataOwnerGenerationCurrent(token.owner)
  );
}

/** 仅提交当前代际的完整快照，并一次通知所有 mounted hooks。 */
export function commitProvidersSnapshot(
  token: ProvidersRefreshToken,
  next: ProviderView[],
): boolean {
  if (!isProvidersRefreshCurrent(token)) return false;
  cachedProviders = { dataOwnerId: token.owner.dataOwnerId, providers: next };
  for (const listener of providerListeners) listener(next);
  return true;
}

export const __testing = {
  reset(): void {
    cachedProviders = null;
    providersGeneration = 0;
  },
};
