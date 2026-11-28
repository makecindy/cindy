import type { AgentEvent, Session } from '@cindy/maker-core';
import {
  captureProductTurnFailureOwner,
  createDeferredProductTurnFailureGate,
  createProductTurnFailureFinalizer,
  type ProductTurnFailureOwner,
} from '../../../desktop/src/main/maker-ipc/productTurnFailureOwner.js';
import { SessionListActivityTracker } from '../../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.js';

/**
 * The desktop's product-turn failure handling (register.ts) over the Host's runtime: the deferred
 * failure gate and the failure finalizer (maker-ipc/productTurnFailureOwner.ts) and the task list's
 * activity tracker (SessionListActivityTracker), one set per owner runtime.
 *
 * A terminal that an automatic resume or a context recovery holds ends the turn's activity held and
 * leaves its owner (task, runtime instance, turn generation) in the gate. When that holder finally gives
 * up, the gate settles the owner if it is still the current turn, and the finalizer commits the held
 * activity at the time the turn ended. A newer turn that started meanwhile has replaced the owner's
 * runtime or generation, so the old owner is dropped and the newer turn keeps its own activity.
 *
 * The finalizer's other two steps have no Host subsystem yet and are bound empty: plugin task
 * receipts (settlePluginTasks; the plugin batch, release table row 33) and the Cindy Make upstream
 * merge turn (interrupt; cindy-make/upstreamMergeRuntime.ts, which needs Electron and is not loaded).
 */
export function createHostProductTurn(deps: {
  /** The runtime the Host currently binds for a task (the desktop's sessionBindings.getSession). */
  getBoundSession: (sessionId: string) => Session | undefined;
  /** The task list's activity write (session-activity.ts), as register.ts's tracker writes it. */
  touchActivity?: (sessionId: string, atMs: number, skipActiveGoal: boolean) => Promise<void>;
  log: { warn(message: string): void };
}) {
  const gate = createDeferredProductTurnFailureGate();
  const listActivity = new SessionListActivityTracker((sessionId, atMs) => {
    void deps.touchActivity?.(sessionId, atMs, true);
  });

  /** register.ts isCurrentProductTurnFailureOwner, over the Host's bindings. */
  function isCurrentOwner(owner: ProductTurnFailureOwner): boolean {
    const bound = deps.getBoundSession(owner.sessionId);
    // A closed owner may still be settled by its holder. If a replacement is already bound, the old
    // identity is stale; while no replacement exists, the captured runtime and generation decide.
    if (bound && bound !== owner.session) return false;
    if (owner.session.instanceId !== owner.instanceId) return false;
    try {
      return owner.session.getTurnGeneration() === owner.generation;
    } catch {
      return false;
    }
  }

  const finalize = createProductTurnFailureFinalizer({
    gate,
    isCurrentOwner,
    commitActivity: (sessionId) => listActivity.commit(sessionId),
    settlePluginTasks: () => {},
    interrupt: async () => {},
  });

  return {
    listActivity,
    capture: (session: Session, event: AgentEvent): ProductTurnFailureOwner =>
      captureProductTurnFailureOwner(session, event, (event as AgentEvent & { agentMeta?: unknown }).agentMeta),
    /** A held terminal: its failure is settled later by its holder (the desktop's deferUnsuccessfulProductTurn). */
    defer: (owner: ProductTurnFailureOwner) => gate.defer(owner),
    /** An unheld unsuccessful terminal, or a holder's final failure (register.ts interruptProductTurn). */
    interrupt(sessionId: string, owner: ProductTurnFailureOwner): void {
      void finalize(sessionId, owner).catch(() => deps.log.warn('Could not interrupt product turn follow-up'));
    },
    /** A successful done (register.ts finishProductTurn): its owner no longer has a failure to settle. */
    finish(owner: ProductTurnFailureOwner): void {
      gate.clear(owner);
    },
    /** A holder gave up (register.ts settleDeferredProductTurnFailure). */
    settleDeferred(sessionId: string): void {
      gate.settle(sessionId, isCurrentOwner, (owner) => {
        void finalize(sessionId, owner).catch(() => deps.log.warn('Could not interrupt product turn follow-up'));
      });
    },
    /** A runtime that replaces a task's runtime takes over its held owners (register.ts onBind). */
    rebind: (sessionId: string, session: Session) => gate.rebindSession(sessionId, session),
    /** A closed runtime (sessionBindingLifecycle.ts teardown and finalizeClosedSession). */
    closed(sessionId: string, session: Session): void {
      gate.clearSession(sessionId, session);
      listActivity.deleteSession(sessionId);
    },
    /** An explicit stop (register.ts resetAutomaticRecoveryForExplicitStop). */
    stopped: (sessionId: string) => gate.clearSession(sessionId),
  };
}

export type HostProductTurn = ReturnType<typeof createHostProductTurn>;
