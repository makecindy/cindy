import type { RecoveryPredecessorPlan } from '../../shared/agentInputQueue.js';

interface PendingRecoveryPlan {
  recoveryUserClientId: string;
  attemptToken: number | null;
  providerGeneration: number;
  plan: RecoveryPredecessorPlan;
}

/** Exact lifecycle boundary between an interrupted plan and its recovery turn. */
export class RecoveryPlanSettlement {
  private readonly pendingBySession = new Map<string, PendingRecoveryPlan>();
  private readonly cancelledBeforeArmBySession = new Map<string, string>();

  arm(
    sessionId: string,
    recoveryUserClientId: string,
    attemptToken: number | null,
    providerGeneration: number,
    plan: RecoveryPredecessorPlan,
  ): void {
    if (this.cancelledBeforeArmBySession.get(sessionId) === recoveryUserClientId) {
      this.cancelledBeforeArmBySession.delete(sessionId);
      return;
    }
    this.cancelledBeforeArmBySession.delete(sessionId);
    this.pendingBySession.set(sessionId, {
      recoveryUserClientId,
      attemptToken,
      providerGeneration,
      plan,
    });
  }

  async persistUserBoundary<T>(params: {
    sessionId: string;
    recoveryUserClientId: string;
    attemptToken: number | null;
    providerGeneration: number;
    plan: RecoveryPredecessorPlan;
    closePlanUpdates: () => void;
    persist: () => Promise<T>;
  }): Promise<T> {
    // Close synchronously before the durable await. A late predecessor event
    // must not enter the shared write FIFO and overtake this recovery row.
    params.closePlanUpdates();
    const persisted = await params.persist();
    this.arm(
      params.sessionId,
      params.recoveryUserClientId,
      params.attemptToken,
      params.providerGeneration,
      params.plan,
    );
    return persisted;
  }

  cancelUndispatched(sessionId: string, recoveryUserClientId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    if (pending?.recoveryUserClientId === recoveryUserClientId) {
      this.pendingBySession.delete(sessionId);
      return;
    }
    // Stop/remove may race the durable write. Remember that exact row so a
    // later onAccepted continuation cannot arm a turn that never dispatched.
    this.cancelledBeforeArmBySession.set(sessionId, recoveryUserClientId);
  }

  settleDone(
    sessionId: string,
    attemptToken: number | null,
    data: { cancelled?: unknown; raw?: { id?: unknown; status?: unknown } } | null | undefined,
    turnScope: 'foreground' | 'background' = 'foreground',
    providerGeneration?: number,
    isCurrentGeneration = true,
  ): RecoveryPredecessorPlan | null {
    const pending = this.pendingBySession.get(sessionId);
    if (
      turnScope === 'background' ||
      !isCurrentGeneration ||
      !pending ||
      pending.attemptToken !== attemptToken ||
      pending.providerGeneration !== providerGeneration
    )
      return null;
    const eventTurnId = typeof data?.raw?.id === 'string' ? data.raw.id : null;
    // A paired/late terminal from the failed predecessor may arrive after a
    // manual retry was armed. It does not own the recovery lifecycle.
    if (eventTurnId === pending.plan.turnId) return null;
    this.pendingBySession.delete(sessionId);
    return isSuccessfulRecoveryDone(data) ? pending.plan : null;
  }

  settleError(
    sessionId: string,
    attemptToken: number | null,
    eventTurnId?: string | null,
    turnScope: 'foreground' | 'background' = 'foreground',
    providerGeneration?: number,
    isCurrentGeneration = true,
  ): boolean {
    const pending = this.pendingBySession.get(sessionId);
    if (
      turnScope === 'background' ||
      !isCurrentGeneration ||
      !pending ||
      pending.attemptToken !== attemptToken ||
      pending.providerGeneration !== providerGeneration
    )
      return false;
    if (eventTurnId === pending.plan.turnId) return false;
    this.pendingBySession.delete(sessionId);
    return true;
  }

  hasPending(sessionId: string): boolean {
    return this.pendingBySession.has(sessionId);
  }

  ownsPredecessorPlan(sessionId: string, toolUseId: string): boolean {
    return this.pendingBySession.get(sessionId)?.plan.toolUseId === toolUseId;
  }

  teardown(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
    // Keep a pre-arm cancellation tombstone: Stop tears down the live session
    // before an in-flight durable write can return and attempt to arm it.
  }
}

function isSuccessfulRecoveryDone(
  data: { cancelled?: unknown; raw?: { status?: unknown } } | null | undefined,
): boolean {
  return data?.cancelled !== true && data?.raw?.status === 'completed';
}
