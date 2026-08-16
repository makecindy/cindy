export interface BotCompactRuntimeSession {
  readonly id: string;
  readonly instanceId: string;
  isTurnRunning(): boolean;
  listBackgroundTasks(): ReadonlyArray<unknown>;
}

export interface BotCompactBoundary {
  readonly sessionId: string;
  readonly sessionInstanceId: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly boundaryCount: number;
}

export type BotCompactRuntimeRefreshOutcome = 'refreshed' | 'not-bot' | 'deferred';

export interface BotCompactRuntimeRefreshDeps {
  hasPendingInteraction(sessionId: string): boolean;
  refresh(
    session: BotCompactRuntimeSession,
    boundary: BotCompactBoundary,
  ): Promise<BotCompactRuntimeRefreshOutcome>;
  now?: () => number;
  onError?: (sessionId: string, error: unknown) => void;
}

/**
 * Preserve the live runtime when a frozen Bot resource changed. The preflight
 * must finish before close, and ownership is checked again immediately before
 * the destructive half of the swap.
 */
export async function replaceBotRuntimeAfterPreflight<T>(deps: {
  preflight(): Promise<void>;
  isCurrentOwner(): boolean;
  close(): Promise<void>;
  bootstrap(): Promise<T>;
}): Promise<T> {
  await deps.preflight();
  if (!deps.isCurrentOwner()) {
    throw new Error('Bot runtime owner changed before compact refresh');
  }
  await deps.close();
  return deps.bootstrap();
}

/**
 * A provider can emit compact_boundary in the middle of one product turn.  The
 * Bot Profile runtime must therefore be rebuilt only after the final product
 * boundary, never directly from the compact event.  This coordinator owns the
 * small instance-scoped state machine; the host callback owns close/bootstrap.
 */
export function createBotCompactRuntimeRefreshCoordinator(
  deps: BotCompactRuntimeRefreshDeps,
) {
  const now = deps.now ?? Date.now;
  const pending = new Map<
    string,
    { session: BotCompactRuntimeSession; boundary: BotCompactBoundary }
  >();
  const inFlight = new Map<string, Promise<BotCompactRuntimeRefreshOutcome>>();

  function noteBoundary(session: BotCompactRuntimeSession): BotCompactBoundary {
    const at = now();
    const existing = pending.get(session.id);
    const sameInstance = existing?.session === session
      && existing.boundary.sessionInstanceId === session.instanceId;
    const boundary: BotCompactBoundary = {
      sessionId: session.id,
      sessionInstanceId: session.instanceId,
      firstObservedAt: sameInstance ? existing.boundary.firstObservedAt : at,
      lastObservedAt: at,
      boundaryCount: sameInstance ? existing.boundary.boundaryCount + 1 : 1,
    };
    pending.set(session.id, { session, boundary });
    return boundary;
  }

  async function attempt(
    session: BotCompactRuntimeSession,
  ): Promise<BotCompactRuntimeRefreshOutcome> {
    const entry = pending.get(session.id);
    if (!entry || entry.session !== session || entry.boundary.sessionInstanceId !== session.instanceId) {
      return 'not-bot';
    }
    if (
      session.isTurnRunning()
      || session.listBackgroundTasks().length > 0
      || deps.hasPendingInteraction(session.id)
    ) {
      return 'deferred';
    }
    const existing = inFlight.get(session.id);
    if (existing) return existing;

    const operation = deps.refresh(session, entry.boundary)
      .then((outcome) => {
        if (
          outcome !== 'deferred'
          && pending.get(session.id)?.session === session
          && pending.get(session.id)?.boundary.sessionInstanceId === session.instanceId
        ) {
          pending.delete(session.id);
        }
        return outcome;
      })
      .catch((error) => {
        deps.onError?.(session.id, error);
        return 'deferred' as const;
      })
      .finally(() => {
        if (inFlight.get(session.id) === operation) inFlight.delete(session.id);
      });
    inFlight.set(session.id, operation);
    return operation;
  }

  function clearForClosedSession(session: BotCompactRuntimeSession): void {
    if (pending.get(session.id)?.session === session) pending.delete(session.id);
  }

  function resetForTest(): void {
    pending.clear();
    inFlight.clear();
  }

  return {
    noteBoundary,
    attempt,
    clearForClosedSession,
    hasPending: (sessionId: string) => pending.has(sessionId),
    resetForTest,
  };
}

export type BotCompactRuntimeRefreshCoordinator = ReturnType<
  typeof createBotCompactRuntimeRefreshCoordinator
>;
