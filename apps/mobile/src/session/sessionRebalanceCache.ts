/** Rebuildable proposal cache, shared by sending and the session-push receiver. No native UI dependencies. */
export interface MobileRebalanceSuggestion {
  kind: 'ask' | 'auto';
  memberKey: string;
  label: string;
  quota: { usedPercent: number; resetAtMs: number | null; windowMs: number };
}

export const prefetchedRebalances = new Map<string, { at: number; suggestion: MobileRebalanceSuggestion | null }>();
export const inFlightRebalances = new Map<string, { invalidated: boolean }>();

export function rebalanceCacheKey(hostDeviceId: string, sessionId: string): string {
  return `${hostDeviceId}\u0000${sessionId}`;
}

/** Retire cached and in-flight proposals when another controller changes the task preference. */
export function applyMobileSessionRebalancePreferencePatch(hostDeviceId: string, sessionId: string, patch: Record<string, unknown>): void {
  if (typeof patch.providerGroupRebalanceEnabled !== 'boolean') return;
  const key = rebalanceCacheKey(hostDeviceId, sessionId);
  prefetchedRebalances.delete(key);
  const pending = inFlightRebalances.get(key);
  if (pending) pending.invalidated = true;
}
