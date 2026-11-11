import { createHostEventPersistence } from './event-persistence.ts';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { isTerminalTurnErrorEvent } from '../../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.ts';
import { setSessionProvider, clearSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { toDesktopSessionDispatchOutcome } from '../../../desktop/src/main/maker-host/send-outcome.ts';
import { applyQueuedSessionSettings, rememberLiveSessionSettings } from './session-settings.mjs';
import { MCP_APP_MESSAGE_GUARD } from '../../../desktop/src/main/mcp-apps/message.ts';
import { prependNoteToWireUserMessage, extractPlainText } from '../../../desktop/src/main/maker-ipc/agentHandoff.ts';
import { readWireSourceDevice, buildWireMessageSourceNote } from '../../../desktop/src/main/maker-ipc/messageSourceNote.ts';
import { FORWARDED_REQUEST_RECEIPT } from '../../../desktop/src/shared/forwardedRequest.ts';
import { buildClientEnvironmentNote, shouldPrependMobileClientPromptNote } from '../../../desktop/src/main/maker-ipc/mobileClientPromptNote.ts';
import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT } from '@cindy/maker-core';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, restoreAutoReviewUserIntent } from '../../../desktop/src/main/maker-ipc/autoReviewUserIntent.ts';

const makerKind = kind => kind === 'cc' ? 'claude-code' : kind;
const dbKind = kind => kind === 'claude-code' ? 'cc' : kind;
const errorText = error => error instanceof Error ? error.message : String(error);

/** Authorization inputs the coordinator derives for one send or steer, kept
 * out of the model-facing body. Dropping them makes maker-core fall back to the
 * expanded text, so quoted pages or plugin resources would count as the user's
 * own words in Auto mode. Text an MCP App sends is page content: it is a
 * delegated continuation, and since Host keeps no authored-text history to
 * restore from, it grants nothing (fail closed). */
export function autoReviewAuthorizationOptions(opts) {
  const delegated = opts[AUTO_REVIEW_DELEGATED_CONTINUATION] === true
    || typeof opts[MCP_APP_MESSAGE_GUARD] === 'function';
  const intent = opts[AUTO_REVIEW_USER_INTENT] ?? (delegated ? restoreAutoReviewUserIntent([]) : undefined);
  return {
    ...(opts[AUTO_REVIEW_SOURCE_CONTENT] !== undefined ? { [AUTO_REVIEW_SOURCE_CONTENT]: opts[AUTO_REVIEW_SOURCE_CONTENT] } : {}),
    ...(intent !== undefined ? { [AUTO_REVIEW_USER_INTENT]: intent } : {}),
    ...(delegated ? { [AUTO_REVIEW_DELEGATED_CONTINUATION]: true } : {}),
  };
}

/**
 * Node platform adapter for one maker-core turn. Queue order, recovery and
 * dispatch ownership belong to AgentInputCoordinator, never to this adapter.
 * A terminal is handed back only after all visible reply rows have settled.
 */
