/**
 * Process-local coordination for Windows shutdown, restart, and logoff.
 * Query events are reversible, so terminal-sensitive active-session events are
 * held until WM_ENDSESSION reports whether Windows confirmed or cancelled the
 * request. The confirmed flag remains monotonic for the rest of the process
 * lifetime.
 */
import type {
  AgentEvent,
  AgentKind,
  SessionEventDispatchGate,
  SessionEventReplayFactory,
} from '@cindy/maker-core';

import { createLogger } from './logger.js';

const log = createLogger('windows-session-end');

let windowsSessionEnding = false;
export interface WindowsSessionEndTurnIdentity {
  sessionInstanceId: string;
  turnGeneration: number;
}

type WindowsSessionEndTurnMap = Map<string, WindowsSessionEndTurnIdentity>;

let pendingQuerySessionTurnGenerations: Map<string, WindowsSessionEndTurnMap> | null = null;
const pendingSilentStopContinuationGenerations = new Map<string, WindowsSessionEndTurnMap>();
const deferredTerminalTurnGenerations = new Map<string, WindowsSessionEndTurnMap>();
const confirmedTerminalTurnGenerations = new Map<string, WindowsSessionEndTurnMap>();
const confirmedInterruptedTurnGenerations = new Map<string, WindowsSessionEndTurnMap>();
type RecoveryMarkerState = 'pending' | 'awaiting-fallback' | 'durable' | 'fallback';

const confirmedRecoveryMarkerStates = new Map<string, RecoveryMarkerState>();
const pendingFallbackEventResolvers = new Map<string, () => void>();
const pendingFallbackStorageTasks = new Map<string, Set<Promise<void>>>();
interface LateProviderDoneStorageHold {
  identity: WindowsSessionEndTurnIdentity;
  resolve: () => void;
  reject: (error: unknown) => void;
  taskBound: boolean;
}
const lateProviderDoneStorageHolds = new Map<
  string,
  Map<string, LateProviderDoneStorageHold>
>();
const finishedFallbackProviderEventInstances = new Set<string>();
const completedRecoveryMarkerSessionIds = new Set<string>();
let fallbackProviderTeardownStarted = false;
const protectedWiringTeardownSessionIds = new Set<string>();
const pendingWiringTeardowns = new Map<string, Set<() => void>>();
const fallbackTerminalEmitters = new Map<string, Map<string, () => boolean | void>>();
const syntheticFallbackEmissionKeys = new Set<string>();
let pendingEventCallbacks: Array<{
  sessionId: string;
  sessionInstanceId: string;
  turnGeneration: number;
  replay: () => void;
  discard?: () => void;
  settlesFailedMarker: boolean;
  syntheticFallbackTerminal?: boolean;
}> = [];

export interface WindowsSessionEndActiveTurn {
  sessionId: string;
  sessionInstanceId: string;
  turnGeneration: number;
  emitFallbackTerminal?: () => boolean | void;
}

function turnIdentityKey(identity: WindowsSessionEndTurnIdentity): string {
  return `${identity.sessionInstanceId}\u0000${identity.turnGeneration}`;
}

function fallbackTurnKey(sessionId: string, identity: WindowsSessionEndTurnIdentity): string {
  return `${sessionId}\u0001${turnIdentityKey(identity)}`;
}

function providerEventInstanceKey(sessionId: string, sessionInstanceId: string): string {
  return `${sessionId}\u0002${sessionInstanceId}`;
}

function createTurnIdentity(
  sessionId: string,
  sessionInstanceId: string | undefined,
  turnGeneration: number,
): WindowsSessionEndTurnIdentity {
  // The fallback keeps existing test/adaptor callers compatible. Production
  // snapshots and Session events always provide the real per-instance id.
  return { sessionInstanceId: sessionInstanceId ?? sessionId, turnGeneration };
}

function eventTurnIdentity(
  sessionId: string,
  event: AgentEvent,
  sessionInstanceId?: string,
): WindowsSessionEndTurnIdentity | null {
  if (typeof event.sessionTurnGeneration !== 'number') return null;
  return createTurnIdentity(
    sessionId,
    event.sessionInstanceId ?? sessionInstanceId,
    event.sessionTurnGeneration,
  );
}

function hasTurnIdentity(
  turns: WindowsSessionEndTurnMap | undefined,
  identity: WindowsSessionEndTurnIdentity | null,
): boolean {
  return identity !== null && turns?.has(turnIdentityKey(identity)) === true;
}

function registerFallbackTerminalEmitter(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
  emitter: (() => boolean | void) | undefined,
): void {
  if (!emitter) return;
  const emitters =
    fallbackTerminalEmitters.get(sessionId) ?? new Map<string, () => boolean | void>();
  emitters.set(turnIdentityKey(identity), emitter);
  fallbackTerminalEmitters.set(sessionId, emitters);
}

function deleteFallbackTerminalEmitter(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
): void {
  const emitters = fallbackTerminalEmitters.get(sessionId);
  if (!emitters) return;
  emitters.delete(turnIdentityKey(identity));
  if (emitters.size === 0) fallbackTerminalEmitters.delete(sessionId);
}

function addQueryTurn(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
  emitFallbackTerminal?: () => boolean | void,
): boolean {
  if (!pendingQuerySessionTurnGenerations) return false;
  registerFallbackTerminalEmitter(sessionId, identity, emitFallbackTerminal);
  protectedWiringTeardownSessionIds.add(sessionId);
  const generations = pendingQuerySessionTurnGenerations.get(sessionId) ?? new Map();
  const previousSize = generations.size;
  generations.set(turnIdentityKey(identity), identity);
  pendingQuerySessionTurnGenerations.set(sessionId, generations);
  return generations.size !== previousSize;
}

