import type { AgentInputCoordinator, AgentInputCoordinatorDeps } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.ts';
import type { AgentInputQueuedMessage } from '../../../desktop/src/shared/agentInputQueue.ts';
import { hydrateQueuedAgentReferences } from '../../../desktop/src/main/maker-ipc/agentInputReferences.ts';
import { runSchedulerQueuedPreparation } from '../../../desktop/src/main/maker-ipc/schedulerQueuedPreparation.ts';
import type { createQueuedAcceptedCallbacks } from '../../../desktop/src/main/maker-ipc/queuedAcceptedCallbacks.ts';
import type { QueuedAttachmentOwnershipRegistry } from '../../../desktop/src/main/maker-ipc/queuedAttachmentOwnership.ts';
import type { createSchedulerQueueBridge } from '../../../desktop/src/main/maker-ipc/schedulerQueueBridge.ts';
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
}

const makerKind = (kind: string | undefined) => kind === 'cc' ? 'claude-code' : kind;

/**
 * The input coordinator's ports on the Node Host, with every optional port written out
 * (explicit-ports.ts): bound to the Host's, or left out with the reason the Host does not bind it.
 * register.ts binds the desktop's.
 */
export function hostCoordinatorDeps(ctx: HostCoordinatorContext): AgentInputCoordinatorDeps {
  const { deps, executor } = ctx;
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
    createUserMessage: ((id, input, options) => deps.persistMessage?.(id, input, options)) as Deps['createUserMessage'],
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
    beforeDispatchUserTurn: executor.beforeDispatchUserTurn,
    // A durable turn that never reached the vendor: drop the record, then the baseline.
    onUndispatchedUserTurn: executor.onUndispatchedUserTurn,
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
    persistTerminalSendError: (id, message) => {
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
      ctx.afterSnapshot(id, () => ctx.attachmentOwnership.discardClient(id, item.clientId));
      ctx.acceptedCallbacks.discard(item.clientId);
      ctx.schedulePreparations.delete(item.clientId);
      const discarded = ctx.scheduleDiscardWatchers.get(item.clientId);
      ctx.scheduleDiscardWatchers.delete(item.clientId);
      discarded?.();
    },

    // ── Not bound on the Host, and why ─────────────────────────────────────────────────────────
    // Orca tasks are refused at Host admission: no saved report is restored, so none is revalidated.
    canRestoreOrcaReport: undefined,
    // The interrupted-turn auto-resume (checkpoint 4b) is not assembled yet.
    onResumableTurnError: undefined,
    isResumableTurnErrorCandidate: undefined,
    onResumableTurnErrorDiscarded: undefined,
    claimExternalAutomaticRecovery: undefined,
    onUnconfirmedAutoResumeTurn: undefined,
    onRejectedUserTurn: undefined,
    onUiRetry: undefined,
    onUserEnqueue: undefined,
    onAutomaticEnqueue: undefined,
    onSteerAccepted: undefined,
    onDispatchedUserTurn: undefined,
    getLastAssistantTranscriptUuid: undefined,
    // The usage-limit resume arrives with the third batch (release table).
    onUsageLimitedTurnError: undefined,
    onUserAction: undefined,
    // Provider-group tasks are refused at Host admission.
    providerGroupSwitchCandidate: undefined,
    // Will-user-message hooks of installed plugins (row 33): not run on the Host yet.
    screenUserMessage: undefined,
    onUserMessageBlocked: undefined,
    onUserMessageRewritten: undefined,
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
    // The desktop's message persistence learns the clear boundary here, so a background turn started
    // before a clear writes no rows after it (backgroundTurnPredatesSessionClear). The Host's
    // persistence is not told: a gap found while writing this list, recorded in the release table.
    noteSessionClearBoundary: undefined,
  });
}
