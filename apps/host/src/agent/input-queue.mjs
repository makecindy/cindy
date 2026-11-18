import { AgentInputCoordinator } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.ts';
import { isDeviceLinkInvoke, isMobileControllerInvoke, readDeviceLinkInvokeSourceDevice } from '../../../desktop/src/main/device-link/invoke-context.ts';
import { stampTrustedDeviceLinkQueuedOrigin, stampTrustedDesktopQueuedOrigin } from '../../../desktop/src/main/maker-ipc/queuedInputOrigin.ts';
import { createTurnExecutor } from './turn-executor.mjs';
import { hostCoordinatorDeps } from './coordinator-deps.ts';
import { createHostAutoResume } from './auto-resume.ts';
import { createHostProductTurn } from './product-turn.ts';
import { getUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { createHostIdleRelease } from './idle-release.ts';
import { createAppMessageSender } from '../../../desktop/src/main/mcp-apps/messageSender.ts';
import { MCP_APP_MESSAGE_GUARD } from '../../../desktop/src/main/mcp-apps/message.ts';
import { randomUUID } from 'node:crypto';
import { createSchedulerQueueBridge } from '../../../desktop/src/main/maker-ipc/schedulerQueueBridge.ts';
import { createQueuedAcceptedCallbacks } from '../../../desktop/src/main/maker-ipc/queuedAcceptedCallbacks.ts';
import { readTaskActionInput } from '../../../desktop/src/main/maker-ipc/taskActionInput.ts';
import { QueuedAttachmentOwnershipRegistry } from '../../../desktop/src/main/maker-ipc/queuedAttachmentOwnership.ts';
import { createLogger } from '../../../desktop/src/main/logger.ts';
import { isSessionErrorSuppressed } from '../../../desktop/src/main/maker-ipc/sessionErrorSuppression.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.ts';

const settlementLog = createLogger('host-turn-settlement');
const attachmentLog = createLogger('host-attachments');
const log = createLogger('host-auto-resume');

/** Create options for every start from a stored task row (send, restore, resume). */
export function storedSessionOptions(stored) {
  return { agentKind: makerKind(stored.agentKind), model: stored.model || '',
    workingDir: stored.workingDir || '', effort: stored.effort || undefined,
    permissionMode: stored.permissionMode || undefined, providerId: stored.providerId ?? undefined,
    fastMode: stored.fastMode ?? undefined, planMode: stored.planModeEnabled ?? undefined,
    resumeSessionId: stored.sdkSessionId || undefined };
}

const makerKind = kind => kind === 'cc' ? 'claude-code' : kind;

/** The interaction lock a profile hold puts on every task (coexistence plan A, profile-coexistence.ts). */
export const PROFILE_HOLD_LOCK = 'profile-coexistence';

/**
 * Hold one task while a desktop that opens this profile's database runs: nothing queued starts
 * (any interaction lock stops the coordinator's dispatch) and the execution pause stops the
 * automatic continuations that read it (interrupted-turn auto-resume when the error arrives and
 * when its wait ends; a saved usage-limit recovery). Both survive Stop.
 */
export function holdTaskForProfile(coordinator, id) {
  coordinator.setInteractionLock(id, PROFILE_HOLD_LOCK, true, { preserveOnStop: true });
  coordinator.setExecutionPaused(id, true);
}
const errorText = error => error instanceof Error ? error.message : String(error);

/** Only composition fields cross the browser trust boundary. Host receipts,
 * scheduler origins, hook bypasses and remote-device identity never do. */
function composeInput(item, stored) {
  if (!item || typeof item.clientId !== 'string' || !item.clientId.trim()) throw new Error('clientId is required');
  const text = typeof item.text === 'string' ? item.text : item.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('message text is required');
  // Picker changes already persist through their own entries (set-model, set-effort,
  // set-permission-mode and the like). Input fields are snapshots for presentation,
  // not another authority over task settings.
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
  // Coexistence plan A: null, or the refusal a new send gets while a desktop uses this profile.
  let profileHold = null;
  let ownerStopping = false;
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
    async function settleAndWake(id, terminal = false) {
      if (closing) return;
      // The rebuilt queue has not served a send yet. Bind its history writer to
      // the current owner before delivering a cancellation from the old hold.
      assertCurrent();
      let settled = false;
      try {
        settled = (await deps.onSessionSettled?.(id)) !== false;
      } finally {
        if ((terminal || settled) && !closing && !profileHold && isCurrent()) {
          try { deps.afterTurnSettled?.(id); }
          finally { coordinator.onExternalTurnSettled(id); }
        }
      }
    }
    function retryTurnSettlement(id, terminal = false) {
      void settleAndWake(id, terminal).catch(error => settlementLog.warn('turn settlement failed', { id, error: errorText(error) }));
    }
    /** A new send while the profile is held: refused, typed, before anything is written. */
    function refuseWhileHeld() {
      if (profileHold) throwIpcError('PRECONDITION_FAILED', profileHold.message);
    }
    function holdIfHeld(id) {
      if (profileHold) holdTaskForProfile(coordinator, id);
    }
    /** The execution pause this module lifts after a write stays while the profile is held. */
    function unpause(id) {
      if (!profileHold) coordinator.setExecutionPaused(id, false);
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
    // Context recovery (context-recovery-assembly.ts): one rollover per runtime, so its memory of
    // continued inputs lasts as long as this owner's runtime; a new owner's runtime gets a new one.
    let rollover = null;
    // The desktop's product-turn failure gate, finalizer and task list activity (product-turn.ts), one per
    // owner runtime: the executor ends a turn's activity (held while a resume or recovery owns it), the
    // auto-resume and the context recovery settle a held one when they give up.
    const productTurn = createHostProductTurn({ getBoundSession: id => executor.boundSession(id),
      touchActivity: deps.touchSessionActivity, log });
    // The desktop's auto-resume (auto-resume.ts), one per owner runtime with its coordinator.
    const autoResume = createHostAutoResume({
      productTurn: () => productTurn,
      userDataDir: deps.userDataDir ?? getUserDataDir,
      coordinator: () => coordinator,
      history: id => executor.autoResumeHistory(id),
      getSession: id => deps.getMaker()?.getSession(id),
      createDbMessage: (id, input, options) => deps.persistMessage?.(id, input, options),
      onTakeoverReleased: id => releaseResumeOrigin(id),
      maybeApplySessionRuntimeFallback: deps.maybeApplySessionRuntimeFallback,
      pendingSessionRuntimeFallbackRebuilds: deps.pendingSessionRuntimeFallbackRebuilds,
      isProfileHeld: () => profileHold !== null,
      log,
    });
    // The input whose stream an automatic resume continues, per task (Host-only: /api/chat follows
    // the resume's turns, which carry their own client ids). Set when the coordinator takes a terminal
    // error over; the resume's turns carry it; it ends with the first receipt of an abandoned resume.
    const resumeOrigins = new Map();
    // A resume that gives up writes the held error row (once) or drops the takeover: the input it
    // continued stopped there, so its stream gets the interrupted receipt once that row is stored.
    function releaseResumeOrigin(id) {
      const origin = resumeOrigins.get(id);
      if (origin === undefined) return;
      resumeOrigins.delete(id);
      const history = executor.autoResumeHistory(id);
      void history.drain().then(() => {
        if (history.hasFailedWrites() || !isCurrent()) return;
        deps.hub?.publish({ type: 'input_receipt', sessionId: id, inputClientId: origin, clientId: origin, status: 'interrupted' });
      });
    }
    const executor = createTurnExecutor({ ...deps,
      // The owner this runtime's turns started under (assertCurrent): usage is written to that account only.
      runtimeOwner: () => owner ?? null,
      getAutoResume: () => autoResume,
      productTurn,
      // A terminal ends its activity held while the coordinator's automatic resume owns it (sessionEventTerminal.ts).
      isAutoResumeHeld: id => coordinator.isAutoResumePending(id) || coordinator.isAutoResumeDeferred(id),
      // The desktop's silent-stop continuation (silent-stop.ts) reads the queue and rebinds the coordinator's
      // turn to the continuation's generation (silentStopTurnEnd.ts); while the profile is held it sends none.
      silentStopCoordinator: {
        hasPendingQueuedWork: id => coordinator.hasPendingQueuedWork(id),
        noteHostTurnContinuation: (id, generation) => coordinator.noteHostTurnContinuation(id, generation),
        noteHostTurnContinuationFailed: (id, generation) => coordinator.noteHostTurnContinuationFailed(id, generation),
      },
      isProfileHeld: () => profileHold !== null,
      resumeOriginOf: id => resumeOrigins.get(id),
      resumeAnswered: (id, origin) => { if (resumeOrigins.get(id) === origin) resumeOrigins.delete(id); },
      autoResumePendingOf: (id, origin) => {
        const pending = coordinator.getProjection(id).autoResumePending;
        if (!pending) { resumeOrigins.delete(id); return undefined; }
        resumeOrigins.set(id, origin);
        return pending;
      },
      // The terminal error an automatic resume holds (sessionEventTerminal.ts): kept in its attempt,
      // with the coordinator's attempt and deferred owner, and written once if the resume gives up.
      holdSuppressedError: (id, data) => autoResume.autoResumeBookkeeping.stashSuppressedError(id, data,
        coordinator.getAutoResumeAttemptToken(id), coordinator.getAutoResumeDeferredOwner(id)),
      assertCurrent, isCurrent,
      prepareUnhealthySession: deps.createContextRecoveryRollover ? async id => {
        assertCurrent();
        const rebuilt = await rollover.prepareUnhealthySession(id);
        // A healthy result also crosses an await before the transaction reads the live session.
        assertCurrent();
        return rebuilt;
      } : undefined,
      getRecoveryRollover: deps.createContextRecoveryRollover ? () => rollover : deps.getRecoveryRollover,
      prepareUserMessage: attachments?.prepareUserMessage,
      isClearBoundaryCurrent: (id, boundary, generation) => coordinator.getClearBoundaryMs(id) === boundary
        && (generation === undefined || coordinator.isGenerationCurrent(id, generation)),
      isInputGenerationCurrent: (id, generation) => coordinator.isGenerationCurrent(id, generation),
      isExecutionPaused: id => coordinator.isExecutionPaused(id),
      isStoppingRuntime: () => closing,
      persistMessage: deps.persistMessage ?? (async () => {}),
      onPersistenceError: persistenceFailed,
      // When a terminal arrives (turn-executor.mjs handTerminalToCoordinator), as on the desktop.
      handTerminal: (id, type, error, signals, meta) => coordinator.onTurnEvent(id, type, error, signals, meta),
      isSessionErrorSuppressed: (id, event) => isSessionErrorSuppressed(coordinator, id, event),
      // Once the turn's rows settle: the coordinator already has the terminal when it arrived as an
      // event, so it is only woken; a turn that ended without one (a stop that only went idle, a
      // closed or replaced runtime, a silent-stop done) hands it here, once.
      onTerminal: (id, type, error, meta, direct, handedOver) => {
        if (direct || handedOver) coordinator.wakeSession(id, 'host-turn-settled');
        else coordinator.onTurnEvent(id, type, error, undefined, meta);
        retryTurnSettlement(id, true);
      },
    });
    // The coordinator's ports (coordinator-deps.ts, every optional port written out).
    const coordinator = new AgentInputCoordinator(hostCoordinatorDeps({
      deps, executor, coordinator: () => coordinator, scheduleBridge: () => scheduleBridge, assertCurrent,
      noteAborting: (id, aborting) => { stateFor(id).aborting = aborting; },
      publish, persist, flushed, afterSnapshot, attachmentOwnership, acceptedCallbacks,
      schedulePreparations, scheduleDiscardWatchers, autoResume, rollover: () => rollover,
    }));
    // The desktop's idle-runtime release (idle-release.ts), one set of watchers per owner runtime.
    const idleRelease = deps.readClaudeIdleMinutes ? createHostIdleRelease({
      coordinator,
      getMaker: () => { try { return deps.getMaker(); } catch { return null; } },
      isTurnPendingCompletion: executor.isRunning,
      hasPendingInteraction: id => (deps.interactions?.pending(id)?.length ?? 0) > 0,
      // As register.ts: a credential switch waiting for this task's turn keeps its runtime.
      hasPendingCredentialSwitch: id => deps.hasPendingCredentialSwitchEntry?.(id) === true,
      readClaudeMinutes: deps.readClaudeIdleMinutes,
      ...(deps.idleReleaseClock ? { clock: deps.idleReleaseClock } : {}),
    }) : null;
    const scheduleBridge = createSchedulerQueueBridge({
      coordinator,
      isSessionBusy: id => coordinator.shouldQueueNewTurn(id) ||
        deps.getMaker().getSession(id)?.isTurnRunning?.() === true,
      getSessionMeta: id => deps.getMaker().getSessionMeta(id),
      getSessionRowSnapshot: id => deps.readSession(id),
      createId: randomUUID,
      preparations: schedulePreparations,
      discardWatchers: scheduleDiscardWatchers,
      discardAcceptedCallback: acceptedCallbacks.discard,
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
          if (!stateFor(id).persistenceError) unpause(id);
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
        holdIfHeld(id);
        if (state.admission !== admission) throw new Error('input cancelled before acceptance');
        return fn(state, admission);
      });
      state.commands = result;
      return result;
    }
    async function mutate(id, fn) {
      return command(id, async state => {
        // Editing, removing or moving a queued input writes the queue the desktop may be using.
        refuseWhileHeld();
        coordinator.setExecutionPaused(id, true);
        const result = fn();
        await flushed(id);
        if (!state.persistenceError) unpause(id);
        return project(result);
      });
    }
    async function stop(id, options = { keepQueue: true, pauseQueue: true }) {
      const state = stateFor(id);
      state.admission += 1;
      await coordinator.ensureQueueRestored(id);
      holdIfHeld(id);
      // Abort is urgent. A pending steer/send command may itself need this
      // cancellation to settle, so never serialize Stop behind that promise.
      coordinator.stop(id, options);
      await state.aborting;
      await state.commands.catch(() => {});
      await flushed(id);
      return project(coordinator.getProjection(id));
    }
    if (deps.createContextRecoveryRollover) {
      rollover = deps.createContextRecoveryRollover({
        assertCurrent,
        replay: (...args) => executor.replay(...args),
        drainHistories: () => executor.drainHistories(),
        resetWireNotes: id => executor.resetWireNotes(id),
        readAutoReviewHistory: id => executor.readAutoReviewHistory(id),
        noteRebuilt: id => executor.noteRecoveryRebuilt(id),
        coordinator: {
          hasPendingQueuedWork: id => coordinator.hasPendingQueuedWork(id),
          getInputAbortSignal: id => coordinator.getInputAbortSignal(id),
          // As the desktop (contextRecoveryRebuilt): the coordinator's clear, synchronously. A
          // context overflow's error is not in the queue snapshot, so the clear writes nothing.
          // Nothing changes once the runtime is closing, the task is closed or the owner changed.
          clearError(id) {
            if (closing || stateFor(id).closed || !isCurrent()) return;
            coordinator.clearError(id);
          },
        },
      });
    }
    const api = {
      wireHostSession: session => { assertCurrent(); executor.wireHostSession(session); },
      beginHostTurn: id => command(id, () => executor.beginHostTurn(id)),
      taskActionInput: id => readTaskActionInput(id, sessionId => deps.getMaker()?.getSession(sessionId), coordinator),
      schedulerQueue: () => ({ ...scheduleBridge,
        ensureQueueRestored: id => command(id, () => coordinator.isQueueRestored(id)),
        isSessionBusy: id => { assertCurrent(); return scheduleBridge.isSessionBusy(id); },
        hasPendingInput: id => {
          if (closing) throw new Error('session is closed');
          assertCurrent(); return scheduleBridge.hasPendingInput(id);
        },
        enqueuePrompt: req => command(req.sessionId, async (_state, admission) => {
          refuseWhileHeld();
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
      /** Closes a task's idle runtime with the executor letting go of it first (turn-executor.mjs). */
      closeRuntime: id => { assertCurrent(); return executor.closeRuntime(id); },
      /** This runtime's context recovery rollover (null when recovery is not assembled). */
      contextRecoveryRollover: () => rollover,
      /** The engine of a task as its message persistence knows it. */
      sessionDbAgentKind: id => executor.sessionDbAgentKind(id),
      recordRuntimeControlError: (id, data) => executor.recordRuntimeControlError(id, data),
      /** Forgets a task's working-directory recovery at its archive or delete (turn-executor.mjs). */
      discardWorkingDirectoryRecovery: id => executor.discardWorkingDirectoryRecovery(id),
      /** Rows of a task's turn not in the database yet (turn-executor.mjs liveHistory). */
      liveHistory: id => executor.liveHistory(id),
      /** Starting a task's runtime outside a turn, as a send starts it (turn-executor.mjs startPorts). */
      startPorts: () => executor.startPorts,
      cancelUsageLimitWait: id => coordinator.cancelUsageLimitWait(id),
      refreshQueuedRoute: (id, route) => coordinator.refreshQueuedRoute(id, route),
      /** A context recovery's replay was accepted (the recovery factory's onRebuilt). */
      noteContextRecoveryRebuilt: id => executor.noteRecoveryRebuilt(id),
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
        // Before the recovery point below: during context recovery the claimed input is the recovery
        // point too, but it is still being answered.
        if (executor.isInputRunning(id, clientId) || executor.isInputRecovering(id, clientId)) return 'running';
        // An automatic resume continues this input (waiting for its backoff, or its resumed turn running).
        if (resumeOrigins.get(id) === clientId) return 'running';
        // A recovery point names its input as clientId (before dispatch) or as item (a stored turn
        // whose dispatch failed): either way the input stopped there.
        if ((projection.recovery?.clientId ?? projection.recovery?.item?.clientId) === clientId) return 'interrupted';
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
          refuseWhileHeld();
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
            if (!state.persistenceError) unpause(id);
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
          refuseWhileHeld();
          await state.aborting?.catch(error => { if (executor.isRunning(id)) throw error; });
          await executor.retryPersistence(id);
          if (state.persistenceError) await persist(id, state.snapshot);
          await flushed(id);
          if (state.admission !== admission) throw new Error('input cancelled before acceptance');
          state.persistenceError = null;
          coordinator.resume(id);
          unpause(id);
          return api.projection(id);
        });
      },
      retryLastError: id => command(id, () => { refuseWhileHeld(); return coordinator.retryLastError(id); }),
      clearError: id => command(id, () => coordinator.clearError(id)),
      steer(id, item) {
        return command(id, async (state, admission) => {
          refuseWhileHeld();
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
          refuseWhileHeld();
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
            if (!state.persistenceError) unpause(id);
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
      /** Starts releasing idle runtimes once this owner's agent runtime is ready (main.ts). */
      startIdleRelease: () => { if (!closing) idleRelease?.start(); },
      /** Hold every task this runtime knows (the profile hold started; later tasks are held as they are read). */
      holdKnownTasks() {
        for (const id of states.keys()) holdTaskForProfile(coordinator, id);
        deps.holdTurnSettlements?.(states.keys());
      },
      /**
       * Whether a turn of this runtime is still running, a context recovery included (its replay is
       * part of the turn that overflowed): the hold is not released before they end.
       */
      hasRunningTurns: () => [...states.keys()].some(id => executor.isRunning(id) || executor.isRecovering(id)),
      /** One scan of every idle-release watcher, for tests. */
      scanIdleRelease: async () => { await idleRelease?.scanNow(); },
      /**
       * The owner boundary began (agent/owner-boundary.ts): the runtime is stopping before dispose()
       * runs. No new input is accepted, and a turn that ends from now on is an interruption (the
       * executor writes no turn end for it). Only `closing` is set; dispose() still stops and drains.
       */
      beginStop() { closing = true; },
      settleAndWake, retryTurnSettlement,
      canSettleTurnControls: () => !ownerStopping && !closing && profileHold === null,
      async dispose() {
        closing = true;
        // No runtime is released while this owner's runtime drains and stops.
        idleRelease?.stop();
        // Recoveries in flight end as failures and write their error rows first (bounded),
        // before their tasks are stopped; a stop would read as the user's and drop the error.
        await executor.drainRecoveriesForShutdown();
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
  // The owner's runtime ends: a hold belonged to it (the next owner's start scans the profile again).
  api.beginStop = () => { ownerStopping = true; runtime.beginStop(); };
  api.dispose = async () => {
    api.beginStop();
    try {
      if (releasing) await releasing;
      await runtime.dispose();
    } finally {
      deps.disposeTurnSettlements?.();
      profileHold = null;
      runtime = createRuntime();
      ownerStopping = false;
    }
  };
  /**
   * Coexistence plan A: a desktop that opens this profile's database is running. New sends are
   * refused with `[PRECONDITION_FAILED] <message>`; nothing queued starts and no automatic
   * continuation runs (holdTaskForProfile). A running turn finishes, and a context recovery's replay
   * belongs to it. Repeating it only updates the message.
   */
  let profileHoldGeneration = 0;
  api.holdForDesktop = message => {
    const first = profileHold === null;
    profileHold = { message };
    if (first) {
      profileHoldGeneration++;
      runtime.holdKnownTasks();
    }
  };
  api.isHeldForDesktop = () => profileHold !== null;
  api.profileHoldGeneration = () => profileHoldGeneration;
  /**
   * The desktop is gone: open again only once no turn runs (false: still held, ask again later). The
   * desktop may have answered or removed queued inputs meanwhile, so this runtime's queues are not
   * trusted: the runtime is rebuilt (dispose writes no queue whose items did not change) and every
   * task restores its queue from the database when next read, before the hold is lifted.
   */
  let releasing = null;
  async function release() {
    if (ownerStopping || runtime.hasRunningTurns()) return false;
    // The hold ends between the two runtimes: no read of the new one is held by mistake. When the
    // old one cannot be disposed, the new one stays held and the next clean scan tries again.
    const released = profileHold;
    let disposed = false;
    try { await runtime.dispose(); disposed = true; }
    // A desktop that came back meanwhile replaced the hold: that one stays.
    finally {
      if (disposed && !ownerStopping && profileHold === released) profileHold = null;
      runtime = createRuntime();
      if (ownerStopping) runtime.beginStop();
    }
    if (profileHold === null) {
      for (const id of deps.deferredTurnSettlements?.() ?? []) {
        try { await runtime.settleAndWake(id); }
        catch (error) { settlementLog.warn('task settlement failed after profile release', { id, error: errorText(error) }); }
      }
    }
    return profileHold === null;
  }
  api.releaseDesktopHold = () => {
    if (profileHold === null) return Promise.resolve(true);
    if (!releasing) releasing = release().finally(() => { releasing = null; });
    return releasing;
  };
  return api;
}