function deleteQueryTurn(sessionId: string, identity: WindowsSessionEndTurnIdentity): void {
  const generations = pendingQuerySessionTurnGenerations?.get(sessionId);
  if (!generations) return;
  generations.delete(turnIdentityKey(identity));
  deleteFallbackTerminalEmitter(sessionId, identity);
  if (generations.size === 0) {
    pendingQuerySessionTurnGenerations?.delete(sessionId);
    protectedWiringTeardownSessionIds.delete(sessionId);
    // A normal done is allowed through the gate immediately after this call.
    // Defer teardown one microtask so that synchronous fan-out still reaches
    // the old instance's consumers before an already-requested replacement
    // detaches them.
    if (pendingWiringTeardowns.has(sessionId)) {
      queueMicrotask(() => {
        if (!protectedWiringTeardownSessionIds.has(sessionId)) {
          settlePendingWiringTeardowns(sessionId);
        }
      });
    }
  }
}

function settlePendingWiringTeardowns(sessionId: string): void {
  protectedWiringTeardownSessionIds.delete(sessionId);
  const teardowns = [...(pendingWiringTeardowns.get(sessionId) ?? [])];
  pendingWiringTeardowns.delete(sessionId);
  for (const teardown of teardowns) {
    try {
      teardown();
    } catch (error) {
      log.warn('deferred session wiring teardown failed', { sessionId, error });
    }
  }
}

function maybeSettlePendingWiringTeardowns(sessionId: string): void {
  if (!completedRecoveryMarkerSessionIds.has(sessionId)) return;
  if (
    confirmedRecoveryMarkerStates.get(sessionId) === 'durable' ||
    !lateProviderDoneStorageHolds.has(sessionId) ||
    fallbackProviderTeardownStarted
  ) {
    settlePendingWiringTeardowns(sessionId);
  }
}

function settleLateProviderDoneStorageHold(
  sessionId: string,
  hold: LateProviderDoneStorageHold,
  rejected?: { error: unknown },
): void {
  const holds = lateProviderDoneStorageHolds.get(sessionId);
  if (holds?.get(turnIdentityKey(hold.identity)) !== hold) return;
  holds.delete(turnIdentityKey(hold.identity));
  if (holds.size === 0) lateProviderDoneStorageHolds.delete(sessionId);
  if (rejected) hold.reject(rejected.error);
  else hold.resolve();
  if (!lateProviderDoneStorageHolds.has(sessionId)) {
    maybeSettlePendingWiringTeardowns(sessionId);
  }
}

