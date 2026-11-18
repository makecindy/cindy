import type { AgentInputCoordinator, AgentInputCoordinatorDeps } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.ts';
import type { AgentInputQueuedMessage } from '../../../desktop/src/shared/agentInputQueue.ts';
import { hydrateQueuedAgentReferences } from '../../../desktop/src/main/maker-ipc/agentInputReferences.ts';
import { runSchedulerQueuedPreparation } from '../../../desktop/src/main/maker-ipc/schedulerQueuedPreparation.ts';
import type { createQueuedAcceptedCallbacks } from '../../../desktop/src/main/maker-ipc/queuedAcceptedCallbacks.ts';
import type { QueuedAttachmentOwnershipRegistry } from '../../../desktop/src/main/maker-ipc/queuedAttachmentOwnership.ts';
import type { createSchedulerQueueBridge } from '../../../desktop/src/main/maker-ipc/schedulerQueueBridge.ts';
import { settleTaskActionInput } from '../../../desktop/src/main/maker-ipc/taskActionAuthorization.ts';
import type { HostAutoResume } from './auto-resume.ts';
import { explicitPorts } from './explicit-ports.ts';

type Deps = AgentInputCoordinatorDeps;
type LiveSession = {
  agentKind?: string;
  isTurnRunning?(): boolean;
  getTurnGeneration?(): number | null;
  getObservedCurrentTurnTerminal?(): ReturnType<NonNullable<Deps['getObservedCurrentTurnTerminal']>>;
};

/** The input queue's deps (input-queue.mjs createInputQueue) the coordinator's ports read. */
export interface HostCoordinatorQueueDeps {
  getTaskRuntimePlugins?(): Pick<Deps, 'screenUserMessage' | 'onUserMessageBlocked' | 'onUserMessageRewritten'> | null;
  getMaker(): { getSession(sessionId: string): LiveSession | undefined } | null | undefined;
  readSession(sessionId: string): Promise<{ sdkSessionId?: string | null }>;
  persistMessage?: Deps['createUserMessage'];
  touchUserSend?: Deps['touchUserSend'];
  interactions?: { pending(sessionId: string): unknown[] | undefined } | null;
  hasAssistantProgressAfter?: Deps['hasAssistantProgressAfter'];
  getRecoveryContextSnapshot?: Deps['getRecoveryContextSnapshot'];
  hasPendingCredentialSwitch?: Deps['hasPendingCredentialSwitch'];
  rewindPersistedUserMessageAfterClear?: Deps['rewindPersistedUserMessageAfterClear'];
  loadQueueSnapshot?: Deps['loadQueueSnapshot'];
  loadClearBoundary?: Deps['loadClearBoundary'];
  getPersistedClientIds?: Deps['getPersistedClientIds'];
  resolveSessionReferences?: Deps['resolveSessionReferences'];
  supersedeRetriedUserTurn?: Deps['supersedeRetriedUserTurn'];
  /**
   * The task's activity time when a person's turn is dispatched or steered (register.ts
   * touchSessionActivityInDb); main.ts gives the Host's write (session-activity.ts, release table 甲 10).
   */
  touchSessionActivity?: (sessionId: string, atMs?: number) => Promise<void>;
}

/** The turn executor (turn-executor.mjs) as the coordinator's ports read it. */
export interface HostCoordinatorExecutor {
  send: Deps['sendToAgent'];
  steer: Deps['steerToAgent'];
  abort(sessionId: string): Promise<void>;
  isRunning(sessionId: string): boolean;
  isSettling(sessionId: string): boolean;
  reconcileIdle: NonNullable<Deps['reconcileTurnIdle']>;
  beforeDispatchUserTurn: NonNullable<Deps['beforeDispatchUserTurn']>;
  onUndispatchedUserTurn: NonNullable<Deps['onUndispatchedUserTurn']>;
  persistTerminalSendError(sessionId: string, message: string, inputClientId?: string): void;
  /** The task's event persistence (historyFor), for the reply anchor of a user row. */
  autoResumeHistory(sessionId: string): { getLastAssistantTranscriptUuid(sessionId: string): string | undefined };
  onPersistedSendRejected(sessionId: string, message: string): void;
}

