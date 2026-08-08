export interface OrcaDisableWorkerRuntimeSession {
  isTurnRunning(): boolean;
  abort(): Promise<void>;
}

export interface OrcaDisableWorkerRuntimeDeps {
  getSession(sessionId: string): OrcaDisableWorkerRuntimeSession | undefined;
  closeSession(sessionId: string): Promise<void>;
  beforeClose(): void;
  afterClose(): void;
  timeoutMs?: number;
  log: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

const disabledOrcaWorkerSessionFenceCounts = new Map<string, number>();

/**
 * Fence sends before a team shutdown starts. The returned rollback only removes
 * this caller's claim, so overlapping shutdown attempts cannot unfence each
 * other. Successful shutdowns deliberately retain their claim for the rest of
 * the process lifetime.
 */
export function fenceOrcaWorkerSessionsForDisable(
  sessionIds: readonly string[],
): () => void {
  const uniqueSessionIds = [...new Set(sessionIds)];
  for (const sessionId of uniqueSessionIds) {
    disabledOrcaWorkerSessionFenceCounts.set(
      sessionId,
      (disabledOrcaWorkerSessionFenceCounts.get(sessionId) ?? 0) + 1,
    );
  }

  let rolledBack = false;
  return () => {
    if (rolledBack) return;
    rolledBack = true;
    for (const sessionId of uniqueSessionIds) {
      const nextCount = (disabledOrcaWorkerSessionFenceCounts.get(sessionId) ?? 0) - 1;
      if (nextCount > 0) {
        disabledOrcaWorkerSessionFenceCounts.set(sessionId, nextCount);
      } else {
        disabledOrcaWorkerSessionFenceCounts.delete(sessionId);
      }
    }
  };
}

export function isOrcaWorkerSessionDisableFenced(sessionId: string): boolean {
  return (disabledOrcaWorkerSessionFenceCounts.get(sessionId) ?? 0) > 0;
}

/**
 * Keep shutdown fences after the team end is durable; roll back only this
 * attempt when lock acquisition or the durable team-end write fails first.
 */
export async function withOrcaWorkerDisableFence<T>(
  sessionIds: readonly string[],
  task: (markTeamEndDurable: () => void) => Promise<T>,
): Promise<T> {
  const rollbackFence = fenceOrcaWorkerSessionsForDisable(sessionIds);
  let teamEndIsDurable = false;
  try {
    return await task(() => {
      teamEndIsDurable = true;
    });
  } finally {
    if (!teamEndIsDurable) rollbackFence();
  }
}

async function waitForRuntimeOperation(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<{ kind: 'done' } | { kind: 'error'; error: unknown } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => ({ kind: 'done' as const }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Acquire every Worker route lock in stable order and keep them until the team
 * transition is durable. Stable ordering prevents two overlapping transitions
 * from deadlocking each other.
 */
export async function withOrcaWorkerSessionLocks<T>(
  withSessionLock: <R>(sessionId: string, task: () => Promise<R>) => Promise<R>,
  sessionIds: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const orderedSessionIds = [...new Set(sessionIds)].sort();
  const acquireAt = (index: number): Promise<T> => {
    const sessionId = orderedSessionIds[index];
    if (sessionId === undefined) return task();
    return withSessionLock(sessionId, () => acquireAt(index + 1));
  };
  return acquireAt(0);
}

/**
 * Close one Worker while its route lock is already held. The live Session is
 * deliberately read here, after lock acquisition: a rehydrate that won the
 * lock first may have replaced the runtime while disableOrca was waiting.
 */
export async function closeOrcaWorkerRuntimeWhileLocked(
  deps: OrcaDisableWorkerRuntimeDeps,
  sessionId: string,
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  deps.beforeClose();
  const session = deps.getSession(sessionId);
  if (session) {
    let shouldAbort = false;
    try {
      shouldAbort = session.isTurnRunning();
    } catch (error) {
      deps.log.warn('disableOrca: running-state probe failed (continuing to close)', {
        sessionId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
    if (shouldAbort) {
      const abortResult = await waitForRuntimeOperation(session.abort(), timeoutMs);
      if (abortResult.kind !== 'done') {
        deps.log.warn(
          abortResult.kind === 'timeout'
            ? 'disableOrca: abort timed out (continuing to close)'
            : 'disableOrca: abort failed (continuing to close)',
          {
            sessionId,
            ...(abortResult.kind === 'error'
              ? { err: abortResult.error instanceof Error
                  ? abortResult.error.message
                  : String(abortResult.error) }
              : { timeoutMs }),
          },
        );
      }
    }

    const closeResult = await waitForRuntimeOperation(deps.closeSession(sessionId), timeoutMs);
    if (closeResult.kind !== 'done') {
      deps.log.warn(
        closeResult.kind === 'timeout'
          ? 'disableOrca: closeSession timed out; runtime remains fenced'
          : 'disableOrca: closeSession failed',
        {
          sessionId,
          ...(closeResult.kind === 'error'
            ? { err: closeResult.error instanceof Error
                ? closeResult.error.message
                : String(closeResult.error) }
            : { timeoutMs }),
        },
      );
    }
  }
  deps.afterClose();
}
