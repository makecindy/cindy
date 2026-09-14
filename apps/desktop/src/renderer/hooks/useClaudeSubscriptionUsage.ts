/** Cached-first Claude subscription quota; Main owns account identity and expiry. */
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';
import { createSubscriptionUsageCache } from './subscriptionUsageCache';
export type { ClaudeSubscriptionUsageSnapshot };

function isSnapshot(v: unknown): v is ClaudeSubscriptionUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** push payload → 下一个缓存值(纯函数, 供单测): null 清空, 快照覆盖, 异常保留。 */
export function reduceClaudeSubscriptionPush(
  current: ClaudeSubscriptionUsageSnapshot | null,
  payload: unknown,
): ClaudeSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  if (isSnapshot(payload)) return payload;
  return current;
}

export function resolvePersistedClaudeSubscriptionRead(
  persisted: unknown,
):
  | { action: 'clear' }
  | { action: 'apply'; snapshot: ClaudeSubscriptionUsageSnapshot }
  | { action: 'ignore' } {
  if (persisted === null) return { action: 'clear' };
  if (isSnapshot(persisted)) return { action: 'apply', snapshot: persisted };
  return { action: 'ignore' };
}

const caches = new Map<
  string,
  ReturnType<typeof createSubscriptionUsageCache<ClaudeSubscriptionUsageSnapshot>>
>();
function usageCache(providerId: string) {
  let cache = caches.get(providerId);
  if (!cache) {
    cache = createSubscriptionUsageCache<ClaudeSubscriptionUsageSnapshot>(() => ({
      read: window.electronAPI?.maker?.usage?.getClaudeSubscription
        ? () => window.electronAPI.maker.usage.getClaudeSubscription(providerId)
        : undefined,
      subscribe: window.electronAPI?.maker?.usage?.onClaudeSubscriptionChanged
        ? (cb) => window.electronAPI.maker.usage.onClaudeSubscriptionChanged(cb, providerId)
        : undefined,
    }));
    caches.set(providerId, cache);
  }
  return cache;
}

export function requestClaudeSubscriptionRefresh(providerId = 'anthropic'): void {
  usageCache(providerId).refresh();
}

export function useClaudeSubscriptionUsage(
  enabled: boolean,
  providerId = 'anthropic',
): ClaudeSubscriptionUsageSnapshot | null {
  return usageCache(providerId).useSnapshot(enabled);
}
