import type { Session } from '@cindy/maker-core';
import type { AgentInputCoordinator } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.ts';
import { createAutoResumeRuntime, type AutoResumeRuntimePorts } from '../../../desktop/src/main/maker-ipc/autoResumeRuntime.ts';
import {
  createInterruptedTurnAutoResumeHooks,
  type InterruptedTurnAutoResumeHookPorts,
} from '../../../desktop/src/main/maker-ipc/interruptedTurnAutoResumeHooks.ts';
import {
  createUserMessageDurableWrite,
  type UserMessageDurableWritePorts,
} from '../../../desktop/src/main/maker-ipc/userMessageDurableWrite.ts';
import type { RuntimeFallbackResult } from '../../../desktop/src/main/maker-ipc/botCandidateRecovery.ts';
import type { SuppressedTurnError } from '../../../desktop/src/main/maker-ipc/autoResumeBookkeeping.ts';
import { readInterruptedTurnAutoResumeSettingsFrom } from '../../../desktop/src/main/maker-host/interruptedTurnAutoResumeSettingsCore.ts';
import { readSilentStopAutoResumeSettingsFrom } from '../../../desktop/src/main/maker-host/silentStopAutoResumeSettingsCore.ts';
import { createSessionRuntimeFallbackSettingsFile } from '../../../desktop/src/main/maker-host/sessionRuntimeFallbackSettingsCore.ts';
import { explicitPorts } from './explicit-ports.ts';

type CreateDbMessage = UserMessageDurableWritePorts['createDbMessage'];

/** What the auto-resume runtime writes through for one task: the Host's event persistence of that task. */
export interface AutoResumeHistory {
  onTurnErrorEvent(sessionId: string, data: SuppressedTurnError, agentMeta: null): unknown;
  markAutoResumeOutcome(sessionId: string, clientId: string | undefined, outcome: 'succeeded' | 'failed'): Promise<boolean>;
  saveTurnStartedAtForDeferred(sessionId: string): void;
  getLastAssistantTranscriptUuid(sessionId: string): string | undefined;
  getSessionDbAgentKind(sessionId: string): ReturnType<UserMessageDurableWritePorts['getSessionDbAgentKind']>;
  enqueueDurableWrite: UserMessageDurableWritePorts['enqueueDurableWrite'];
}

type AutoResumeLog = InterruptedTurnAutoResumeHookPorts<Session>['log'];

export interface HostAutoResumePorts {
  /** The profile the kill switches are read from, on every decision (as the desktop reads them). */
  userDataDir(): string;
  /** The task's input coordinator; it is assembled after this runtime, so it is read when used. */
  coordinator(): AgentInputCoordinator;
  /** The task's event persistence (turn-executor.mjs historyFor); read when used. */
  history(sessionId: string): AutoResumeHistory;
  /** The task's live runtime, if any. */
  getSession(sessionId: string): Session | null | undefined;
  /** Writes a user row (the Host's message store). */
  createDbMessage: CreateDbMessage;
  /**
   * The automatic route change an auto-resume tries first (sessionRuntimeFallback.ts). Without it the
   * resume stays on the task's route, as the desktop does when there is no other route.
   */
  maybeApplySessionRuntimeFallback?: InterruptedTurnAutoResumeHookPorts<Session>['maybeApplySessionRuntimeFallback'];
  /** The rebuild leases the route change marks on the runtime it switched (sessionRuntimeFallback.ts). */
  pendingSessionRuntimeFallbackRebuilds?: InterruptedTurnAutoResumeHookPorts<Session>['pendingSessionRuntimeFallbackRebuilds'];
  /**
   * A takeover ended without a resumed turn to answer its input: the held error row was written, or
   * the takeover was dropped (Host-only; input-queue.mjs ends that input's /api/chat stream).
   */
  onTakeoverReleased?(sessionId: string): void;
  log: AutoResumeLog;
}