function registerLateProviderDoneStorageHolds(
  sessionId: string,
  registerStoragePrerequisite:
    | ((prerequisite: Promise<void>, identity: WindowsSessionEndTurnIdentity) => void)
    | undefined,
): void {
  if (!registerStoragePrerequisite) return;
  const holds = lateProviderDoneStorageHolds.get(sessionId) ?? new Map();
  for (const identity of confirmedInterruptedTurnGenerations.get(sessionId)?.values() ?? []) {
    const identityKey = turnIdentityKey(identity);
    if (
      holds.has(identityKey) ||
      finishedFallbackProviderEventInstances.has(
        providerEventInstanceKey(sessionId, identity.sessionInstanceId),
      )
    ) {
      continue;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const hold: LateProviderDoneStorageHold = {
      identity,
      resolve,
      reject,
      taskBound: false,
    };
    holds.set(identityKey, hold);
    registerStoragePrerequisite(promise, identity);
  }
  if (holds.size > 0) lateProviderDoneStorageHolds.set(sessionId, holds);
}

function bindLateProviderDoneStorageTask(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
  task: Promise<void>,
): void {
  const hold = lateProviderDoneStorageHolds.get(sessionId)?.get(turnIdentityKey(identity));
  if (!hold || hold.taskBound) return;
  hold.taskBound = true;
  void task.then(
    () => settleLateProviderDoneStorageHold(sessionId, hold),
    (error) => settleLateProviderDoneStorageHold(sessionId, hold, { error }),
  );
}

/**
 * Close the exact provider-event fence only after no later done can enter it.
 * A done whose accounting task was already captured keeps its storage hold;
 * otherwise teardown proves that the placeholder can resolve without a write.
 */
export function finishWindowsSessionEndFallbackProviderEvents(
  sessionId: string,
  sessionInstanceId: string,
): void {
  if (!windowsSessionEnding) return;
  finishedFallbackProviderEventInstances.add(
    providerEventInstanceKey(sessionId, sessionInstanceId),
  );
  for (const hold of [
    ...(lateProviderDoneStorageHolds.get(sessionId)?.values() ?? []),
  ]) {
    if (hold.identity.sessionInstanceId === sessionInstanceId && !hold.taskBound) {
      settleLateProviderDoneStorageHold(sessionId, hold);
    }
  }
}

/**
 * `shutdown-maker` is the lifecycle point at which retained replacement wiring
 * may be detached. If its generic prerequisite timed out, remember the intent
 * and apply it when marker settlement eventually makes replay safe.
 */
export function beginWindowsSessionEndFallbackProviderTeardown(): void {
  if (!windowsSessionEnding) return;
  fallbackProviderTeardownStarted = true;
  for (const sessionId of [...pendingWiringTeardowns.keys()]) {
    maybeSettlePendingWiringTeardowns(sessionId);
  }
}

function isProtectedQueryTurn(
  sessionId: string,
  sessionInstanceId: string | undefined,
  event: AgentEvent,
): boolean {
  return hasTurnIdentity(
    pendingQuerySessionTurnGenerations?.get(sessionId),
    eventTurnIdentity(sessionId, event, sessionInstanceId),
  );
}

function addDeferredTerminalTurn(sessionId: string, identity: WindowsSessionEndTurnIdentity): void {
  const generations = deferredTerminalTurnGenerations.get(sessionId) ?? new Map();
  generations.set(turnIdentityKey(identity), identity);
  deferredTerminalTurnGenerations.set(sessionId, generations);
}

function hasDeferredTerminalTurn(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity | null,
): boolean {
  return hasTurnIdentity(deferredTerminalTurnGenerations.get(sessionId), identity);
}

function addConfirmedTerminalTurn(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
): void {
  const generations = confirmedTerminalTurnGenerations.get(sessionId) ?? new Map();
  generations.set(turnIdentityKey(identity), identity);
  confirmedTerminalTurnGenerations.set(sessionId, generations);
}

function hasConfirmedTerminalTurn(
  sessionId: string,
  sessionInstanceId: string | undefined,
  event: AgentEvent,
): boolean {
  return hasTurnIdentity(
    confirmedTerminalTurnGenerations.get(sessionId),
    eventTurnIdentity(sessionId, event, sessionInstanceId),
  );
}

function hasConfirmedInterruptedTurn(
  sessionId: string,
  sessionInstanceId: string | undefined,
  event: AgentEvent,
): boolean {
  return hasTurnIdentity(
    confirmedInterruptedTurnGenerations.get(sessionId),
    eventTurnIdentity(sessionId, event, sessionInstanceId),
  );
}

function finishConfirmedTerminalTurn(
  sessionId: string,
  sessionInstanceId: string | undefined,
  event: AgentEvent,
): void {
  if (event.type !== 'done') return;
  const identity = eventTurnIdentity(sessionId, event, sessionInstanceId);
  if (!identity) return;
  const generations = confirmedTerminalTurnGenerations.get(sessionId);
  if (!generations) return;
  generations.delete(turnIdentityKey(identity));
  if (generations.size === 0) confirmedTerminalTurnGenerations.delete(sessionId);
}

function holdConfirmedEvent(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
  getReplay: SessionEventReplayFactory,
  settlesFailedMarker: boolean,
  syntheticFallbackTerminal = false,
): void {
  const recoveryMarkerState = confirmedRecoveryMarkerStates.get(sessionId);
  if (recoveryMarkerState !== 'pending' && recoveryMarkerState !== 'awaiting-fallback') return;
  const replay = getReplay();
  pendingEventCallbacks.push({
    sessionId,
    ...identity,
    replay,
    discard: replay.discard,
    settlesFailedMarker,
    syntheticFallbackTerminal,
  });
  if (!settlesFailedMarker) return;
  if (!hasFallbackTerminalForEveryInterruptedGeneration(sessionId)) return;
  const resolveFallbackEvent = pendingFallbackEventResolvers.get(sessionId);
  if (resolveFallbackEvent) {
    pendingFallbackEventResolvers.delete(sessionId);
    resolveFallbackEvent();
  }
}

function replaceSyntheticFallbackTerminal(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
): boolean {
  let replaced = false;
  pendingEventCallbacks = pendingEventCallbacks.filter((callback) => {
    if (
      callback.sessionId !== sessionId ||
      callback.sessionInstanceId !== identity.sessionInstanceId ||
      callback.turnGeneration !== identity.turnGeneration ||
      !callback.syntheticFallbackTerminal
    ) {
      return true;
    }
    replaced = true;
    try {
      callback.discard?.();
    } catch (error) {
      log.warn('synthetic Windows fallback terminal discard failed', {
        sessionId,
        ...identity,
        error,
      });
    }
    return false;
  });
  return replaced;
}

function hasFallbackTerminalForEveryInterruptedGeneration(sessionId: string): boolean {
  const interruptedGenerations = confirmedInterruptedTurnGenerations.get(sessionId);
  return (
    interruptedGenerations !== undefined &&
    interruptedGenerations.size > 0 &&
    [...interruptedGenerations.values()].every((identity) =>
      hasFallbackTerminalForGeneration(sessionId, identity),
    )
  );
}

function hasFallbackTerminalForGeneration(
  sessionId: string,
  identity: WindowsSessionEndTurnIdentity,
): boolean {
  return pendingEventCallbacks.some(
    (callback) =>
      callback.sessionId === sessionId &&
      callback.sessionInstanceId === identity.sessionInstanceId &&
      callback.turnGeneration === identity.turnGeneration &&
      callback.settlesFailedMarker,
  );
}

function takePendingEventCallbacks(sessionId: string): typeof pendingEventCallbacks {
  const selected: typeof pendingEventCallbacks = [];
  const remaining: typeof pendingEventCallbacks = [];
  for (const callback of pendingEventCallbacks) {
    (callback.sessionId === sessionId ? selected : remaining).push(callback);
  }
  pendingEventCallbacks = remaining;
  return selected;
}

function settlePendingEventCallbacks(sessionId: string, durable: boolean): boolean {
  const callbacks = takePendingEventCallbacks(sessionId);
  for (const callback of callbacks) {
    try {
      if (durable) callback.discard?.();
      else callback.replay();
    } catch (error) {
      log.warn(
        durable
          ? 'confirmed session-end event discard failed'
          : 'confirmed session-end fallback replay failed',
        error,
      );
    }
  }
  return callbacks.length > 0;
}

/** Include async storage work started by synchronous fallback replay in the barrier. */
export function trackWindowsSessionEndFallbackStorageTask(
  sessionId: string,
  task: Promise<void>,
  options?: { requireSuccess?: boolean },
): void {
  if (confirmedRecoveryMarkerStates.get(sessionId) !== 'fallback') return;
  const settledTask = task.catch((error) => {
    log.warn('Windows session-end fallback storage task failed', { sessionId, error });
    if (options?.requireSuccess) throw error;
  });
  const tasks = pendingFallbackStorageTasks.get(sessionId) ?? new Set<Promise<void>>();
  tasks.add(settledTask);
  pendingFallbackStorageTasks.set(sessionId, tasks);
  const removeSettledTask = (): void => {
    const currentTasks = pendingFallbackStorageTasks.get(sessionId);
    if (!currentTasks) return;
    currentTasks.delete(settledTask);
    if (currentTasks.size === 0) pendingFallbackStorageTasks.delete(sessionId);
  };
  // Attach both handlers immediately so a synchronously rejected required task
  // cannot surface as unhandled before the fallback drain reaches Promise.all.
  void settledTask.then(removeSettledTask, removeSettledTask);
}

async function drainWindowsSessionEndFallbackStorageTasks(sessionId: string): Promise<void> {
  let firstRejection: unknown;
  let hasRejection = false;
  while (true) {
    const tasks = [...(pendingFallbackStorageTasks.get(sessionId) ?? [])];
    if (tasks.length === 0) {
      if (hasRejection) throw firstRejection;
      return;
    }
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected' && !hasRejection) {
        firstRejection = result.reason;
        hasRejection = true;
      }
    }
  }
}

