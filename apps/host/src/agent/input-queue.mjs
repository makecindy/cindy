import { AgentInputCoordinator } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.ts';
import { isDeviceLinkInvoke, isMobileControllerInvoke, readDeviceLinkInvokeSourceDevice } from '../../../desktop/src/main/device-link/invoke-context.ts';
import { stampTrustedDeviceLinkQueuedOrigin, stampTrustedDesktopQueuedOrigin } from '../../../desktop/src/main/maker-ipc/queuedInputOrigin.ts';
import { createTurnExecutor } from './turn-executor.mjs';
import { createAppMessageSender } from '../../../desktop/src/main/mcp-apps/messageSender.ts';
import { MCP_APP_MESSAGE_GUARD } from '../../../desktop/src/main/mcp-apps/message.ts';
import { randomUUID } from 'node:crypto';
import { createSchedulerQueueBridge } from '../../../desktop/src/main/maker-ipc/schedulerQueueBridge.ts';
import { createQueuedAcceptedCallbacks } from '../../../desktop/src/main/maker-ipc/queuedAcceptedCallbacks.ts';
import { runSchedulerQueuedPreparation } from '../../../desktop/src/main/maker-ipc/schedulerQueuedPreparation.ts';
import { readTaskActionInput } from '../../../desktop/src/main/maker-ipc/taskActionInput.ts';
import { QueuedAttachmentOwnershipRegistry } from '../../../desktop/src/main/maker-ipc/queuedAttachmentOwnership.ts';
import { createLogger } from '../../../desktop/src/main/logger.ts';

const attachmentLog = createLogger('host-attachments');

/** Create options for every start from a stored task row (send, restore, resume). */
export function storedSessionOptions(stored) {
  return { agentKind: makerKind(stored.agentKind), model: stored.model || '',
    workingDir: stored.workingDir || '', effort: stored.effort || undefined,
    permissionMode: stored.permissionMode || undefined, providerId: stored.providerId ?? undefined,
    fastMode: stored.fastMode ?? undefined, planMode: stored.planModeEnabled ?? undefined,
    resumeSessionId: stored.sdkSessionId || undefined };
}

const makerKind = kind => kind === 'cc' ? 'claude-code' : kind;
const errorText = error => error instanceof Error ? error.message : String(error);

/** Only composition fields cross the browser trust boundary. Host receipts,
 * scheduler origins, hook bypasses and remote-device identity never do. */
function composeInput(item, stored) {
  if (!item || typeof item.clientId !== 'string' || !item.clientId.trim()) throw new Error('clientId is required');
  const text = typeof item.text === 'string' ? item.text : item.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('message text is required');
  // Picker changes already persist through /sessions/update. Input fields are
  // snapshots for presentation, not another authority over task settings.
  const agentKind = makerKind(stored.agentKind);
  if (!['claude-code', 'codex', 'pi'].includes(agentKind)) throw new Error('invalid agent kind');
  const model = stored.model || '';
  const workingDir = stored.workingDir || '';
  const effort = stored.effort || '';
  const permissionMode = stored.permissionMode || '';
  const content = typeof item.persistedContent === 'string' ? item.persistedContent : text;
  // The renderer already separates visible composer text from its serialized
  // storage envelope. Keep that distinction in queue snapshots and projections.
  const displayContent = typeof item.chatMessage?.content === 'string' ? item.chatMessage.content : text;
  const result = { clientId: item.clientId, text, persistedContent: content,
    model, workingDir, effort, permissionMode,
    chatMessage: { ...item.chatMessage, clientId: item.clientId, role: 'user', content: displayContent },
    createOpts: { agentKind, model, workingDir, effort: effort || undefined,
      permissionMode: permissionMode || undefined, providerId: stored.providerId ?? undefined,
      fastMode: stored.fastMode ?? undefined, planMode: stored.planModeEnabled ?? undefined } };
  for (const key of ['files', 'mentions', 'sessionRefs', 'agentReferences']) {
    if (item[key] !== undefined) {
      if (!Array.isArray(item[key])) throw new Error(`invalid ${key}`);
      result[key] = item[key];
    }
  }
  // Only the in-process App service can mint this symbol. Wire JSON cannot
  // promote page text into user intent or recreate a grant after a crash.
  if (typeof item[MCP_APP_MESSAGE_GUARD] === 'function') {
    result[MCP_APP_MESSAGE_GUARD] = item[MCP_APP_MESSAGE_GUARD];
    result.sourcePlugin = item.sourcePlugin;
    result.autoReviewUserText = { kind: 'delegated-continuation' };
  }
  // AsyncLocalStorage belongs to authenticated dispatch, never the wire item.
  const remote = isDeviceLinkInvoke();
  if (remote && isMobileControllerInvoke()) result.fromMobileClient = true;
  // An MCP App message is page content relayed by the in-process App service.
  // The desktop stamp would record its text as the user's own authored intent,
  // and the device stamp strips the source plugin it exists to forge-proof, so
  // keep the delegated receipt and restore the plugin the service minted.
  const fromApp = typeof item[MCP_APP_MESSAGE_GUARD] === 'function';
  const stamped = stampTrustedDeviceLinkQueuedOrigin(
    // Browser input has no native desktop command privilege.
    fromApp ? result : stampTrustedDesktopQueuedOrigin(result, true),
    remote, readDeviceLinkInvokeSourceDevice(),
  );
  if (fromApp) stamped.sourcePlugin = result.sourcePlugin;
  return stamped;
}

