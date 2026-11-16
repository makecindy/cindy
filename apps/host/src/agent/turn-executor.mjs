import { createMakerSteerTransaction } from '../../../desktop/src/main/maker-ipc/makerSteerTransaction.ts';
import { AUTO_REVIEW_DELEGATED_CONTINUATION } from '../../../desktop/src/main/maker-ipc/autoReviewUserIntent.ts';
import { readReplyQuoteNote } from '../../../desktop/src/main/maker-ipc/chatReplyQuoteNote.ts';
import { publishUiSessionIntervention } from '../../../desktop/src/main/maker-ipc/uiContinuationSignal.ts';
import { listMessagesForAgentHandoff } from '../../../desktop/src/main/localDb/agentHandoffHistory.ts';
import { createSessionOptionsReconciler } from '../../../desktop/src/main/maker-ipc/sessionOptionsReconciler.ts';
import { createMakerSendTransaction, prepareDirectoryGrantsForBootstrap } from '../../../desktop/src/main/maker-ipc/makerSendTransaction.ts';
import { createSessionStderrOptions, isSessionRunningError } from '../../../desktop/src/main/maker-ipc/sessionRequest.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';
import { createWireNoteMemory } from '../../../desktop/src/main/maker-ipc/wireNoteMemory.ts';
import { createLogger } from '../../../desktop/src/main/logger.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { DEFAULT_CLASSICAL_REPLY_STYLE } from '@cindy/maker-shared/classical-reply';
import { assertHostTaskExecutionSupported, prepareHostUserMessage } from './send-preflight.ts';
import { createHostLearnInvocationCapture } from './learn-capture.ts';
import { createHostEventPersistence } from './event-persistence.ts';
import { createHostContextRecovery } from './context-recovery.ts';
import { createHostWorkingDirectory } from './working-directory.ts';
import { clearSealedCodexPlanState, readCodexPlanState } from '../../../desktop/src/main/localDb/codexPlanState.ts';
import { buildCompletedPlanGuardNote, buildPlanReconcileNote } from '../../../desktop/src/main/maker-ipc/planReconcile.ts';
import { peekGoalInactiveNote } from '../../../desktop/src/main/goal-host/inactiveNote.ts';
import { createTurnModelAttribution } from '../../../desktop/src/main/maker-ipc/turnModelAttribution.ts';
import { patchMessageAgentMetaWithResultRow } from '../../../desktop/src/main/localDb/messageMutations.ts';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { persistAndHydrateSessionProvider } from '../../../desktop/src/main/maker-ipc/sessionProviderBootstrap.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.ts';
import { eq } from 'drizzle-orm';
import { isPiPromptRpcTimeoutError } from '../../../desktop/src/shared/inputError.ts';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { isTerminalTurnErrorEvent } from '../../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.ts';
import { noteClaudeSessionTurnState } from '../../../desktop/src/main/maker-host/claude-session-background-activity.ts';
import { syncBackgroundCommandWork } from '../../../desktop/src/main/maker-host/claude-background-command-work-sync.ts';
import { clearPendingTurnChangeSets, finalizeTurnChangeSet, noteTurnDiffEvent } from '../../../desktop/src/main/turn-change-set/store.ts';
import { beginTurnChangeSetAtDispatch } from '../../../desktop/src/main/turn-change-set/dispatchBoundary.ts';
import { setSessionProvider, clearSessionProvider, getSessionProvider, hydrateSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { setSessionEffort } from '../../../desktop/src/main/maker-host/session-effort-store.ts';
import { applyQueuedSessionSettings, rememberLiveSessionSettings } from './session-settings.mjs';
import { MCP_APP_MESSAGE_GUARD } from '../../../desktop/src/main/mcp-apps/message.ts';
import { redactEventForRenderer } from '../../../desktop/src/main/maker-ipc/rendererEventRedaction.ts';
import { isGatewayProxyTokenRecoveryErrorEventForProvider } from '../../../desktop/src/main/maker-ipc/gatewayProxyTokenRecovery.ts';
import { contextSnapshotForStatus, isContextCompactionSnapshot } from '../../../desktop/src/main/maker-ipc/sessionContextSnapshot.ts';
import { recordHostContextSnapshot } from './context-usage.ts';
import { readTerminalTurnErrorSignals } from '../../../desktop/src/main/maker-ipc/terminalTurnErrorSignals.ts';
import { isForegroundRunningStatus, noteAutoResumeProgress, noteForegroundTurnStarted, settleAutoResumeAttemptOnDone,
  settleAutoResumeAttemptOnTerminalError } from '../../../desktop/src/main/maker-ipc/sessionEventAutoResumeSteps.ts';

const makerKind = kind => kind === 'cc' ? 'claude-code' : kind;
const dbKind = kind => kind === 'claude-code' ? 'cc' : kind;
const errorText = error => error instanceof Error ? error.message : String(error);

/**
 * Node platform adapter for one maker-core turn. Queue order, recovery and
 * dispatch ownership belong to AgentInputCoordinator, never to this adapter.
 * The coordinator receives a turn's terminal when it arrives, as on the desktop; the next input
 * still waits until all visible reply rows have settled, because the turn counts as running
 * (isRunning, the coordinator's dispatch boundary) until then.
 */
/**
 * Publishes an agent event to the Host's clients (the event stream and the device link read the
 * hub). As on the desktop (sessionEventPreparation.ts broadcastEvent), what leaves is the
 * renderer-boundary projection of the event; persistence and bookkeeping keep the original.
 */
export function publishAgentEvent(hub, sessionId, event, fields) {
  const clientEvent = redactEventForRenderer(event);
  hub.publish({ ...clientEvent, sessionId, event: clientEvent, ...fields });
}

export function createTurnExecutor(deps) {
  const turns = new Map();

  const histories = new Map();
  const bindings = new Map();
  const wireNotes = createWireNoteMemory();
  const log = createLogger('host-input');
  // Context recovery of a terminal error (context-recovery.ts); without a recovery factory the
  // listener behaves as before.
  const recovery = deps.getRecoveryRollover ? createHostContextRecovery({ getRollover: deps.getRecoveryRollover,
    isRecoverable: deps.isContextRecoveryOpen, isErrorSuppressed: deps.isSessionErrorSuppressed,
    publish: (id, event, fields) => publishAgentEvent(deps.hub, id, event, fields), log }) : null;
  // The auto-resume bookkeeping steps of the desktop's event preparation (sessionEventAutoResumeSteps.ts),
  // over the auto-resume runtime (auto-resume.ts). The failed-turn assistant pairing map is the
  // desktop's; the Host only keeps it so a new turn drops a stale entry, as there.
  const pendingFailedTurnAssistantPersistId = new Map();
  function autoResumeStepDeps() {
    const autoResume = deps.getAutoResume?.();
    return autoResume ? { autoResumeBookkeeping: autoResume.autoResumeBookkeeping, pendingFailedTurnAssistantPersistId,
      silentStopAutoResumeGuard: autoResume.silentStopAutoResumeGuard,
      interruptedTurnAutoResumeGuard: autoResume.interruptedTurnAutoResumeGuard, usageLimitAutoResume: undefined } : null;
  }
  function historyFor(id) {
    let history = histories.get(id);
    if (!history) {
      history = createHostEventPersistence({ getOwner: deps.getOwner, isCurrent: deps.isCurrent,
        persistMessage: deps.persistMessage, publish: event => deps.hub.publish(event),
        onPersistenceError: error => {
          const turn = turns.get(id);
          if (turn) turn.persistenceError = errorText(error);
          deps.onPersistenceError(id, errorText(error));
        },
      });
      histories.set(id, history);
    }
    return history;
  }

  // The Git baseline of one turn, settled as the desktop's event delivery settles it
  // (sessionEventDelivery.ts: a done takes the after-edit savepoint, a terminal error cancels the
  // baseline), each at most once for this turn of this instance. A failed turn that reports its
  // error and then its done settles both, as there. A stop the Host settles itself takes the
  // savepoint once the engine is idle and closes both, so a late done or error of the stopped
  // turn takes nothing from the next turn's baseline.
  function settleGitBaseline(sessionId, turn, kind) {
    const git = turn.gitBaseline;
    // Only this turn's accepted dispatch can own a baseline. Host-originated
    // adapters may deliver terminals without having opened one.
    if (!git) return;
    const snapshot = deps.getGitSnapshot?.();
    if (kind === 'end') {
      if (git.ended) return;
      git.ended = true;
      void snapshot?.onTurnEnd(sessionId);
    } else if (kind === 'abort') {
      if (git.aborted || git.ended) return;
      git.aborted = true;
      snapshot?.onTurnAbort(sessionId);
    } else {
      if (!git.aborted && !git.ended) void snapshot?.onTurnEnd(sessionId);
      git.aborted = git.ended = true;
    }
  }

  function startGitBaseline(sessionId, signal) {
    const turn = turns.get(sessionId);
    const snapshot = deps.getGitSnapshot?.();
    if (!turn || !snapshot) return;
    turn.gitBaseline = { aborted: false, ended: false };
    return snapshot.onTurnStart(sessionId, signal);
  }

  // recoveryOwnsError: context recovery claimed this terminal error and writes its row if it fails.
  function finish(sessionId, turn, error, event, recoveryOwnsError = false) {
    if (turn.terminal) return turn.settlement;
    turn.terminal = true;
    // A stop the engine acknowledged without a terminal event: the engines' stop paths end in a
    // done on the desktop, which takes the after-edit savepoint there.
    if (!event && !error && turn.abortRequested && !deps.isStoppingRuntime()) settleGitBaseline(sessionId, turn, 'stopped');
    turn.endedAt = Date.now();
    turn.interruptedByShutdown = deps.isStoppingRuntime();
    const history = historyFor(sessionId);
    history.flushAssistantBlock(sessionId);
    history.flushOrphanToolResults(sessionId, event?.agentMeta ?? null);
    if (error && !recoveryOwnsError) {
      // As the desktop's terminal stage (sessionEventTerminal.ts): while an automatic resume holds this
      // error (pending or deferred, sessionErrorSuppression.ts), its row is not written; the bookkeeping
      // keeps it, with the turn's start for the clear cap, and writes it once if the resume gives up.
      if (event && deps.isSessionErrorSuppressed?.(sessionId, event) === true && deps.holdSuppressedError) {
        history.saveTurnStartedAtForDeferred(sessionId);
        deps.holdSuppressedError(sessionId, { ...event.data, message: error });
      } else {
        history.onTurnErrorEvent(sessionId, { ...event?.data, message: error }, event?.agentMeta ?? null);
        // A new terminal replaces an older interruption's replacement (sessionEventTerminal.ts).
        if (event && isTerminalTurnErrorEvent(event)) autoResumeStepDeps()?.autoResumeBookkeeping.discardReplacementProvenByProviderEvent(sessionId);
      }
    }
    if (error) history.persistCodexPlanOnTerminalError(sessionId);
    else if (event) history.persistCodexPlanOnDone(sessionId, event.data);
    history.preserveTurnPersistStateForBackground(sessionId);
    history.resetTurnPersistState(sessionId);
    turn.settlement = history.drain().then(async () => {
      if (!history.hasFailedWrites() && !turn.persistenceError && !turn.interruptedByShutdown && deps.isCurrent()) {
        try { await deps.markEnded?.(sessionId, turn.endedAt); }
        catch (failure) { turn.persistenceError = errorText(failure); deps.onPersistenceError(sessionId, turn.persistenceError); }
      }
      turn.running = false;
      if (turns.get(sessionId) === turn) {
        // Some providers become idle after abort without emitting done. Publish
        // the settled input receipt after persistence drains, never fake a
        // successful provider result or close another queued input's stream.
        if (!event && turn.abortRequested && typeof turn.clientId === 'string'
          && !turn.interruptedByShutdown && deps.isCurrent()) {
          deps.hub.publish({ type: 'input_receipt', sessionId, inputClientId: turn.clientId,
            clientId: turn.clientId, status: 'interrupted' });
        }
        deps.onTerminal(sessionId, error ? 'error' : 'done', error, turn.terminalMeta, turn.direct === true,
          turn.terminalHandedOver === true);
      }
    });
    return turn.settlement;
  }

  // Desktop's exact-instance binding (sessionBindingLifecycle.ts): when the bound
  // instance closes, the snapshot state is released, then the unfinished turn
  // change record; a replaced instance only drops its record, and a late close of
  // an instance that is no longer bound changes nothing.
  function releaseBinding(sessionId) {
    if (!bindings.has(sessionId)) return;
    deps.getGitSnapshot?.()?.onSessionClosed(sessionId);
    clearPendingTurnChangeSets(sessionId);
  }

  // Claude's background-activity detection (claude-session-background-activity.ts) reads the logical
  // turn's start and end at the desktop's points: a running status of the foreground turn starts it
  // (sessionEventPreparation.ts); a done, a terminal error or a foreground running=false status ends
  // it, refreshing the background command work (sessionEventDelivery.ts); a task update refreshes
  // that work. Idle release reads the result (idle-release.ts). A silent-stop done ends the turn
  // here: the Host has no silent-stop resume yet, so nothing continues it.
  function noteBackgroundActivity(session, event) {
    const continuation = isTurnContinuationBoundaryEvent(event);
    if (event.type === 'status' && event.data?.isRunning === true && event.turnScope !== 'background') {
      noteClaudeSessionTurnState(session.id, true);
    } else if ((event.type === 'done' && !continuation) || isTerminalTurnErrorEvent(event)
      || (event.type === 'status' && event.data?.isRunning === false && !continuation && event.turnScope !== 'background')) {
      syncBackgroundCommandWork(session);
      noteClaudeSessionTurnState(session.id, false);
    } else if (event.type === 'agent_task_update') {
      syncBackgroundCommandWork(session);
    }
  }

  // As the desktop's event preparation (sessionEventPreparation.ts) hands a terminal to the input
  // coordinator: a product done (not a continuation boundary, not a silent-stop done, which the
  // desktop decides on later) and a terminal error with its message and structured signals. The
  // desktop leaves out the planned close of a remote daemon; the Host runs no remote tasks.
  // Whether the terminal is this input's and current is the coordinator's own decision
  // (shouldIgnoreUnownedTerminal, isFencedStaleTerminal).
  function handTerminalToCoordinator(sessionId, event) {
    if (!deps.handTerminal) return false;
    const meta = { sessionTurnGeneration: event.sessionTurnGeneration, sessionInstanceId: event.sessionInstanceId };
    if (event.type === 'done') {
      if (isTurnContinuationBoundaryEvent(event) || event.data?.silentStop === true) return false;
      deps.handTerminal(sessionId, 'done', undefined, undefined, meta);
      return true;
    }
    if (!isTerminalTurnErrorEvent(event)) return false;
    const { message, signals } = readTerminalTurnErrorSignals(event, redactEventForRenderer(event));
    deps.handTerminal(sessionId, 'error', message, signals, meta);
    return true;
  }

  // The desktop's preparation steps that come before it hands a terminal to the coordinator
  // (sessionEventPreparation.ts :219, :363, :409, :483): the first event of a resume's attempt, a
  // foreground running status starting a new attempt, a done or terminal error settling it.
  function noteAutoResumeEventBeforeTerminal(session, event) {
    const steps = autoResumeStepDeps();
    if (!steps) return;
    if (typeof event.turnAttemptToken === 'number') steps.interruptedTurnAutoResumeGuard.noteAttemptEvent(session.id, event.turnAttemptToken);
    if (event.type === 'status' && event.data && isForegroundRunningStatus(event.data, event)) {
      // The turn's start for the clear cap is noted by the Host at dispatch (beginHostTurn, the send
      // transaction); subagent observation is the desktop's renderer feature.
      noteForegroundTurnStarted(steps, session, event, { noteTurnStarted: () => {}, noteSubagentObservationTurnStarted: () => {} });
    }
    if (event.type === 'done') settleAutoResumeAttemptOnDone(steps, session, event, isTurnContinuationBoundaryEvent(event));
    if (isTerminalTurnErrorEvent(event)) settleAutoResumeAttemptOnTerminalError(steps, session, event);
  }

  function listen(sessionId, session) {
    if (bindings.get(sessionId)?.session === session) return;
    if (bindings.has(sessionId)) clearPendingTurnChangeSets(sessionId);
    bindings.get(sessionId)?.unsubscribe();
    const history = historyFor(sessionId);
    history.noteSessionAgentKind(sessionId, dbKind(session.agentKind ?? turns.get(sessionId)?.dbKind));
    deps.interactions?.attach(session, sessionId, { history, isCurrent: deps.isCurrent,
      isPaused: () => deps.isExecutionPaused?.(sessionId) === true });
    // As the desktop wires a runtime (register.ts): the owner it was wired under, which a runtime's own
    // Plan change is saved for.
    const ownerDb = deps.getOwner?.() ?? null;
    const unsubscribe = session.onEvent(event => {
      // As the desktop's emitWiredSessionEvent: a Plan mode the runtime changed itself is saved (behind
      // the task's permission queue, only while the owner, this binding and the runtime's value hold), in
      // or out of a turn, and is not delivered as a turn event.
      if (event.type === 'plan_mode_changed') {
        deps.persistAgentPlanModeChange?.({ ownerDb, sessionBindings: { getSession: id => bindings.get(id)?.session } }, session, event);
        return;
      }
      // The coordinator gets a terminal before the Host's own turn filters below, which only keep the
      // Host's records, publishing and rows: a follow-up of Session.holdEventStream was handled by the
      // host that held it (as the desktop), and an owner that is not current has its coordinator closing.
      const prepared = !event.hostProjection && deps.isCurrent();
      if (prepared) noteAutoResumeEventBeforeTerminal(session, event);
      const handedOver = prepared && handTerminalToCoordinator(sessionId, event);
      const turn = turns.get(sessionId);
      if (!turn || turn.session !== session || !deps.isCurrent()) return;
      // The context usage a status event carries, decided as the desktop decides it
      // (sessionEventPreparation.ts: before its turn bookkeeping, from the shared rules) and written
      // once the event is delivered, as the desktop writes it (sessionEventSnapshots.ts). The
      // `event.data` check is the Host's own guard (the desktop reads a status event's data as
      // present); a status without data carries no snapshot either way.
      const contextSnapshot = event.type === 'status' && event.data
        ? contextSnapshotForStatus(isContextCompactionSnapshot(session, event, event.data), event.data)
        : null;
      const recordContextSnapshot = () => {
        if (contextSnapshot) void recordHostContextSnapshot(sessionId, contextSnapshot.contextTokens, contextSnapshot.contextWindow);
      };
      if (event.turnScope !== 'background') {
        if (event.hostProjection) return;
        if (typeof event.sessionTurnGeneration === 'number' && (typeof turn.generation === 'number'
          ? event.sessionTurnGeneration !== turn.generation : event.sessionTurnGeneration === turn.previousGeneration)) return;
        noteBackgroundActivity(session, event);
        if (turn.terminal) {
          recordContextSnapshot();
          // The turn has ended for the Host; only its Git baseline still listens.
          if (event.type === 'done' && !isTurnContinuationBoundaryEvent(event)) settleGitBaseline(sessionId, turn, 'end');
          else if (isTerminalTurnErrorEvent(event)) settleGitBaseline(sessionId, turn, 'abort');
          return;
        }
      }
      if (event.turnScope === 'background') noteBackgroundActivity(session, event);
      if (event.type === 'compact_boundary') wireNotes.reset(sessionId);
      // Desktop records Codex's native turn diff from the event stream (register.ts)
      // and closes the turn change record at the turn's end (sessionEventPreparation.ts).
      noteTurnDiffEvent(sessionId, event, session.remoteHostId !== null);
      // As the desktop (sessionEventPreparation.ts): the diff is kept by the change record only; it is
      // not saved as history or sent to clients (it can be several megabytes).
      if (event.type === 'turn_diff') return;
      if (turn.changeRecordStarted && event.type === 'done' && !isTurnContinuationBoundaryEvent(event)) {
        const rawTurn = event.data?.raw;
        // Desktop settles a silent-stop done once its guard declines to resume
        // (settleSilentStopDone); the Host has no auto-resume, so it settles now.
        if (event.data?.silentStop === true) void finalizeTurnChangeSet(sessionId, null, 'complete');
        else void finalizeTurnChangeSet(sessionId, typeof rawTurn?.id === 'string' ? rawTurn.id : null,
          rawTurn && rawTurn.status !== 'completed' ? 'partial' : 'complete');
      }
      if (turn.changeRecordStarted && isTerminalTurnErrorEvent(event)) void finalizeTurnChangeSet(sessionId, null, 'partial');
      const stream = history.event(session, event);
      // As the desktop's preparation, after the event's bookkeeping: substantive output proves a resume.
      const steps = autoResumeStepDeps();
      if (steps) noteAutoResumeProgress(steps, session, event);
      // As the desktop (sessionEventDelivery.ts): a turn that ended on a rejected Cindy AI Key
      // reports the current key, which resynchronizes the credentials.
      const gatewayKeyRejected = isGatewayProxyTokenRecoveryErrorEventForProvider(getSessionProvider(sessionId), event);
      if (gatewayKeyRejected) deps.reportAgentCindyGatewayKeyRejected?.();
      const fields = { ...stream, inputClientId: turn.clientId, ...(turn.resumeOf ? { autoResumeOf: turn.resumeOf } : {}) };
      // A terminal error the coordinator took over for an automatic resume (handed over above): its
      // clients see it with the takeover, as the desktop's window sees the error and the activity row,
      // and a stream that waits for this input follows the resume instead of ending here.
      if (handedOver && event.turnScope !== 'background' && isTerminalTurnErrorEvent(event)) {
        const pending = deps.autoResumePendingOf?.(sessionId, turn.resumeOf ?? turn.clientId);
        if (pending) fields.autoResumePending = pending;
      }
      // Recovery claims a turn's terminal error synchronously, after the coordinator has it (above), as on
      // the desktop: its preparation hands it over first, its delivery and terminal stages claim it.
      const recoveryTerminal = recovery && event.type === 'error' && isTerminalTurnErrorEvent(event)
        && event.turnScope !== 'background'
        ? { session, event, history, fields, isStopping: deps.isStoppingRuntime(), isGatewayProxyTokenRecovery: gatewayKeyRejected }
        : null;
      const claim = recoveryTerminal ? recovery.claim(recoveryTerminal) : 'idle';
      if (claim === 'idle') publishAgentEvent(deps.hub, sessionId, event, fields);
      recordContextSnapshot();
      // Desktop takes the after-edit savepoint once the event is delivered (sessionEventDelivery.ts).
      if (event.type === 'done' && !isTurnContinuationBoundaryEvent(event)) settleGitBaseline(sessionId, turn, 'end');
      if (isTerminalTurnErrorEvent(event)) settleGitBaseline(sessionId, turn, 'abort');
      if ((event.type === 'done' || isTerminalTurnErrorEvent(event))
        && event.turnScope !== 'background' && !isTurnContinuationBoundaryEvent(event)) {
        turn.terminalMeta = { sessionTurnGeneration: event.sessionTurnGeneration,
          sessionInstanceId: event.sessionInstanceId };
        // A resumed turn that ended without another takeover answered the input it continued.
        if (turn.resumeOf !== undefined && !fields.autoResumePending) deps.resumeAnswered?.(sessionId, turn.resumeOf);
        const error = event.type === 'error'
          ? event.data?.message || event.message || (typeof event.data === 'string' ? event.data : 'Agent error')
          : undefined;
        // The coordinator has this terminal already; finish then only wakes it once the rows settle.
        if (handedOver) turn.terminalHandedOver = true;
        void finish(sessionId, turn, error, event, claim !== 'idle');
        if (claim !== 'idle') recovery.settle(recoveryTerminal, claim, () => turn.settlement);
      }
    });
    const unsubscribeStatus = session.onStatusChange?.(status => {
      if (status === 'closed' && bindings.get(sessionId)?.session === session) releaseBinding(sessionId);
    });
    bindings.set(sessionId, { session, unsubscribe: () => { unsubscribe(); unsubscribeStatus?.(); } });
  }

  async function readExecutionSession(id) {
    deps.assertCurrent();
    const row = await deps.readSession(id);
    deps.assertCurrent();
    assertHostTaskExecutionSupported(row);
    deps.assertProviderExecutionSupported?.(id, row.providerId);
    return row;
  }

  // As the desktop's bootstrapSession (register.ts) once the runtime has started: the task row takes the
  // start's provider (a route the start admission rerouted or pinned included), and a failed write
  // refuses the start. The Host has no temporary runtime override, so the start's provider is written.
  async function persistStartedSessionProvider(session, opts, assertAccess) {
    try {
      const db = getDbClient().drizzle;
      await persistAndHydrateSessionProvider({
        sessionId: session.id,
        providerId: opts.providerId,
        updateProviderId: async (targetSessionId, providerId) => {
          deps.assertCurrent();
          await db.update(sessions).set({ providerId }).where(eq(sessions.id, targetSessionId));
        },
        readProviderId: async (targetSessionId) => {
          const [pRow] = await db
            .select({ providerId: sessions.providerId })
            .from(sessions)
            .where(eq(sessions.id, targetSessionId))
            .limit(1);
          return pRow?.providerId;
        },
        hydrateSessionProvider: (...args) => { assertAccess?.(); hydrateSessionProvider(...args); },
      });
    } catch (err) {
      log.warn('session provider persistence failed; refusing task startup', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // A duplicate create can reuse a running Session; do not interrupt its turn.
      await deps.getMaker().closeSessionIfCurrent(session, 'requested', { onlyIfIdle: true }).catch((closeError) => {
        log.warn('failed to close task after provider persistence failure', {
          sessionId: session.id, error: String(closeError),
        });
      });
      throwIpcError('PRECONDITION_FAILED', 'Could not save the selected model provider. Retry the task.');
    }
  }

  async function readAutoReviewHistory(id) {
    deps.assertCurrent();
    await historyFor(id).drain();
    deps.assertCurrent();
    const rows = await (deps.readAuthorizationHistory
      ? deps.readAuthorizationHistory(id)
      : listMessagesForAgentHandoff(id, null, undefined, 'authorization'));
    deps.assertCurrent();
    return rows;
  }

  // A runtime refresh occurs inside an active send transaction. It must never
  // settle that input, delete its turn, or clear its persisted reply state.
  async function closeRuntime(id, onlyIfCurrent = false) {
    const maker = deps.getMaker();
    const session = maker.getSession(id);
    deps.interactions?.detach(id);
    // The bound instance closes here; release it before the binding goes away.
    releaseBinding(id);
    bindings.get(id)?.unsubscribe();
    bindings.delete(id);
    wireNotes.reset(id);
    if (onlyIfCurrent && session) await maker.closeSessionIfCurrent(session, 'runtime-refresh');
    else await maker.closeSession(id);
  }

  function bindTurnSession(id, session) {
    const turn = turns.get(id);
    turn?.check();
    if (turn) { turn.session = session; turn.dbKind = dbKind(session.agentKind); }
    listen(id, session);
  }

  // The desktop's write FIFO does not pause on a failed write (messagePersistBroadcaster.ts
  // enqueueDurableWrite pauses only when given onPersistenceError, which the desktop never passes);
  // the Host's pauses the task's reply writes after one, until it is retried. Used for two reads (the
  // plan snapshot, the goal note) and two best-effort writes (clearing a sealed plan, recording the
  // turn's model and its model-change card): they wait behind the task's writes, as on the desktop,
  // and their failure goes back to the caller (which skips the note or logs) without pausing the task.
  function behindDurableWrites(id, label, fn) {
    return historyFor(id).enqueueDurableWrite(label, () => Promise.resolve().then(fn)
      .then(value => ({ value }), error => ({ error })))
      .then(result => { if ('error' in result) throw result.error; return result.value; });
  }

  const reconcileCreateOptsWithDb = createSessionOptionsReconciler({ log, readSession: readExecutionSession });
  // The desktop's working-directory check and recovery (working-directory.ts).
  const workingDirectory = createHostWorkingDirectory({
    stat: deps.statDirectory,
    readBoundWorkingDir: async id => [deps.getMaker().getSession(id)?.workDir || null,
      await readExecutionSession(id).then(row => row.workingDir ?? null, () => null)],
    listActiveSessions: () => deps.getMaker().listActiveSessions?.() ?? [],
    log,
  });
  const statDirectory = workingDirectory.statDirectory;
  const transactionDeps = {
    // A model or engine the user picked lands when the message is sent, before the runtime is read
    // (makerSendTransaction.ts), with the desktop's steps (runtime-selection.ts).
    applyPendingAgentSwitch: deps.applyPendingAgentSwitch,
    // A server's OS language is not the remote user's interface preference.
    getResolvedMainLocale: deps.getResolvedMainLocale ?? (() => null),
    getMainClassicalStyle: deps.getMainClassicalStyle ?? (() => DEFAULT_CLASSICAL_REPLY_STYLE),
    readAutoReviewHistory,
    readMcpAppModelContext: deps.readMcpAppModelContext ?? (async () => ({ text: '', async assertCurrent() {}, consume() {} })),
    getSession: id => deps.getMaker().getSession(id),
    closeSession: id => closeRuntime(id),
    closeSessionIfCurrent: id => closeRuntime(id, true),
    preflightBotRuntimeResources: async opts => { await readExecutionSession(opts.id); },
    getSessionMeta: id => deps.getMaker().getSessionMeta(id),
    ensureRemoteReadyForSessionStart: async ({ session, createOpts }) => {
      if (session) assertHostTaskExecutionSupported(session);
      if (createOpts) assertHostTaskExecutionSupported(createOpts);
    },
    checkWorkDirExists: async (id, ...args) => {
      await readExecutionSession(id);
      return workingDirectory.checkWorkDirExists(id, ...args);
    },
    resolveRecoveredWorkingDir: workingDirectory.resolveRecoveredWorkingDir,
    isPersistedWorktreeFallback: workingDirectory.isPersistedWorktreeFallback,
    peekWorkingDirectoryRecoveryNote: workingDirectory.peekWorkingDirectoryRecoveryNote,
    consumeWorkingDirectoryRecoveryNote: workingDirectory.consumeWorkingDirectoryRecoveryNote,
    statDirectory,
    readSessionWorkingDirFromDb: async id => (await readExecutionSession(id)).workingDir ?? null,
    readSessionWorkingDirState: async id => ({ exists: true, workingDir: (await readExecutionSession(id)).workingDir ?? null }),
    // Admission above rejects Orca; ordinary tasks must not enter hydration.
    isOrcaMcpHydrated: () => true,
    synthesizeOrcaVendorOptionsFromDb: async (id, opts) => {
      assertHostTaskExecutionSupported(opts);
      await readExecutionSession(id);
      return false;
    },
    markOrcaRoleIfNeeded: async (_id, orcaRole) => { assertHostTaskExecutionSupported({ orcaRole }); },
    buildCreateOptsWithStderr: createSessionStderrOptions(log),
    readSessionExtraDirsFromDb: deps.readSessionExtraDirs ?? (async () => []),
    readSessionWritableDirsFromDb: deps.readSessionWritableDirs ?? (async () => []),
    withRehydrateCloseSuppressed,
    // assertAccess and nativeHistoryResume as the desktop's bootstrapSession (register.ts) takes them
    // from a committed engine switch (agentSwitchDepsCore.ts createSwitchedSessionBootstrap): the owner
    // check before the start, and a parked native session that must resume or fail (the switch then
    // handles the failure; no fresh start here).
    bootstrapSession: async (opts, assertAccess, nativeHistoryResume = false) => {
      const turn = turns.get(opts.id);
      turn?.check();
      assertAccess?.();
      if (nativeHistoryResume) opts.vendorOptions = { ...opts.vendorOptions, _cindyRequireNativeResume: true };
      const preparing = (async () => {
        const stored = await readExecutionSession(opts.id);
        assertHostTaskExecutionSupported(opts);
        await prepareDirectoryGrantsForBootstrap(opts, {
          // Recovery must never persist unavailable grants as revocations.
          preservePersistedGrants: true,
          statDirectory,
          readPersistedWritableDirs: deps.readSessionWritableDirs ?? (async () => []),
          persistExistingSession: async () => { throw new Error('Host must not rewrite directory grants at startup'); },
        });
        turn?.check();
        // The resume id is known before the start admission reads it: a verified resume of the task's
        // stored route keeps that route (register.ts admitLocalRoute). The admission may reroute
        // `providerId` before createSession freezes it (start-options.ts).
        // Kept for the flow of o.resumeSessionId in the desktop's bootstrapSession, which the admission
        // reads already set. Every current caller brings the task row's id (the shared options
        // reconciler, the cold Pi check, the engine switch, storedSessionOptions), so the fallback to
        // stored.sdkSessionId takes no different value; for that reason no test covers this step alone.
        opts.resumeSessionId = opts.resumeSessionId ?? (opts.agentKind === makerKind(stored.agentKind) ? stored.sdkSessionId || undefined : undefined);
        await deps.admitLocalRoute(opts);
        assertAccess?.();
        turn?.check();
        const session = await deps.getMaker().createSession({ ...opts }, turn?.sendOpts.signal);
        turn?.check();
        await persistStartedSessionProvider(session, opts, assertAccess);
        turn?.check();
        rememberLiveSessionSettings(session, opts);
        setSessionProvider(opts.id, opts.providerId ?? null);
        wireNotes.reset(opts.id);
        bindTurnSession(opts.id, session);
        return { session, didInjectOrcaInstructions: false, didInjectProjectContext: false };
      })();
      if (turn) turn.preparing = preparing;
      return preparing;
    },
    // Runtime creation updates an existing task; it does not create another row.
    broadcastSessionCreated: id => deps.hub.publish({ type: 'session_changed', sessionId: id }),
    prepareSendUserMessage: deps.prepareUserMessage ?? prepareHostUserMessage,
    // The trusted /learn Skill of a persisted user turn, as on the desktop (learn-capture.ts).
    captureCindyLearnInvocation: deps.captureCindyLearnInvocation ?? createHostLearnInvocationCapture({ getMaker: deps.getMaker }),
    // The turn's user row, through the one entry the desktop writes it from (register.ts:17811,
    // createUserMessageDurably): it recharges the resume budgets for a person's message, registers an
    // auto-resume's pending outcome, and writes the row behind the task's reply rows with its
    // transcript anchor. A failed write goes back to the transaction, as on the desktop: it does not
    // pause the task's reply writes and is not written later (auto-resume.ts).
    createDbMessage: async (id, message, options) => {
      const turn = turns.get(id);
      turn?.check();
      const write = deps.getAutoResume?.()?.createUserMessage;
      const row = { ...message, agentKind: turn?.dbKind };
      if (write) return write(id, row, options);
      const history = historyFor(id);
      await history.drain();
      const transcriptParentUuid = history.getLastAssistantTranscriptUuid(id);
      return deps.persistMessage(id, { ...row,
        agentMeta: { ...message.agentMeta, ...(transcriptParentUuid ? { transcriptParentUuid } : {}) } }, options);
    },
    isSessionRunningError,
    reconcileCreateOptsWithDb,
    readWorkingDirectoryRecoveryCreateOpts: async id => {
      const stored = await readExecutionSession(id);
      const turn = turns.get(id);
      // The shared reconciler refreshes execution settings before bootstrap;
      // recovery also needs the current task directory and native identity.
      return { ...turn.createOpts, workingDir: stored.workingDir,
        resumeSessionId: turn.createOpts.agentKind === makerKind(stored.agentKind) ? stored.sdkSessionId || undefined : undefined };
    },
    readScheduledPermissions: async id => {
      const row = await readExecutionSession(id);
      return { permissionMode: row.permissionMode, planModeEnabled: row.planModeEnabled };
    },
    assertScheduledDispatchRoute: async id => { await readExecutionSession(id); },
    beforeProviderStart: async id => {
      const turn = turns.get(id);
      turn.check();
      await turn.sendOpts.beforeProviderStart?.();
      await readExecutionSession(id);
      deps.assertProviderExecutionSupported?.(id, turn.createOpts.providerId);
      turn.check();
      historyFor(id).noteTurnStarted(id);
      await deps.markStarted?.(id);
      turn.check();
    },
    assertBeforeVendorDispatch: id => {
      const turn = turns.get(id);
      turn.check();
      deps.assertProviderExecutionSupported?.(id, turn.createOpts.providerId);
    },
    ackInterruptedTurnDispatched: deps.ackInterruptedTurnDispatched,
    // The pending handoff summary (handoff-pending.ts): sent once with the next accepted send, as
    // on the desktop (register.ts peekPendingHandoff / consumePendingHandoff).
    peekPendingHandoff: deps.pendingHandoff ? id => deps.pendingHandoff.peek(id) : undefined,
    consumePendingHandoff: deps.pendingHandoff ? id => deps.pendingHandoff.consume(id) : undefined,
    isClearBoundaryCurrent: deps.isClearBoundaryCurrent,
    rewindPersistedUserMessageAfterClear: deps.rewindPersistedUserMessageAfterClear,
    readPiUserEntry: deps.readPiUserEntry ? async (id, clientId) => {
      deps.assertCurrent();
      const entry = await deps.readPiUserEntry(id, clientId);
      deps.assertCurrent();
      return entry;
    } : undefined,
    linkPiUserEntry: deps.linkPiUserEntry ? (id, clientId, entryId) =>
      historyFor(id).enqueueDurableWrite(`pi-entry-link:${id}:${clientId}`, async () => {
        deps.assertCurrent();
        try {
          return await deps.linkPiUserEntry(id, clientId, entryId);
        } catch (error) {
          // This optional identity patch follows the accepted user row in the
          // same FIFO. Catch inside it so a failed link cannot pause subsequent
          // reply writes; Desktop likewise falls back to legacy Pi recovery.
          log.warn('send: Pi transcript entry link failed (non-fatal)', {
            sessionId: id, clientId, err: errorText(error),
          });
        }
      }) : undefined,
    readTaskSource: async id => (await readExecutionSession(id)).source ?? null,
    // Sending to an archived task makes it active first (task-restore.ts), as on the desktop.
    restoreArchivedSessionForSend: deps.restoreArchivedSessionForSend,
    // Desktop register.ts: a direct (non-queued) user turn takes the Git baseline
    // before dispatch and drops it when the turn is not dispatched.
    beforeDispatchDirectUserTurn: startGitBaseline,
    onUndispatchedDirectUserTurn: id => { const turn = turns.get(id); if (turn) settleGitBaseline(id, turn, 'abort'); },
    readHostDeviceIdentity: deps.readHostDeviceIdentity,
    planRepeatableWireNotes: (id, notes, options) => wireNotes.plan(id, notes, options),
    // The plan reconciliation and goal notes, read behind the task's durable writes, as register.ts
    // reads them behind its write FIFO (so a reply still being stored is not missed).
    peekPlanReconcileNote: async id => {
      const snapshot = await behindDurableWrites(id, `plan-reconcile-read:${id}`, () => readCodexPlanState(id));
      if (!snapshot) return null;
      if (snapshot.state === 'sealed') return { note: buildCompletedPlanGuardNote(), sealedTurnId: snapshot.turnId };
      const openSteps = snapshot.plan.filter(item => item.status !== 'completed').map(item => item.step);
      if (openSteps.length === 0 && snapshot.state !== 'interrupted') return null;
      return { note: buildPlanReconcileNote({ openSteps, totalSteps: snapshot.plan.length }) };
    },
    consumeSealedPlanReconcileNote: (id, turnId) =>
      behindDurableWrites(id, `plan-seal-consume:${id}:${turnId}`, () => clearSealedCodexPlanState(id, turnId)),
    peekGoalInactiveNote: id => behindDurableWrites(id, `goal-inactive-read:${id}`, () => peekGoalInactiveNote(id)),
    // Which model ran a dispatched user turn, and a model-change card when it changed (turnModelAttribution.ts).
    onModelDispatched: (id, clientId) => createTurnModelAttribution({
      maker: deps.getMaker(), getSessionProvider,
      captureDataOwnerBroadcastScope: () => deps.getOwner?.() ?? null,
      isDataOwnerBroadcastScopeCurrent: owner => (deps.getOwner?.() ?? null) === owner && deps.isCurrent(),
      enqueueDurableWrite: (label, write) => behindDurableWrites(id, label, write),
      patchMessageAgentMeta: async (sessionId, messageClientId, patch) =>
        (await patchMessageAgentMetaWithResultRow(getDbClient(), sessionId, messageClientId, patch)) !== null,
      createDbMessage: (sessionId, body) => deps.persistMessage(sessionId, body),
      log,
    })(id, clientId),
    log,
  };
  const transaction = createMakerSendTransaction(transactionDeps);

  function assertSteerCurrent(id, opts) {
    deps.assertCurrent();
    opts.signal?.throwIfAborted();
    if (opts.expectedClearBoundaryMs !== undefined
      && !deps.isClearBoundaryCurrent(id, opts.expectedClearBoundaryMs, opts.expectedInputGeneration)) {
      throw new Error('[STALE_INPUT] Task history changed before steer delivery');
    }
    if (opts.expectedInputGeneration !== undefined
      && !deps.isInputGenerationCurrent(id, opts.expectedInputGeneration)) {
      throw new Error('[STALE_INPUT] Input generation changed before steer delivery');
    }
  }

  const steerTransaction = createMakerSteerTransaction({
    maker: {
      getSession: id => deps.getMaker().getSession(id),
      getSessionMeta: id => deps.getMaker().getSessionMeta(id),
    },
    assertInputAllowed: async id => { await readExecutionSession(id); },
    assertInputCurrent: assertSteerCurrent,
    prepareUserMessageForAgent: deps.prepareUserMessage ?? prepareHostUserMessage,
    readReplyQuoteNote,
    readAutoReviewHistory,
    readSessionSource: async id => (await readExecutionSession(id)).source ?? null,
    getHostSourceDevice: () => deps.readHostDeviceIdentity?.(),
    getResolvedMainLocale: deps.getResolvedMainLocale ?? (() => null),
    getMainClassicalStyle: deps.getMainClassicalStyle ?? (() => DEFAULT_CLASSICAL_REPLY_STYLE),
    wireNoteMemory: wireNotes,
    // Host has no input-handoff service yet, so no pending handoff note exists.
    inputHandoffSteerNote: () => null,
    inputHandoffNoteDelivered: () => {},
    mcpAppModelContext: deps.readMcpAppModelContext ?? (async () => ({ text: '', async assertCurrent() {}, consume() {} })),
    publishUiSessionIntervention,
    log,
  });

  async function steer(id, message, opts) {
    opts.signal?.throwIfAborted();
    await opts[MCP_APP_MESSAGE_GUARD]?.();
    await opts.beforeProviderStart?.();
    assertSteerCurrent(id, opts);
    const session = deps.getMaker().getSession(id);
    if (!session) throw new Error('NO_ACTIVE_TURN');
    const generation = session.getTurnGeneration();
    const assertTurnCurrent = () => {
      assertSteerCurrent(id, opts);
      if (deps.getMaker().getSession(id) !== session || session.getTurnGeneration() !== generation) {
        throw new Error('[STALE_TURN] Session changed turns before steer delivery');
      }
    };
    // Bind before any async normalization/history IO. The common transaction
    // and the provider-start hook both reject a replacement turn or owner.
    await steerTransaction(id, message, { ...opts,
      expectedTurnSession: opts.expectedTurnSession ?? session,
      expectedTurnGeneration: opts.expectedTurnGeneration ?? generation,
      [AUTO_REVIEW_DELEGATED_CONTINUATION]: opts[AUTO_REVIEW_DELEGATED_CONTINUATION] === true
        || typeof opts[MCP_APP_MESSAGE_GUARD] === 'function' ? true : undefined,
      beforeProviderStart: async () => {
        await opts.beforeProviderStart?.();
        assertTurnCurrent();
      },
    });
  }

  // The record a dispatched turn runs under. The listener only accepts events of the record's
  // instance and generation (listen), and the shared transaction's hooks read it (turns.get), so
  // every dispatch, an input's send or a context recovery's replay, opens one.
  function openTurn(sessionId, createOpts, sendOpts, clientId) {
    // Until this turn reserves its own generation, events of the previous one are recognised by theirs.
    const turn = { running: true, terminal: false, dbKind: dbKind(createOpts.agentKind),
      createOpts, sendOpts, clientId, previousGeneration: turns.get(sessionId)?.generation };
    turns.set(sessionId, turn);
    turn.check = () => {
      deps.assertCurrent();
      sendOpts.signal?.throwIfAborted();
      if (turns.get(sessionId) !== turn) throw new Error('input runtime was replaced');
    };
    return turn;
  }

  // Runs the shared send transaction for a turn once it is prepared, binding the instance and
  // generation it reserves (bindTurnSession listens to that instance). A dispatch that throws
  // leaves the record not running.
  async function dispatchTurn(sessionId, turn, message, dispatch) {
    try {
      await turn.preparing;
      turn.check();
      return await dispatch(sessionId, message, turn.createOpts, {
        ...turn.sendOpts,
        onVendorTurnReserved: generation => {
          turn.check();
          bindTurnSession(sessionId, deps.getMaker().getSession(sessionId));
          turn.generation = generation;
          turn.sendOpts.onVendorTurnReserved?.(generation);
        },
      });
    } catch (error) {
      turn.running = false;
      throw error;
    }
  }

  // As the desktop's sendToAgentAccepted (register.ts), every send of a task runs under that
  // task's send lock, shared with the entries that change its runtime or route
  // (session-route-lock.mjs) and with context recovery. Held until the send is accepted or refused.
  function send(sessionId, message, createOpts, sendOpts) {
    return withSendToSessionLock(sessionId, () => sendUnlocked(sessionId, message, createOpts, sendOpts));
  }

  async function sendUnlocked(sessionId, message, createOpts, sendOpts) {
    createOpts = { ...createOpts };
    const turn = openTurn(sessionId, createOpts, sendOpts, sendOpts.persistUserMessage?.clientId);
    // An automatic resume continues an earlier input whose stream (/api/chat) still waits for it.
    if (sendOpts.persistUserMessage?.autoResume === true) turn.resumeOf = deps.resumeOriginOf?.(sessionId);
    const check = turn.check;
    turn.preparing = (async () => {
      await sendOpts[MCP_APP_MESSAGE_GUARD]?.();
      const stored = await readExecutionSession(sessionId);
      const queuedPlan = createOpts.planMode;
      await reconcileCreateOptsWithDb(sessionId, createOpts);
      // Every input retains its enqueue-time Plan intent, as on Desktop. The
      // shared transaction reconciles a copy for cold bootstrap separately.
      createOpts.planMode = queuedPlan;
      createOpts.workingDir = stored.workingDir || '';
      turn.dbKind = dbKind(createOpts.agentKind);
      check();
      assertHostTaskExecutionSupported(createOpts);
      deps.assertProviderExecutionSupported?.(sessionId, createOpts.providerId);
      check();
      let session = deps.getMaker().getSession(sessionId);
      if (session?.agentKind && session.agentKind !== createOpts.agentKind) {
        await closeRuntime(sessionId);
        check();
        session = null;
      }
      if (session) {
        await applyQueuedSessionSettings(session, createOpts, stored);
        check();
        bindTurnSession(sessionId, session);
      }
      setSessionProvider(sessionId, createOpts.providerId ?? null);
    })();
    const result = await dispatchTurn(sessionId, turn, message,
      (...args) => transaction.sendToAgentAccepted(...args));
    try {
      if (!result.accepted) {
        turn.running = false;
        if (deps.isCurrent()) await deps.markEnded?.(sessionId, Date.now());
      } else if (deps.isCurrent() && deps.sent) {
        // Acceptance is irreversible. A failed draft promotion is a pending
        // durable write, not a failed send: pause and retry only the write.
        await historyFor(sessionId).enqueueDurableWrite(`draft-commit:${sessionId}`,
          () => deps.sent(sessionId)).catch(() => {});
      }
      return result.outcome;
    } catch (error) {
      turn.running = false;
      throw error;
    }
  }

  // A context recovery's replay of the user's message (contextRecoveryAssembly.ts
  // replayContextRecoveryWithPorts, the desktop's sendToAgentAcceptedUnlocked): a turn of its own
  // through the same shared transaction, with no input-queue item, no new user row and no send lock
  // (recovery holds it). Recovery has closed the task's runtime and waited for the claimed turn's
  // settlement before it replays; a turn of the task still running, or a live runtime, means
  // something started since, so the replay is refused. As on the desktop, its Git baseline is the
  // transaction's: a replay has no persistUserMessage, so beforeDispatchDirectUserTurn opens it and
  // onUndispatchedDirectUserTurn drops it when the replay is refused or fails. Its turn carries the
  // claimed input's client id, only to stamp its events and receipts (Host-only: /api/chat ends a
  // message's stream on a terminal of its own client id); no user row is written for it.
  async function replay(sessionId, message, createOpts, sendOpts = {}) {
    if (turns.get(sessionId)?.running || deps.getMaker().getSession(sessionId)) return { accepted: false };
    createOpts = { ...createOpts };
    const turn = openTurn(sessionId, createOpts, sendOpts, recovery?.replayClientId(sessionId));
    turn.preparing = (async () => {
      await readExecutionSession(sessionId);
      assertHostTaskExecutionSupported(createOpts);
      deps.assertProviderExecutionSupported?.(sessionId, createOpts.providerId);
      turn.check();
    })();
    const result = await dispatchTurn(sessionId, turn, message, (...args) => transaction.sendToAgentAccepted(...args));
    if (!result.accepted) {
      turn.running = false;
      if (deps.isCurrent()) await deps.markEnded?.(sessionId, Date.now());
    }
    return result;
  }

  return {
    send,
    /**
     * What starting a task's runtime outside a turn reads, as the desktop binds the same functions
     * for the send transaction and for a cold Pi runtime's window check (register.ts
     * createColdPiRehydrationForWindowVerification): the start options with the stderr capture, the
     * working directory check, the Orca and directory option preparation, and the bootstrap, which
     * creates the runtime and listens to it as a send does.
     */
    startPorts: {
      buildCreateOptsWithStderr: transactionDeps.buildCreateOptsWithStderr,
      checkWorkDirExists: transactionDeps.checkWorkDirExists,
      synthesizeOrcaVendorOptionsFromDb: transactionDeps.synthesizeOrcaVendorOptionsFromDb,
      readSessionExtraDirsFromDb: transactionDeps.readSessionExtraDirsFromDb,
      readSessionWritableDirsFromDb: transactionDeps.readSessionWritableDirsFromDb,
      ensureRemoteReadyForSessionStart: transactionDeps.ensureRemoteReadyForSessionStart,
      bootstrapSession: transactionDeps.bootstrapSession,
      broadcastSessionCreated: transactionDeps.broadcastSessionCreated,
    },
    /** The engine of a task as its message persistence knows it (the desktop's getSessionDbAgentKind). */
    sessionDbAgentKind: id => histories.get(id)?.getSessionDbAgentKind(id) ?? null,
    /** Rows of a task's turn not in the database yet, as the history view shows them (the desktop's
     * getSessionThinkingSnapshots, which its history view reads, bootstrap-electron.ts readHistoryLiveMessages). */
    liveHistory: id => histories.get(id)?.getSessionThinkingSnapshots(id) ?? [],
    /** On shutdown, before stopping tasks: waits (bounded) for context recoveries in flight to end. */
    drainRecoveriesForShutdown: () => recovery?.drainForShutdown(),
    /** A recovery's replay was accepted (the recovery factory's onRebuilt). */
    noteRecoveryRebuilt: id => recovery?.noteRebuilt(id),
    replay,
    /** Writes the queued history of every task, as the desktop's drainPersistQueue. */
    async drainHistories() { await Promise.all([...histories.values()].map(history => history.drain())); },
    /** A rebuilt native context has seen no environment notes (contextRecoveryRebuilt). */
    resetWireNotes: id => wireNotes.reset(id),
    /**
     * Closes a task's runtime outside a turn, as a runtime refresh does: the executor lets go of the
     * instance (interactions, binding, environment notes) before Maker closes it. A working-directory
     * move closes an idle runtime this way (session-move.ts).
     */
    closeRuntime: id => closeRuntime(id),
    async beforeDispatchUserTurn(id, item, signal) {
      const turn = turns.get(id);
      const live = deps.getMaker()?.getSession(id);
      if (live) {
        await beginTurnChangeSetAtDispatch(live, item.clientId);
        turn.changeRecordStarted = true;
      }
      turn.check();
      await startGitBaseline(id, signal);
    },
    onUndispatchedUserTurn(id) {
      const turn = turns.get(id);
      if (!turn) return;
      if (turn.changeRecordStarted) clearPendingTurnChangeSets(id);
      settleGitBaseline(id, turn, 'abort');
    },
    wireHostSession(session) {
      deps.assertCurrent();
      if (deps.getMaker()?.getSession(session.id) !== session) throw new Error('Host Session was replaced');
      listen(session.id, session);
    },
    async beginHostTurn(id) {
      deps.assertCurrent();
      const session = deps.getMaker()?.getSession(id);
      if (!session) throw new Error('Host Session is unavailable');
      const previous = turns.get(id);
      const generation = session.getTurnGeneration?.();
      if (previous?.running) {
        if (previous.session === session && previous.generation === generation) return;
        throw new Error('Host turn is already running');
      }
      const turn = { session, generation, direct: true, running: true, terminal: false, dbKind: dbKind(session.agentKind) };
      turns.set(id, turn);
      listen(id, session);
      historyFor(id).noteTurnStarted(id);
      turn.preparing = (async () => {
        await deps.markStarted?.(id);
        deps.assertCurrent();
        if (turns.get(id) !== turn || deps.getMaker()?.getSession(id) !== session) throw new Error('Host Session was replaced');
      })();
      try { await turn.preparing; }
      catch (error) { turn.running = false; throw error; }
    },
    steer,
    readExecutionSession,
    readAutoReviewHistory,
    async restoreSession(id, options, assertCurrent) {
      deps.assertCurrent(); await assertCurrent();
      await readExecutionSession(id);
      assertHostTaskExecutionSupported(options);
      deps.assertProviderExecutionSupported?.(id, options.providerId);
      await assertCurrent();
      const maker = deps.getMaker();
      let session = maker.getSession(id);
      if (!session) {
        // As every runtime start (the bootstrap above): the start admission, then the start's provider
        // on the task row.
        const start = { ...options, id };
        await deps.admitLocalRoute(start);
        deps.assertCurrent(); await assertCurrent();
        session = await maker.createSession({ ...start });
        await persistStartedSessionProvider(session, start);
        rememberLiveSessionSettings(session, start);
      }
      deps.assertCurrent(); await assertCurrent();
      listen(id, session);
      return session;
    },
    enqueueDurableWrite(id, label, fn) { return historyFor(id).enqueueDurableWrite(label, fn); },
    /** A task's event persistence, for the auto-resume runtime (auto-resume.ts) and the reply anchor. */
    autoResumeHistory: id => historyFor(id),
    // The coordinator's hooks for a user turn stored but not dispatched, as register.ts passes them:
    // a retryable error row (the desktop's onTurnErrorEvent with the Pi prompt-timeout reason), and
    // for a Pi prompt timeout, closing the stuck native process (no replay; the user retries).
    // Host-only: the input's interrupted receipt once its error row is stored. /api/chat (chat.mjs)
    // ends a message's stream on it; without it a stream for this input waited for a terminal event
    // that never comes. Only this path sends it: an error claimed by context recovery (or, later,
    // held by an automatic continuation) stores no row here, so that stream stays open.
    persistTerminalSendError(id, message, inputClientId) {
      const history = historyFor(id);
      history.onTurnErrorEvent(id, {
        message, ...(isPiPromptRpcTimeoutError({ message }) ? { reason: 'pi-prompt-timeout' } : {}),
      }, null);
      if (typeof inputClientId !== 'string') return;
      void history.drain().then(() => {
        if (history.hasFailedWrites() || !deps.isCurrent()) return;
        deps.hub.publish({ type: 'input_receipt', sessionId: id, inputClientId, clientId: inputClientId, status: 'interrupted' });
      });
    },
    onPersistedSendRejected(id, message) {
      if (!isPiPromptRpcTimeoutError({ message })) return;
      void closeRuntime(id).catch(error => {
        log.warn('failed to close unhealthy PI session after prompt timeout', { sessionId: id, error: errorText(error) });
      });
    },
    isRunning(id) { return turns.get(id)?.running === true; },
    // The turn has its terminal and its rows are still settling: still running for dispatch (isRunning).
    isSettling(id) { const turn = turns.get(id); return turn?.terminal === true && turn.running === true; },
    isInputRunning(id, clientId) { const turn = turns.get(id); return turn?.clientId === clientId && turn.running; },
    // Context recovery has claimed this input's terminal error and is rebuilding before its replay:
    // the input is still being answered (the replay carries its client id).
    isInputRecovering(id, clientId) { return recovery?.replayClientId(id) === clientId; },
    reconcileIdle(id) {
      const turn = turns.get(id);
      if (!turn?.abortRequested || turn.terminal || turn.session?.isTurnRunning?.() !== false) return false;
      // finish owns the durable terminal and its asynchronous settlement wakes the coordinator. What
      // holds the next input until the rows settle is isRunning (the coordinator rechecks it before any
      // dispatch; input-queue.test.mjs 'the next input is not dispatched before the reply rows settle');
      // this only reports that the turn has not been reconciled, so no idle is claimed while it writes.
      void finish(id, turn);
      return false;
    },
    async abort(id) {
      const turn = turns.get(id);
      if (turn) turn.abortRequested = true;
      // Host-originated plugin/file confirmations are outside Session's own
      // interaction listener. Settle them before awaiting provider shutdown,
      // while retaining the listener needed by the next turn in this task.
      deps.interactions?.cancelHostWaits?.(id);
      await turn?.preparing?.catch(() => {});
      const session = deps.getMaker()?.getSession(id);
      if (session) await session.abort();
      // A failed abort throws above and retains the active boundary/listener.
      // A real maker-core Session can settle abort before the provider is idle.
      if (turn && session?.isTurnRunning?.() !== true) await finish(id, turn);
    },
    async retryPersistence(id) {
      const turn = turns.get(id);
      if (!turn) return;
      const history = historyFor(id);
      await history.drain();
      await history.retryFailedWrites();
      turn.persistenceError = null;
      if (turn.terminal && !turn.interruptedByShutdown) { deps.assertCurrent(); await deps.markEnded?.(id, turn.endedAt); }
    },
    async close(id) {
      deps.interactions?.detach(id);
      const turn = turns.get(id);
      await turn?.settlement;
      const history = histories.get(id);
      await history?.drain();
      if (history?.hasFailedWrites()) throw new Error(turn?.persistenceError || 'Reply persistence is incomplete');
      releaseBinding(id);
      bindings.get(id)?.unsubscribe();
      bindings.delete(id);
      history?.clearSessionPersistState(id);
      histories.delete(id);
      wireNotes.reset(id);
      clearSessionProvider(id);
      // The desktop session runtime cleanup clears the effort axis with the provider.
      setSessionEffort(id, null);
      await deps.getMaker()?.closeSession?.(id);
      turns.delete(id);
    },
  };
}