async function settleFailedRecoveryMarker(
  sessionId: string,
  registerStoragePrerequisite?: (
    prerequisite: Promise<void>,
    identity: WindowsSessionEndTurnIdentity,
  ) => void,
): Promise<string | null> {
  if (!hasFallbackTerminalForEveryInterruptedGeneration(sessionId)) {
    confirmedRecoveryMarkerStates.set(sessionId, 'awaiting-fallback');
    await new Promise<void>((resolve) => {
      pendingFallbackEventResolvers.set(sessionId, resolve);
    });
    // Tests can reset process-local state while this wait is pending.
    if (confirmedRecoveryMarkerStates.get(sessionId) !== 'awaiting-fallback') return null;
  }
  confirmedRecoveryMarkerStates.set(sessionId, 'fallback');
  confirmedTerminalTurnGenerations.delete(sessionId);
  fallbackTerminalEmitters.delete(sessionId);
  // Register the lifecycle hold before synchronous replay can drain its first
  // storage batch. A real provider done may arrive after that batch is empty;
  // its exact-generation usage task will bind to this still-live placeholder.
  registerLateProviderDoneStorageHolds(sessionId, registerStoragePrerequisite);
  if (!settlePendingEventCallbacks(sessionId, false)) return null;
  await drainWindowsSessionEndFallbackStorageTasks(sessionId);
  return sessionId;
}

function isTerminalAgentErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return true;
  const data = event.data as { isTerminal?: unknown; willRetry?: unknown };
  if (typeof data.isTerminal === 'boolean') return data.isTerminal;
  if (typeof data.willRetry === 'boolean') return !data.willRetry;
  return true;
}

function isSilentStopDoneEvent(event: AgentEvent): boolean {
  if (event.type !== 'done') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  return (event.data as { silentStop?: unknown }).silentStop === true;
}

function isProductTurnTerminalDoneEvent(event: AgentEvent): boolean {
  return (
    event.type === 'done' &&
    event.turnContinuationId === undefined &&
    !isSilentStopDoneEvent(event)
  );
}

function isTerminalStatusEvent(event: AgentEvent): boolean {
  if (event.type !== 'status') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  return (event.data as { isRunning?: unknown }).isRunning === false;
}

function isWindowsSessionEndTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || isTerminalAgentErrorEvent(event) || isTerminalStatusEvent(event);
}

function replayPendingQueryEvents(): void {
  const protectedSessionIds = [...protectedWiringTeardownSessionIds];
  pendingQuerySessionTurnGenerations = null;
  pendingSilentStopContinuationGenerations.clear();
  deferredTerminalTurnGenerations.clear();
  fallbackTerminalEmitters.clear();
  const callbacks = pendingEventCallbacks;
  pendingEventCallbacks = [];
  for (const { replay } of callbacks) {
    try {
      replay();
    } catch (error) {
      // Original session listeners isolate their own failures. Timeout replay
      // runs outside that emitter, so preserve the same containment here.
      log.warn('query-phase event replay failed', error);
    }
  }
  // A replacement Session can reuse the same business id while this advisory
  // query is pending. Keep the old wiring alive through synchronous replay so
  // its original event consumers can persist/finalize the held provider event.
  for (const sessionId of protectedSessionIds) settlePendingWiringTeardowns(sessionId);
}

export function beginWindowsSessionEndQuery(
  activeTurns: Iterable<WindowsSessionEndActiveTurn>,
): void {
  if (windowsSessionEnding) return;
  if (pendingQuerySessionTurnGenerations) {
    // Repeated advisory messages describe the same currently active turns.
    // Ensure membership without double-counting an existing generation.
    for (const {
      sessionId,
      sessionInstanceId,
      turnGeneration,
      emitFallbackTerminal,
    } of activeTurns) {
      addQueryTurn(
        sessionId,
        createTurnIdentity(sessionId, sessionInstanceId, turnGeneration),
        emitFallbackTerminal,
      );
    }
    return;
  }
  pendingQuerySessionTurnGenerations = new Map();
  for (const {
    sessionId,
    sessionInstanceId,
    turnGeneration,
    emitFallbackTerminal,
  } of activeTurns) {
    addQueryTurn(
      sessionId,
      createTurnIdentity(sessionId, sessionInstanceId, turnGeneration),
      emitFallbackTerminal,
    );
  }
}

/** Keep turns dispatched during the advisory query inside the protected snapshot. */
export function noteWindowsSessionEndTurnStarted(
  sessionId: string,
  agentKind: AgentKind,
  turnGeneration: number,
  emitFallbackTerminal?: () => boolean | void,
  sessionInstanceId?: string,
): boolean {
  if (windowsSessionEnding || agentKind !== 'claude-code' || !pendingQuerySessionTurnGenerations) {
    return false;
  }
  // A replacement request after silent-stop is the same product turn only
  // while it stays on the same Session instance. A different instance can
  // reuse the business id and generation sequence for unrelated work; that
  // turn needs its own rollback ownership and must not retire the old slot.
  const identity = createTurnIdentity(sessionId, sessionInstanceId, turnGeneration);
  const pendingSilentStops = pendingSilentStopContinuationGenerations.get(sessionId);
  const replacedGeneration = [...(pendingSilentStops?.values() ?? [])].find(
    (pending) => pending.sessionInstanceId === identity.sessionInstanceId,
  );
  if (replacedGeneration !== undefined && pendingSilentStops !== undefined) {
    deleteQueryTurn(sessionId, replacedGeneration);
    addQueryTurn(sessionId, identity, emitFallbackTerminal);
    pendingSilentStops.delete(turnIdentityKey(replacedGeneration));
    pendingSilentStops.set(turnIdentityKey(identity), identity);
    // N+1 now owns the query snapshot slot. Keep onUndispatched rollback
    // ownership so a route/provider failure can remove this never-dispatched
    // continuation instead of leaving a phantom interrupted generation.
    return true;
  }
  // The advisory snapshot can observe Session's incremented generation before
  // this lifecycle hook runs. Register rollback ownership even when the exact
  // generation is already present, so an undispatched send can remove it.
  addQueryTurn(sessionId, identity, emitFallbackTerminal);
  return true;
}