/** One owner runtime of the input queue (input-queue.mjs createRuntime), as the ports read it. */
export interface HostCoordinatorContext {
  deps: HostCoordinatorQueueDeps;
  executor: HostCoordinatorExecutor;
  /** The coordinator these ports are handed to; read when a port runs. */
  coordinator(): AgentInputCoordinator;
  /** The scheduler bridge, assembled after the coordinator; read when a port runs. */
  scheduleBridge(): Pick<ReturnType<typeof createSchedulerQueueBridge>, 'onPersistedSendRejected' | 'recoverySourceClientId'>;
  assertCurrent(): void;
  /** Starts an abort and remembers it, so a stop can wait for it (input-queue.mjs stop). */
  noteAborting(sessionId: string, aborting: Promise<void>): void;
  publish: Deps['emitProjection'];
  persist: NonNullable<Deps['persistQueueSnapshot']>;
  flushed: NonNullable<Deps['awaitQueuePersistence']>;
  /** Runs once the coordinator's next snapshot is durable (input-queue.mjs afterSnapshot). */
  afterSnapshot(sessionId: string, action: () => unknown): void;
  attachmentOwnership: QueuedAttachmentOwnershipRegistry;
  acceptedCallbacks: ReturnType<typeof createQueuedAcceptedCallbacks>;
  schedulePreparations: Parameters<typeof runSchedulerQueuedPreparation>[1];
  scheduleDiscardWatchers: Map<string, () => void>;
  /** The auto-resume runtime and hooks of this owner runtime (auto-resume.ts). */
  autoResume: HostAutoResume;
  /** This owner runtime's context recovery, if assembled; read when a port runs. */
  rollover(): { cancelRecovery(sessionId: string): void } | null | undefined;
}

const makerKind = (kind: string | undefined) => kind === 'cc' ? 'claude-code' : kind;

/**
 * The input coordinator's ports on the Node Host, with every optional port written out
 * (explicit-ports.ts): bound to the Host's, or left out with the reason the Host does not bind it.
 * register.ts binds the desktop's.
 */
