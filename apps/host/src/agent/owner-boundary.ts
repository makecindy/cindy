import { beginSessionTurnEndedSuppression } from '../../../desktop/src/main/localDb/sessionActiveTurn.ts';

/**
 * The first step of every owner boundary on the Host: logout, session invalidation and shutdown (an
 * account switch reuses it). From `begin()` on, a turn that ends is an interruption, as on the desktop
 * (bootstrap-electron.ts: the account boundary holds beginSessionTurnEndedSuppression, quit freezes the
 * turn markers): it keeps `activeTurnStartedAt > lastTurnEndedAt`, shows the interruption banner and is
 * listed as interrupted at the next start, instead of reading as finished or as an error.
 * - The input runtime is stopping (input-queue.mjs beginStop): no new input is accepted, and the executor
 *   writes no turn end for a turn that ends from now on (turn-executor.mjs interruptedByShutdown).
 * - The shared turn-end suppression is held as a second line, until the boundary's teardown, the owner's
 *   storage close included, has finished.
 * - Open /chat streams end with the interrupted receipt (chat.mjs), so no caller waits on a turn that
 *   is being stopped.
 * Begun before anything a running turn depends on is taken apart (requests paused, confirmations and
 * plugins closed, the server revoke at logout); otherwise a turn that fails on that teardown is written as
 * ended, with an error row.
 */
export interface OwnerBoundaryStop {
  /** Enter the stopping state; returns the release of the turn-end suppression (idempotent). */
  begin(): () => void;
  /** Called on each begin, before it returns (a /chat stream ends itself). Returns the unsubscribe. */
  onStop(listener: () => void): () => void;
}

export function createOwnerBoundaryStop(ports: { beginStop(): void }): OwnerBoundaryStop {
  const listeners = new Set<() => void>();
  return {
    begin() {
      ports.beginStop();
      const release = beginSessionTurnEndedSuppression();
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* a stream that is already closed */ }
      }
      return release;
    },
    onStop(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * One owner boundary: begin the stop, then the path's own teardown, then the owner's runtime, then (logout)
 * the stored session. Logout keeps the desktop's order (authManager.ts logout: the local boundary first,
 * `revokeLoggedOutAccountBestEffort` last): the running turns stop before the server revokes the session
 * they use. A failing step does not skip the later ones; the failures are returned for the path to report.
 */
export async function runOwnerBoundary<T = undefined>(boundary: OwnerBoundaryStop, steps: {
  /** The path's teardown before the runtime: requests paused, waits cancelled, the refresh settled. */
  beforeDispose?(): Promise<unknown> | unknown;
  dispose(): Promise<void>;
  /** Logout only: the stored session is signed out, the server revoke best effort (auth/logout.mjs). */
  afterDispose?(): Promise<T>;
}): Promise<{ result: T | undefined; errors: unknown[] }> {
  const release = boundary.begin();
  const errors: unknown[] = [];
  try {
    try { await steps.beforeDispose?.(); } catch (error) { errors.push(error); }
    try { await steps.dispose(); } catch (error) { errors.push(error); }
    let result: T | undefined;
    if (steps.afterDispose) {
      try { result = await steps.afterDispose(); } catch (error) { errors.push(error); }
    }
    return { result, errors };
  } finally {
    release();
  }
}