/** Reject a new Claude provider dispatch after the confirmed OS-session boundary. */
export function shouldRejectWindowsSessionEndTurnStart(agentKind: AgentKind): boolean {
  return windowsSessionEnding && agentKind === 'claude-code';
}

/** Identify terminal replay that must persist instead of starting normal recovery. */
export function isWindowsSessionEndFallbackSession(sessionId: string): boolean {
  return windowsSessionEnding && confirmedRecoveryMarkerStates.get(sessionId) === 'fallback';
}

/** Roll back a query-time turn reservation that never reached its provider. */
export function rollbackWindowsSessionEndTurnStarted(
  sessionId: string,
  turnGeneration: number,
  sessionInstanceId?: string,
): void {
  finishWindowsSessionEndProductTurn(sessionId, turnGeneration, sessionInstanceId);
}

/** Retire one completed Claude product turn from the advisory snapshot. */
export function finishWindowsSessionEndProductTurn(
  sessionId: string,
  turnGeneration: number,
  sessionInstanceId?: string,
): void {
  const identity = createTurnIdentity(sessionId, sessionInstanceId, turnGeneration);
  if (windowsSessionEnding || !pendingQuerySessionTurnGenerations) {
    return;
  }
  deleteQueryTurn(sessionId, identity);
  const pendingSilentStops = pendingSilentStopContinuationGenerations.get(sessionId);
  pendingSilentStops?.delete(turnIdentityKey(identity));
  if (pendingSilentStops?.size === 0) {
    pendingSilentStopContinuationGenerations.delete(sessionId);
  }
}

/** Retire every advisory-query turn owned by a Session that completed close. */
export function finishWindowsSessionEndSessionClosed(
  sessionId: string,
  sessionInstanceId: string,
): void {
  if (windowsSessionEnding || !pendingQuerySessionTurnGenerations) return;
  const turns = pendingQuerySessionTurnGenerations.get(sessionId);
  for (const identity of [...(turns?.values() ?? [])]) {
    if (identity.sessionInstanceId === sessionInstanceId) {
      deleteQueryTurn(sessionId, identity);
    }
  }
  const pendingSilentStops = pendingSilentStopContinuationGenerations.get(sessionId);
  for (const identity of [...(pendingSilentStops?.values() ?? [])]) {
    if (identity.sessionInstanceId === sessionInstanceId) {
      pendingSilentStops?.delete(turnIdentityKey(identity));
    }
  }
  if (pendingSilentStops?.size === 0) {
    pendingSilentStopContinuationGenerations.delete(sessionId);
  }
}

/** WM_ENDSESSION(wParam=FALSE) is the authoritative cancellation signal. */
export function cancelWindowsSessionEndQuery(): boolean {
  if (windowsSessionEnding || !pendingQuerySessionTurnGenerations) return false;
  replayPendingQueryEvents();
  return true;
}

export function shouldGateWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  sessionInstanceId?: string,
): boolean {
  if (agentKind !== 'claude-code') return false;
  if (
    windowsSessionEnding &&
    confirmedRecoveryMarkerStates.get(sessionId) === 'fallback'
  ) {
    const identity = eventTurnIdentity(sessionId, event, sessionInstanceId);
    if (
      identity &&
      hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event)
    ) {
      return true;
    }
  }
  // Outside the post-fallback exact-generation fence above, text/thinking/tool
  // events dominate the stream and never need coordinator allocation.
  if (event.type !== 'done' && event.type !== 'error' && event.type !== 'status') return false;
  if (event.type === 'error' && !isTerminalAgentErrorEvent(event)) return false;
  if (event.type === 'status' && !isTerminalStatusEvent(event)) return false;
  if (!windowsSessionEnding && pendingQuerySessionTurnGenerations === null) return false;
  const identity = eventTurnIdentity(sessionId, event, sessionInstanceId);
  const recoveryMarkerState = confirmedRecoveryMarkerStates.get(sessionId);
  if (
    windowsSessionEnding &&
    recoveryMarkerState === 'fallback' &&
    identity &&
    hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event) &&
    isWindowsSessionEndTerminalEvent(event)
  ) {
    return true;
  }
  if (
    windowsSessionEnding &&
    recoveryMarkerState !== undefined &&
    recoveryMarkerState !== 'fallback'
  ) {
    if (
      isTerminalAgentErrorEvent(event) &&
      hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event)
    ) {
      return true;
    }
    if (
      hasConfirmedTerminalTurn(sessionId, sessionInstanceId, event) &&
      (isTerminalStatusEvent(event) || event.type === 'done')
    ) {
      return true;
    }
    if (event.type === 'done' && hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event)) {
      return true;
    }
  }
  return (
    isProtectedQueryTurn(sessionId, sessionInstanceId, event) &&
    (isTerminalAgentErrorEvent(event) ||
      event.type === 'done' ||
      (isTerminalStatusEvent(event) && hasDeferredTerminalTurn(sessionId, identity)))
  );
}

