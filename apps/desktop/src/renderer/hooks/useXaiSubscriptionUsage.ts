/** Cached-first Xai subscription quota; Main owns account identity and expiry. */
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage';
import { createSubscriptionUsageCache } from './subscriptionUsageCache';
export type { XaiSubscriptionUsageSnapshot };

function isSnapshot(v: unknown): v is XaiSubscriptionUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function reduceXaiSubscriptionPush(
  current: XaiSubscriptionUsageSnapshot | null,
  payload: unknown,
): XaiSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  if (isSnapshot(payload)) return payload;
  return current;
}

export function resolvePersistedXaiSubscriptionRead(
  persisted: unknown,
):
  | { action: 'clear' }
  | { action: 'apply'; snapshot: XaiSubscriptionUsageSnapshot }
  | { action: 'ignore' } {
  if (persisted === null) return { action: 'clear' };
  if (isSnapshot(persisted)) return { action: 'apply', snapshot: persisted };
  return { action: 'ignore' };
}

/** 迟到的 IPC read 是否还能落地:期间若已经有 push,就信 push。 */
export function shouldApplyXaiSubscriptionRead(
  epochAtStart: number,
  currentEpoch: number,
): boolean {
  return epochAtStart === currentEpoch;
}

const caches = new Map<
  string,
  ReturnType<typeof createSubscriptionUsageCache<XaiSubscriptionUsageSnapshot>>
>();
function usageCache(providerId: string) {
  let cache = caches.get(providerId);
  if (!cache) {
    cache = createSubscriptionUsageCache<XaiSubscriptionUsageSnapshot>(() => ({
      read: window.electronAPI?.maker?.usage?.getXaiSubscription
        ? () => window.electronAPI.maker.usage.getXaiSubscription(providerId)
        : undefined,
      subscribe: window.electronAPI?.maker?.usage?.onXaiSubscriptionChanged
        ? (cb) => window.electronAPI.maker.usage.onXaiSubscriptionChanged(cb, providerId)
        : undefined,
    }));
    caches.set(providerId, cache);
  }
  return cache;
}

export function requestXaiSubscriptionRefresh(providerId = 'xai'): void {
  usageCache(providerId).refresh();
}

export function useXaiSubscriptionUsage(
  enabled: boolean,
  providerId = 'xai',
): XaiSubscriptionUsageSnapshot | null {
  return usageCache(providerId).useSnapshot(enabled);
}
