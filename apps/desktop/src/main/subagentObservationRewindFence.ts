import {
  normalizeAgentTaskUpdate,
  type AgentTaskUpdate,
} from '@cindy/maker-shared/agent-task';
import {
  normalizeSubagentObservation,
  type SubagentObservation,
} from '@cindy/maker-shared/subagent-observation';
import type { SubagentProvider } from '@cindy/maker-shared/subagent-workspace';

interface PendingObservationWrite<T> {
  generation: number;
  taskKey: string;
  enqueue: () => Promise<T>;
  resolve: (value: T | null) => void;
  reject: (error: unknown) => void;
}

interface SessionFenceState {
  generation: number;
  acceptsNewTasks: boolean;
  activeToken: symbol | null;
  clearRequested: boolean;
  clearTimer: ReturnType<typeof setTimeout> | null;
  taskGenerations: Map<string, number>;
  pending: PendingObservationWrite<unknown>[];
}

export interface SubagentRewindFence {
  sessionId: string;
  token: symbol;
}

export interface VisibleSubagentIdentity {
  provider: SubagentProvider;
  identities: readonly string[];
}

export interface SubagentObservationGenerationStamp {
  generation: number;
  taskKey: string;
}

const stateBySession = new Map<string, SessionFenceState>();
const DEFERRED_CLEAR_TIMEOUT_MS = 30_000;

function dropSessionState(sessionId: string, state: SessionFenceState): void {
  if (state.clearTimer) {
    clearTimeout(state.clearTimer);
    state.clearTimer = null;
  }
  for (const item of state.pending.splice(0)) item.resolve(null);
  state.activeToken = null;
  if (stateBySession.get(sessionId) === state) stateBySession.delete(sessionId);
}

function sessionState(sessionId: string): SessionFenceState {
  let state = stateBySession.get(sessionId);
  if (!state) {
    state = {
      generation: 0,
      acceptsNewTasks: true,
      activeToken: null,
      clearRequested: false,
      clearTimer: null,
      taskGenerations: new Map(),
      pending: [],
    };
    stateBySession.set(sessionId, state);
  }
  return state;
}

function observationFrom(data: unknown): SubagentObservation | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return normalizeSubagentObservation(
    (data as Record<string, unknown>).subagentObservation,
  );
}

function taskKey(update: AgentTaskUpdate, observation: SubagentObservation | null): string {
  return `${update.provider}:${observation?.logicalSubagentId ?? update.taskId}`;
}

function visibleIdentityKeys(visible: readonly VisibleSubagentIdentity[]): Set<string> {
  const keys = new Set<string>();
  for (const row of visible) {
    for (const identity of row.identities) {
      if (identity) keys.add(`${row.provider}:${identity}`);
    }
  }
  return keys;
}

function generationForObservation(
  state: SessionFenceState,
  update: AgentTaskUpdate,
  observation: SubagentObservation | null,
): number | null {
  const key = taskKey(update, observation);
  const known = state.taskGenerations.get(key);
  if (known !== undefined) return known;
  if (!state.acceptsNewTasks) return null;
  // A process can reattach to a native child and receive progress/terminal
  // without replaying spawn. Treat an unknown identity as current; the Rewind
  // snapshot below primes every already-visible durable alias, so those old
  // lifecycles remain on their prior generation after a successful commit.
  state.taskGenerations.set(key, state.generation);
  return state.generation;
}

function enqueuePending<T>(pending: PendingObservationWrite<T>): void {
  void pending.enqueue().then(pending.resolve, pending.reject);
}

/**
 * Start the session-local critical section before Stop / SDK rollback begins.
 * Observations arriving until commit/rollback are held outside the global
 * durable FIFO, so a long Rewind cannot stall unrelated chat/session writes.
 */
export function beginSubagentRewindFence(sessionId: string): SubagentRewindFence {
  let state = sessionState(sessionId);
  if (state.activeToken && state.clearRequested) {
    dropSessionState(sessionId, state);
    state = sessionState(sessionId);
  }
  if (state.activeToken) {
    throw new Error(`Subagent Rewind already active for session ${sessionId}`);
  }
  const token = Symbol(`subagent-rewind:${sessionId}`);
  state.activeToken = token;
  return { sessionId, token };
}

