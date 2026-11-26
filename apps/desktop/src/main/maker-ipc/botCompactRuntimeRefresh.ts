// Internal send-admission signal for the queue coordinator. Keep the existing
// IPC error contract if this reaches the ordinary failure path.
export class BotCapabilityRefreshDeferredError extends Error {
  readonly code = 'PRECONDITION_FAILED';

  constructor() {
    super('[PRECONDITION_FAILED] 伙伴能力正在刷新，请稍后再发送');
  }
}

export class BotRuntimeBecameBusyError extends Error {
  constructor() {
    super('Bot runtime became busy before compact refresh');
  }
}

export interface BotCompactRuntimeSession {
  readonly id: string;
  readonly instanceId: string;
  isTurnRunning(): boolean;
  listBackgroundTasks(): ReadonlyArray<unknown>;
  countPendingWakeContinuations?(): number;
}

export interface BotCompactBoundary {
  readonly sessionId: string;
  readonly sessionInstanceId: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly boundaryCount: number;
}

export type BotCompactRuntimeRefreshOutcome = 'refreshed' | 'not-bot' | 'deferred';

/** Send admission adds one outcome: the refresh stays pending, but the input
 * may run on the current runtime because only background jobs block it. */
type BotRuntimeRefreshAttempt = BotCompactRuntimeRefreshOutcome | 'refresh-failed';
export type BotCapabilityEpochSendOutcome = BotRuntimeRefreshAttempt | 'kept-current-runtime';

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
  onReady?: (sessionId: string) => void;
}

/**
 * A resource/profile refresh signal may keep the live runtime only when the
 * preflight compared against an applied baseline and found it unchanged. No
 * hydrated Profile or no applied baseline (e.g. its first write failed) is not
 * proof of "unchanged", so it keeps the previous rebuild.
 */
export function botRuntimeRefreshNeedsReplacement(snapshot: {
  runtimeEpochChanged: boolean;
  runtimeEpochBaseline: boolean;
} | null | undefined): boolean {
  return !snapshot || !snapshot.runtimeEpochBaseline || snapshot.runtimeEpochChanged;
}

/**
 * Preserve the live runtime when a frozen Bot resource changed. The preflight
 * must finish before close, and ownership is checked again immediately before
 * the destructive half of the swap. The preflight reports whether the runtime
 * epoch changed; an unchanged epoch keeps the live runtime and returns null,
 * matching the comparison made before a send.
 */
export async function replaceBotRuntimeAfterPreflight<T>(deps: {
  preflight(): Promise<boolean>;
  isCurrentOwner(): boolean;
  isIdle?(): boolean;
  close(): Promise<void>;
  bootstrap(): Promise<T>;
}): Promise<T | null> {
  if (!await deps.preflight()) return null;
  if (!deps.isCurrentOwner()) {
    throw new Error('Bot runtime owner changed before compact refresh');
  }
  if (deps.isIdle && !deps.isIdle()) {
    throw new BotRuntimeBecameBusyError();
  }
  await deps.close();
  return deps.bootstrap();
}

/**
 * Explicit Bot resource changes may arrive during a product turn. Defer their
 * runtime refresh until the turn settles. Native compact_boundary alone does
 * not register a refresh. This coordinator owns the instance-scoped pending
 * state; the host callback owns close/bootstrap.
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
    operation: Promise<BotRuntimeRefreshAttempt>;
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

  async function attemptForSend(
    session: BotCompactRuntimeSession,
  ): Promise<BotRuntimeRefreshAttempt> {
    const entry = pending.get(session.id);
    if (!entry || entry.session !== session || entry.boundary.sessionInstanceId !== session.instanceId) {
      return 'not-bot';
    }
    const existing = inFlight.get(session.id);
    if (existing) {
      if (existing.entry === entry) return existing.operation;
      // A newer boundary/instance must not consume the old refresh's receipt.
      await existing.operation;
      return attemptForSend(session);
    }
    if (
      session.isTurnRunning()
      || session.listBackgroundTasks().length > 0
      || (session.countPendingWakeContinuations?.() ?? 0) > 0
      || deps.hasPendingInteraction(session.id)
    ) {
      return 'deferred';
    }

    const operation = (async () => deps.refresh(session, entry.boundary))()
      .then((outcome) => {
        const current = pending.get(session.id);
        if (outcome !== 'deferred' && current === entry) {
          pending.delete(session.id);
        }
        // A successful replacement can clear the old runtime's marker during
        // close. A newer pending epoch still owns its own readiness boundary.
        if (outcome !== 'deferred' && (current === entry || (!current && outcome === 'refreshed'))) {
          deps.onReady?.(session.id);
        }
        return outcome;
      })
      .catch((error) => {
        if (error instanceof BotRuntimeBecameBusyError) return 'deferred' as const;
        deps.onError?.(session.id, error);
        const current = pending.get(session.id);
        if (current === entry || !current) deps.onReady?.(session.id);
        return 'refresh-failed' as const;
      })
      .finally(() => {
        if (inFlight.get(session.id)?.operation === operation) inFlight.delete(session.id);
      });
    inFlight.set(session.id, { entry, operation });
    return operation;
  }

  /** Background jobs live inside the runtime, so refresh (close + bootstrap)
   * must wait for them. Unlike a running turn or a pending interaction, they do
   * not stop the session from taking a new turn on its current runtime. */
  function isBlockedOnlyByBackgroundTasks(session: BotCompactRuntimeSession): boolean {
    return !session.isTurnRunning()
      && !deps.hasPendingInteraction(session.id)
      && !inFlight.has(session.id)
      && (session.listBackgroundTasks().length > 0
        || (session.countPendingWakeContinuations?.() ?? 0) > 0);
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
    async attempt(session: BotCompactRuntimeSession): Promise<BotCompactRuntimeRefreshOutcome> {
      const outcome = await attemptForSend(session);
      return outcome === 'refresh-failed' ? 'deferred' : outcome;
    },
    attemptForSend,
    clearForClosedSession,
    isBlockedOnlyByBackgroundTasks,
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
 * Background jobs never block input (a turn's end does not wait for them): the
 * input runs on the current runtime and the refresh waits for a truly idle
 * session (turn end / agent_task_update retry it).
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
}): Promise<BotCapabilityEpochSendOutcome> {
  const row = await deps.readSession();
  if (!row || (row.role !== 'canonical' && row.role !== 'group' && row.role !== 'channel' && row.role !== 'thread' && row.role !== 'routine')
    || row.source !== 'bot' || row.status !== 'active' || !row.workingDir) {
    return 'not-bot';
  }
  const { coordinator } = deps;
  if (!coordinator.hasPending(session.id, session)) {
    if (!await deps.preflight({ ...row, workingDir: row.workingDir })) return 'not-bot';
    coordinator.noteBoundary(session);
  }
  const outcome = await coordinator.attemptForSend(session);
  if (!coordinator.hasPending(session.id, session)) return outcome;
  if (coordinator.isBlockedOnlyByBackgroundTasks(session)) return 'kept-current-runtime';
  return outcome === 'refresh-failed' ? outcome : 'deferred';
}
