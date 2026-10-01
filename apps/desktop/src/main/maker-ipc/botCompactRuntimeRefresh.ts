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

/** Model switching may already bootstrap the latest Profile. Do not close that
 * fresh handle again: a native thread may not persist a rollout until its first
 * turn. An unchanged (including busy) handle still needs the safe refresh path.
 */
export async function refreshBotRuntimeAfterModelSelection<T>(deps: {
  current(): T | undefined;
  select(): Promise<void>;
  refresh(session: T): Promise<BotCompactRuntimeRefreshOutcome>;
}): Promise<BotCompactRuntimeRefreshOutcome> {
  const before = deps.current();
  await deps.select();
  const after = deps.current();
  if (!after || after !== before) return 'not-bot';
  return deps.refresh(after);
}

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
  const inFlight = new Map<string, {
    entry: { session: BotCompactRuntimeSession; boundary: BotCompactBoundary };
    operation: Promise<BotCompactRuntimeRefreshOutcome>;
  }>();

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
    if (existing) {
      if (existing.entry === entry) return existing.operation;
      // A newer boundary/instance must not consume the old refresh's receipt.
      await existing.operation;
      return attempt(session);
    }

    const operation = (async () => deps.refresh(session, entry.boundary))()
      .then((outcome) => {
        if (
          outcome !== 'deferred'
          && pending.get(session.id) === entry
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
        if (inFlight.get(session.id)?.operation === operation) inFlight.delete(session.id);
      });
    inFlight.set(session.id, { entry, operation });
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
    hasPending: (sessionId: string, session?: BotCompactRuntimeSession) => {
      const entry = pending.get(sessionId);
      return !!entry && (!session || (entry.session === session
        && entry.boundary.sessionInstanceId === session.instanceId));
    },
    resetForTest,
  };
}

export type BotCompactRuntimeRefreshCoordinator = ReturnType<
  typeof createBotCompactRuntimeRefreshCoordinator
>;

/** Only live Bot chats require a capability refresh before accepting input.
 * Ordinary and delegated tasks also emit compaction events, but keep their
 * existing runtime and queue semantics. Resolve ownership before the busy gate.
 */
export async function prepareBotCapabilityEpochBeforeSend<T extends {
  role: string;
  source: string;
  status: string;
  workingDir: string | null;
}>(session: BotCompactRuntimeSession, deps: {
  readSession(): Promise<T | null | undefined>;
  preflight(row: T & { workingDir: string }): Promise<boolean>;
  coordinator: BotCompactRuntimeRefreshCoordinator;
}): Promise<BotCompactRuntimeRefreshOutcome> {
  const row = await deps.readSession();
  if (!row || (row.role !== 'canonical' && row.role !== 'group')
    || row.source !== 'bot' || row.status !== 'active' || !row.workingDir) {
    return 'not-bot';
  }
  const { coordinator } = deps;
  if (!coordinator.hasPending(session.id, session)) {
    if (!await deps.preflight({ ...row, workingDir: row.workingDir })) return 'not-bot';
    coordinator.noteBoundary(session);
  }
  const outcome = await coordinator.attempt(session);
  return coordinator.hasPending(session.id, session) ? 'deferred' : outcome;
}