export function gateWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  getReplay: SessionEventReplayFactory,
  sessionInstanceId?: string,
  onLateProviderDoneUsage?: (event: AgentEvent) => void | Promise<void>,
): boolean {
  if (agentKind !== 'claude-code') return false;
  const identity = eventTurnIdentity(sessionId, event, sessionInstanceId);
  const recoveryMarkerState = confirmedRecoveryMarkerStates.get(sessionId);
  if (
    windowsSessionEnding &&
    recoveryMarkerState === 'fallback' &&
    identity &&
    hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event)
  ) {
    if (isProductTurnTerminalDoneEvent(event)) {
      let usageTask: Promise<void>;
      try {
        usageTask = Promise.resolve(onLateProviderDoneUsage?.(event));
      } catch (error) {
        // A bookkeeping callback must never reopen Session fan-out after the
        // fallback terminal became authoritative.
        log.warn('late Windows provider done accounting failed to start', {
          sessionId,
          ...identity,
          error,
        });
        usageTask = Promise.reject(error);
      }
      bindLateProviderDoneStorageTask(sessionId, identity, usageTask);
    }
    log.debug('ignored late Windows provider event after fallback replay', {
      sessionId,
      ...identity,
      eventType: event.type,
    });
    return true;
  }
  // Confirmation is irreversible. Keep shutdown-generated terminal failures out
  // of Session's unified fan-out until the protected session is detached; the
  // interrupted marker is the authoritative restart state for these turns.
  if (
    windowsSessionEnding &&
    recoveryMarkerState !== undefined &&
    recoveryMarkerState !== 'fallback'
  ) {
    if (
      identity &&
      isTerminalAgentErrorEvent(event) &&
      hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event)
    ) {
      const replacedSynthetic = replaceSyntheticFallbackTerminal(sessionId, identity);
      addConfirmedTerminalTurn(sessionId, identity);
      const syntheticFallbackTerminal = syntheticFallbackEmissionKeys.has(
        fallbackTurnKey(sessionId, identity),
      );
      holdConfirmedEvent(sessionId, identity, getReplay, true, syntheticFallbackTerminal);
      if (replacedSynthetic) {
        log.debug('replaced synthetic Windows fallback terminal with provider terminal', {
          sessionId,
          ...identity,
        });
      }
      return true;
    }
    // Claude closes a terminal failure with status:isRunning=false and done.
    // Once its error was suppressed, drop that paired tail at the same unified
    // boundary; a normal done without a preceding shutdown error still passes.
    if (
      identity &&
      hasConfirmedTerminalTurn(sessionId, sessionInstanceId, event) &&
      (isTerminalStatusEvent(event) || event.type === 'done')
    ) {
      const replacedSynthetic =
        event.type === 'done' &&
        isProductTurnTerminalDoneEvent(event) &&
        replaceSyntheticFallbackTerminal(sessionId, identity);
      if (replacedSynthetic) {
        // The real product terminal now owns this generation. Keep the
        // confirmed-terminal fence so a paired status/done tail remains held.
        holdConfirmedEvent(sessionId, identity, getReplay, true, false);
        log.debug('replaced synthetic Windows fallback terminal with real done', {
          sessionId,
          ...identity,
        });
        return true;
      }
      // The terminal error already made this session eligible for fallback.
      // Its paired status/done tail must remain ordered behind that decision,
      // but cannot independently turn an SDK continuation into a product end.
      holdConfirmedEvent(sessionId, identity, getReplay, false);
      finishConfirmedTerminalTurn(sessionId, sessionInstanceId, event);
      return true;
    }
    // A normal completion of a generation that was active at confirmation must
    // not fan out behind the newly durable started marker while ended writes
    // are frozen. Hold it under the same per-session marker outcome.
    if (
      identity &&
      event.type === 'done' &&
      hasConfirmedInterruptedTurn(sessionId, sessionInstanceId, event)
    ) {
      // Continuation-bearing and silent-stop done events are SDK boundaries,
      // not product terminals. Keep them queued, but wait for a real terminal
      // before a failed marker is allowed to fall back to event persistence.
      holdConfirmedEvent(sessionId, identity, getReplay, isProductTurnTerminalDoneEvent(event));
      return true;
    }
  }
  if (!identity || !isProtectedQueryTurn(sessionId, sessionInstanceId, event)) return false;
  if (isTerminalAgentErrorEvent(event)) {
    addDeferredTerminalTurn(sessionId, identity);
    const replay = getReplay();
    pendingEventCallbacks.push({
      sessionId,
      ...identity,
      replay,
      discard: replay.discard,
      settlesFailedMarker: true,
      syntheticFallbackTerminal: syntheticFallbackEmissionKeys.has(
        fallbackTurnKey(sessionId, identity),
      ),
    });
    return true;
  }
  if (
    hasDeferredTerminalTurn(sessionId, identity) &&
    (isTerminalStatusEvent(event) || event.type === 'done')
  ) {
    const replay = getReplay();
    pendingEventCallbacks.push({
      sessionId,
      ...identity,
      replay,
      discard: replay.discard,
      settlesFailedMarker: false,
      syntheticFallbackTerminal: false,
    });
    return true;
  }
  if (event.type !== 'done') return false;
  // A claim-bearing or silent-stop done is only an SDK continuation boundary;
  // the product turn remains active, so keep the query-time snapshot protected
  // until an unclaimed terminal done or Windows confirmation arrives.
  if (event.turnContinuationId !== undefined) return false;
  if (isSilentStopDoneEvent(event)) {
    const pendingSilentStops =
      pendingSilentStopContinuationGenerations.get(sessionId) ?? new Map();
    pendingSilentStops.set(turnIdentityKey(identity), identity);
    pendingSilentStopContinuationGenerations.set(sessionId, pendingSilentStops);
    return false;
  }
  // An unclaimed done without a preceding terminal error completed normally
  // during the advisory query. Let consumers commit it and exclude it from
  // interruption.
  finishWindowsSessionEndProductTurn(
    sessionId,
    identity.turnGeneration,
    identity.sessionInstanceId,
  );
  return false;
}

/** Install one sparse gate whose hot-path preflight does not allocate per event. */
export function createWindowsSessionEndEventGate(
  sessionId: string,
  agentKind: AgentKind,
  sessionInstanceId = sessionId,
  onLateProviderDoneUsage?: (event: AgentEvent) => void | Promise<void>,
): SessionEventDispatchGate {
  const gate: SessionEventDispatchGate = (event, getReplay) =>
    gateWindowsSessionEndEvent(
      sessionId,
      agentKind,
      event,
      getReplay,
      sessionInstanceId,
      onLateProviderDoneUsage,
    );
  gate.shouldRun = (event) =>
    shouldGateWindowsSessionEndEvent(sessionId, agentKind, event, sessionInstanceId);
  return gate;
}

/** Adapter for the already-sparse terminal-only listener gates. */
export function deferWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  replay: () => void,
  discard?: () => void,
  sessionInstanceId?: string,
): boolean {
  return gateWindowsSessionEndEvent(
    sessionId,
    agentKind,
    event,
    () => Object.assign(replay, { discard: discard ?? (() => undefined) }),
    sessionInstanceId,
  );
}

