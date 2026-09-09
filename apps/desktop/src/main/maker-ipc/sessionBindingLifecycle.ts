import type { Session, SessionStatus } from '@cindy/maker-core';

type BindingSession = Pick<Session, 'id' | 'onStatusChange' | 'setInteractionListener'>;

/** Resources belong to a Session instance, even when its business id is reused. */
export interface SessionBindingRegistration<S extends BindingSession> {
  readonly session: S;
  readonly disposers: Array<() => void>;
}

export interface SessionBindingLifecycleDeps<S extends BindingSession, CloseContext> {
  log: { warn(message: string, context: Record<string, unknown>): void };
  restoreInteractionListener(session: S): void;
  beforeReplace(session: S): void;
  onBind(session: S): void;
  broadcastStatus(session: S, status: SessionStatus): void;
  captureCloseContext(session: S): CloseContext;
  cleanupClosedSession(session: S, context: CloseContext): void;
  beforeCloseTeardown(session: S): void;
  finalizeClosedSession(session: S, context: CloseContext): void;
}

/**
 * Owns Desktop's exact-instance registration and synchronous close boundary.
 * Event/turn observers are installed between beginBinding and attachStatusListener,
 * preserving their existing registration order. Their accepted asynchronous work
 * (message persistence, usage accounting) is not cancelled by this registry.
 */
export function createSessionBindingLifecycle<S extends BindingSession, CloseContext>(
  deps: SessionBindingLifecycleDeps<S, CloseContext>,
) {
  const bindings = new Map<string, SessionBindingRegistration<S>>();

  function beginBinding(session: S): SessionBindingRegistration<S> | null {
    const existing = bindings.get(session.id);
    if (existing?.session === session) {
      deps.restoreInteractionListener(session);
      return null;
    }
    if (existing) {
      deps.beforeReplace(existing.session);
      // Replacement remains fail-fast: do not install a new instance when an
      // old resource failed to detach. Close below has a different contract.
      for (const dispose of existing.disposers) dispose();
      existing.session.setInteractionListener(null);
    }
    deps.onBind(session);
    const registration: SessionBindingRegistration<S> = { session, disposers: [] };
    bindings.set(session.id, registration);
    return registration;
  }

  function attachStatusListener(registration: SessionBindingRegistration<S>): void {
    const { session } = registration;
    registration.disposers.push(
      session.onStatusChange((status) => {
        if (bindings.get(session.id)?.session !== session) return;
        try {
          deps.broadcastStatus(session, status);
        } catch (err) {
          deps.log.warn('session status broadcast failed', {
            sessionId: session.id,
            status,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (status !== 'closed') return;

        // Capture abort/recovery ownership before any cleanup removes it.
        const context = deps.captureCloseContext(session);
        try {
          deps.cleanupClosedSession(session, context);
        } catch (err) {
          deps.log.warn('session close cleanup failed; forcing idle reconciliation', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // Product cleanup is best-effort. Unregister before calling disposers
          // so a late status callback cannot enter the close boundary again.
          deps.beforeCloseTeardown(session);
          bindings.delete(session.id);
          for (const dispose of registration.disposers) {
            try {
              dispose();
            } catch (err) {
              deps.log.warn('session disposer failed during close teardown', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          try {
            session.setInteractionListener(null);
          } catch (err) {
            deps.log.warn('session interaction listener teardown failed', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          deps.finalizeClosedSession(session, context);
        }
      }),
    );
  }

  return {
    beginBinding,
    attachStatusListener,
    getSession: (sessionId: string): S | undefined => bindings.get(sessionId)?.session,
  };
}

export interface SessionCloseCleanupActions {
  cleanupInteractions(): void;
  preserveAutoResume(): void;
  resetAutoResume(): void;
  shouldPreserveInputBoundary(): boolean;
  closeInputCoordinator(options: {
    preserveInputBoundary: boolean;
    preserveAutoResumeIntent: boolean;
  }): void;
  cleanupRuntimeState(): void;
}

/** A runtime rebuild may preserve input/recovery, but never skips runtime cleanup. */
export function runSessionCloseCleanup(
  preserveAutoResumeIntent: boolean,
  actions: SessionCloseCleanupActions,
): void {
  actions.cleanupInteractions();
  if (preserveAutoResumeIntent) actions.preserveAutoResume();
  else actions.resetAutoResume();
  actions.closeInputCoordinator({
    preserveInputBoundary: actions.shouldPreserveInputBoundary(),
    preserveAutoResumeIntent,
  });
  actions.cleanupRuntimeState();
}

/** Only the captured direct-abort owner can wake a Goal after close proves idle. */
export function finalizeSessionClose(
  settlesDirectAbort: boolean,
  actions: {
    clearTurnState(): void;
    notifyGoalIdle(): void;
    cancelGoalResume(): void;
  },
): void {
  actions.clearTurnState();
  if (settlesDirectAbort) actions.notifyGoalIdle();
  else actions.cancelGoalResume();
}