/** Add durable identities read after the fence was raised but before commit. */
export function primeSubagentRewindFence(
  fence: SubagentRewindFence,
  visible: readonly VisibleSubagentIdentity[],
): void {
  const state = stateBySession.get(fence.sessionId);
  if (!state || state.activeToken !== fence.token) return;
  for (const key of visibleIdentityKeys(visible)) {
    if (!state.taskGenerations.has(key)) state.taskGenerations.set(key, state.generation);
  }
}

/**
 * Finish a Rewind fence. Success advances the session generation, migrates
 * identities that remain visible after commit, replays their buffered frames,
 * and discards frames belonging to the withdrawn branch. Failure keeps the
 * generation and replays every buffered write in original arrival order.
 */
export function finishSubagentRewindFence(
  fence: SubagentRewindFence,
  committed: boolean,
  visibleAfterCommit: readonly VisibleSubagentIdentity[] = [],
): void {
  const state = stateBySession.get(fence.sessionId);
  if (!state || state.activeToken !== fence.token) return;
  if (state.clearRequested) {
    dropSessionState(fence.sessionId, state);
    return;
  }
  state.activeToken = null;
  const pending = state.pending.splice(0);
  if (committed) {
    state.generation += 1;
    state.acceptsNewTasks = false;
    const visibleKeys = visibleIdentityKeys(visibleAfterCommit);
    for (const key of visibleKeys) state.taskGenerations.set(key, state.generation);
    for (const item of pending) {
      if (visibleKeys.has(item.taskKey)) enqueuePending(item);
      else item.resolve(null);
    }
    return;
  }
  for (const item of pending) {
    if (item.generation === state.generation) enqueuePending(item);
    else item.resolve(null);
  }
}

/** The next provider turn is authoritative permission to accept new task ids. */
export function noteSubagentObservationTurnStarted(sessionId: string): void {
  let state = sessionState(sessionId);
  if (state.clearRequested) {
    dropSessionState(sessionId, state);
    state = sessionState(sessionId);
  }
  state.acceptsNewTasks = true;
}

/**
 * Persist one marked Subagent observation under the task generation captured
 * at its first spawn. Old-task duplicate/out-of-order frames stay rejected
 * after a successful Rewind, while a new task id after commit joins the new
 * generation normally. This is provider-neutral and leaves native harness
 * creation/control flows untouched.
 */
export function captureSubagentObservationGeneration(args: {
  sessionId: string;
  data: unknown;
  source?: SubagentProvider;
}): SubagentObservationGenerationStamp | null {
  const update = normalizeAgentTaskUpdate(args.data, args.source);
  if (!update) return null;
  const observation = observationFrom(args.data);
  const state = sessionState(args.sessionId);
  const key = taskKey(update, observation);
  const generation = generationForObservation(state, update, observation);
  return generation === null ? null : { generation, taskKey: key };
}

export function enqueueSubagentObservationWrite<T>(args: {
  sessionId: string;
  stamp: SubagentObservationGenerationStamp;
  enqueue: () => Promise<T>;
}): Promise<T | null> {
  const state = sessionState(args.sessionId);
  const generation = args.stamp.generation;
  if (generation !== state.generation) return Promise.resolve(null);

  if (!state.activeToken) return args.enqueue();

  return new Promise<T | null>((resolve, reject) => {
    state.pending.push({
      generation,
      taskKey: args.stamp.taskKey,
      enqueue: args.enqueue,
      resolve,
      reject,
    } as PendingObservationWrite<unknown>);
  });
}

export function clearSubagentObservationRewindState(sessionId: string): boolean {
  const state = stateBySession.get(sessionId);
  if (!state) return true;
  if (state.activeToken) {
    state.clearRequested = true;
    if (!state.clearTimer) {
      const activeToken = state.activeToken;
      state.clearTimer = setTimeout(() => {
        const current = stateBySession.get(sessionId);
        if (
          current === state &&
          current.clearRequested &&
          current.activeToken === activeToken
        ) {
          dropSessionState(sessionId, current);
        }
      }, DEFERRED_CLEAR_TIMEOUT_MS);
      state.clearTimer.unref?.();
    }
    return false;
  }
  dropSessionState(sessionId, state);
  return true;
}

export function __resetSubagentObservationRewindStateForTesting(): void {
  for (const [sessionId, state] of stateBySession) {
    dropSessionState(sessionId, state);
  }
}