/** The route stays as it is: what the desktop's fallback answers when it has nothing to change. */
const UNCHANGED_ROUTE: RuntimeFallbackResult<Session> = { session: null, outcome: 'unchanged' };

/**
 * The desktop's auto-resume for the Node Host: the process-wide runtime (autoResumeRuntime.ts), the
 * input coordinator's interrupted-turn hooks (interruptedTurnAutoResumeHooks.ts) and the user-row
 * write that charges the budgets (userMessageDurableWrite.ts), with register.ts's side effects bound
 * to the Host's. Every optional port is written out; the ones left empty say why.
 *
 * The Host's scheduled input has a single source, the queue snapshot restored from the shared
 * database at startup, and no runner to resume or settle it (release table B1). The five scheduler
 * ports are therefore bound empty: beginSchedulerAutoResume, pendingSchedulerAutoResumeRunBySession,
 * notifySchedulerAutoResumeFailed, the bookkeeping's onAutoResumeFailed and
 * finishScheduledUsageLimitWait. The Host refuses provider-group, Teammate and Orca tasks at
 * admission, so their held errors and terminals are never stashed.
 */
export function createHostAutoResume(ports: HostAutoResumePorts) {
  const fallbackSettings = createSessionRuntimeFallbackSettingsFile(() => ports.userDataDir());
  const runtime = createAutoResumeRuntime(explicitPorts<AutoResumeRuntimePorts>({
    isSilentStopAutoResumeEnabled: () => readSilentStopAutoResumeSettingsFrom(ports.userDataDir()).enabled,
    // As register.ts: the route-change setting also turns the interrupted-turn resume on.
    isInterruptedTurnAutoResumeEnabled: () =>
      readInterruptedTurnAutoResumeSettingsFrom(ports.userDataDir()).enabled || fallbackSettings.read().enabled,
    guardLog: { debug: ports.log.debug, warn: ports.log.warn },
    bookkeeping: explicitPorts<AutoResumeRuntimePorts['bookkeeping']>({
      // As register.ts (agentMeta null): the held error row, written once the takeover gives up.
      persistSuppressedError: (sessionId, detail) => {
        ports.history(sessionId).onTurnErrorEvent(sessionId, detail, null);
        ports.onTakeoverReleased?.(sessionId);
      },
      // The desktop shows the held error in the Agent Island and settles the deferred product-turn
      // failure (the plugin-task receipt and the upstream merge turn). The Host has no Agent Island and
      // runs no product-turn finalizer (a gap of its own, in the release table); the error row and the coordinator's
      // banner are what its clients see.
      surfaceSuppressedError: undefined,
      // Orca and Teammate tasks are refused at Host admission: nothing is held for them.
      finalizeOrcaSuppressedTerminal: undefined,
      finalizeBotGroupSuppressedTerminal: undefined,
      markOutcome: (sessionId, clientId, outcome) => { void ports.history(sessionId).markAutoResumeOutcome(sessionId, clientId, outcome); },
      abandonTakeover: (sessionId, message, attemptToken) => {
        ports.coordinator().abandonAutoResume(sessionId, message, attemptToken);
        ports.onTakeoverReleased?.(sessionId);
      },
      // Scheduler (see above): no run is waiting on this attempt.
      onAutoResumeFailed: undefined,
      log: (message, fields) => ports.log.debug(message, fields),
    }),
    restoreAutoResumeRecovery: (sessionId, clientId, attemptToken) =>
      ports.coordinator().restoreAutoResumeRecovery(sessionId, clientId, attemptToken) === true,
    // Scheduler (see above): no scheduled quota wait exists.
    finishScheduledUsageLimitWait: () => {},
    // Provider-group tasks are refused at admission: no continuation is held.
    settleProviderGroupContinuation: () => {},
  }));
  const { interruptedTurnAutoResumeGuard, silentStopAutoResumeGuard, autoResumeBookkeeping, autoResumeAttemptToken } = runtime;
  const pendingSessionRuntimeFallbackRebuilds = ports.pendingSessionRuntimeFallbackRebuilds ?? new WeakMap<Session, number>();
  const hooks = createInterruptedTurnAutoResumeHooks<Session>(explicitPorts<InterruptedTurnAutoResumeHookPorts<Session>>({
    inputCoordinator: {
      isExecutionPaused: sessionId => ports.coordinator().isExecutionPaused(sessionId),
      autoRetryLastError: (sessionId, attemptToken) => ports.coordinator().autoRetryLastError(sessionId, attemptToken),
    },
    interruptedTurnAutoResumeGuard,
    autoResumeBookkeeping,
    // Teammate tasks are refused at admission: no input carries a Teammate route to fall back from.
    botFallbackInputs: { has: () => false },
    saveTurnStartedAtForDeferred: sessionId => ports.history(sessionId).saveTurnStartedAtForDeferred(sessionId),
    // Scheduler (see above).
    beginSchedulerAutoResume: () => {},
    getStableSessionForTurnBoundary: sessionId => ports.getSession(sessionId) ?? null,
    // The lease a continuation-only resume keeps on its runtime (register.ts keeps it across an
    // unexpected close). The Host does not tear the resume down when a runtime closes, so nothing reads it.
    pendingContinuationOnlyAutoResumeRebuilds: new WeakMap<Session, number>(),
    maybeApplySessionRuntimeFallback: ports.maybeApplySessionRuntimeFallback ?? (async () => UNCHANGED_ROUTE),
    pendingSessionRuntimeFallbackRebuilds,
    // Provider-group tasks are refused at admission (see above).
    providerGroupHeldErrors: { stash: () => {} },
    providerGroupHeldTerminals: { stash: () => {} },
    // Scheduler (see above).
    pendingSchedulerAutoResumeRunBySession: { get: () => undefined },
    notifySchedulerAutoResumeFailed: () => {},
    autoResumeAttemptToken,
    log: ports.log,
  }));
  /**
   * The user-row write of a turn (register.ts createUserMessageDurably): it charges the budgets for a
   * person's message and registers an auto-resume's pending outcome, and writes the row through the
   * task's durable writes, behind its reply rows.
   */
  const createUserMessage: CreateDbMessage = (sessionId, message, opts) => {
    const history = ports.history(sessionId);
    return createUserMessageDurableWrite(explicitPorts<UserMessageDurableWritePorts>({
      autoResumeBookkeeping, silentStopAutoResumeGuard, interruptedTurnAutoResumeGuard,
      // The usage-limit resume arrives with the third batch; until then a person's message has no
      // usage-limit wait to restart.
      usageLimitAutoResume: { noteUserAction: () => {} },
      // Provider-group tasks are refused at admission (see above).
      getProviderGroupService: () => null,
      enqueueDurableWrite: history.enqueueDurableWrite,
      getLastAssistantTranscriptUuid: id => history.getLastAssistantTranscriptUuid(id),
      getSessionDbAgentKind: id => history.getSessionDbAgentKind(id),
      createDbMessage: ports.createDbMessage,
    }))(sessionId, message, opts);
  };
  return {
    ...runtime,
    ...hooks,
    createUserMessage,
    /**
     * An explicit stop withdraws both automatic resumes and their backoff (register.ts
     * resetAutomaticRecoveryForExplicitStop). The desktop also clears its MCP setup bridge and the
     * deferred product-turn failure gate, which the Host does not have.
     */
    resetForExplicitStop(sessionId: string) {
      silentStopAutoResumeGuard.noteSessionReset(sessionId);
      interruptedTurnAutoResumeGuard.noteSessionReset(sessionId);
      autoResumeBookkeeping.teardown(sessionId);
    },
  };
}

export type HostAutoResume = ReturnType<typeof createHostAutoResume>;