/** Retain one synthetic terminal after Session has already disabled its fan-out. */
export function deferRetainedWindowsSessionEndFallback(
  sessionId: string,
  agentKind: AgentKind,
  sessionInstanceId: string,
  turnGeneration: number,
  replay: (event: AgentEvent) => void,
): boolean {
  const capturedAt = Date.now();
  const fallbackEvent: AgentEvent = {
    type: 'error',
    data: {
      message: 'Windows ended the session before this turn produced a terminal event.',
      isTerminal: true,
      reason: 'session_event_loop_crashed',
    },
    source: agentKind,
    sessionInstanceId,
    sessionTurnGeneration: turnGeneration,
  };
  return deferWindowsSessionEndEvent(
    sessionId,
    agentKind,
    fallbackEvent,
    () => replay({ ...fallbackEvent, sessionEventReplay: { capturedAt } }),
    undefined,
    sessionInstanceId,
  );
}

/** Keep a replaced Session's held-event pipeline alive until its events are settled. */
export function deferWindowsSessionEndWiringTeardown(
  sessionId: string,
  agentKind: AgentKind,
  teardown: () => void,
): boolean {
  if (agentKind !== 'claude-code' || !protectedWiringTeardownSessionIds.has(sessionId)) {
    return false;
  }
  const teardowns = pendingWiringTeardowns.get(sessionId) ?? new Set<() => void>();
  teardowns.add(teardown);
  pendingWiringTeardowns.set(sessionId, teardowns);
  return true;
}

export function markWindowsSessionEnding(
  activeTurns: Iterable<WindowsSessionEndActiveTurn>,
): string[] {
  const interruptedAtQueryOrConfirmation = new Map<string, WindowsSessionEndTurnMap>();
  for (const [sessionId, turnGenerations] of pendingQuerySessionTurnGenerations ?? []) {
    interruptedAtQueryOrConfirmation.set(sessionId, new Map(turnGenerations));
  }
  for (const {
    sessionId,
    sessionInstanceId,
    turnGeneration,
    emitFallbackTerminal,
  } of activeTurns) {
    const identity = createTurnIdentity(sessionId, sessionInstanceId, turnGeneration);
    const generations = interruptedAtQueryOrConfirmation.get(sessionId) ?? new Map();
    generations.set(turnIdentityKey(identity), identity);
    interruptedAtQueryOrConfirmation.set(sessionId, generations);
    registerFallbackTerminalEmitter(sessionId, identity, emitFallbackTerminal);
  }
  windowsSessionEnding = true;
  for (const [sessionId, turnGenerations] of interruptedAtQueryOrConfirmation) {
    protectedWiringTeardownSessionIds.add(sessionId);
    confirmedInterruptedTurnGenerations.set(sessionId, turnGenerations);
    confirmedRecoveryMarkerStates.set(sessionId, 'pending');
  }
  for (const [sessionId, turnGenerations] of deferredTerminalTurnGenerations) {
    for (const identity of turnGenerations.values()) {
      addConfirmedTerminalTurn(sessionId, identity);
    }
  }
  pendingQuerySessionTurnGenerations = null;
  pendingSilentStopContinuationGenerations.clear();
  deferredTerminalTurnGenerations.clear();
  return [...interruptedAtQueryOrConfirmation.keys()];
}

/**
 * Give every still-running protected generation a terminal while its exact
 * Session consumers are alive. Active Session teardown deliberately drops
 * provider events after `terminationStarted`; this host-owned event therefore
 * has to enter the dispatch gate before shutdown-maker calls Session.detach().
 */
export async function prepareWindowsSessionEndFallbackBeforeSessionTeardown(): Promise<
  WindowsSessionEndActiveTurn[]
> {
  if (!windowsSessionEnding) return [];
  const emitted: WindowsSessionEndActiveTurn[] = [];
  for (const [sessionId, state] of confirmedRecoveryMarkerStates) {
    if (state !== 'pending' && state !== 'awaiting-fallback') continue;
    for (const identity of confirmedInterruptedTurnGenerations.get(sessionId)?.values() ?? []) {
      if (hasFallbackTerminalForGeneration(sessionId, identity)) continue;
      const emitter = fallbackTerminalEmitters.get(sessionId)?.get(turnIdentityKey(identity));
      if (!emitter) {
        log.warn('missing Windows session-end fallback terminal emitter before Session teardown', {
          sessionId,
          ...identity,
        });
        continue;
      }
      try {
        syntheticFallbackEmissionKeys.add(fallbackTurnKey(sessionId, identity));
        const emittedFallback = emitter();
        if (emittedFallback === false) {
          log.warn('Windows session-end fallback terminal was rejected before Session teardown', {
            sessionId,
            ...identity,
          });
          continue;
        }
        emitted.push({ sessionId, ...identity });
      } catch (error) {
        log.warn('Windows session-end fallback terminal emit failed before Session teardown', {
          sessionId,
          ...identity,
          error,
        });
      } finally {
        syntheticFallbackEmissionKeys.delete(fallbackTurnKey(sessionId, identity));
      }
    }
  }
  // An awaiting fallback resolver resumes in a microtask. Yield once so its
  // synchronous replay reaches Session consumers before Maker reserves detach.
  await Promise.resolve();
  return emitted;
}

/**
 * Give one closing Session instance its protected fallback terminals before
 * Session.close/detach reserves teardown. Replacement keeps this narrow
 * observer with the deferred replay consumers, so a confirmed old instance
 * cannot close first and make its saved emitter permanently reject.
 */
