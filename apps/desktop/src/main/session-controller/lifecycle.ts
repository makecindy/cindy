import type { SessionExecutionIdentity } from '@cindy/maker-shared/session-controller';
import { handleCloseSessionRequest } from '../maker-ipc/closeSessionRequest.js';
import { isSameSessionExecution } from '../maker-ipc/sessionExecutionOwnership.js';
import { SessionAdmissionError } from './controller.js';
import { assertSessionOperationCurrent, revalidateSessionOperation } from './operationContext.js';

export interface SessionLifecycleRuntime {
  instanceId: string;
  getTurnGeneration(): number;
  abort(): Promise<void>;
}

export interface SessionLifecycleRequest {
  sessionId: string;
  expectedExecution?: SessionExecutionIdentity | null;
}

export interface SessionLifecycleDeps<Runtime extends SessionLifecycleRuntime, Boundary> {
  current(id: string): Runtime | null;
  stable(id: string): Runtime | null;
  markManualInterrupt(id: string): void;
  cancelRecovery(id: string): void;
  pauseGoal(id: string): Promise<void>;
  markStopped(runtime: Runtime): void;
  beginAbort(id: string, runtime: Runtime): Boundary;
  reconcileAbort(id: string, boundary: Boundary): void;
  cleanupInteractions(id: string, reason: 'session_aborted' | 'session_closed'): void;
  reportSecondaryError(id: string, error: unknown): void;
  withLock<T>(id: string, run: () => Promise<T>): Promise<T>;
  close(id: string): Promise<void>;
  withPreservedWorkspace<T>(id: string, run: () => Promise<T>): Promise<T>;
}

/** Explicit stop semantics shared by UI and authorized host clients, not Session.abort alone. */
export function createSessionLifecycle<Runtime extends SessionLifecycleRuntime, Boundary>(
  deps: SessionLifecycleDeps<Runtime, Boundary>,
) {
  function matches(id: string, expected: SessionExecutionIdentity | null | undefined): boolean {
    const live = deps.current(id);
    return expected !== undefined && (live === null ? expected === null
      : isSameSessionExecution({ instanceId: live.instanceId, generation: live.getTurnGeneration() }, expected));
  }
  function assertExpected(request: SessionLifecycleRequest): void {
    assertSessionOperationCurrent();
    if (!matches(request.sessionId, request.expectedExecution)) {
      throw new SessionAdmissionError('CONFLICT', 'Session execution changed before control was applied');
    }
  }

  async function abortSession(request: SessionLifecycleRequest): Promise<void> {
    const { sessionId } = request;
    assertExpected(request);
    // Revoke continuations synchronously before the first storage/vendor await.
    deps.markManualInterrupt(sessionId);
    deps.cancelRecovery(sessionId);
    const goalPause = deps.pauseGoal(sessionId);
    const runtime = deps.stable(sessionId);
    if (!runtime) { await goalPause; return; }
    deps.markStopped(runtime);
    const boundary = deps.beginAbort(sessionId, runtime);
    // Observe storage rejection immediately while a slow vendor abort is pending.
    const paused = goalPause.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    let abortFailed = false;
    let abortError: unknown;
    try { await runtime.abort(); }
    catch (error) { abortFailed = true; abortError = error; }
    finally {
      try { deps.reconcileAbort(sessionId, boundary); }
      finally {
        if (matches(sessionId, request.expectedExecution)) deps.cleanupInteractions(sessionId, 'session_aborted');
      }
    }
    const settledPause = await paused;
    if (abortFailed) {
      if (!settledPause.ok) deps.reportSecondaryError(sessionId, settledPause.error);
      throw abortError;
    }
    if (!settledPause.ok) throw settledPause.error;
  }

  async function closeSession(request: SessionLifecycleRequest & { preserveWorkspace?: boolean }): Promise<void> {
    const { sessionId } = request;
    await deps.withLock(sessionId, async () => {
      await revalidateSessionOperation();
      assertExpected(request);
      await handleCloseSessionRequest({
        closeSession: deps.close,
        withRehydrateCloseSuppressed: deps.withPreservedWorkspace,
        cleanupPendingInteractions: id => {
          if (!deps.current(id) || matches(id, request.expectedExecution)) deps.cleanupInteractions(id, 'session_closed');
        },
      }, sessionId, request);
    });
  }
  return { abortSession, closeSession };
}
