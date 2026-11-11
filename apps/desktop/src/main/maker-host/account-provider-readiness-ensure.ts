import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { accountProviderReadinessArm } from './account-provider-readiness-arm.js';
import {
  accountProviderReadinessBarrier,
  isSameOwnerScopeKey,
  type AccountProviderReadinessBarrier,
} from './account-provider-readiness-barrier.js';

export interface EnsureAccountProviderReadinessDeps {
  barrier: AccountProviderReadinessBarrier;
  startIfOwnerMatches(ownerId: string | null): boolean;
  resumeIncompleteDiscovery?(ownerId: string | null): Promise<boolean>;
  getScopeKey(): string;
  getOwnerId(): string | null;
  isBoundaryPending(): boolean;
  onReady?(ownerId: string): void;
}

let readyHandler: ((ownerId: string) => void) | undefined;

export function setAccountProviderReadinessReadyHandler(
  handler: ((ownerId: string) => void) | undefined,
): void {
  readyHandler = handler;
}

const defaultDeps: EnsureAccountProviderReadinessDeps = {
  barrier: accountProviderReadinessBarrier,
  startIfOwnerMatches: (ownerId) => accountProviderReadinessArm.startIfOwnerMatches(ownerId),
  resumeIncompleteDiscovery: (ownerId) =>
    accountProviderReadinessArm.resumeIncompleteIfOwnerMatches(ownerId),
  getScopeKey: activeOwnerScopeKey,
  getOwnerId: () => getActiveAppSession().dataOwnerId,
  isBoundaryPending: isAppSessionBoundaryPending,
};

/**
 * Adopt a completed same-owner discovery task, or start one for this owner
 * incarnation. Shared by renderer send/create and the Maker start hook.
 */
export async function ensureCurrentAccountProviderReadiness(
  deps: EnsureAccountProviderReadinessDeps = defaultDeps,
): Promise<boolean> {
  const scopeKey = deps.getScopeKey();
  const ownerId = deps.getOwnerId();
  if (!ownerId || deps.isBoundaryPending()) return false;

  let adopted = await deps.barrier.adoptSameOwnerAfterPreviousSettles(scopeKey);
  if (deps.barrier.needsIncompleteDiscoveryResume(scopeKey)) {
    await deps.resumeIncompleteDiscovery?.(ownerId);
    adopted = await deps.barrier.adoptSameOwnerAfterPreviousSettles(scopeKey);
  } else if (!adopted && !deps.barrier.hasScope(scopeKey)) {
    deps.startIfOwnerMatches(ownerId);
  }

  const ready = await deps.barrier.waitForScope(scopeKey);
  if (!ready || deps.getScopeKey() !== scopeKey || deps.isBoundaryPending()) {
    return false;
  }
  if (deps.barrier.markConsumersStarted()) {
    (deps.onReady ?? readyHandler)?.(ownerId);
  }
  return true;
}

export function shouldStartReadinessConsumers(opts: {
  capturedScopeKey: string;
  currentScopeKey: string;
  boundaryPending: boolean;
  adoptable: boolean;
}): boolean {
  return (
    opts.adoptable &&
    !opts.boundaryPending &&
    isSameOwnerScopeKey(opts.capturedScopeKey, opts.currentScopeKey)
  );
}
