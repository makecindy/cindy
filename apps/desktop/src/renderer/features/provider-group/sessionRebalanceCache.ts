import type { ProviderGroupRebalanceSuggestion } from '../../../shared/providerGroup';

/** Rebuildable proposal cache shared by sending and local/remote session-push receivers. */
export const prefetchedRebalances = new Map<string, { at: number; suggestion: ProviderGroupRebalanceSuggestion }>();
export const inFlightRebalances = new Map<string, { invalidated: boolean }>();

export function rebalanceCacheKey(sessionId: string, hostDeviceId: string | undefined): string {
  return `${hostDeviceId ?? ''}\u0000${sessionId}`;
}

/** A task-computer preference push also retires proposals cached by other controllers. */
export function applySessionRebalancePreferencePatch(sessionId: string, patch: Record<string, unknown>, hostDeviceId?: string): void {
  if (typeof patch.providerGroupRebalanceEnabled !== 'boolean') return;
  const key = rebalanceCacheKey(sessionId, hostDeviceId);
  prefetchedRebalances.delete(key);
  const pending = inFlightRebalances.get(key);
  if (pending) pending.invalidated = true;
}
