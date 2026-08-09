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
  enqueue: () => Promise<T>;
  resolve: (value: T | null) => void;
  reject: (error: unknown) => void;
}

interface SessionFenceState {
  generation: number;
  acceptsNewTasks: boolean;
  activeToken: symbol | null;
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
}

const stateBySession = new Map<string, SessionFenceState>();

function sessionState(sessionId: string): SessionFenceState {
  let state = stateBySession.get(sessionId);
  if (!state) {
    state = {
      generation: 0,
      acceptsNewTasks: true,
      activeToken: null,
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
  const state = sessionState(sessionId);
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
  for (const row of visible) {
    for (const identity of row.identities) {
      if (!identity) continue;
      const key = `${row.provider}:${identity}`;
      if (!state.taskGenerations.has(key)) state.taskGenerations.set(key, state.generation);
    }
  }
}

/**
 * Finish a Rewind fence. Success advances the session generation and discards
 * every lifecycle frame observed during the withdrawn branch. Failure keeps
 * the generation and replays buffered writes in original arrival order.
 */
export function finishSubagentRewindFence(
  fence: SubagentRewindFence,
  committed: boolean,
): void {
  const state = stateBySession.get(fence.sessionId);
  if (!state || state.activeToken !== fence.token) return;
  state.activeToken = null;
  const pending = state.pending.splice(0);
  if (committed) {
    state.generation += 1;
    state.acceptsNewTasks = false;
    for (const item of pending) item.resolve(null);
    return;
  }
  for (const item of pending) {
    if (item.generation === state.generation) enqueuePending(item);
    else item.resolve(null);
  }
}

/** The next provider turn is authoritative permission to accept new task ids. */
export function noteSubagentObservationTurnStarted(sessionId: string): void {
  sessionState(sessionId).acceptsNewTasks = true;
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
  const generation = generationForObservation(state, update, observation);
  return generation === null ? null : { generation };
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
      enqueue: args.enqueue,
      resolve,
      reject,
    } as PendingObservationWrite<unknown>);
  });
}

export function clearSubagentObservationRewindState(sessionId: string): boolean {
  const state = stateBySession.get(sessionId);
  if (!state) return true;
  // Claude Rewind may close its native query while the session-local critical
  // section is still active. Keep the fence until the IPC owner commits or
  // rolls back it; a later ordinary close can reclaim the state.
  if (state.activeToken) return false;
  for (const item of state.pending) item.resolve(null);
  stateBySession.delete(sessionId);
  return true;
}

export function __resetSubagentObservationRewindStateForTesting(): void {
  for (const sessionId of stateBySession.keys()) {
    clearSubagentObservationRewindState(sessionId);
  }
}