/** Node assembly of the desktop input transaction. There is one queue state
 * machine for both launchers; this module owns only IO and runtime lifetime. */
export function createInputQueue(deps) {
  let runtime = createRuntime();

  function createRuntime() {
    const states = new Map();
    const schedulePreparations = new Map();
    const scheduleDiscardWatchers = new Map();
    const scheduleAdmissions = new Map();
    const acceptedCallbacks = createQueuedAcceptedCallbacks();
    let closing = false;
    let owner;
    const isCurrent = () => !deps.getOwner || (owner !== undefined && owner != null && deps.getOwner() === owner);
    function assertCurrent() {
      if (!deps.getOwner) return;
      if (owner === undefined) owner = deps.getOwner();
      if (!isCurrent()) throw new Error('input runtime owner changed');
    }
    const attachments = deps.createAttachments?.({ assertCurrent });
    const attachmentOwnership = new QueuedAttachmentOwnershipRegistry(({ sessionId, clientId, error }) => {
      attachmentLog.warn('attachment cleanup failed', { sessionId, clientId, error: errorText(error) });
    });
    // Discard callbacks precede the coordinator's new snapshot. Wait until
    // that snapshot is queued and durable before releasing recoverable files.
    function afterSnapshot(id, action) {
      queueMicrotask(() => { void flushed(id).then(action).catch(error => {
        attachmentLog.warn('attachment settlement deferred', { sessionId: id, error: errorText(error) });
      }); });
    }
    async function prepareAttachments(id, item, admission) {
      const check = () => {
        assertCurrent();
        if (closing || stateFor(id).closed || stateFor(id).admission !== admission) {
          throw new Error('input cancelled before acceptance');
        }
      };
      check();
      const materialized = attachments ? await attachments.materialize(id, item, check) : { item };
      try { check(); }
      catch (error) { await materialized.cleanupBeforeAcceptance?.(); throw error; }
      const ownerId = attachmentOwnership.register(id, item.clientId, materialized.cleanupLocalMaterialization, {
        parts: materialized.materializedParts, cleanupAfterDurable: materialized.cleanupAfterAcceptance,
      });
      return { item: materialized.item, ownerId };
    }
    function stateFor(id) {
      if (!states.has(id)) states.set(id, { commands: Promise.resolve(), writing: Promise.resolve(),
        admission: 0, closed: false, snapshot: [], persistenceError: null });
      return states.get(id);
    }
    function project(value) {
      const error = states.get(value.sessionId)?.persistenceError;
      return error ? { ...value, error, queuePaused: true } : value;
    }
    function publish(value) {
      if (isCurrent()) deps.hub?.publish({ type: 'input_projection', sessionId: value.sessionId, projection: project(value) });
    }
    function persistenceFailed(id, error) {
      stateFor(id).persistenceError = errorText(error);
      coordinator.setExecutionPaused(id, true);
      publish(coordinator.getProjection(id));
    }
    function persist(id, snapshot) {
      const state = stateFor(id);
      state.snapshot = snapshot;
      const writing = state.writing.catch(() => {}).then(() => { assertCurrent(); return deps.persistQueueSnapshot?.(id, snapshot); });
      state.writing = writing;
      void writing.catch(error => persistenceFailed(id, error));
      return writing;
    }
    async function flushed(id) {
      const state = stateFor(id);
      let writing;
      do { writing = state.writing; await writing; } while (writing !== state.writing);
    }
    const executor = createTurnExecutor({ ...deps,
      assertCurrent, isCurrent,
      prepareUserMessage: attachments?.prepareUserMessage,
      isClearBoundaryCurrent: (id, boundary, generation) => coordinator.getClearBoundaryMs(id) === boundary
        && (generation === undefined || coordinator.isGenerationCurrent(id, generation)),
      isInputGenerationCurrent: (id, generation) => coordinator.isGenerationCurrent(id, generation),
      isExecutionPaused: id => coordinator.isExecutionPaused(id),
      isStoppingRuntime: () => closing,
      persistMessage: deps.persistMessage ?? (async () => {}),
      onPersistenceError: persistenceFailed,
      onTerminal: (id, type, error, meta, direct) => {
        if (direct) coordinator.wakeSession(id, 'host-turn-settled');
        else coordinator.onTurnEvent(id, type, error, undefined, meta);
        deps.onSessionSettled?.(id);
      },
    });
    const coordinator = new AgentInputCoordinator({
      sendToAgent: async (id, message, createOpts, sendOpts) => {
        const clientId = sendOpts.persistUserMessage?.clientId;
        try {
          await runSchedulerQueuedPreparation(clientId, schedulePreparations,
            () => { scheduleDiscardWatchers.delete(clientId); acceptedCallbacks.discard(clientId); });
          assertCurrent();
          const result = await executor.send(id, message, createOpts, sendOpts);
          await acceptedCallbacks.settle(id, sendOpts, result);
          return result;
        } catch (error) {
          await acceptedCallbacks.rollback(id, clientId);
          throw error;
        }
      },
      steerToAgent: executor.steer,
      abortSession: id => {
        const promise = executor.abort(id);
        stateFor(id).aborting = promise;
        return promise;
      },
      isTurnRunning: executor.isRunning,
      isLiveTurnRunning: id => deps.getMaker()?.getSession(id)?.isTurnRunning?.(),
      isLiveSessionPresent: id => !!deps.getMaker()?.getSession(id),
      getTurnGeneration: id => deps.getMaker()?.getSession(id)?.getTurnGeneration?.() ?? null,
      getTurnSessionIdentity: id => deps.getMaker()?.getSession(id) ?? null,
      getObservedCurrentTurnTerminal: id => deps.getMaker()?.getSession(id)?.getObservedCurrentTurnTerminal?.(),
      reconcileTurnIdle: executor.reconcileIdle,
      getAgentKind: id => makerKind(deps.getMaker()?.getSession(id)?.agentKind) ?? null,
      getSdkSessionId: async id => (await deps.readSession(id)).sdkSessionId || undefined,
      hasAssistantProgressAfter: deps.hasAssistantProgressAfter,
      getRecoveryContextSnapshot: deps.getRecoveryContextSnapshot,
      hasPendingInteraction: id => (deps.interactions?.pending(id)?.length ?? 0) > 0,
      hasPendingCredentialSwitch: deps.hasPendingCredentialSwitch,
      rewindPersistedUserMessageAfterClear: deps.rewindPersistedUserMessageAfterClear,
      createUserMessage: (id, input, options) => deps.persistMessage?.(id, input, options),
      touchUserSend: deps.touchUserSend ?? (async () => {}),
      emitProjection: publish,
      persistQueueSnapshot: persist,
      loadQueueSnapshot: deps.loadQueueSnapshot,
      loadClearBoundary: deps.loadClearBoundary,
      getPersistedClientIds: deps.getPersistedClientIds,
      onUserMessagePersisting: (id, item) => attachmentOwnership.markPersistenceStarted(id, item.clientId),
      onUserMessagePersisted: (id, item) => { void attachmentOwnership.settleDurable(id, item.clientId); },
      onUserMessagePersistenceFailed: (id, item, options) => {
        afterSnapshot(id, () => attachmentOwnership.markPersistenceFailed(id, item.clientId, options));
      },
      // Desktop register.ts (AgentInputCoordinator hooks): after the user row is durable
      // and before vendor dispatch, open the turn change record, then the Git baseline.
      beforeDispatchUserTurn: executor.beforeDispatchUserTurn,
      // A durable turn that never reached the vendor: drop the record, then the baseline.
      onUndispatchedUserTurn: executor.onUndispatchedUserTurn,
      onAcceptedQueuedMessage: async (id, item) => {
        schedulePreparations.delete(item.clientId);
        scheduleDiscardWatchers.delete(item.clientId);
        await acceptedCallbacks.run(id, item);
      },
      onDiscardedQueuedMessage: (id, item) => {
        afterSnapshot(id, () => attachmentOwnership.discardClient(id, item.clientId));
        acceptedCallbacks.discard(item.clientId);
        schedulePreparations.delete(item.clientId);
        const discarded = scheduleDiscardWatchers.get(item.clientId);
        scheduleDiscardWatchers.delete(item.clientId);
        discarded?.();
      },
    });
    const scheduleBridge = createSchedulerQueueBridge({
      coordinator,
      isSessionBusy: id => coordinator.shouldQueueNewTurn(id) ||
        deps.getMaker().getSession(id)?.isTurnRunning?.() === true,
      getSessionMeta: id => deps.getMaker().getSessionMeta(id),
      getSessionRowSnapshot: id => deps.readSession(id),
      createId: randomUUID,
      preparations: schedulePreparations,
      discardWatchers: scheduleDiscardWatchers,
      enqueue: async req => {
        const id = req.targetSessionId;
        const state = stateFor(id);
        const admission = scheduleAdmissions.get(id);
        const stored = await deps.readSession(id);
        assertCurrent();
        if (admission === undefined || admission !== state.admission || closing || state.closed) {
          throw new Error('input cancelled before acceptance');
        }
        const createOpts = { ...storedSessionOptions(stored),
          planMode: req.inheritTargetPlanMode ? Boolean(stored.planModeEnabled) : false };
        // This entry is only called by the local scheduler, never a wire request.
        // In particular it must not go through composeInput's user-origin stamp.
        const item = { clientId: req.clientId, text: req.message,
          persistedContent: req.persistedContent, origin: req.origin, createOpts,
          model: createOpts.model, workingDir: createOpts.workingDir,
          effort: createOpts.effort ?? '', permissionMode: createOpts.permissionMode ?? 'ask',
          chatMessage: { clientId: req.clientId, role: 'user', content: req.persistedContent } };
        acceptedCallbacks.register(req.clientId, () => req.onAccepted({
          permissionMode: createOpts.permissionMode, planMode: createOpts.planMode,
        }), req.onAcceptedRollback);
        coordinator.setExecutionPaused(id, true);
        try {
          coordinator.enqueue(id, item);
          await flushed(id);
        } catch (error) {
          acceptedCallbacks.discard(req.clientId);
          throw error;
        } finally {
          if (!stateFor(id).persistenceError) coordinator.setExecutionPaused(id, false);
        }
      },
    });
    function command(id, fn) {
      const state = stateFor(id);
      const admission = state.admission;
      const result = state.commands.catch(() => {}).then(async () => {
        if (closing || state.closed) throw new Error('session is closed');
        assertCurrent();
        await coordinator.ensureQueueRestored(id);
        assertCurrent();
        if (state.admission !== admission) throw new Error('input cancelled before acceptance');
        return fn(state, admission);
      });
      state.commands = result;
      return result;
    }
    async function mutate(id, fn) {
      return command(id, async state => {
        coordinator.setExecutionPaused(id, true);
        const result = fn();
        await flushed(id);
        if (!state.persistenceError) coordinator.setExecutionPaused(id, false);
        return project(result);
      });
    }
    async function stop(id, options = { keepQueue: true, pauseQueue: true }) {
      const state = stateFor(id);
      state.admission += 1;
      await coordinator.ensureQueueRestored(id);
      // Abort is urgent. A pending steer/send command may itself need this
      // cancellation to settle, so never serialize Stop behind that promise.
      coordinator.stop(id, options);
      await state.aborting;
      await state.commands.catch(() => {});
      await flushed(id);
      return project(coordinator.getProjection(id));
    }
    const api = {
      wireHostSession: session => { assertCurrent(); executor.wireHostSession(session); },
      beginHostTurn: id => command(id, () => executor.beginHostTurn(id)),
      taskActionInput: id => readTaskActionInput(id, sessionId => deps.getMaker()?.getSession(sessionId), coordinator),
      schedulerQueue: () => ({ ...scheduleBridge,
        ensureQueueRestored: id => command(id, () => coordinator.isQueueRestored(id)),
        isSessionBusy: id => { assertCurrent(); return scheduleBridge.isSessionBusy(id); },
        enqueuePrompt: req => command(req.sessionId, async (_state, admission) => {
          // The bridge reads metadata and the stored row before enqueue. Keep
          // the original command generation across every one of those reads.
          scheduleAdmissions.set(req.sessionId, admission);
          try { return await scheduleBridge.enqueuePrompt(req); }
          finally { scheduleAdmissions.delete(req.sessionId); }
        }),
        removeQueuedPrompt: (id, clientId) => {
          // Coordinator owns the immediate cancellation; persist() serializes its snapshot.
          assertCurrent(); coordinator.remove(id, clientId);
        },
        getLastUserActionAt: id => states.get(id)?.lastUserActionAt ?? null,
      }),
      isTurnRunning: executor.isRunning,
      wakeSession: (id, reason) => coordinator.wakeSession(id, reason),
      restoreSession: (id, check) => command(id, async () => {
        await check(); assertCurrent();
        const session = await executor.restoreSession(id, storedSessionOptions(await deps.readSession(id)), check);
        await check(); assertCurrent(); return session;
      }),
      enqueueDurableWrite: (id, label, fn) => command(id, () => executor.enqueueDurableWrite(id, label, fn)),
      projection: id => project(coordinator.getProjection(id)),
      getProjection: id => command(id, () => api.projection(id)),
      inputStatus: (id, clientId) => command(id, async () => {
        const projection = api.projection(id);
        if (executor.isInputRunning(id, clientId)) return 'running';
        if (projection.recovery?.clientId === clientId) return 'interrupted';
        if (projection.pendingQueue.some(item => item.clientId === clientId)) return 'queued';
        const known = await deps.getPersistedClientIds?.(id, [clientId]);
        assertCurrent();
        return known?.has(clientId) ? 'recorded' : 'unknown';
      }),
      enqueue(id, item) {
        const admission = stateFor(id).admission;
        return command(id, async state => {
          if (coordinator.hasKnownClientId(id, item?.clientId)) {
            await flushed(id);
            return api.projection(id);
          }
          const known = await deps.getPersistedClientIds?.(id, [item?.clientId]);
          if (known?.has(item?.clientId)) return api.projection(id);
          const prepared = await prepareAttachments(id, composeInput(item, await deps.readSession(id)), admission);
          let accepted = false;
          try {
            state.lastUserActionAt = Date.now();
            coordinator.setExecutionPaused(id, true);
            coordinator.enqueue(id, prepared.item);
            accepted = true;
            if (prepared.ownerId) attachmentOwnership.activateCurrentOwner(id, item.clientId, prepared.ownerId);
            await flushed(id);
            await attachmentOwnership.markDurable(id, item.clientId, prepared.ownerId ?? undefined);
            if (!state.persistenceError) coordinator.setExecutionPaused(id, false);
            return api.projection(id);
          } finally {
            if (!accepted && prepared.ownerId) await attachmentOwnership.discardSpecific(id, item.clientId, prepared.ownerId);
          }
        });
      },
      stop,
      async resume(id) {
        if (stateFor(id).closed) return api.projection(id);
        return command(id, async (state, admission) => {
          await state.aborting?.catch(error => { if (executor.isRunning(id)) throw error; });
          await executor.retryPersistence(id);
          if (state.persistenceError) await persist(id, state.snapshot);
          await flushed(id);
          if (state.admission !== admission) throw new Error('input cancelled before acceptance');
          state.persistenceError = null;
          coordinator.resume(id);
          coordinator.setExecutionPaused(id, false);
          return api.projection(id);
        });
      },
      retryLastError: id => command(id, () => coordinator.retryLastError(id)),
      clearError: id => command(id, () => coordinator.clearError(id)),
      steer(id, item) {
        return command(id, async (state, admission) => {
          const prepared = await prepareAttachments(id, composeInput(item, await deps.readSession(id)), admission);
          const previous = prepared.ownerId
            ? attachmentOwnership.activateCurrentOwner(id, item.clientId, prepared.ownerId) : null;
          let accepted = false;
          try {
            accepted = await coordinator.steer(id, prepared.item);
            if (accepted) {
              await flushed(id);
              await attachmentOwnership.markDurable(id, item.clientId, prepared.ownerId ?? undefined);
            }
            return accepted;
          } finally {
            if (!accepted && prepared.ownerId) {
              attachmentOwnership.restoreCurrentOwner(id, item.clientId, previous);
              await attachmentOwnership.discardSpecific(id, item.clientId, prepared.ownerId);
            }
          }
        });
      },
      remove: (id, clientId) => mutate(id, () => coordinator.remove(id, clientId)),
      updateText: (id, clientId, text) => mutate(id, () => coordinator.updateText(id, clientId, text)),
      updateContent(id, clientId, item) {
        return command(id, async (state, admission) => {
          const old = coordinator.getProjection(id).pendingQueue.find(row => row.clientId === clientId);
          if (!old) return api.projection(id);
          const composed = composeInput({ ...old, ...item, clientId,
            persistedContent: item.persistedContent ?? item.text ?? old.persistedContent }, await deps.readSession(id));
          const prepared = await prepareAttachments(id, composed, admission);
          let accepted = false;
          try {
            coordinator.setExecutionPaused(id, true);
            const result = coordinator.updateContentWithResult(id, clientId, prepared.item);
            accepted = result.updated;
            if (accepted) {
              const refs = attachments?.collectRefs(prepared.item) ?? new Set();
              const survivor = attachmentOwnership.retainReferencedOwners(id, clientId, prepared.ownerId, ref => refs.has(ref));
              if (survivor) attachmentOwnership.activateCurrentOwner(id, clientId, survivor);
              else attachmentOwnership.restoreCurrentOwner(id, clientId, null);
              afterSnapshot(id, () => attachmentOwnership.discardSuperseded(id, clientId));
            }
            await flushed(id);
            await attachmentOwnership.markDurable(id, clientId);
            if (!state.persistenceError) coordinator.setExecutionPaused(id, false);
            return api.projection(id);
          } finally {
            if (!accepted && prepared.ownerId) await attachmentOwnership.discardSpecific(id, clientId, prepared.ownerId);
          }
        });
      },
      move: (id, clientId, index) => mutate(id, () => coordinator.move(id, clientId, index)),
      setExpanded: (id, expanded) => command(id, () => coordinator.setExpanded(id, expanded)),
      setInteractionLock: (id, lock, locked) => command(id, () => coordinator.setInteractionLock(id, lock, locked)),
      setEditLock: (id, clientId, locked) => command(id, () => coordinator.setEditLock(id, clientId, locked)),
      // This endpoint clears pending inputs, not persisted history. Only the
      // history service may advance the durable conversation clear boundary.
      clearSession: id => stop(id, { keepQueue: false }),
      /** The running turn's accepted input, as the desktop's Auto-review context reads it. */
      acceptedInputProvenance: id => coordinator.getAcceptedInputProvenance(id),
      async disposeSession(id) {
        stateFor(id).closed = true;
        await stop(id);
        coordinator.clearSession(id);
        coordinator.onSessionClosed(id);
        await executor.close(id);
        await attachments?.closeSession(id);
        await flushed(id);
      },
      async dispose() {
        closing = true;
        const settled = await Promise.allSettled([...states.keys()].map(async id => {
          try { await stop(id); }
          finally {
            coordinator.onSessionClosed(id);
            // close() can fail while draining writes, before Maker closes the
            // runtime. Keep its temporary inputs until a confirmed close or
            // the next process's orphan sweep; a finally cleanup could delete
            // files still held by that runtime.
            try { await executor.close(id); await attachments?.closeSession(id); }
            finally { await flushed(id); }
          }
        }));
        const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Failed to drain task persistence');
      },
    };
    api.sendAppMessage = createAppMessageSender({
      queueOnly: true, owner: deps.getOwner,
      readClearBoundary: deps.loadClearBoundary,
      restoreQueue: id => command(id, () => {}),
      clearBoundary: id => coordinator.getClearBoundaryMs(id),
      getSessionMeta: deps.readSession, createClientId: randomUUID,
      buildQueueItem: async ({ message, meta, targetSessionId, ...item }) => ({ ...item, text: message,
        createOpts: storedSessionOptions(meta), model: meta.model, workingDir: meta.workingDir }),
      enqueue: (id, item) => api.enqueue(id, item),
    });
    return api;
  }
  const api = Object.fromEntries(Object.keys(runtime).map(name => [name, (...args) => runtime[name](...args)]));
  api.dispose = async () => { try { await runtime.dispose(); } finally { runtime = createRuntime(); } };
  return api;
}
