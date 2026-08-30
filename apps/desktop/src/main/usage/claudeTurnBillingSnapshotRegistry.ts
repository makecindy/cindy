import type { BillingRoute } from './turnCostCalculator.js';

export interface ClaudeTurnBillingSnapshot {
  readonly providerId: string | null;
  readonly billingRoute: BillingRoute;
  readonly subscriptionSession: boolean;
}

export interface ClaudeBillingContinuationClaim {
  readonly kind: 'silent-stop';
  readonly token: string;
  readonly predecessorGeneration: number;
}

interface PendingContinuationSnapshot {
  readonly predecessorGeneration: number;
  readonly snapshot: ClaudeTurnBillingSnapshot;
}

export interface StagedClaudeTurnBillingSnapshot {
  readonly snapshot: ClaudeTurnBillingSnapshot;
  readonly inherited: boolean;
}

const UNKNOWN_BILLING_SNAPSHOT: ClaudeTurnBillingSnapshot = {
  providerId: null,
  billingRoute: 'unknown',
  subscriptionSession: false,
};

/**
 * Only a fresh provider-less local request needs its loopback route resolved at
 * usage time. A silent-stop replacement may already own the predecessor's
 * resolved default route; re-resolving that inherited snapshot from the
 * replacement generation would discard it when no new default route was used.
 */
export function shouldResolveClaudeTurnBillingSnapshotAtUsage(
  snapshot: ClaudeTurnBillingSnapshot,
  remote: boolean,
): boolean {
  return !remote && snapshot.providerId === null && snapshot.billingRoute === 'unknown';
}

/**
 * Owns generation-scoped Claude billing evidence and one-shot silent-stop handoffs.
 *
 * A claimed predecessor is copied into a token slot before any independent turn can
 * finish and clear the generation map. Only the replacement send carrying that exact
 * token and predecessor generation can consume it, once.
 */
export class ClaudeTurnBillingSnapshotRegistry {
  private readonly snapshotsBySession = new Map<string, Map<number, ClaudeTurnBillingSnapshot>>();

  private readonly continuationsBySession = new Map<
    string,
    Map<string, PendingContinuationSnapshot>
  >();

  hasSession(sessionId: string): boolean {
    return this.snapshotsBySession.has(sessionId);
  }

  read(sessionId: string, turnGeneration: number): ClaudeTurnBillingSnapshot | null {
    return this.snapshotsBySession.get(sessionId)?.get(turnGeneration) ?? null;
  }

  replace(sessionId: string, turnGeneration: number, snapshot: ClaudeTurnBillingSnapshot): boolean {
    const snapshots = this.snapshotsBySession.get(sessionId);
    if (!snapshots?.has(turnGeneration)) return false;
    snapshots.set(turnGeneration, snapshot);
    return true;
  }

  stage(
    sessionId: string,
    turnGeneration: number,
    capture: () => ClaudeTurnBillingSnapshot,
    continuation: ClaudeBillingContinuationClaim | null = null,
  ): StagedClaudeTurnBillingSnapshot {
    const continuedSnapshot = continuation
      ? this.consumeContinuation(sessionId, continuation)
      : null;
    // A malformed or already-consumed continuation must fail closed. Falling
    // back to capture() here would attribute the replacement to whichever
    // provider an independent user turn selected in the meantime.
    const snapshot = continuation ? (continuedSnapshot ?? UNKNOWN_BILLING_SNAPSHOT) : capture();
    let snapshots = this.snapshotsBySession.get(sessionId);
    if (!snapshots) {
      snapshots = new Map();
      this.snapshotsBySession.set(sessionId, snapshots);
    }
    snapshots.set(turnGeneration, snapshot);
    return { snapshot, inherited: continuedSnapshot !== null };
  }

  claimContinuation(
    sessionId: string,
    predecessorGeneration: number,
    token: string,
  ): ClaudeBillingContinuationClaim | null {
    if (!token) return null;
    const snapshot = this.read(sessionId, predecessorGeneration);
    if (!snapshot) return null;
    let continuations = this.continuationsBySession.get(sessionId);
    if (!continuations) {
      continuations = new Map();
      this.continuationsBySession.set(sessionId, continuations);
    }
    if (continuations.has(token)) return null;
    continuations.set(token, {
      predecessorGeneration,
      snapshot: { ...snapshot },
    });
    return { kind: 'silent-stop', token, predecessorGeneration };
  }

  releaseContinuation(sessionId: string, token: string): void {
    const continuations = this.continuationsBySession.get(sessionId);
    continuations?.delete(token);
    if (continuations?.size === 0) this.continuationsBySession.delete(sessionId);
  }

  rollback(sessionId: string, turnGeneration: number): void {
    const snapshots = this.snapshotsBySession.get(sessionId);
    snapshots?.delete(turnGeneration);
    if (snapshots?.size === 0) this.snapshotsBySession.delete(sessionId);
  }

  clear(sessionId: string, turnGeneration: number): void {
    const snapshots = this.snapshotsBySession.get(sessionId);
    if (!snapshots) return;
    snapshots.delete(turnGeneration);
    if (snapshots.size === 0) this.snapshotsBySession.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.snapshotsBySession.delete(sessionId);
    this.continuationsBySession.delete(sessionId);
  }

  private consumeContinuation(
    sessionId: string,
    claim: ClaudeBillingContinuationClaim,
  ): ClaudeTurnBillingSnapshot | null {
    const continuations = this.continuationsBySession.get(sessionId);
    const pending = continuations?.get(claim.token) ?? null;
    // Token ownership is one-shot even when the caller supplies a mismatched predecessor.
    continuations?.delete(claim.token);
    if (continuations?.size === 0) this.continuationsBySession.delete(sessionId);
    if (!pending || pending.predecessorGeneration !== claim.predecessorGeneration) return null;
    this.clear(sessionId, pending.predecessorGeneration);
    return { ...pending.snapshot };
  }
}