export function prepareWindowsSessionEndFallbackBeforeSessionClose(
  sessionId: string,
  sessionInstanceId: string,
): WindowsSessionEndActiveTurn[] {
  if (!windowsSessionEnding) return [];
  const state = confirmedRecoveryMarkerStates.get(sessionId);
  if (state !== 'pending' && state !== 'awaiting-fallback') return [];
  const emitted: WindowsSessionEndActiveTurn[] = [];
  for (const identity of confirmedInterruptedTurnGenerations.get(sessionId)?.values() ?? []) {
    if (
      identity.sessionInstanceId !== sessionInstanceId ||
      hasFallbackTerminalForGeneration(sessionId, identity)
    ) {
      continue;
    }
    const emitter = fallbackTerminalEmitters.get(sessionId)?.get(turnIdentityKey(identity));
    if (!emitter) {
      log.warn('missing Windows session-end fallback terminal emitter before Session close', {
        sessionId,
        ...identity,
      });
      continue;
    }
    try {
      syntheticFallbackEmissionKeys.add(fallbackTurnKey(sessionId, identity));
      const emittedFallback = emitter();
      if (emittedFallback === false) {
        log.warn('Windows session-end fallback terminal was rejected before Session close', {
          sessionId,
          ...identity,
        });
        continue;
      }
      emitted.push({ sessionId, ...identity });
    } catch (error) {
      log.warn('Windows session-end fallback terminal emit failed before Session close', {
        sessionId,
        ...identity,
        error,
      });
    } finally {
      syntheticFallbackEmissionKeys.delete(fallbackTurnKey(sessionId, identity));
    }
  }
  return emitted;
}

/**
 * Commit the confirmed-session-end handoff only after every recovery marker has
 * a durable outcome. A failed marker waits for the original terminal stream to
 * become the fallback instead of leaving neither a marker nor a persisted
 * failure.
 */
export async function settleWindowsSessionEndRecoveryMarkers(
  durableSessionIds: Iterable<string>,
  settleFallbackSession?: (sessionId: string) => void | Promise<void>,
  registerLateProviderDoneStoragePrerequisite?: (
    prerequisite: Promise<void>,
    identity: WindowsSessionEndTurnIdentity,
  ) => void,
): Promise<string[]> {
  if (!windowsSessionEnding) return [];
  const durableSessions = new Set(durableSessionIds);
  const settlingSessionIds: string[] = [];
  const failedMarkerSettlements: Array<Promise<string | null>> = [];
  for (const [sessionId, state] of confirmedRecoveryMarkerStates) {
    if (state !== 'pending') continue;
    settlingSessionIds.push(sessionId);
    const durable = durableSessions.has(sessionId);
    if (durable) {
      confirmedRecoveryMarkerStates.set(sessionId, 'durable');
      settlePendingEventCallbacks(sessionId, true);
      fallbackTerminalEmitters.delete(sessionId);
    } else {
      failedMarkerSettlements.push(
        settleFailedRecoveryMarker(
          sessionId,
          registerLateProviderDoneStoragePrerequisite,
        ).then(async (fallbackSessionId) => {
          if (fallbackSessionId !== null) await settleFallbackSession?.(fallbackSessionId);
          return fallbackSessionId;
        }),
      );
    }
  }
  // A required task may fail while another failed-marker session is still
  // replaying/persisting its only terminal history. Do not fail fast: storage
  // disposal is gated by this promise and must stay blocked until every
  // session's settlement has reached a durable success or an explicit failure.
  const settlementResults = await Promise.allSettled(failedMarkerSettlements);
  const failedSettlement = settlementResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  const fallbackSessionIds = settlementResults
    .filter(
      (result): result is PromiseFulfilledResult<string | null> => result.status === 'fulfilled',
    )
    .map((result) => result.value);
  // Durable markers have discarded their held events and can detach now.
  // Fallback gates remain alive for a possible real provider done unless the
  // shutdown-maker phase already started. Captured usage continues to hold DB
  // disposal even after its gate is detached.
  for (const sessionId of settlingSessionIds) {
    completedRecoveryMarkerSessionIds.add(sessionId);
    maybeSettlePendingWiringTeardowns(sessionId);
  }
  // A rejected required write keeps the recovery marker, but it must not keep
  // an unbound provider-event placeholder or retained replacement gate alive
  // forever. Publish teardown readiness only after every session settlement
  // above has stopped scheduling storage, then propagate the original failure.
  if (failedSettlement) throw failedSettlement.reason;
  return fallbackSessionIds.filter((sessionId): sessionId is string => sessionId !== null);
}

export function shouldSuppressWindowsSessionEndClaudeError(context: {
  sessionId: string;
  source: string | undefined;
  isTerminalError: boolean;
  sessionInstanceId?: string;
  sessionTurnGeneration?: number;
}): boolean {
  const identity =
    typeof context.sessionTurnGeneration === 'number'
      ? createTurnIdentity(
          context.sessionId,
          context.sessionInstanceId,
          context.sessionTurnGeneration,
        )
      : null;
  return (
    windowsSessionEnding &&
    confirmedRecoveryMarkerStates.get(context.sessionId) !== 'fallback' &&
    hasTurnIdentity(confirmedInterruptedTurnGenerations.get(context.sessionId), identity) &&
    context.source === 'claude-code' &&
    context.isTerminalError
  );
}

export function __resetWindowsSessionEndForTests(): void {
  for (const pendingEvent of pendingEventCallbacks) pendingEvent.discard?.();
  windowsSessionEnding = false;
  pendingQuerySessionTurnGenerations = null;
  pendingSilentStopContinuationGenerations.clear();
  deferredTerminalTurnGenerations.clear();
  confirmedTerminalTurnGenerations.clear();
  confirmedInterruptedTurnGenerations.clear();
  confirmedRecoveryMarkerStates.clear();
  protectedWiringTeardownSessionIds.clear();
  pendingWiringTeardowns.clear();
  fallbackTerminalEmitters.clear();
  syntheticFallbackEmissionKeys.clear();
  pendingFallbackStorageTasks.clear();
  for (const holds of lateProviderDoneStorageHolds.values()) {
    for (const hold of holds.values()) hold.resolve();
  }
  lateProviderDoneStorageHolds.clear();
  finishedFallbackProviderEventInstances.clear();
  completedRecoveryMarkerSessionIds.clear();
  fallbackProviderTeardownStarted = false;
  pendingEventCallbacks = [];
  const fallbackEventResolvers = [...pendingFallbackEventResolvers.values()];
  pendingFallbackEventResolvers.clear();
  for (const resolveFallbackEvent of fallbackEventResolvers) resolveFallbackEvent();
}
