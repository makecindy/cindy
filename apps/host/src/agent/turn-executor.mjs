import fs from 'node:fs/promises';
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
import { DEFAULT_CLASSICAL_REPLY_STYLE } from '@cindy/maker-shared/classical-reply';
import { assertHostTaskExecutionSupported, prepareHostUserMessage } from './send-preflight.ts';
import { createHostEventPersistence } from './event-persistence.ts';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { isTerminalTurnErrorEvent } from '../../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.ts';
import { setSessionProvider, clearSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { applyQueuedSessionSettings, rememberLiveSessionSettings } from './session-settings.mjs';
import { MCP_APP_MESSAGE_GUARD } from '../../../desktop/src/main/mcp-apps/message.ts';

const makerKind = kind => kind === 'cc' ? 'claude-code' : kind;
const dbKind = kind => kind === 'claude-code' ? 'cc' : kind;
const errorText = error => error instanceof Error ? error.message : String(error);

/**
 * Node platform adapter for one maker-core turn. Queue order, recovery and
 * dispatch ownership belong to AgentInputCoordinator, never to this adapter.
 * A terminal is handed back only after all visible reply rows have settled.
 */
export function createTurnExecutor(deps) {
  const turns = new Map();

  const histories = new Map();
  const bindings = new Map();
  const wireNotes = createWireNoteMemory();
  const log = createLogger('host-input');
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
      if (turns.get(sessionId) === turn) {
        // Some providers become idle after abort without emitting done. Publish
        // the settled input receipt after persistence drains, never fake a
        // successful provider result or close another queued input's stream.
        if (!event && turn.abortRequested && typeof turn.clientId === 'string'
          && !turn.interruptedByShutdown && deps.isCurrent()) {
          deps.hub.publish({ type: 'input_receipt', sessionId, inputClientId: turn.clientId,
            clientId: turn.clientId, status: 'interrupted' });
        }
        deps.onTerminal(sessionId, error ? 'error' : 'done', error, turn.terminalMeta, turn.direct === true);
      }
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
      if (event.type === 'compact_boundary') wireNotes.reset(sessionId);
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

  async function readExecutionSession(id) {
    deps.assertCurrent();
    const row = await deps.readSession(id);
    deps.assertCurrent();
    assertHostTaskExecutionSupported(row);
    deps.assertProviderExecutionSupported?.(id, row.providerId);
    return row;
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

  const reconcileCreateOptsWithDb = createSessionOptionsReconciler({ log, readSession: readExecutionSession });
  const statDirectory = deps.statDirectory ?? fs.stat;
  const transaction = createMakerSendTransaction({
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
    checkWorkDirExists: async (id, dir) => {
      await readExecutionSession(id);
      if (!dir) return true;
      try { return (await statDirectory(dir)).isDirectory(); }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
        throw error;
      }
    },
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
    bootstrapSession: async opts => {
      const turn = turns.get(opts.id);
      turn?.check();
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
        const session = await deps.getMaker().createSession({ ...opts,
          resumeSessionId: opts.resumeSessionId ?? (opts.agentKind === makerKind(stored.agentKind) ? stored.sdkSessionId || undefined : undefined),
        }, turn?.sendOpts.signal);
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
    createDbMessage: async (id, message, options) => {
      const history = historyFor(id);
      await history.drain();
      const turn = turns.get(id);
      turn?.check();
      const transcriptParentUuid = history.getLastAssistantTranscriptUuid(id);
      return deps.persistMessage(id, { ...message, agentKind: turn?.dbKind,
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
    readHostDeviceIdentity: deps.readHostDeviceIdentity,
    planRepeatableWireNotes: (id, notes, options) => wireNotes.plan(id, notes, options),
    log,
  });

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

  async function send(sessionId, message, createOpts, sendOpts) {
    createOpts = { ...createOpts };
    const turn = { running: true, terminal: false, dbKind: dbKind(createOpts.agentKind),
      createOpts, sendOpts, clientId: sendOpts.persistUserMessage?.clientId };
    turns.set(sessionId, turn);
    const check = () => {
      deps.assertCurrent();
      sendOpts.signal?.throwIfAborted();
      if (turns.get(sessionId) !== turn) throw new Error('input runtime was replaced');
    };
    turn.check = check;
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
      await deps.beforeSessionStart?.(sessionId, createOpts.agentKind);
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
    try {
      await turn.preparing;
      check();
      const result = await transaction.sendToAgentAccepted(sessionId, message, createOpts, {
        ...sendOpts,
        onVendorTurnReserved: generation => {
          check();
          bindTurnSession(sessionId, deps.getMaker().getSession(sessionId));
          turn.generation = generation;
          sendOpts.onVendorTurnReserved?.(generation);
        },
      });
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

  return {
    send,
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
      wireNotes.reset(id);
      clearSessionProvider(id);
      await deps.getMaker()?.closeSession?.(id);
      turns.delete(id);
    },
  };
}