export function hostCoordinatorDeps(ctx: HostCoordinatorContext): AgentInputCoordinatorDeps {
  const { deps, executor } = ctx;
  /**
   * An exact retry owner that never crossed vendor dispatch (register.ts
   * finalizeUndispatchedClaimedRetry): a failure surfaces the held error, a cancellation writes it
   * quietly. The desktop also closes the Agent Island lifecycle, which the Host does not have.
   */
  const finalizeUndispatchedClaimedRetry = (id: string, item: AgentInputQueuedMessage, disposition: 'cancelled' | 'failed') =>
    disposition === 'failed'
      ? ctx.autoResume.autoResumeBookkeeping.surfaceSuppressedErrorForRetry(id, item.clientId)
      : ctx.autoResume.autoResumeBookkeeping.flushSuppressedErrorForRetry(id, item.clientId);
  return explicitPorts<AgentInputCoordinatorDeps>({
    sendToAgent: async (id, message, createOpts, sendOpts) => {
      const clientId = sendOpts.persistUserMessage?.clientId;
      try {
        await runSchedulerQueuedPreparation(clientId, ctx.schedulePreparations,
          () => { ctx.scheduleDiscardWatchers.delete(clientId as string); ctx.acceptedCallbacks.discard(clientId as string); });
        ctx.assertCurrent();
        const result = await executor.send(id, message, createOpts, sendOpts);
        await ctx.acceptedCallbacks.settle(id, sendOpts, result);
        return result;
      } catch (error) {
        await ctx.acceptedCallbacks.rollback(id, clientId);
        throw error;
      }
    },
    steerToAgent: executor.steer,
    abortSession: id => {
      // As register.ts: an explicit stop withdraws both automatic resumes and their backoff first.
      ctx.autoResume.resetForExplicitStop(id);
      const promise = executor.abort(id);
      ctx.noteAborting(id, promise);
      return promise;
    },
    isTurnRunning: id => executor.isRunning(id),
    // While a turn's rows settle after its terminal, the Host still counts it as running (isTurnRunning)
    // and the Session is already idle; the coordinator, which gets the terminal on arrival, would read
    // that as a stale boundary and start polling it. The probe answers 'unavailable' (fail-closed) in that
    // window; it never reports the Host's own record as a running Session.
    isLiveTurnRunning: id => executor.isSettling(id) ? undefined : deps.getMaker()?.getSession(id)?.isTurnRunning?.(),
    isLiveSessionPresent: id => !!deps.getMaker()?.getSession(id),
    getTurnGeneration: id => deps.getMaker()?.getSession(id)?.getTurnGeneration?.() ?? null,
    getTurnSessionIdentity: id => (deps.getMaker()?.getSession(id) as object | undefined) ?? null,
    getObservedCurrentTurnTerminal: id => deps.getMaker()?.getSession(id)?.getObservedCurrentTurnTerminal?.(),
    reconcileTurnIdle: executor.reconcileIdle,
    getAgentKind: id => (makerKind(deps.getMaker()?.getSession(id)?.agentKind) ?? null) as ReturnType<Deps['getAgentKind']>,
    getSdkSessionId: async id => (await deps.readSession(id)).sdkSessionId || undefined,
    hasAssistantProgressAfter: deps.hasAssistantProgressAfter,
    getRecoveryContextSnapshot: deps.getRecoveryContextSnapshot,
    hasPendingInteraction: id => (deps.interactions?.pending(id)?.length ?? 0) > 0,
    hasPendingCredentialSwitch: deps.hasPendingCredentialSwitch,
    rewindPersistedUserMessageAfterClear: deps.rewindPersistedUserMessageAfterClear,
    // As register.ts (createUserMessageDurably): budgets charged for a person's message, an
    // auto-resume's outcome registered, the row written behind the task's reply rows.
    createUserMessage: ctx.autoResume.createUserMessage,
    touchUserSend: deps.touchUserSend ?? (async () => {}) as unknown as Deps['touchUserSend'],
    emitProjection: ctx.publish,
    persistQueueSnapshot: ctx.persist,
    awaitQueuePersistence: ctx.flushed,
    loadQueueSnapshot: deps.loadQueueSnapshot,
    loadClearBoundary: deps.loadClearBoundary,
    getPersistedClientIds: deps.getPersistedClientIds,
    onUserMessagePersisting: (id, item) => ctx.attachmentOwnership.markPersistenceStarted(id, item.clientId),
    onUserMessagePersisted: (id, item) => { void ctx.attachmentOwnership.settleDurable(id, item.clientId); },
    onUserMessagePersistenceFailed: (id, item, options) => {
      ctx.afterSnapshot(id, () => ctx.attachmentOwnership.markPersistenceFailed(id, item.clientId, options));
    },
    // Desktop register.ts (AgentInputCoordinator hooks): after the user row is durable
    // and before vendor dispatch, open the turn change record, then the Git baseline.
    beforeDispatchUserTurn: (id, item, signal) => {
      ctx.autoResume.autoResumeBookkeeping.markReplacementDispatching(id, item.clientId);
      return executor.beforeDispatchUserTurn(id, item, signal);
    },
    // A durable turn that never reached the vendor: drop the record, then the baseline.
    // Then, as register.ts, the auto-resume that item carried hands its error back (exactly once).
    onUndispatchedUserTurn: (id, item, disposition) => {
      executor.onUndispatchedUserTurn(id, item, disposition);
      ctx.autoResume.autoResumeBookkeeping.rollbackReplacementPreview(id, item.clientId);
      const autoResume = item.autoResume === true;
      if (autoResume) ctx.autoResume.settleUndispatchedInterruptedAutoResume(id, item);
      finalizeUndispatchedClaimedRetry(id, item, disposition);
      if (!autoResume) ctx.autoResume.settleUndispatchedInterruptedAutoResume(id, item);
    },
    // Session references in the composer (register.ts resolveSessionReferences, with the Host's
    // device identity; reading another device's task needs Device Link, which the Host lacks).
    resolveSessionReferences: deps.resolveSessionReferences,
    refreshAgentReferencesBeforeDispatch: async (item: AgentInputQueuedMessage) => {
      const refreshed = await hydrateQueuedAgentReferences(item, {
        isSessionTurnRunning: target => deps.getMaker()?.getSession(target)?.isTurnRunning?.() ?? false,
      });
      Object.assign(item, refreshed);
      if (refreshed.agentReferences === undefined) delete item.agentReferences;
    },
    supersedeRetriedUserTurn: deps.supersedeRetriedUserTurn,
    // The coordinator has just kept this input as the task's recovery point (active-turn) when it
    // stores the error row; that input stopped here, so its receipt follows the row (turn-executor).
    persistTerminalSendError: (id, message, attemptToken) => {
      // An automatic recovery already owns this input (main 3792724192): its error is held once, in
      // that attempt, and written when the attempt gives up.
      if (attemptToken !== undefined) {
        ctx.autoResume.autoResumeBookkeeping.stashSuppressedError(id, { message }, attemptToken);
        return;
      }
      const recovery = ctx.coordinator().getProjection(id).recovery;
      executor.persistTerminalSendError(id, message, recovery?.kind === 'active-turn' ? recovery.item?.clientId : undefined);
    },
    // As register.ts: the scheduler bridge first (a scheduled prompt's persisted failure), then the
    // Pi prompt timeout's runtime close (turn-executor).
    onPersistedSendRejected: (id, message, item, recovering) => {
      ctx.scheduleBridge().onPersistedSendRejected(id, message, item, recovering);
      executor.onPersistedSendRejected(id, message);
    },
    onAcceptedQueuedMessage: async (id, item) => {
      ctx.schedulePreparations.delete(item.clientId);
      ctx.scheduleDiscardWatchers.delete(item.clientId);
      await ctx.acceptedCallbacks.run(id, item, ctx.scheduleBridge().recoverySourceClientId(id, item));
    },
    onDiscardedQueuedMessage: (id, item) => {
      // As register.ts: settle a task-action input that will not run.
      void settleTaskActionInput(item).catch(() => undefined);
      ctx.afterSnapshot(id, () => ctx.attachmentOwnership.discardClient(id, item.clientId));
      ctx.acceptedCallbacks.discard(item.clientId);
      ctx.schedulePreparations.delete(item.clientId);
      const discarded = ctx.scheduleDiscardWatchers.get(item.clientId);
      ctx.scheduleDiscardWatchers.delete(item.clientId);
      // As register.ts: an auto-resume item settles before a claimed retry releases its error.
      const autoResume = item.autoResume === true;
      if (autoResume) ctx.autoResume.settleUndispatchedInterruptedAutoResume(id, item);
      finalizeUndispatchedClaimedRetry(id, item, 'cancelled');
      if (!autoResume) ctx.autoResume.settleUndispatchedInterruptedAutoResume(id, item);
      discarded?.();
    },

    // ── Interrupted-turn auto-resume (auto-resume.ts), as register.ts binds it ───────────────────
    isResumableTurnErrorCandidate: ctx.autoResume.canRecoverTurn,
    claimExternalAutomaticRecovery: id =>
      ctx.autoResume.interruptedTurnAutoResumeGuard.claimExternalAutomaticRecovery(id).action === 'allow',
    onResumableTurnErrorDiscarded: ctx.autoResume.onResumableTurnErrorDiscarded,
    onResumableTurnError: ctx.autoResume.onResumableTurnError,
    onUnconfirmedAutoResumeTurn: ctx.autoResume.onUnconfirmedAutoResumeTurn,
    // The desktop also settles Teammate group, plugin-task and welcome receipts and the Agent Island
    // here; the Host has none of them.
    onRejectedUserTurn: ctx.autoResume.onRejectedUserTurn,
    onDispatchedUserTurn: (id, item, preVendorDispatchAt) => {
      if (!item.autoResume) void deps.touchSessionActivity?.(id, preVendorDispatchAt);
      void settleTaskActionInput(item).catch(() => undefined);
      const attemptToken = ctx.autoResume.autoResumeAttemptToken(item);
      // The vendor accepted the resume: the held error is dropped, unless a newer attempt owns it.
      if (attemptToken !== null) ctx.autoResume.autoResumeBookkeeping.discardSuppressedError(id, attemptToken);
    },
    onSteerAccepted: (id, item) => {
      if (!item.autoResume) void deps.touchSessionActivity?.(id);
      void settleTaskActionInput(item).catch(() => undefined);
      // The desktop also releases the Orca accepted callback; Orca tasks are refused at Host admission.
    },
    onUiRetry: (id, clientId, source, attemptToken) => {
      const bookkeeping = ctx.autoResume.autoResumeBookkeeping;
      bookkeeping.claimSuppressedErrorForRetry(id, clientId, source);
      if (source === 'auto' && attemptToken !== undefined) bookkeeping.bindSuppressedErrorToClient(id, attemptToken, clientId);
      if (source === 'manual') {
        ctx.rollover()?.cancelRecovery(id);
        // The click itself is the person's intervention: a fresh budget, before any await.
        ctx.autoResume.silentStopAutoResumeGuard.noteUserSend(id);
        ctx.autoResume.interruptedTurnAutoResumeGuard.noteUserSend(id);
      }
      // The desktop also retires a scheduled waiter, notes the provider group and publishes the hook
      // continuation signal; the Host has no scheduler runner, provider groups or hook channels.
    },
    // A new message takes the task over: a context recovery in flight and an unclaimed held error give way.
    onUserEnqueue: id => {
      ctx.rollover()?.cancelRecovery(id);
      ctx.autoResume.autoResumeBookkeeping.supersedeUnclaimedErrorForUserIntervention(id);
    },
    // An automatic input moves the task on too, without charging the person's budgets.
    onAutomaticEnqueue: id => {
      ctx.rollover()?.cancelRecovery(id);
      ctx.autoResume.autoResumeBookkeeping.supersedeUnclaimedErrorForUserIntervention(id);
    },
    getLastAssistantTranscriptUuid: id => executor.autoResumeHistory(id).getLastAssistantTranscriptUuid(id),

    screenUserMessage: deps.getTaskRuntimePlugins
      ? (id, text, item) => deps.getTaskRuntimePlugins!()?.screenUserMessage?.(id, text, item) ?? Promise.resolve({ action: 'allow' })
      : undefined,
    onUserMessageBlocked: (...args) => deps.getTaskRuntimePlugins?.()?.onUserMessageBlocked?.(...args),
    onUserMessageRewritten: (...args) => deps.getTaskRuntimePlugins?.()?.onUserMessageRewritten?.(...args),

    // ── Not bound on the Host, and why ─────────────────────────────────────────────────────────
    // Orca tasks are refused at Host admission: no saved report is restored, so none is revalidated.
    canRestoreOrcaReport: undefined,
    // The usage-limit resume arrives with the third batch (release table).
    onUsageLimitedTurnError: undefined,
    onUserAction: undefined,
    // Provider-group tasks are refused at Host admission.
    providerGroupSwitchCandidate: undefined,
    // The desktop's Orca assignment-history gate; Orca tasks are refused at Host admission.
    onUserMessageQueryable: undefined,
    // Orca queue notes; Orca tasks are refused at Host admission.
    describeQueueBehindDispatch: undefined,
    // Agent Island (a desktop window surface): the Host has none.
    onQueueEmptied: undefined,
    previewQueuedUserTurn: undefined,
    // Dismissing an input handoff and the runtime's asynchronous questions on the owner's next
    // message: the Host's questions arrive after checkpoint 4 (askUserQuestionAsync, release table).
    onOwnerMessage: undefined,
    // The desktop's message persistence learns the conversation clear boundary here, so a background
    // turn started before a /clear writes no rows after it (backgroundTurnPredatesSessionClear). The
    // desktop calls clearSession only from its /clear entry (maker:input:clear-session). The Host has no
    // /clear entry yet: it calls clearSession only when a task is deleted or a draft discarded, and
    // closes the task's persistence right after. Bound with the Host's /clear entry (release table).
    noteSessionClearBoundary: undefined,
  });
}