export function createTurnExecutor(deps) {
  const turns = new Map();

  const histories = new Map();
  const bindings = new Map();
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

  function finish(sessionId, turn, error, event) {
    if (turn.terminal) return turn.settlement;
    turn.terminal = true;
    turn.endedAt = Date.now();
    turn.interruptedByShutdown = deps.isStoppingRuntime();
    const history = historyFor(sessionId);
    history.flushAssistantBlock(sessionId);
    history.flushOrphanToolResults(sessionId, event?.agentMeta ?? null);
    if (error) history.onTurnErrorEvent(sessionId, { ...event?.data, message: error }, event?.agentMeta ?? null);
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
      if (turns.get(sessionId) === turn) deps.onTerminal(sessionId,
        error ? 'error' : 'done', error, turn.terminalMeta);
    });
    return turn.settlement;
  }

  function listen(sessionId, session) {
    if (bindings.get(sessionId)?.session === session) return;
    bindings.get(sessionId)?.unsubscribe();
    const history = historyFor(sessionId);
    history.noteSessionAgentKind(sessionId, dbKind(session.agentKind ?? turns.get(sessionId)?.dbKind));
    deps.interactions?.attach(session, sessionId, { history, isCurrent: deps.isCurrent,
      isPaused: () => deps.isExecutionPaused?.(sessionId) === true });
    const unsubscribe = session.onEvent(event => {
      const turn = turns.get(sessionId);
      if (!turn || turn.session !== session || !deps.isCurrent()) return;
      if (event.turnScope !== 'background') {
        if (turn.terminal || event.hostProjection) return;
        if (typeof event.sessionTurnGeneration === 'number' && typeof turn.generation === 'number'
          && event.sessionTurnGeneration !== turn.generation) return;
      }
      const stream = history.event(session, event);
      deps.hub.publish({ ...event, sessionId, event, ...stream, inputClientId: turn.clientId });
      if ((event.type === 'done' || isTerminalTurnErrorEvent(event))
        && event.turnScope !== 'background' && !isTurnContinuationBoundaryEvent(event)) {
        turn.terminalMeta = { sessionTurnGeneration: event.sessionTurnGeneration,
          sessionInstanceId: event.sessionInstanceId };
        const error = event.type === 'error'
          ? event.data?.message || event.message || (typeof event.data === 'string' ? event.data : 'Agent error')
          : undefined;
        void finish(sessionId, turn, error, event);
      }
    });
    bindings.set(sessionId, { session, unsubscribe });
  }

  async function send(sessionId, message, createOpts, sendOpts) {
    const turn = { running: true, terminal: false, dbKind: dbKind(createOpts.agentKind),
      clientId: sendOpts.persistUserMessage?.clientId };
    turns.set(sessionId, turn);
    const check = () => {
      deps.assertCurrent();
      sendOpts.signal?.throwIfAborted();
      if (turns.get(sessionId) !== turn) throw new Error('input runtime was replaced');
    };
    turn.preparing = (async () => {
      await sendOpts[MCP_APP_MESSAGE_GUARD]?.();
      await deps.beforeSessionStart?.(sessionId, createOpts.agentKind);
      check();
      const stored = await deps.readSession(sessionId);
      check();
      const maker = deps.getMaker();
      let session = maker.getSession(sessionId);
      if (session?.agentKind && session.agentKind !== createOpts.agentKind) {
        await maker.closeSession(sessionId);
        check();
        session = null;
      }
      if (!session) {
        session = await maker.createSession({ ...createOpts, id: sessionId,
          resumeSessionId: createOpts.agentKind === makerKind(stored.agentKind)
            ? stored.sdkSessionId || undefined : undefined });
        rememberLiveSessionSettings(session, createOpts);
      } else await applyQueuedSessionSettings(session, createOpts, stored);
      check();
      turn.session = session;
      setSessionProvider(sessionId, createOpts.providerId ?? null);
      listen(sessionId, session);
      return session;
    })();
    try {
      const session = await turn.preparing;
      check();
      const delegated = autoReviewAuthorizationOptions(sendOpts)[AUTO_REVIEW_DELEGATED_CONTINUATION] === true;
      // The host-stamped device of a remote input: shown as attribution on the
      // stored row, and told to the model once per message like the desktop does.
      const sourceDevice = readWireSourceDevice(sendOpts.sourceDevice);
      const allowsNotes = shouldPrependMobileClientPromptNote(message, createOpts.agentKind);
      const deviceNote = sourceDevice && allowsNotes
        ? buildClientEnvironmentNote({ device: sourceDevice }) : null;
      // Who sent it (another task, a teammate, a plugin or App, a shared-task
      // member) is told to the model only at dispatch, from the same stamped
      // data the stored row shows; the stored body never contains it.
      const origin = sendOpts.persistUserMessage;
      const sourceNote = allowsNotes
        ? buildWireMessageSourceNote({
            origin: origin?.origin, sourcePlugin: origin?.sourcePlugin,
            sharedTaskAuthor: origin?.sharedTaskAuthor, autoReviewUserText: origin?.[FORWARDED_REQUEST_RECEIPT],
          }, {
            visibleText: origin?.content !== undefined ? extractPlainText(origin.content).trim() : '',
            autoResume: origin?.autoResume === true,
          })
        : null;
      const withSource = sourceNote ? prependNoteToWireUserMessage(message, sourceNote) : message;
      const wireMessage = deviceNote ? prependNoteToWireUserMessage(withSource, deviceNote) : withSource;
      const result = await session.send(wireMessage, { messageUuid: sendOpts.messageUuid,
        ...autoReviewAuthorizationOptions(sendOpts),
        ...(sendOpts.origin ? { origin: sendOpts.origin } : {}),
        signal: sendOpts.signal, onTurnReserved: generation => {
          turn.generation = generation;
          sendOpts.onVendorTurnReserved?.(generation);
        },
        beforeProviderStart: async () => {
          check();
          await sendOpts[MCP_APP_MESSAGE_GUARD]?.();
          await sendOpts.beforeProviderStart?.();
          historyFor(sessionId).noteTurnStarted(sessionId);
          await deps.markStarted?.(sessionId);
          check();
        },
        onAccepted: async signal => {
          check();
          signal?.throwIfAborted();
          const persist = sendOpts.persistUserMessage;
          if (!persist) return;
          persist.onPersisting?.();
          try {
            await deps.persistMessage(sessionId, { clientId: persist.clientId, role: 'user',
              content: persist.content, agentKind: turn.dbKind,
              ...(persist.origin || persist.sourcePlugin || sourceDevice || delegated ? { agentMeta: {
                ...(persist.origin ? { origin: persist.origin } : {}),
                ...(sourceDevice ? { sourceDevice } : {}),
                // Attribution for history reconciliation, not an authorization input.
                ...(persist.sourcePlugin ? { sourcePlugin: persist.sourcePlugin } : {}),
                ...(delegated ? { autoReviewUserText: { kind: 'delegated-continuation' } } : {}),
              } } : {}),
            }, {
              expectedClearBoundaryMs: persist.expectedClearBoundaryMs,
              shouldBroadcast: persist.shouldBroadcast,
            });
          } catch (error) { persist.onPersistFailed?.(); throw error; }
          await persist.onPersisted?.(signal ?? sendOpts.signal);
          check();
        },
      });
      const outcome = toDesktopSessionDispatchOutcome(result, { source: 'host-input', context: 'send' });
      if (!outcome.dispatched) {
        turn.running = false;
        if (deps.isCurrent()) await deps.markEnded?.(sessionId, Date.now());
      } else if (deps.isCurrent() && deps.sent) {
        // Acceptance is irreversible. A failed draft promotion is a pending
        // durable write, not a failed send: pause and retry only the write.
        await historyFor(sessionId).enqueueDurableWrite(`draft-commit:${sessionId}`,
          () => deps.sent(sessionId)).catch(() => {});
      }
      return outcome;
    } catch (error) {
      turn.running = false;
      throw error;
    }
  }

  return {
    send,
    async restoreSession(id, options, assertCurrent) {
      deps.assertCurrent(); await assertCurrent();
      const maker = deps.getMaker();
      let session = maker.getSession(id);
      if (!session) {
        session = await maker.createSession({ ...options, id });
        rememberLiveSessionSettings(session, options);
      }
      deps.assertCurrent(); await assertCurrent();
      listen(id, session);
      return session;
    },
    enqueueDurableWrite(id, label, fn) { return historyFor(id).enqueueDurableWrite(label, fn); },
    isRunning(id) { return turns.get(id)?.running === true; },
    isInputRunning(id, clientId) { const turn = turns.get(id); return turn?.clientId === clientId && turn.running; },
    reconcileIdle(id) {
      const turn = turns.get(id);
      if (!turn?.abortRequested || turn.terminal || turn.session?.isTurnRunning?.() !== false) return false;
      // finish owns the durable terminal. Its asynchronous settlement releases
      // the coordinator; returning true here would let the next input overtake it.
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
      bindings.get(id)?.unsubscribe();
      bindings.delete(id);
      history?.clearSessionPersistState(id);
      histories.delete(id);
      clearSessionProvider(id);
      await deps.getMaker()?.closeSession?.(id);
      turns.delete(id);
    },
  };
}
