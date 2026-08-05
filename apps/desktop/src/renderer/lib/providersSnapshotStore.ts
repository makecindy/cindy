/**
 * Renderer 本地 provider 快照存储。
 *
 * 状态与 React hook 分离，供 localCatalogSnapshot 原子提交 providers 与两份
 * agent capabilities；这样 useProviders.refetch 可以复用联合刷新而不形成循环依赖。
 */
import type { ProviderView } from '@cindy/model-providers';

let cachedProviders: ProviderView[] | null = null;
let providersGeneration = 0;
const providerListeners = new Set<(providers: ProviderView[]) => void>();

/** 返回最近一次完整 provider 快照；尚未成功加载时为 null。 */
export function getCachedProvidersSnapshot(): ProviderView[] | null {
  return cachedProviders;
}

/** 订阅完整 provider 快照提交。 */
export function subscribeProvidersSnapshot(
  listener: (providers: ProviderView[]) => void,
): () => void {
  providerListeners.add(listener);
  return () => providerListeners.delete(listener);
}

/** 为一次 provider 快照读取分配代际；更早请求完成后不得再覆盖缓存。 */
export function beginProvidersRefresh(): number {
  providersGeneration += 1;
  return providersGeneration;
}

/** 读取 provider 快照。失败向上抛，由联合刷新保留上一份有效缓存。 */
export async function loadProvidersSnapshot(): Promise<ProviderView[]> {
  const result = await window.electronAPI.maker.listProviders();
  return result.providers;
}

export function isProvidersRefreshCurrent(generation: number): boolean {
  return providersGeneration === generation;
}

/** 仅提交当前代际的完整快照，并一次通知所有 mounted hooks。 */
export function commitProvidersSnapshot(
  generation: number,
  next: ProviderView[],
): boolean {
  if (!isProvidersRefreshCurrent(generation)) return false;
  cachedProviders = next;
  for (const listener of providerListeners) listener(next);
  return true;
}
