import { supportsSubscriptionCreditsPolicy, type ProviderView } from '@cindy/model-providers';
import { peekCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { getActiveCatalog } from './active-catalog.js';
import { providerCreditsPolicy } from './provider-credits-policy-store.js';

interface UsageWindowLike {
  usedPercent?: number;
  resetsAt?: number | null;
  windowMinutes?: number | null;
}

interface CreditsUsageSnapshotLike {
  credits?: { hasCredits?: boolean; unlimited?: boolean } | null;
  primary?: UsageWindowLike | null;
  secondary?: UsageWindowLike | null;
  appServerBuckets?: Record<string, CreditsUsageSnapshotLike> | null;
  webSnapshot?: CreditsUsageSnapshotLike | null;
}

function weeklyWindow(snapshot: CreditsUsageSnapshotLike): UsageWindowLike | null {
  if (snapshot.secondary) return snapshot.secondary;
  return snapshot.primary?.windowMinutes === 10_080 ? snapshot.primary : null;
}

function windowExhausted(window: UsageWindowLike | null | undefined, nowMs: number): boolean {
  if (!window || typeof window.usedPercent !== 'number' || window.usedPercent < 99.95) return false;
  return !window.resetsAt || window.resetsAt * 1000 > nowMs;
}

function hasAvailableCredits(snapshot: CreditsUsageSnapshotLike): boolean {
  return snapshot.credits?.unlimited === true || snapshot.credits?.hasCredits === true;
}

/**
 * A request may only be blocked when the account has something to spend and the included
 * window is actually exhausted. Unknown snapshots stay fail-open; the upstream still enforces
 * its own quota.
 */
export function creditsPolicyBlocksRequest(
  provider: Pick<ProviderView, 'id' | 'auth'> | null | undefined,
  autoUseCredits: boolean,
  payload: CreditsUsageSnapshotLike | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!supportsSubscriptionCreditsPolicy(provider) || autoUseCredits || !payload) return false;
  const snapshots = [
    payload,
    ...Object.values(payload.appServerBuckets ?? {}),
    payload.webSnapshot,
  ].filter((snapshot): snapshot is CreditsUsageSnapshotLike => Boolean(snapshot));
  if (!snapshots.some(hasAvailableCredits)) return false;
  return snapshots.some((snapshot) => windowExhausted(weeklyWindow(snapshot), nowMs));
}

/** Request-time check used by the local Codex proxy. */
export function subscriptionCreditsRequestBlocked(providerId: string, nowMs = Date.now()): boolean {
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  return creditsPolicyBlocksRequest(
    provider,
    providerCreditsPolicy.autoUses(providerId),
    peekCodexAccountUsageSnapshot(providerId),
    nowMs,
  );
}

/** Effective presentation only: never mutate the stored provider definition. */
export function projectSubscriptionCreditsPolicy(provider: ProviderView): ProviderView {
  if (!supportsSubscriptionCreditsPolicy(provider)) return provider;
  return {
    ...provider,
    subscriptionCreditsPolicy: { autoUseCredits: providerCreditsPolicy.autoUses(provider.id) },
  };
}
